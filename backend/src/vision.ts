/**
 * Looking at a photo the user texted.
 *
 * The photo is a hype beat, not evidence: the model gets a plain description
 * of what is in it and reacts in Snap's voice. Nothing here can touch a
 * stake — release still needs a covering HealthKit workout, and the guards
 * do not know photos exist.
 *
 * OpenAI's chat model sees the image itself. Without a key, or if it fails,
 * the Workers AI vision model describes it instead. Either way the caller
 * gets one or two literal sentences, or an error it can trace.
 */

import type { AiBinding } from './brains/workers-ai';

const OPENAI_ENDPOINT = 'https://api.openai.com/v1/chat/completions';
const DEFAULT_VISION_MODEL = '@cf/meta/llama-3.2-11b-vision-instruct';

/** Bigger than an iMessage photo ever is; a bound so a bad URL can't stream forever. */
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

export const DESCRIBE_PROMPT = `describe this photo in one or two plain sentences for a gym bro deciding how to react to it. say whether it looks like a gym or workout setting, whether the person looks mid-workout or just finished (sweat, gym clothes, equipment, a mirror), and one specific detail worth riffing on. be literal. no compliments, no advice, no questions.`;

export interface VisionEnv {
  OPENAI_API_KEY?: string;
  OPENAI_MODEL?: string;
  LINQ_API_KEY?: string;
  WORKERS_AI_VISION_MODEL?: string;
  AI?: AiBinding;
}

export interface PhotoLook {
  description: string;
  /** Which model actually looked, for the trace. */
  via: 'openai' | 'workers-ai';
}

export async function describePhoto(env: VisionEnv, url: string): Promise<PhotoLook> {
  const image = await fetchImage(url, env.LINQ_API_KEY);

  let primaryError: unknown = null;
  if (env.OPENAI_API_KEY) {
    try {
      const description = await describeWithOpenAI(env.OPENAI_API_KEY, env.OPENAI_MODEL || 'gpt-4o', image);
      return { description, via: 'openai' };
    } catch (error) {
      primaryError = error;
    }
  }

  if (env.AI) {
    const description = await describeWithWorkersAI(env.AI, env.WORKERS_AI_VISION_MODEL || DEFAULT_VISION_MODEL, image);
    return { description, via: 'workers-ai' };
  }

  if (primaryError) throw primaryError;
  throw new Error('no vision model configured — set OPENAI_API_KEY or the AI binding');
}

/** What the trace and the conversation record for a photo. */
export function photoSummary(text: string, count: number): string {
  const label = count > 1 ? `sent ${count} photos` : 'sent a photo';
  return text.trim() ? `📷 ${text.trim()}` : `📷 ${label}`;
}

/** The instruction the agent runs on a photo turn. */
export function photoInstruction(text: string, description: string | null): string {
  const caption = text.trim() ? ` with the text "${text.trim()}"` : '';
  const seen = description
    ? `what you can see in it: "${description.trim()}"`
    : 'you could not make out what is in it (the photo did not load)';
  return `the user just sent you a photo${caption}. ${seen}. react to the picture itself, in your voice — hype the pump, roast the empty rack, notice the one detail. two or three short texts. this is a moment, not a checkpoint: do NOT bring up proof, the watch, whether it counts, or their money, unless they ask you directly whether the photo counts. if they look like they are at the gym right now and they have a plan on the line, tell them to finish it and that you are watching.`;
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
            { type: 'text', text: DESCRIBE_PROMPT },
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
    prompt: DESCRIBE_PROMPT,
    image: Array.from(image.bytes),
    max_tokens: 160,
  })) as { response?: string | null; description?: string | null };
  const content = (raw.response ?? raw.description ?? '').trim();
  if (!content) throw new Error('workers-ai vision returned no description');
  return content;
}
