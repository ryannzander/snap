/**
 * Looking at a photo the user texted — and deciding whether it is proof.
 *
 * The photo is the verifier now. It used to be a hype beat that could not
 * touch a stake; releasing money on a picture is a different job, so this
 * module returns a verdict as well as a description, and the verdict is
 * deliberately hard to pass:
 *
 * - a person has to be visibly in the shot, somewhere that reads as training
 * - a screenshot, a photo of a screen, or an empty room is not proof
 * - anything the model is not sure about is `unsure`, which never releases
 *
 * Every photo is also fingerprinted, because the obvious way to beat a photo
 * verifier is to send the same one every day. See `fingerprint`.
 *
 * OpenAI's chat model sees the image itself. Without a key, or if it fails,
 * the Workers AI vision model looks instead. Either way the caller gets a
 * verdict, a sentence it can riff on, and a fingerprint — or an error it can
 * trace.
 */

import type { AiBinding } from './brains/workers-ai';
import { solText } from './money';

const OPENAI_ENDPOINT = 'https://api.openai.com/v1/chat/completions';
const DEFAULT_VISION_MODEL = '@cf/meta/llama-3.2-11b-vision-instruct';

/** Bigger than an iMessage photo ever is; a bound so a bad URL can't stream forever. */
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

/**
 * Asks for JSON because the answer has to be machine-read: money moves on
 * `training`. The description rides along in the same call so the hype beat
 * costs one request, not two.
 *
 * The negative list is longer than the positive one on purpose. Everything on
 * it is something a person would actually try.
 */
export const VERIFY_PROMPT = `you are checking whether a photo proves someone just trained.

reply with ONLY a json object and nothing else:
{"training": true|false, "person": true|false, "gym": true|false, "screenshot": true|false, "confidence": 0.0, "description": "one plain literal sentence"}

"training" is true ONLY when a real person is visibly in the photo AND the setting reads as training: a gym floor, equipment in use, a mirror selfie in gym clothes, obvious sweat, a run or ride in progress.

"training" is false for: a screenshot of anything (an app, a watch face, a workout summary), a photo of a screen or of another photo, an empty gym or room, equipment with nobody in the shot, a meal, a supplement, a pet, a car, a selfie somewhere that is not a training setting.

"screenshot" is true whenever the image looks like a captured screen rather than a camera photo — status bars, app chrome, perfectly flat lighting, ui text.

"confidence" is how sure you are about "training", 0 to 1.

"description" is one literal sentence a friend could riff on. no compliments, no advice, no questions.`;

/**
 * What the photo is worth.
 *
 * `unsure` exists so that "the model could not tell" and "this is not a
 * workout" are different outcomes: one gets a second chance in Snap's voice,
 * the other gets roasted. Neither releases money.
 */
export type PhotoVerdict = 'training' | 'not_training' | 'unsure';

/**
 * How sure the model has to be before a photo is allowed to move money.
 * Below this the answer is `unsure`, not `training` — a coin flip must not
 * release a stake.
 */
export const MIN_VERIFY_CONFIDENCE = 0.6;

export interface VisionEnv {
  OPENAI_API_KEY?: string;
  OPENAI_MODEL?: string;
  LINQ_API_KEY?: string;
  WORKERS_AI_VISION_MODEL?: string;
  AI?: AiBinding;
}

export interface PhotoLook {
  description: string;
  verdict: PhotoVerdict;
  /** Why it was not proof, in words the agent can say. Null when it was. */
  rejection: string | null;
  /** SHA-256 of the image bytes — see `fingerprint`. */
  fingerprint: string;
  /** Which model actually looked, for the trace. */
  via: 'openai' | 'workers-ai';
}

export async function describePhoto(env: VisionEnv, url: string): Promise<PhotoLook> {
  const image = await fetchImage(url, env.LINQ_API_KEY);
  const fingerprint = await fingerprint_(image.bytes);

  let primaryError: unknown = null;
  if (env.OPENAI_API_KEY) {
    try {
      const raw = await describeWithOpenAI(env.OPENAI_API_KEY, env.OPENAI_MODEL || 'gpt-4o', image);
      return { ...readVerdict(raw), fingerprint, via: 'openai' };
    } catch (error) {
      primaryError = error;
    }
  }

  if (env.AI) {
    const raw = await describeWithWorkersAI(env.AI, env.WORKERS_AI_VISION_MODEL || DEFAULT_VISION_MODEL, image);
    return { ...readVerdict(raw), fingerprint, via: 'workers-ai' };
  }

  if (primaryError) throw primaryError;
  throw new Error('no vision model configured — set OPENAI_API_KEY or the AI binding');
}

