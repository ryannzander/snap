/**
 * Photos in the thread.
 *
 * A photo is a hype beat: the adapter has to find it in whatever shape Linq
 * sends, the trace has to record that it happened, and the instruction the
 * agent gets has to say, in so many words, that a photo does not count.
 */
import { imageUrlsFromParts, normalizeInbound } from '../src/channels/linq';
import { photoInstruction, photoSummary } from '../src/vision';
import { section, eq, isTrue, done } from './harness';

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
{
  const seen = photoInstruction('done', 'a person in gym clothes at a squat rack, sweaty');
  isTrue('the instruction carries the description', seen.includes('squat rack'));
  isTrue('the instruction carries the caption', seen.includes('"done"'));
  isTrue('the instruction asks for a reaction to the picture', seen.includes('react to the picture'));
  isTrue('and tells him not to lecture about proof or the watch', seen.includes('do NOT bring up proof'));
  isTrue('unless asked outright', seen.includes('unless they ask you directly'));
  isTrue('he never claims he cannot end or count a workout', seen.includes("never say you can't end"));
  isTrue('an unclear photo gets an ask for a gym-floor selfie', seen.includes('selfie from the gym floor'));

  const blind = photoInstruction('', null);
  isTrue('a failed look is said plainly', blind.includes('could not make out'));
  isTrue('and still keeps the lecture out', blind.includes('do NOT bring up proof'));
}

done('photos');
