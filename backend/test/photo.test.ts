/**
 * Photos in the thread.
 *
 * A photo is a hype beat: the adapter has to find it in whatever shape Linq
 * sends, the trace has to record that it happened, and the instruction the
 * agent gets has to say, in so many words, that a photo does not count.
 */
import { imageUrlsFromParts, normalizeInbound } from '../src/channels/linq';
import {
  MIN_VERIFY_CONFIDENCE,
  applyPhotoMode,
  photoInstruction,
  photoSummary,
  readVerdict,
} from '../src/vision';
import { section, eq, isTrue, isFalse, done } from './harness';

const envelope = (parts: unknown[]) => ({
  event_type: 'message.received',
  event_id: 'evt_1',
  data: { direction: 'inbound', sender_handle: { handle: '+15555550123' }, parts },
});

section('finding the photo in a message');
eq('a plain image part with a url value',
  imageUrlsFromParts([{ type: 'image', value: 'https://cdn.example/a.jpg' }]),
  ['https://cdn.example/a.jpg']);
eq('an attachment whose value is an object',
  imageUrlsFromParts([{ type: 'attachment', value: { url: 'https://cdn.example/b.heic', mime_type: 'image/heic' } }]),
  ['https://cdn.example/b.heic']);
eq('a media part with media_url at the top level',
  imageUrlsFromParts([{ type: 'media', media_url: 'https://cdn.example/c.png', content_type: 'image/png' }]),
  ['https://cdn.example/c.png']);
eq('a pdf attachment is not a photo',
  imageUrlsFromParts([{ type: 'attachment', value: { url: 'https://cdn.example/d.pdf', mime_type: 'application/pdf' } }]),
  []);
eq('text parts are ignored', imageUrlsFromParts([{ type: 'text', value: 'https://not-a-photo.example' }]), []);
eq('a non-http value is ignored', imageUrlsFromParts([{ type: 'image', value: 'data:image/png;base64,AAAA' }]), []);
eq('garbage is ignored', imageUrlsFromParts('nope'), []);

section('normalizing an inbound message');
{
  const textOnly = normalizeInbound(envelope([{ type: 'text', value: 'gym at 7' }]));
  eq('text only', textOnly && { text: textOnly.text, imageUrls: textOnly.imageUrls }, { text: 'gym at 7', imageUrls: [] });

  const photoOnly = normalizeInbound(envelope([{ type: 'image', value: 'https://cdn.example/a.jpg' }]));
  eq('photo only — empty text, one url',
    photoOnly && { text: photoOnly.text, imageUrls: photoOnly.imageUrls },
    { text: '', imageUrls: ['https://cdn.example/a.jpg'] });

  const both = normalizeInbound(envelope([
    { type: 'text', value: 'look' },
    { type: 'image', value: 'https://cdn.example/a.jpg' },
  ]));
  eq('caption and photo', both && { text: both.text, imageUrls: both.imageUrls },
    { text: 'look', imageUrls: ['https://cdn.example/a.jpg'] });

  eq('nothing usable is still dropped', normalizeInbound(envelope([{ type: 'sticker', value: 'x' }])), null);

  const noId = normalizeInbound({
    event_type: 'message.received',
    data: { direction: 'inbound', sender_handle: { handle: '+1' }, parts: [{ type: 'image', value: 'https://cdn.example/a.jpg' }] },
  });
  eq('the dedupe id falls back to the photo url when there is no text', noId?.eventId, '+1:https://cdn.example/a.jpg');
}

section('what the trace and the agent see');
eq('a bare photo', photoSummary('', 1), '📷 sent a photo');
eq('two photos', photoSummary('', 2), '📷 sent 2 photos');
eq('a captioned photo keeps the caption', photoSummary('pump check', 1), '📷 pump check');

