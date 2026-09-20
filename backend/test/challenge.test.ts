/**
 * The gesture that makes a photo *this* session.
 *
 * The verifier checks that a real person is training. It cannot check that the
 * person is you, so any gym photo of anybody would pass the first time it is
 * sent. The gesture is picked when the stake locks, which is the only reason a
 * photo taken before then cannot have it in it.
 */
import { CHALLENGES, challengeById, pickChallenge } from '../src/agent/challenge';
import { applyPhotoMode, readVerdict, verifyPrompt, VERIFY_PROMPT } from '../src/vision';
import { section, eq, isTrue, isFalse, done } from './harness';

const good = (extra = '') =>
  `{"training": true, "person": true, "gym": true, "screenshot": false, "confidence": 0.9, "description": "mid-set at the rack"${extra}}`;

section('the list is usable by a model and by a person mid-set');
{
  isTrue('there are several to pick from', CHALLENGES.length >= 4);
  eq('ids are unique', new Set(CHALLENGES.map((c) => c.id)).size, CHALLENGES.length);
  eq('and so is what snap asks for', new Set(CHALLENGES.map((c) => c.ask)).size, CHALLENGES.length);
  for (const c of CHALLENGES) {
    isTrue(`${c.id}: snap has words for it`, c.ask.length > 0);
    isTrue(`${c.id}: the model is told literally what to look for`, c.look.includes('the person'));
  }
}

section('no gesture may be a COUNT');
{
  // The first version asked for "exactly two / three / four fingers". Counting
  // fingers is the least reliable thing a vision model does — three against
  // four in a dim gym mirror is near a coin flip — and worse, "two fingers up"
  // and "a peace sign" are the same hand, so a user who did exactly what he
  // was asked could be told he had not. A false rejection here decides whether
  // someone's money comes back, so the rule is shapes only.
  const counting = /\b(one|two|three|four|five|exactly \d|\d fingers)\b/i;
  for (const c of CHALLENGES) {
    isFalse(`${c.id}: snap does not ask for a number`, counting.test(c.ask));
    // 'two fingers in a V' survives as a description of the peace SHAPE; what
    // must not appear is the model being asked to count to decide.
    isFalse(`${c.id}: and the model is not asked to count`, /exactly \w+ fingers/i.test(c.look));
  }
}

section('picking');
{
  // Uniform over the list, and never off the end — Math.random() can return
  // values arbitrarily close to 1.
  eq('the bottom of the range', pickChallenge(() => 0).id, CHALLENGES[0]!.id);
  eq('the very top does not fall off', pickChallenge(() => 0.999999999).id, CHALLENGES.at(-1)!.id);
  const seen = new Set(Array.from({ length: 400 }, () => pickChallenge().id));
  eq('random picks reach every one', seen.size, CHALLENGES.length);
}

section('reading one back');
{
  eq('a known id', challengeById('thumb')?.id, 'thumb');
  eq('an unknown one is nothing, not a crash', challengeById('somersault'), null);
  eq('and so is a commitment made before challenges existed', challengeById(undefined), null);
}

section('the prompt only asks when there is something to ask');
{
  eq('no challenge, no extra question', verifyPrompt(null), VERIFY_PROMPT);
  const asked = verifyPrompt(CHALLENGES[1]!.look);
  isTrue('the base rules survive', asked.startsWith(VERIFY_PROMPT));
  isTrue('and the gesture is named', asked.includes(CHALLENGES[1]!.look));
  isTrue('a guess is explicitly a no', asked.includes('you are guessing, answer false'));
}