/**
 * The same picture must not release two stakes.
 *
 * Fingerprinting the bytes catches the obvious attack — send Monday's gym
 * selfie again on Tuesday — and nothing else. A re-crop, a re-save or a
 * screenshot of the same photo hashes differently and gets through, which is
 * worth saying plainly: this raises the cost of cheating, it does not close
 * it. The honest defence is that the watch is still there underneath.
 */
async function fingerprint_(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as unknown as BufferSource);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Turns whatever the model said into a verdict.
 *
 * Models wrap JSON in prose and in markdown fences, so the object is pulled
 * out of the text rather than parsed from the whole of it. A reply that has
 * no readable verdict in it is `unsure` with the text as the description —
 * the conversation still happens, the money does not move.
 *
 * Pure, and exported, because this is the function that decides whether a
 * picture is worth 0.05 SOL.
 */
export function readVerdict(raw: string): {
  description: string;
  verdict: PhotoVerdict;
  rejection: string | null;
} {
  const text = raw.trim();
  const parsed = extractJson(text);

  if (!parsed) {
    return {
      description: stripFences(text) || 'a photo',
      verdict: 'unsure',
      rejection: "couldn't tell what that was",
    };
  }

  const description =
    typeof parsed.description === 'string' && parsed.description.trim()
      ? parsed.description.trim()
      : 'a photo';
  const confidence = asNumber(parsed.confidence);
  const screenshot = asBoolean(parsed.screenshot);
  const training = asBoolean(parsed.training);
  const person = asBoolean(parsed.person);

  // A screenshot is the single most likely fake — a workout summary, someone
  // else's post, a watch face — so it is refused before anything else is
  // weighed, however confident the model is about what is in it.
  if (screenshot === true) {
    return { description, verdict: 'not_training', rejection: "that's a screenshot" };
  }
  if (training !== true) {
    return {
      description,
      verdict: 'not_training',
      rejection: person === false ? "you're not even in it" : "that's not you training",
    };
  }
  if (person === false) {
    return { description, verdict: 'not_training', rejection: "you're not even in it" };
  }
  if (confidence < MIN_VERIFY_CONFIDENCE) {
    return { description, verdict: 'unsure', rejection: "can't tell if that's really you training" };
  }

  return { description, verdict: 'training', rejection: null };
}

/**
 * Models are asked for JSON and answer with whatever they feel like: `0.9` and
 * `"0.9"`, `true` and `"true"`, are all things that come back. The Workers AI
 * fallback is the one that stringifies, which made a good gym photo score 0
 * and land on `unsure` precisely when the primary model was already down.
 *
 * Unreadable stays unreadable: confidence falls to 0, and a boolean the model
 * did not really answer stays null so the tri-state below still tells "said
 * no" apart from "did not say".
 */
function asNumber(value: unknown): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (typeof value === 'string') {
    const parsed = Number(value.trim());
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function asBoolean(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true' || normalized === 'yes' || normalized === '1') return true;
    if (normalized === 'false' || normalized === 'no' || normalized === '0') return false;
  }
  return null;
}

/** The first `{...}` in the text, parsed, or null. */
function extractJson(text: string): Record<string, unknown> | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    const value = JSON.parse(text.slice(start, end + 1));
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function stripFences(text: string): string {
  return text.replace(/^```[a-z]*\n?/i, '').replace(/```$/, '').trim();
}

/** What the trace and the conversation record for a photo. */
export function photoSummary(text: string, count: number): string {
  const label = count > 1 ? `sent ${count} photos` : 'sent a photo';
  return text.trim() ? `📷 ${text.trim()}` : `📷 ${label}`;
}

/**
 * What the backend already did about the photo, by the time the agent speaks.
 *
 * The verdict, the replay check and the payout all happen in code before this
 * turn runs — the model's job is to say what happened in Snap's voice, not to
 * decide it. Passing the outcome in is what stops it congratulating someone
 * on a stake that did not release, or arguing with a refusal it cannot see.
 */
export type PhotoOutcome =
  | { kind: 'released'; text: string; lamports: number }
  | { kind: 'no_stake' }
  | { kind: 'rejected'; reason: string }
  | { kind: 'unsure'; reason: string }
  | { kind: 'replay'; reason: string }
  | { kind: 'unseen' };