section('reading the verdict out of whatever the model said');
{
  const good = readVerdict(
    '{"training":true,"person":true,"gym":true,"screenshot":false,"confidence":0.9,"description":"a sweaty guy at a squat rack"}',
  );
  eq('a clear gym photo is proof', good.verdict, 'training');
  eq('and carries the sentence to riff on', good.description, 'a sweaty guy at a squat rack');
  eq('with nothing to explain away', good.rejection, null);

  // Models wrap JSON in fences and in chat, constantly.
  const fenced = readVerdict('```json\n{"training":true,"person":true,"confidence":0.8,"description":"mirror selfie mid-set"}\n```');
  eq('fenced json still reads', fenced.verdict, 'training');
  const chatty = readVerdict('sure! here is the result:\n{"training":true,"person":true,"confidence":0.95,"description":"on a treadmill"}\nhope that helps');
  eq('json buried in prose still reads', chatty.verdict, 'training');
}

section('the things people will actually try');
{
  // The most likely fake by a mile: a screenshot of a workout summary, a
  // watch face, or somebody else's post.
  const shot = readVerdict('{"training":true,"person":true,"screenshot":true,"confidence":0.99,"description":"a screenshot of a workout app"}');
  eq('a screenshot is never proof, however confident', shot.verdict, 'not_training');
  isTrue('and says why in words snap can use', shot.rejection!.includes('screenshot'));

  const empty = readVerdict('{"training":false,"person":false,"gym":true,"screenshot":false,"confidence":0.9,"description":"an empty squat rack"}');
  eq('an empty gym is not a workout', empty.verdict, 'not_training');
  isTrue('and the reason names the missing person', empty.rejection!.includes('not even in it'));

  const dinner = readVerdict('{"training":false,"person":true,"gym":false,"screenshot":false,"confidence":0.9,"description":"a plate of chicken and rice"}');
  eq('meal prep is not a session', dinner.verdict, 'not_training');

  // A coin flip must never release money.
  const maybe = readVerdict('{"training":true,"person":true,"screenshot":false,"confidence":0.3,"description":"blurry, might be a gym"}');
  eq('low confidence is unsure, not proof', maybe.verdict, 'unsure');
  isTrue('confidence exactly at the floor passes',
    readVerdict(`{"training":true,"person":true,"confidence":${MIN_VERIFY_CONFIDENCE},"description":"x"}`).verdict === 'training');

  const nonsense = readVerdict('i think that might be a gym? hard to say');
  eq('an unparseable answer is unsure', nonsense.verdict, 'unsure');
  eq('and keeps the text as the description', nonsense.description, 'i think that might be a gym? hard to say');

  eq('an empty answer is still unsure', readVerdict('').verdict, 'unsure');
  eq('a json array is not a verdict', readVerdict('[1,2,3]').verdict, 'unsure');
  // Missing keys must not read as a pass.
  eq('no training key is not a pass', readVerdict('{"description":"a gym"}').verdict, 'not_training');

  // Asked for JSON, models answer with strings. The Workers AI fallback is the
  // one that does it, so this fires exactly when the primary model is down —
  // a good gym photo used to score 0 and land on unsure.
  const stringy = readVerdict('{"training":"true","person":"true","screenshot":"false","confidence":"0.9","description":"a person mid-squat"}');
  eq('a stringified verdict still reads as proof', stringy.verdict, 'training');

  eq(
    'a stringified screenshot is still refused',
    readVerdict('{"training":"true","person":"true","screenshot":"true","confidence":"0.99","description":"a workout summary"}').verdict,
    'not_training',
  );
  eq(
    'a stringified low confidence is still unsure',
    readVerdict('{"training":"true","person":"true","confidence":"0.3","description":"blurry"}').verdict,
    'unsure',
  );
  eq(
    'a stringified negative is still a no',
    readVerdict('{"training":"false","person":"true","confidence":"0.9","description":"a plate of food"}').verdict,
    'not_training',
  );
  // Coercion must not invent a pass out of something unreadable.
  eq(
    'an unreadable confidence is unsure, not proof',
    readVerdict('{"training":true,"person":true,"confidence":"very high","description":"a gym"}').verdict,
    'unsure',
  );
  eq(
    'an unreadable training flag is not a pass',
    readVerdict('{"training":"maybe","person":true,"confidence":0.9,"description":"a gym"}').verdict,
    'not_training',
  );
}

