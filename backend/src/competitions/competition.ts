import { DurableObject } from 'cloudflare:workers';

import { fail, ok, type DoResult } from '../http';
import { solText } from '../money';
import { parseIso } from '../time';
import type { UserAgent } from '../user-agent';
import {
  DEFAULT_RAKE_BPS,
  meetsGoal,
  progressFor,
  settleCompetition,
  type Goal,
  type Standing,
} from './rules';

/**
 * One Durable Object per competition: the pot, the rule, the entrants, and the
 * oracle that settles it.
 *
 * ROADMAP.md → "Competitions": three kinds, one engine. A 1v1, a group pot and
 * a solo weekly pot differ only in how many people are in the entrant list, so
 * there is one object and one settlement path rather than three.
 *
 * The competition never holds money itself. Entry moves a stake from the
 * entrant's wallet into the same escrow the single-commitment loop uses, and
 * settlement pays out of it — so there is one custodian to explain to a judge,
 * not two.
 */

const KEY = {
  record: 'competition',
} as const;

export type CompetitionKind = 'solo' | 'h2h' | 'group';
export type CompetitionStatus = 'open' | 'settled';

export interface Entrant {
  userId: string;
  name: string;
  stakeLamports: number;
  joinedAt: string;
  entryTxSig: string | null;
  /** Filled in at settlement. */
  progress?: number;
  met?: boolean;
  payoutLamports?: number;
  payoutTxSig?: string | null;
}

export interface CompetitionRecord {
  id: string;
  kind: CompetitionKind;
  name: string;
  goal: Goal;
  entryLamports: number;
  rakeBps: number;
  joinCode: string;
  startsAt: string;
  endsAt: string;
  status: CompetitionStatus;
  createdBy: string;
  entrants: Entrant[];
  potLamports?: number;
  rakeLamports?: number;
  settledAt?: string;
}

export interface CompetitionView extends CompetitionRecord {
  /** Live standings, recomputed on every read rather than stored. */
  standings: Array<{ userId: string; name: string; progress: number; met: boolean; stakeLamports: number }>;
}

export class Competition extends DurableObject<Env> {
  async create(input: {
    id: string;
    kind: CompetitionKind;
    name: string;
    goal: Goal;
    entryLamports: number;
    rakeBps?: number;
    joinCode: string;
    startsAt: string;
    endsAt: string;
    createdBy: string;
  }): Promise<DoResult<CompetitionRecord>> {
    if (await this.record()) return fail(409, 'bad_request', 'that competition already exists');

    const record: CompetitionRecord = {
      ...input,
      rakeBps: input.rakeBps ?? DEFAULT_RAKE_BPS,
      status: 'open',
      entrants: [],
    };
    await this.ctx.storage.put(KEY.record, record);

    // Settles itself when the window closes, so nobody has to remember to.
    const endsAt = parseIso(record.endsAt);
    if (endsAt !== null) await this.ctx.storage.setAlarm(Math.max(endsAt, Date.now() + 1_000));

    return ok(record);
  }

  /** Locks the entrant's stake and adds them. Idempotent per user. */
  async join(userId: string): Promise<DoResult<CompetitionRecord>> {
    const record = await this.record();
    if (!record) return fail(404, 'not_found', 'no such competition');
    if (record.status !== 'open') return fail(409, 'bad_request', 'that competition is already settled');
    if (record.entrants.some((e) => e.userId === userId)) return ok(record);

    // A head-to-head is exactly two people; anything else is a group pot.
    if (record.kind === 'h2h' && record.entrants.length >= 2) {
      return fail(409, 'bad_request', 'that one is a 1v1 and both spots are taken');
    }
    if (parseIso(record.endsAt) !== null && parseIso(record.endsAt)! <= Date.now()) {
      return fail(409, 'bad_request', 'that competition has already finished');
    }

    // Take the seat BEFORE the money moves, and with nothing but storage
    // between the read above and this write — which is the only window in
    // which this object delivers no other events.
    //
    // Entering is a chain transfer inside another Durable Object and takes
    // seconds, and events ARE delivered while that is awaited. Pushing onto
    // the record read before it meant two taps on "join" both passed the
    // "already an entrant" check and both staked, leaving one entrant row and
    // two debits; and a join still in flight when the alarm settled wrote its
    // stale copy back afterwards, reviving a settled competition as "open"
    // with the payouts erased.
    record.entrants.push({
      userId,
      name: '',
      stakeLamports: record.entryLamports,
      joinedAt: new Date().toISOString(),
      entryTxSig: null,
    });
    await this.ctx.storage.put(KEY.record, record);

    const entry = await this.user(userId).enterCompetition(
      record.id,
      record.name,
      record.entryLamports,
    );

    // Re-read: settlement may have claimed the record while the stake moved.
    const current = (await this.record()) ?? record;
    const seat = current.entrants.find((e) => e.userId === userId);

    if (!entry.ok) {
      // Nothing was staked, so nothing may be owed. Only give the seat back
      // while the competition is still open — a settled record has already
      // paid out around this entrant and must not be rewritten.
      if (seat && current.status === 'open') {
        current.entrants = current.entrants.filter((e) => e.userId !== userId);
        await this.ctx.storage.put(KEY.record, current);
      }
      return entry;
    }

    if (seat) {
      seat.name = entry.value.name;
      seat.entryTxSig = entry.value.txSig;
      await this.ctx.storage.put(KEY.record, current);
    }
    return ok(current);
  }

