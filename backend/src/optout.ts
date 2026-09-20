/**
 * Opt-out keywords. Linq rejects sends to a keyword-opted-out recipient with
 * 403/2024, so this has to be honoured on our side too — and a conversational
 * "stop messaging me" never reaches their filter, which makes it our job.
 *
 * Exact and case-sensitive per the Linq docs, except OPT OUT which matches in
 * any casing, spaced or hyphenated.
 */
const EXACT = ['STOP', 'UNSUBSCRIBE', 'OPTOUT', 'CANCEL', 'END', 'QUIT'];

export function isOptOut(text: string): boolean {
  const trimmed = text.trim();
  if (EXACT.includes(trimmed)) return true;
  return /^opt[\s-]?out$/i.test(trimmed);
}
