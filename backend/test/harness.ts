/**
 * A test harness small enough to read in one sitting.
 *
 * The backend runs on Workers, so there is no jest/vitest here and no need
 * for one: every module worth testing is a pure function, and `npm test`
 * compiles them out and runs them on plain Node.
 *
 * Output is meant to be read during a demo rehearsal, not parsed by CI —
 * a failure prints what was expected next to what happened.
 */

// The suites run on Node, which the Worker's type surface knows nothing
// about. One declaration is cheaper than pulling @types/node into a project
// whose only real target is the edge runtime.
declare const process: { exit(code: number): never };

let failures = 0;
let checks = 0;

export function section(name: string): void {
  console.log(`\n  ${name}`);
}

function pass(label: string, note?: string): void {
  checks++;
  console.log(`    ✓ ${label}${note ? `  ${note}` : ''}`);
}

function fail(label: string, detail: string): void {
  checks++;
  failures++;
  console.log(`    ✗ ${label}\n        ${detail}`);
}

export function eq<T>(label: string, got: T, want: T): void {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g === w) pass(label);
  else fail(label, `got ${g}, wanted ${w}`);
}

export function isTrue(label: string, got: boolean): void {
  if (got) pass(label);
  else fail(label, 'expected true, got false');
}

export function isFalse(label: string, got: boolean): void {
  if (!got) pass(label);
  else fail(label, 'expected false, got true');
}

type Guarded = { ok: true; value: unknown } | { ok: false; reason: string };

/** The guard allowed it, as it should have. */
export function allows(label: string, result: Guarded): void {
  if (result.ok) pass(label);
  else fail(label, `denied: "${result.reason}"`);
}

/**
 * The guard refused, as it should have. The reason is printed on success
 * because a guard that refuses for the wrong reason is still a bug, and the
 * only way to notice is to read them.
 */
export function denies(label: string, result: Guarded): void {
  if (!result.ok) pass(label, `→ "${result.reason}"`);
  else fail(label, 'was ALLOWED');
}

export function throws(label: string, fn: () => unknown): void {
  try {
    fn();
    fail(label, 'expected a throw, returned normally');
  } catch {
    pass(label);
  }
}

export function done(name: string): never {
  const line = failures
    ? `\n  ${name}: ${failures} FAILED of ${checks}\n`
    : `\n  ${name}: ${checks} checks pass\n`;
  console.log(line);
  process.exit(failures ? 1 : 0);
}
