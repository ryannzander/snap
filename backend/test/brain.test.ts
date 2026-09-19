/**
 * The brain fallback.
 *
 * What this protects against: OPENAI_MODEL is config nobody can verify from
 * outside the Worker, and before this a wrong name meant `decide` threw,
 * runAgent caught it, and the agent said nothing at all. No commitment, no
 * reply, a silent demo — and the only evidence a line in the trace nobody
 * was watching.
 */
import { FallbackBrain } from '../src/brains/fallback';
import type { Brain, BrainDecision, BrainTurn } from '../src/brain';
import { section, eq, isTrue, done } from './harness';

const TURN: BrainTurn = { system: 's', context: 'c', instruction: 'i', tools: [] };

function fake(name: string, behaviour: 'answers' | 'throws'): Brain & { calls: number } {
  return {
    name,
    calls: 0,
    async decide(): Promise<BrainDecision> {
      (this as { calls: number }).calls++;
      if (behaviour === 'throws') throw new Error(`${name} is down`);
      return { toolCalls: [{ name: 'send_messages', arguments: { texts: [name] } }], reasoning: name };
    },
  };
}

section('when the primary answers');
{
  const primary = fake('openai', 'answers');
  const backup = fake('workers-ai', 'answers');
  const noted: string[] = [];
  const brain = new FallbackBrain(primary, backup, async (e) => void noted.push(e));

  const decision = await brain.decide(TURN);
  eq('its answer is used', decision.reasoning, 'openai');
  eq('the backup is never called', backup.calls, 0);
  eq('nothing is reported', noted, []);
  eq('the trace names the primary', brain.name, 'openai');
}

section('when the primary is down — a wrong model name, a dead key');
{
  const primary = fake('openai', 'throws');
  const backup = fake('workers-ai', 'answers');
  const noted: string[] = [];
  const brain = new FallbackBrain(primary, backup, async (e) => void noted.push(e));

  const decision = await brain.decide(TURN);
  eq('the backup answers instead of silence', decision.reasoning, 'workers-ai');
  eq('the backup was called once', backup.calls, 1);
  eq('the fallback is reported, not swallowed', noted.length, 1);
  isTrue('and says what went wrong', noted[0]!.includes('openai is down'));
  eq('the trace names whoever actually answered', brain.name, 'workers-ai');
}

section('when both are down');
{
  const brain = new FallbackBrain(fake('openai', 'throws'), fake('workers-ai', 'throws'), async () => {});
  let threw = false;
  try {
    await brain.decide(TURN);
  } catch (error) {
    threw = true;
    // The backup's failure is the useful one: both brains down is a
    // different problem from one being misconfigured.
    isTrue('the backup\'s error surfaces', String(error).includes('workers-ai is down'));
  }
  isTrue('it throws rather than pretending', threw);
}

section('the primary is retried on the next turn, not written off');
{
  let fail = true;
  const flaky: Brain = {
    name: 'openai',
    async decide(): Promise<BrainDecision> {
      if (fail) throw new Error('rate limited');
      return { toolCalls: [], reasoning: 'openai' };
    },
  };
  const backup = fake('workers-ai', 'answers');
  const brain = new FallbackBrain(flaky, backup, async () => {});

  eq('first turn falls back', (await brain.decide(TURN)).reasoning, 'workers-ai');
  fail = false;
  eq('second turn uses the primary again', (await brain.decide(TURN)).reasoning, 'openai');
  eq('the backup was only used once', backup.calls, 1);
}

done('brain fallback');