  /** The competition with standings computed from HealthKit, right now. */
  async view(): Promise<DoResult<CompetitionView>> {
    const record = await this.record();
    if (!record) return fail(404, 'not_found', 'no such competition');
    return ok({ ...record, standings: await this.standings(record) });
  }

  async alarm(): Promise<void> {
    await this.settle();
  }

  /**
   * Reads every entrant's workouts, decides who met the goal, and moves the
   * money. Safe to call twice: a settled competition returns its result
   * unchanged rather than paying out again.
   */
  async settle(): Promise<DoResult<CompetitionRecord>> {
    const record = await this.record();
    if (!record) return fail(404, 'not_found', 'no such competition');
    if (record.status === 'settled') return ok(record);

    // Claim it first, in the same breath as the check above — the same
    // "delete first, then run" rule the user agent's alarms follow.
    //
    // Paying an entrant is a Durable Object call that transfers on chain and
    // then runs a model turn, seconds each, and this object accepts events
    // for the whole of it. Marking the record settled only at the end meant a
    // POST /competitions/<id>/settle racing the alarm — or the alarm retrying
    // after an RPC threw halfway down the list — read "open", recomputed the
    // same settlement, and paid every winner a second time out of an escrow
    // that only ever received one stake each. Losing a payout to a crash can
    // be repaired by hand from the record; paying twice cannot be undone.
    record.status = 'settled';
    record.settledAt = new Date().toISOString();
    await this.ctx.storage.put(KEY.record, record);
    await this.ctx.storage.deleteAlarm();

    const standings = await this.standings(record);
    const settlement = settleCompetition(
      standings.map(
        (s): Standing => ({
          userId: s.userId,
          name: s.name,
          stakeLamports: s.stakeLamports,
          progress: s.progress,
          met: s.met,
        }),
      ),
      record.goal,
      record.rakeBps,
    );

    for (const entrant of record.entrants) {
      const standing = standings.find((s) => s.userId === entrant.userId);
      entrant.progress = standing?.progress ?? 0;
      entrant.met = standing?.met ?? false;

      const payout = settlement.payouts.find((p) => p.userId === entrant.userId);
      entrant.payoutLamports = payout?.lamports ?? 0;

      const agent = this.user(entrant.userId);
      const result = await agent.settleCompetitionEntry(
        record.id,
        record.name,
        entrant.payoutLamports,
        entrant.met,
        entrant.progress,
        record.goal,
        record.entrants.length,
      );
      entrant.payoutTxSig = result.ok ? result.value.txSig : null;
    }

    record.potLamports = settlement.potLamports;
    record.rakeLamports = settlement.rakeLamports;
    await this.ctx.storage.put(KEY.record, record);

    return ok(record);
  }

  private async standings(record: CompetitionRecord): Promise<CompetitionView['standings']> {
    const from = parseIso(record.startsAt) ?? 0;
    const to = parseIso(record.endsAt) ?? Date.now();

    return Promise.all(
      record.entrants.map(async (entrant) => {
        // From when THEY staked, not when the competition opened. A shared
        // join code means people arrive late, and counting the training they
        // had already done before there was any money on it would let someone
        // join on day six, meet the goal on arrival, and take a share of what
        // the people who actually tried forfeited.
        const joined = parseIso(entrant.joinedAt);
        const start = joined !== null && joined > from ? joined : from;

        const data = await this.user(entrant.userId).competitionData(start, to);
        const progress = data.ok
          ? progressFor(record.goal, data.value.workouts, start, to, data.value.timezone)
          : 0;
        return {
          userId: entrant.userId,
          name: data.ok ? data.value.name : entrant.name,
          stakeLamports: entrant.stakeLamports,
          progress,
          met: meetsGoal(record.goal, progress),
        };
      }),
    );
  }

  private user(userId: string): DurableObjectStub<UserAgent> {
    return this.env.USER_AGENT.get(this.env.USER_AGENT.idFromName(userId));
  }

  private async record(): Promise<CompetitionRecord | null> {
    return (await this.ctx.storage.get<CompetitionRecord>(KEY.record)) ?? null;
  }
}

export function competitionStub(env: Env, id: string): DurableObjectStub<Competition> {
  return env.COMPETITION.get(env.COMPETITION.idFromName(id));
}

/** "4 workouts", "5 hours of training", "5 active days" — for the trace and texts. */
export function goalText(goal: Goal): string {
  if (goal.type === 'workouts') return `${goal.target} workouts`;
  if (goal.type === 'activeHours') return `${goal.target} hours of training`;
  return `${goal.target} active days`;
}

export function potText(lamports: number): string {
  return solText(lamports);
}
