/**
 * How hard Snap pushes. Chosen once at onboarding, changeable any time.
 *
 * Two things, and deliberately not a third. It sets the TARGET — how long a
 * session you asked to be held to — and it sets the PRESSURE — how soon he
 * checks on you, what he puts up by default, whether he texts first in the
 * morning.
 *
 * Neither one is a gate on your money. Turning up and doing some of it pays,
 * every time; the target is what Snap holds you to out loud, and coming in
 * under it is a conversation, not a forfeit. The money only moves when you
 * did not go.
 *
 * It does not tell you what to train. ROADMAP.md → "Why Snap is different":
 * **no plans, no macros, no encouragement. A friend who roasts you and holds
 * your money.** Naming a target is what a friend does. Writing you a push day
 * is coaching, and that product already exists everywhere.
 */

export type Intensity = 'easy' | 'medium' | 'hard';

export const INTENSITIES: readonly Intensity[] = ['easy', 'medium', 'hard'];
export const DEFAULT_INTENSITY: Intensity = 'medium';

export interface IntensitySettings {
  /** Minutes after the deadline before the first "where are you". */
  graceMin: number;
  /**
   * How long a session they asked to be held to — the difficulty half of the
   * dial.
   *
   * It is a target, never a gate. Snap names it when you commit and says
   * something when you come in under it, but it does not decide whether your
   * money comes back: a session you turned up for pays out at 30 minutes of a
   * 60-minute target, because showing up is the behaviour we are buying and
   * "doesn't count" is how you teach someone to stop staking.
   */
  targetMin: number;
  /** What goes on the line when the user names no amount. */
  defaultStakeLamports: number;
  /** Whether he texts first in the morning when there is no plan for today. */
  morningCheckIn: boolean;
  /** Handed to the model so the voice matches the dial. */
  voice: string;
}

const SETTINGS: Record<Intensity, IntensitySettings> = {
  easy: {
    graceMin: 45,
    targetMin: 30,
    defaultStakeLamports: 20_000_000, // 0.02 SOL
    morningCheckIn: false,
    voice:
      'they picked EASY. they are aiming at 30-minute sessions. long leash: give them 45 minutes past the deadline before you say anything, keep it light, and let a bad day go. you are still the same person, just not on their back.',
  },
  medium: {
    graceMin: 20,
    targetMin: 45,
    defaultStakeLamports: 50_000_000, // 0.05 SOL
    morningCheckIn: true,
    voice:
      'they picked MEDIUM. they are aiming at 45-minute sessions. this is you as normal: check in 20 minutes past, push once, take a real reason but not a soft one.',
  },
  hard: {
    graceMin: 10,
    targetMin: 60,
    defaultStakeLamports: 100_000_000, // 0.1 SOL
    morningCheckIn: true,
    voice:
      'they picked HARD. they are aiming at hour-long sessions. they asked for this: you are on them 10 minutes past, you do not soften it, and an excuse has to be genuinely good before it earns anything. never cruel — still their friend, just one who took them at their word.',
  },
};

/**
 * The biggest stake the dial can put up on its own.
 *
 * A new wallet has to clear this, or choosing HARD at onboarding means Snap
 * refuses his own first offer for want of funds — which is exactly what
 * happened: *"their wallet holds 0.1 SOL and this stake needs 0.1 SOL"*.
 */
export const MAX_DEFAULT_STAKE_LAMPORTS = Math.max(
  ...INTENSITIES.map((intensity) => SETTINGS[intensity].defaultStakeLamports),
);

export function settingsFor(intensity: Intensity | undefined): IntensitySettings {
  return SETTINGS[intensity ?? DEFAULT_INTENSITY];
}

export function isIntensity(value: unknown): value is Intensity {
  return typeof value === 'string' && (INTENSITIES as readonly string[]).includes(value);
}