/** The instruction the agent runs on a photo turn. */
export function photoInstruction(
  text: string,
  description: string | null,
  outcome: PhotoOutcome,
): string {
  const caption = text.trim() ? ` with the text "${text.trim()}"` : '';
  const seen = description
    ? `what you can see in it: "${description.trim()}"`
    : 'you could not make out what is in it (the photo did not load)';

  const voice =
    'two or three short texts, your voice, lowercase. never sound like a receipt.';

  switch (outcome.kind) {
    case 'released':
      return `the user just sent you a photo${caption}. ${seen}. it checked out — that is them training — so you have ALREADY given them their ${solText(outcome.lamports)} back on "${outcome.text}". the money is home, it is done, do not ask for anything else and do not mention the watch. hype the picture itself: the pump, the sweat, the one detail worth riffing on, and tell them the money is back. ${voice}`;

    case 'no_stake':
      return `the user just sent you a photo${caption}. ${seen}. it is a real training photo, but they had nothing on the line for it, so there was nothing to pay back. hype the picture, then tell them that with money on it that pic would have paid them. ${voice}`;

    case 'rejected':
      return `the user just sent you a photo${caption}. ${seen}. it does NOT count as proof — ${outcome.reason}. their money is still on the line. roast the picture lightly, funny not mean, and say exactly what you want instead: them in the shot, on the gym floor, mid-set or dripping. do not explain rules and do not lecture; make the ask a bit. ${voice}`;

    case 'unsure':
      return `the user just sent you a photo${caption}. ${seen}. you could not tell whether that is really them training, so nothing moved and their money is still on the line. say you cannot tell, ask for one you can — them in it, at the gym — and keep it light. ${voice}`;

    case 'replay':
      return `the user just sent you a photo${caption}. ${seen}. you have seen that EXACT photo before and already counted it once. call it out — they are trying to reuse a pic — funny, not furious. their money is still on the line and you want a fresh one, from today. ${voice}`;

    case 'unseen':
      return `the user just sent you a photo${caption}. ${seen}, so nothing moved and their money is still where it was. say the pic did not come through and ask them to send it again. keep it short and do not make it their fault. ${voice}`;
  }
}

// --- fetching --------------------------------------------------------------

interface FetchedImage {
  bytes: Uint8Array;
  mime: string;
}

/**
 * A Worker subrequest sends no User-Agent, and some hosts (Wikimedia, for
 * one) answer that with a 403. Name ourselves on every photo fetch.
 */
const FETCH_HEADERS = {
  'user-agent': 'snap/1.0 (+https://github.com/ryannzander/snap)',
  accept: 'image/*,*/*;q=0.5',
};

async function fetchImage(url: string, linqApiKey: string | undefined): Promise<FetchedImage> {
  let response = await fetch(url, { headers: FETCH_HEADERS });
  // Linq's media URLs may be behind the partner key; try plain first so a
  // public CDN link never sees the key.
  if ((response.status === 401 || response.status === 403) && linqApiKey) {
    response = await fetch(url, { headers: { ...FETCH_HEADERS, authorization: `Bearer ${linqApiKey}` } });
  }
  if (!response.ok) throw new Error(`photo fetch failed: ${response.status} from ${new URL(url).host}`);

  const declared = Number(response.headers.get('content-length') ?? '0');
  if (declared > MAX_IMAGE_BYTES) throw new Error(`photo too large: ${declared} bytes`);

  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > MAX_IMAGE_BYTES) throw new Error(`photo too large: ${bytes.byteLength} bytes`);
  if (bytes.byteLength === 0) throw new Error('photo fetch returned no bytes');

  const header = (response.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
  const mime = header.startsWith('image/') ? header : sniffMime(bytes);
  return { bytes, mime };
}

/** The handful of formats a phone sends. Anything else is treated as JPEG. */
function sniffMime(bytes: Uint8Array): string {
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return 'image/gif';
  if (bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return 'image/webp';
  if (bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70) return 'image/heic';
  return 'image/jpeg';
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

// --- models ------------------------------------------------------------------

/** Returns whatever the model said, raw. `readVerdict` makes sense of it. */
async function describeWithOpenAI(apiKey: string, model: string, image: FetchedImage): Promise<string> {
  const response = await fetch(OPENAI_ENDPOINT, {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: VERIFY_PROMPT },
            { type: 'image_url', image_url: { url: `data:${image.mime};base64,${toBase64(image.bytes)}`, detail: 'low' } },
          ],
        },
      ],
    }),
    signal: AbortSignal.timeout(25_000),
  });
  if (!response.ok) {
    throw new Error(`openai vision ${response.status}: ${(await response.text()).slice(0, 300)}`);
  }
  const body = (await response.json()) as { choices?: Array<{ message?: { content?: string | null } }> };
  const content = body.choices?.[0]?.message?.content?.trim();
  if (!content) throw new Error('openai vision returned no description');
  return content;
}

async function describeWithWorkersAI(ai: AiBinding, model: string, image: FetchedImage): Promise<string> {
  const raw = (await ai.run(model, {
    prompt: VERIFY_PROMPT,
    image: Array.from(image.bytes),
    max_tokens: 160,
  })) as { response?: string | null; description?: string | null };
  const content = (raw.response ?? raw.description ?? '').trim();
  if (!content) throw new Error('workers-ai vision returned no description');
  return content;
}