section('what a missing gesture is worth');
{
  const three = challengeById('thumb')!;

  eq('with it, the photo pays', readVerdict(good(', "challenge": true'), three).verdict, 'training');
  eq('and with no gesture asked for, it pays too', readVerdict(good()).verdict, 'training');

  // Deliberately `unsure` rather than `not_training`. A model missing three
  // fingers in a blurry mirror shot is not the same accusation as sending a
  // picture of lunch, and the difference is whether Snap roasts them or asks
  // again. Neither one moves money.
  const missing = readVerdict(good(', "challenge": false'), three);
  eq('without it, nothing moves', missing.verdict, 'unsure');
  isTrue('and it says which gesture', missing.rejection!.includes(three.ask));

  // The model not answering the question is the same as answering no: an
  // absent field must never be read as a pass, or the whole check is opt-in
  // for whichever model happens to be up.
  eq('a silent model is not a pass', readVerdict(good(), three).verdict, 'unsure');
  eq('nor is a null', readVerdict(good(', "challenge": null'), three).verdict, 'unsure');

  // Workers AI stringifies its JSON values; that already cost us a good photo
  // once, on the confidence field.
  eq('"true" as a string still passes', readVerdict(good(', "challenge": "true"'), three).verdict, 'training');
  eq('"false" as a string does not', readVerdict(good(', "challenge": "false"'), three).verdict, 'unsure');
}

section('the gesture is the LAST thing checked, never the first');
{
  const three = challengeById('thumb')!;
  // A screenshot with three fingers in it is still a screenshot. Getting the
  // order wrong would let the gesture launder a photo the other rules refused.
  const shot = readVerdict(
    '{"training": true, "person": true, "gym": true, "screenshot": true, "confidence": 0.9, "description": "a workout summary", "challenge": true}',
    three,
  );
  eq('a screenshot stays refused', shot.verdict, 'not_training');
  isFalse('and is not excused by the gesture', shot.rejection!.includes(three.ask));

  const empty = readVerdict(
    '{"training": false, "person": false, "gym": true, "screenshot": false, "confidence": 0.9, "description": "an empty squat rack", "challenge": true}',
    three,
  );
  eq('an empty room too', empty.verdict, 'not_training');
}

section('the stage valve does not quietly switch the gesture off');
{
  const three = challengeById('thumb')!;
  const missed = readVerdict(good(', "challenge": false'), three);
  const hedged = readVerdict(
    '{"training": true, "person": true, "gym": true, "screenshot": false, "confidence": 0.3, "description": "blurry, might be a gym"}',
  );

  eq('strict changes nothing', applyPhotoMode(missed.verdict, 'strict', true).verdict, 'unsure');

  // `lenient` exists to rescue a model that HEDGED — a real gym selfie the
  // Workers AI fallback mangled. The model did not hedge on a missing gesture:
  // it looked, and the hand was not in the frame. Rescuing that would switch
  // off the borrowed-photo check on the setting most likely to be on during a
  // demo, and nobody watching would know.
  eq('lenient still rescues a hedge', applyPhotoMode(hedged.verdict, 'lenient', false).verdict, 'training');
  eq('but not a missing gesture', applyPhotoMode(missed.verdict, 'lenient', true).verdict, 'unsure');
  eq('and says it did not override', applyPhotoMode(missed.verdict, 'lenient', true).overridden, null);

  // Break-glass is break-glass: the vision model is unreachable and the
  // closing beat has to happen anyway.
  eq('always overrides even that', applyPhotoMode(missed.verdict, 'always', true).verdict, 'training');

  // The flag only ever rides on the verdict it explains.
  isTrue('a gesture miss is flagged', missed.challengeMissed === true);
  isFalse('a hedge is not', hedged.challengeMissed === true);
  isFalse('and neither is a pass', readVerdict(good(', "challenge": true'), three).challengeMissed === true);

  // And a model that did not answer the question at all is a HEDGE, not a
  // miss. The Workers AI fallback answers the six keys the schema names and
  // drops anything else, so reading silence as "looked and it wasn't there"
  // would refuse every genuine photo on the fallback path with the one
  // setting that could have saved it switched off. Nothing moves either way
  // under strict; lenient is allowed to rescue it and not the other.
  const silent = readVerdict(good(), three);
  eq('a silent model still does not pay under strict', applyPhotoMode(silent.verdict, 'strict', silent.challengeMissed ?? false).verdict, 'unsure');
  isFalse('a silent model is not a definite miss', silent.challengeMissed === true);
  eq(
    'so lenient can still rescue it',
    applyPhotoMode(silent.verdict, 'lenient', silent.challengeMissed ?? false).verdict,
    'training',
  );
}

done('photo challenges');
