/**
 * How hard Snap pushes. Chosen once at onboarding, changeable any time.
 *
 * This is deliberately about *pressure* and nothing else — how soon he checks
 * on you, how much money he puts on by default, and how much room he gives
 * you before he starts. It does not touch what you train or how you train it.
 * ROADMAP.md → "Why Snap is different": **no plans, no macros, no
 * encouragement. A friend who roasts you and holds your money.**
 *
 * Dialling the pressure is in character. Prescribing sets is a different
 * product, and one that already exists everywhere.
 */

export type Intensity = 'easy' | 'medium' | 'hard';

export const INTENSITIES: readonly Intensity[] = ['easy', 'medium', 'hard'];
export const DEFAULT_INTENSITY: Intensity = 'medium';

export interface IntensitySettings {
  /** Minutes after the deadline before the first "where are you". */
  graceMin: number;
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
    defaultStakeLamports: 20_000_000, // 0.02 SOL
    morningCheckIn: false,
    voice:
      'they picked EASY. long leash: give them 45 minutes before you say anything, keep it light, and let a bad day go. you are still the same person, just not on their back.',
  },
  medium: {
    graceMin: 20,
    defaultStakeLamports: 50_000_000, // 0.05 SOL
    morningCheckIn: true,
    voice:
      'they picked MEDIUM. this is you as normal: check in 20 minutes past, push once, take a real reason but not a soft one.',
  },
  hard: {
    graceMin: 10,
    defaultStakeLamports: 100_000_000, // 0.1 SOL
    morningCheckIn: true,
    voice:
      'they picked HARD. they asked for this: you are on them 10 minutes past, you do not soften it, and an excuse has to be genuinely good before it earns anything. never cruel — still their friend, just one who took them at their word.',
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
