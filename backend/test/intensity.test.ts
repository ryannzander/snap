/**
 * The pressure dial.
 *
 * It moves how hard Snap pushes and nothing else — grace, the default stake,
 * and whether he texts first in the morning. It deliberately does not touch
 * what you train or how, because ROADMAP.md calls that ban permanent:
 * "no plans, no macros, no encouragement."
 */
import {
  settingsFor,
  isIntensity,
  INTENSITIES,
  DEFAULT_INTENSITY,
  MAX_DEFAULT_STAKE_LAMPORTS,
} from '../src/agent/intensity';
import { guardCreate } from '../src/agent/guards';
import { FEE_HEADROOM_LAMPORTS, USER_FUNDING_LAMPORTS, solText } from '../src/money';
import { section, eq, isTrue, isFalse, done } from './harness';

const TZ = 'America/Toronto';
const NOW = Date.parse('2026-09-19T14:00:00Z');

section('the dial moves pressure, monotonically');
{
  const easy = settingsFor('easy');
  const medium = settingsFor('medium');
  const hard = settingsFor('hard');

  eq('grace shortens as it gets harder', [easy.graceMin, medium.graceMin, hard.graceMin], [45, 20, 10]);
  eq(
    'the default stake rises',
    [easy.defaultStakeLamports, medium.defaultStakeLamports, hard.defaultStakeLamports],
    [20_000_000, 50_000_000, 100_000_000],
  );
  isFalse('easy is never texted first in the morning', easy.morningCheckIn);
  isTrue('medium is', medium.morningCheckIn);
  isTrue('hard is', hard.morningCheckIn);

  // A profile written before the dial existed must still work.
  eq('an absent setting runs at the default', settingsFor(undefined), settingsFor(DEFAULT_INTENSITY));
}

section('every mode carries a voice, and none of them coach');
{
  const problems: string[] = [];
  for (const level of INTENSITIES) {
    const { voice } = settingsFor(level);
    if (voice.trim().length < 40) problems.push(`${level}: voice too thin to steer anything`);
    // The ban is permanent: the dial changes pressure, never programming.
    for (const banned of ['sets', 'reps', 'macros', 'plan', 'routine', 'chest', 'legs']) {
      if (voice.toLowerCase().includes(banned)) problems.push(`${level}: voice mentions "${banned}"`);
    }
  }
  eq('no mode turns Snap into a coach', problems, []);
}

section('the stake a commitment lands on follows the dial');
{
  const made = (level: 'easy' | 'medium' | 'hard') => {
    const g = guardCreate({ text: 'gym', hour: 20 }, NOW, TZ, [], settingsFor(level).defaultStakeLamports);
    return g.ok ? g.value.lamports : null;
  };
  eq('easy stakes 0.02', made('easy'), 20_000_000);
  eq('medium stakes 0.05', made('medium'), 50_000_000);
  eq('hard stakes 0.1', made('hard'), 100_000_000);

  // Naming an amount still wins over the dial — it is a default, not a cap.
  const named = guardCreate({ text: 'gym', hour: 20, sol: 0.3 }, NOW, TZ, [], settingsFor('easy').defaultStakeLamports);
  eq('a named amount overrides it', named.ok ? named.value.lamports : null, 300_000_000);
}

section('a new wallet can afford the mode they picked');
{
  // This is the one that shipped broken. A fresh wallet held exactly 0.1 SOL,
  // HARD's default stake is 0.1 SOL, and canCover wants the stake plus fee
  // headroom — so a new HARD user's first offer was refused for want of funds
  // and Snap never mentioned a stake at all.
  for (const level of INTENSITIES) {
    const stake = settingsFor(level).defaultStakeLamports;
    isTrue(
      `${level} (${solText(stake)} SOL) fits in a new wallet`,
      USER_FUNDING_LAMPORTS >= stake + FEE_HEADROOM_LAMPORTS,
    );
  }
  eq('the funding is derived from the hardest mode', MAX_DEFAULT_STAKE_LAMPORTS, 100_000_000);
}

section('validation');
{
  isTrue('easy', isIntensity('easy'));
  isTrue('hard', isIntensity('hard'));
  isFalse('extreme', isIntensity('extreme'));
  isFalse('a number', isIntensity(3));
  isFalse('nothing', isIntensity(undefined));
}

done('intensity');
