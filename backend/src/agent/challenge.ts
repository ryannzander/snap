/**
 * The thing that makes a photo *this* session rather than *a* session.
 *
 * The photo verifier checks that a real person is visibly training. It does
 * not check that the person is you, and it cannot: any gym photo of anybody,
 * the first time it is sent, would release a stake. The fingerprint catches a
 * byte-identical resend and nothing cleverer — a re-crop gets through.
 *
 * So the stake names a gesture when it locks, and the photo has to have it in
 * it. A picture from last Tuesday cannot have three fingers up in it, because
 * nobody knew to hold three fingers up until ninety seconds ago, and a photo
 * borrowed from a friend's camera roll has the same problem. It turns "prove
 * you trained" into "prove you trained *now*", which is the half of the claim
 * the vision model could never answer on its own.
 *
 * It is deliberately not identity. A friend standing next to you could hold
 * up three fingers too. What it kills is the cheap attack — the photo you
 * already had — and that is the one anybody actually tries. Binding the face
 * to an enrolled selfie is the next layer; see ROADMAP.md.
 *
 * Chosen for a vision model, not for a person: each one is a large, obvious,
 * unambiguous thing in the frame that a model gets right, and that nobody has
 * to think about at the gym.
 */

export interface Challenge {
  /** The token stored on the commitment and put to the verifier. */
  id: string;
  /** What Snap asks for, in his words. */
  ask: string;
  /** What the vision model is asked to look for, said literally. */
  look: string;
}

export const CHALLENGES: readonly Challenge[] = [
  { id: 'two', ask: '2 fingers up in the pic', look: 'the person is holding up exactly two fingers' },
  { id: 'three', ask: '3 fingers up in the pic', look: 'the person is holding up exactly three fingers' },
  { id: 'four', ask: '4 fingers up in the pic', look: 'the person is holding up exactly four fingers' },
  { id: 'thumb', ask: 'a thumbs up in the pic', look: 'the person is giving a thumbs up' },
  { id: 'peace', ask: 'a peace sign in the pic', look: 'the person is making a peace sign' },
  { id: 'palm', ask: 'an open hand up in the pic', look: 'the person is holding up an open flat palm' },
];

/**
 * Picked at random when the stake locks, so it cannot be guessed ahead of the
 * commitment — which is the whole point. Uniform over the list; repeats are
 * fine, because what a photo cannot know is *which* one this time.
 */
export function pickChallenge(random: () => number = Math.random): Challenge {
  const index = Math.floor(random() * CHALLENGES.length);
  return CHALLENGES[Math.min(index, CHALLENGES.length - 1)]!;
}

export function challengeById(id: string | null | undefined): Challenge | null {
  if (!id) return null;
  return CHALLENGES.find((c) => c.id === id) ?? null;
}
