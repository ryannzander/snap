import type { Brain, BrainDecision, BrainTurn } from '../brain';

/**
 * One brain, with another behind it.
 *
 * Until this existed, a wrong OPENAI_MODEL or a dead key meant the agent said
 * nothing at all: `decide` threw, runAgent caught it, wrote "brain
 * unavailable" to the trace and returned. The loop survived and the product
 * did not — no commitment, no reply, a silent demo.
 *
 * That risk is not hypothetical. The model name is config, nobody can verify
 * it from outside the Worker, and the first time it is exercised for real is
 * the first time it matters. Degrading to the Workers AI binding is worse
 * than the model we want and enormously better than silence.
 *
 * The fallback is deliberately loud: it writes to the trace every time, so a
 * misconfiguration shows up in rehearsal as a visible line rather than as a
 * quietly worse demo.
 */
export class FallbackBrain implements Brain {
  private lastUsed: Brain;

  constructor(
    private readonly primary: Brain,
    private readonly backup: Brain,
    private readonly onFallback: (error: string) => Promise<void>,
  ) {
    this.lastUsed = primary;
  }

  /** Whichever brain actually answered, so the trace names the real one. */
  get name(): string {
    return this.lastUsed.name;
  }

  async decide(turn: BrainTurn): Promise<BrainDecision> {
    try {
      const decision = await this.primary.decide(turn);
      this.lastUsed = this.primary;
      return decision;
    } catch (error) {
      await this.onFallback(String(error));
      // If the backup throws too, that error is the one worth surfacing:
      // both brains being down is a different problem from one being
      // misconfigured, and runAgent already traces it.
      this.lastUsed = this.backup;
      return this.backup.decide(turn);
    }
  }
}