section('what snap is told to say about a photo');
{
  const released = photoInstruction('done', 'a person at a squat rack, sweaty', {
    kind: 'released',
    text: 'gym at 7',
    lamports: 50_000_000,
  });
  isTrue('the instruction carries the description', released.includes('squat rack'));
  isTrue('the instruction carries the caption', released.includes('"done"'));
  isTrue('it names the amount already returned', released.includes('0.05 SOL'));
  isTrue('and names what it closed', released.includes('gym at 7'));
  // The money is already home. A turn that asks for anything else after that
  // reads as Snap not knowing what his own backend did.
  isTrue('it tells him not to ask for more', released.includes('do not ask for anything else'));
  isTrue('and to leave the watch out of it', released.includes('do not mention the watch'));

  const rejected = photoInstruction('', 'a screenshot of a workout app', {
    kind: 'rejected',
    reason: "that's a screenshot",
  });
  isTrue('a refusal carries the reason', rejected.includes("that's a screenshot"));
  isTrue('says the money is still on the line', rejected.includes('still on the line'));
  isTrue('and asks for the shot he actually wants', rejected.includes('them in the shot'));
  isFalse('without turning into a rulebook', rejected.includes('lecture them'));

  const unsure = photoInstruction('', 'blurry', { kind: 'unsure', reason: "can't tell" });
  isTrue('an unsure photo asks for a clearer one', unsure.includes('could not tell'));
  isTrue('and nothing moved', unsure.includes('still on the line'));

  const replay = photoInstruction('', 'the same gym selfie', { kind: 'replay', reason: 'seen it' });
  isTrue('a reused photo is called out', replay.includes('EXACT photo'));
  isTrue('and a fresh one is asked for', replay.includes('fresh one'));

  const noStake = photoInstruction('', 'a person mid-set', { kind: 'no_stake' });
  isTrue('a real photo with no stake still gets hyped', noStake.includes('hype'));
  isTrue('and points out what it would have been worth', noStake.includes('would have paid'));

  const blind = photoInstruction('', null, { kind: 'unseen' });
  isTrue('a failed look is said plainly', blind.includes('could not make out'));
  isTrue('and asks for a resend', blind.includes('send it again'));
  isFalse('never blaming them for it', blind.includes('their fault') && !blind.includes('do not make it their fault'));
}

section('the stage valve — the one switch that can turn "not proof" into money');
{
  // Strict is ship behaviour and the default. Nothing is rescued.
  eq('strict leaves a pass alone', applyPhotoMode('training', 'strict'), { verdict: 'training', overridden: null });
  eq('strict leaves unsure alone', applyPhotoMode('unsure', 'strict'), { verdict: 'unsure', overridden: null });
  eq('strict leaves a refusal alone', applyPhotoMode('not_training', 'strict'), { verdict: 'not_training', overridden: null });

  // Lenient exists for exactly one failure: a real gym selfie the model
  // hedged on, or one the Workers AI fallback answered with unparseable JSON.
  eq('lenient rescues unsure', applyPhotoMode('unsure', 'lenient'), { verdict: 'training', overridden: 'lenient' });
  // And nothing else. The screenshot roast is a demo beat worth keeping, and
  // "not training" is a judgement the model actually made.
  eq('lenient does NOT rescue a refusal', applyPhotoMode('not_training', 'lenient'), {
    verdict: 'not_training',
    overridden: null,
  });
  eq('lenient does not relabel a pass', applyPhotoMode('training', 'lenient'), { verdict: 'training', overridden: null });

  // Break-glass: the vision model is down and the closing beat has to happen.
  eq('always rescues a refusal', applyPhotoMode('not_training', 'always'), { verdict: 'training', overridden: 'always' });
  eq('always rescues unsure', applyPhotoMode('unsure', 'always'), { verdict: 'training', overridden: 'always' });
  // A photo that passed on its own is never marked as overridden — the trace
  // would otherwise claim a valve was used when it was not.
  eq('always does not mark an honest pass', applyPhotoMode('training', 'always'), { verdict: 'training', overridden: null });
}

done('photos');
