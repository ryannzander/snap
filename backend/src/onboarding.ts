/**
 * What Snap says before he has said anything else.
 *
 * Pure strings in their own module for the same reason money.ts is: the
 * explainer is the one message in the product that must be identical every
 * time and can never be improvised, because it is the one that tells someone
 * a tapback will move their money. Kept out of user-agent.ts so it is
 * testable on plain Node, with no Durable Object in the way.
 */

/**
 * "help", and the handful of ways people ask a number they just met what it
 * is. Kept tight on purpose: "how do i get my money back" is a real question
 * for the agent to answer in context, not a cue to replay onboarding.
 */
export function asksHowItWorks(text: string): boolean {
  const trimmed = text.trim().toLowerCase().replace(/[?!.]+$/, '');
  if (trimmed === 'help' || trimmed === 'info' || trimmed === 'how does this work') return true;
  return /^(how (does|do) (this|it|you|u) work|what (do|can) (you|u) do|how do i (use|start)( this)?|wtf (is|are) (this|you))$/.test(
    trimmed,
  );
}

/**
 * The first thing anyone reads from Snap.
 *
 * Until this existed, linking got you "yo ryan / im in. what are we doing
 * today" and nothing else: the user had just been told in onboarding that
 * money would be involved, and the thread never mentioned it again until a
 * stake was offered. Everything a person has to know to use Snap safely is
 * here, in his voice, before anything can cost them anything —
 * what he does, that the watch is what counts, where the money lives, and
 * that a 👍 on an offer is what takes it.
 *
 * `again` is the same explainer asked for on purpose ("help"), so it does not
 * open by greeting someone who has been here for a week.
 *
 * Nine texts, which is nine of the Linq sandbox's hundred a day. That is the
 * price of nobody being surprised by a stake, and it is paid once per user.
 */
export function onboardingTexts(name: string | null, weeklyGoal: number | null, again = false): string[] {
  const who = (name ?? '').trim().toLowerCase();
  const goal = weeklyGoal && weeklyGoal > 0 ? `${weeklyGoal}x a week` : 'your week';

  return [
    ...(again
      ? ['aight, the rules again 👇']
      : [who ? `yo ${who}` : 'yo', 'im snap. im in your texts now. heres the deal 👇']),
    'you tell me when youre training. "gym at 7" is enough',
    'then i put money on it. YOUR money',
    'you go, you get all of it back. you skip and its gone 💀',
    'tap 👍 on my text to agree to a stake. thats how you say yes',
    'i never ask if you went. your watch tells me',
    'your wallet is in the app — add sol there, and you can see whats locked',
    ...(again ? [] : [`${goal}. what are we doing today`]),
  ];
}
