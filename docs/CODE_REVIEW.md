# Code review — full pass over the repository

Date: 2026-09-19. Scope: every file in this repository (iOS app, tests, project config, docs, brand assets), plus an attempt to verify the deployed backend, its Solana staking, and its AI agent.

Four reviewers worked in parallel, each reading the whole of their area rather than sampling: core Swift code, UI/UX and view code, tests and project configuration, and live backend verification. Their findings were cross-checked against the source before anything was changed. Fixes that were confirmed, small, and safe were applied in the same change as this document; everything else is listed here with a location so it can be picked up deliberately.

## What this repository is

An iOS SwiftUI app with three jobs: onboarding, HealthKit → backend workout sync, and the live "Snap's brain" agent-trace screen. It has no chat UI by design.

**The backend is not in this repository.** `README.md` and `docs/BACKEND_TASKS.md` describe a `backend/` directory holding the Cloudflare Worker, the OpenAI function-calling agent, the Telegram/Linq channel adapters and the Solana devnet escrow. That directory has never been committed here (checked across the full git history). The app talks to it at `https://snap.snap-backend.workers.dev`, set in `ios/Snap/Config.swift`. So there is no blockchain code, no Anchor program, no agent loop and no wallet key anywhere in this repo to review; the only signature-shaped string in the tree is the mock's deliberately fake one.

## Verdict

| Area | State |
|---|---|
| iOS code quality | Unusually disciplined for a hackathon build. Clean layering (`SnapAPI` protocol, `LiveAPI`, `MockAPI` actor, `@Observable` `AppModel`, `WorkoutSync`), correct ISO 8601 handling both ways, a genuinely race-free staggered trace drain, and a provenance story (`wasUserEntered`, the HKDIAG test) that shows real thought about the one bit the demo turns on. |
| iOS correctness | Two HIGH findings on the HealthKit → network edge (no retry after a failed POST; observer registered too late for background launches), a handful of MEDIUMs (dropped observer fires, strict enums that could blank `/state`, mock singleton never resets). All fixed in this change. |
| UI/UX | Information architecture matches the spec beat for beat and the decision rows land exactly as designed. The biggest risks were legibility on a mirrored screen (white cards on off-white at 1.11:1, secondary type at 3.2:1) and a silent dead end if `/onboard` fails. Fixed. |
| Tests | 32 unit tests, all compile against the source by hand-check; a few were tautological or vacuous. Coverage gaps remain around `LiveAPI`, `AppModel` and the anchor-on-failure path (no injection seams). Seven tests added, one vacuous test fixed. |
| Project config | The committed `project.pbxproj` carried three settings `project.yml` didn't (team id, app-icon name, a legacy signing identity), so regenerating with XcodeGen would have dropped signing and the icon. The shared scheme ran the HealthKit UI test by default despite its own docstring. An unused `processing` background mode was an App Review flag. Fixed. |
| Docs | Materially stale: `backend/` claims, an "not written yet" table listing files that exist, and `API.md` missing four things the app now depends on (error envelope, `since` exclusivity, page size, the slashed-stake split). Updated. |
| Backend / Solana / agent | **Could not be verified from this environment.** Every outbound HTTPS request is refused by the session's egress policy (403 on the Worker, on `api.devnet.solana.com`, and on control hosts). No probe reached the backend and no devnet RPC call succeeded. See the section below for what the repo itself says and a ready-to-run probe script. |

## Backend, Solana staking and the agent: what could and could not be checked

**Nothing live was verified.** The probes were written and attempted; the network refused all of them. The scratch probe script (`probe.sh`, described at the end of this section) runs the whole check in about a minute from any machine with internet access.

What the repository establishes on its own:

- **The app's view of the agent is `GET /trace`.** The ten `kind` values in `API.md` are decoded exactly, an unknown kind degrades to a plain row rather than failing, and (as of this change) `stay_quiet` and `data.reasoning` are decoded too. If the backend emits those, the "agent decided not to text" beat and the reasoning under each decision will show.
- **The app's view of Solana is `stake.txSig`.** The explorer link is only drawn when the backend returned a signature, which is the correct honesty posture. On the mock the link is now labelled "mock · no chain" so it cannot be mistaken for a real transaction on stage.
- **The commit history is the only evidence about the chain.** Commit `2bbb274` (Sat 13:25) says "the devnet RPC still 403s Workers", which is a known problem with the public devnet endpoint and Cloudflare Workers. Commit `22643d6` (Sat 14:46) describes an atomic half-refund/half-forfeit slash transaction, which implies it was solved, but only Swift files changed in that commit. Commit `9e603c7` (Sat 11:37) says no messaging channel was wired on the backend at that time, which would mean `state.linked` never flips and the app never leaves the link screen. Whether either was fixed later is exactly what could not be checked.
- **Design fallback.** `DESIGN.md` pre-authorises a backend-held wallet doing plain `SystemProgram` transfers if the Anchor escrow wasn't on devnet by Saturday evening. That is acceptable, but it is the first thing a Solana judge will ask about, and the answer is not in this repo.

**Risks for the demo, ranked (all unverifiable from here):**

1. `state.linked` never flips → the app never reaches the brain screen. Check first.
2. No real `txSig` → the Solana claim is unsupported on screen. Know which wallet model shipped (Anchor PDA vs plain transfers) and have one real devnet signature ready.
3. The app promises "half goes to charity" on the deal page; `DESIGN.md` said treasury. The backend's actual destination wallet decides which copy is true. Make them agree before the pitch.
4. `POST /workouts` with an omitted `activeKcal` (every simulated workout) — the app omits absent optionals rather than sending `null`. If the Worker's schema is `.nullable()` rather than `.nullish()`, the no-Watch fallback 400s. One probe line settles it; `API.md` now documents the app's behaviour.
5. `WorkoutQualifyingTests` pins the accepted workout types and the 30-minute floor against a hand copy of a backend file that isn't here. It can go green while the backend drifts.

**To run the verification** (from any machine with network access): the probe script created during this review lives outside the repo; the equivalent is three `curl` calls — `POST /onboard` with a clearly named test user, `GET /state` and `GET /trace` with the returned bearer token, and `POST /workouts` twice with the same `hkUuid` to check idempotency — then, for any `txSig` in the response, `getTransaction` against `https://api.devnet.solana.com` to see whether it is an Anchor program call or a plain transfer, and whether it succeeded.

## What changed in this pass

### iOS code

| Finding | Severity | Fix |
|---|---|---|
| A failed workout POST was never retried: HealthKit does not re-fire an acknowledged delivery, and nothing else called `drain()`. "Kill the network mid-sync and restore it" (an acceptance item in `IOS_SPEC.md`) required a relaunch. | HIGH | `WorkoutSync.post` retries twice with short back-off; `AppModel` re-drains on every return to the foreground. |
| The HealthKit observer was registered from the root view's `.task`, which a background launch for a locked-phone delivery may never reach. | HIGH (plausible; needs a device test) | `SnapApp.init` calls `startWorkoutSyncIfOnboarded()` before any view exists. `WorkoutSync.start()` was already idempotent. |
| An observer fire landing during an in-flight drain was dropped but still acknowledged. | MEDIUM | Drain coalesces: a fire during a drain sets `needsRedrain` and the loop goes round again. |
| Every cold launch of a linked phone flashed the link screen until the first `/state` landed. | MEDIUM | `linked` is persisted and the phase starts from it. |
| `MockAPI.shared` never reset, so a second demo run-through opened on a finished loop; and `linked` was measured from process launch, so the mock skipped the link screen entirely. | MEDIUM | `MockAPI.reset()` (called by `AppModel.reset()` and by `onboard`); `linked` is measured from the onboard call. |
| Unknown `commitment.status` / `stake.status` values failed the entire `/state` decode. | MEDIUM | Both enums gain an `unknown` fallback like `TraceEvent.Kind`; the card draws nothing for it. |
| One malformed trace event failed the entire feed. | MEDIUM | `/trace` decodes per element; bad events are dropped. |
| A scheme-less URL pasted into the debug panel silently ran the mock while the panel said "live". | MEDIUM | `Config.serverURL(from:)` requires `http(s)` and a host; the panel names the mock for anything else and reads the field, not the saved value. |
| Keychain writes discarded their status and used delete-then-add; a failed write meant a silent re-onboard as a new user on the next launch. | MEDIUM | `SecItemUpdate` then `SecItemAdd`, `ThisDeviceOnly` accessibility, and the status surfaces in the debug panel. |
| Every `/state` poll republished an identical state, invalidating the whole screen twice a second. | HIGH (UI) | `SnapState` and friends are `Equatable`; the model only assigns on change. The feed and the countdown are their own views so their churn doesn't re-run the header and card. |
| Polling cancellation (background, reconnect) landed in the debug panel as an error. | LOW | Cancellation is ignored; results are not applied after cancellation. |
| An event with `id == 0` would be dropped forever. | LOW | Cursor floor is `Int.min` before the first page. |
| A seeded backlog drained at 350 ms per event (fifty events ≈ 17 s). | LOW | Backlogs above eight pending events drain at 60 ms; the tail keeps the 350 ms "thinking" pace. |
| `stop()` never disabled background delivery, so iOS kept launching the app after a reset with nobody to acknowledge. | LOW | Disabled in `stop()`. |
| The anchored query used a 7-day predicate only on the first run, mixing predicates across one anchor lineage. | LOW | The 7-day bound applies to every drain. |
| Decode failures were reported as "HTTP 200" whatever the real status. | LOW | The real status is carried. |
| Trace timestamps used the device locale. | LOW | POSIX locale, Gregorian calendar. |
| `data.reasoning` and `stay_quiet` from `API.md`/`DESIGN.md` were not modelled. | LOW | Decoded; reasoning shows under the decision row. |

### UI/UX

| Finding | Severity | Fix |
|---|---|---|
| A failed `/onboard` was a silent dead end: the button flipped to "one sec…" and back, and the debug panel was unreachable before a token existed. | CRITICAL | One in-voice red line under the button after a failed attempt; long-press the progress dashes to open the debug panel. A local `submitting` flag also stops a double tap during the HealthKit sheet creating two users. |
| Cards were `#FFFFFF` on `#F3F3F1` (1.11:1) with no border or shadow; secondary type was 3.2:1; unfilled dots and dashes 1.16:1. Illegible mirrored over QuickTime from two metres, which is the last item on the "Done means" list. | HIGH | `inkDim` → 4.6:1, `hairline` visible, new `surfaceAlt` for received bubbles, unselected chips and the secondary pill; trace text one step larger; goal dots 12 pt. |
| Every onboarding page change squashed the content to half height: `.frame(maxHeight: .infinity)` sat inside the `.id(page)` subtree, so outgoing and incoming pages shared the VStack. | HIGH | Frame moved outside the identified subtree. |
| Tapping the link code replaced it with "copied" forever. | HIGH | Reverts after 1.6 s. |
| "reset app" was a one-tap session wipe two rows below the on-stage fallback button. | HIGH | Confirmation dialog. |
| The link screen was a dead end with no buttons when `/onboard` returned no contact, and the iMessage/Telegram visibility and fill conditions disagreed on an empty string. | HIGH | One computed source of truth per channel; a red line names the problem when neither exists. |
| The feed opened at the top and yanked the reader back to the bottom on every event. | MEDIUM | `.defaultScrollAnchor(.bottom)`; the full-height gradient mask (a compositing cost and the app's only gradient) became an 18 pt overlay. |
| Nothing said HealthKit was never authorised, or that the feed was empty. | MEDIUM | A red line when authorisation is undetermined; a dim in-voice empty state. |
| The name field's Done key did nothing, focus was requested mid-transition. | MEDIUM | `onSubmit` advances; focus after 350 ms. |
| Goal chips were 30–40 pt wide and read as a meter. | MEDIUM | Tighter spacing, visible unselected fill, and the number restated large underneath. |
| The secondary pill was a stroked border against a "no borders" rule. | MEDIUM | Pale fill. |
| No accessibility labels on the primary flows. | MEDIUM | Labels on the header, dots, countdown, code card, goal chips, bubbles and decisions. |

### Tests and project

- Seven tests added: per-element lossy trace decoding, `data.reasoning` and `stay_quiet`, unknown status fallback, state equality, decode-failure status, `Config.serverURL`, mock reset, and mock `linked` timing.
- `testTraceSinceIsExclusive` was vacuous (the second page was always empty, so `allSatisfy` passed on nothing). It now time-warps first.
- `ErrorAndMockTests` imports HealthKit explicitly rather than relying on transitive lookup.
- `project.yml` now carries `DEVELOPMENT_TEAM` and `ASSETCATALOG_COMPILER_APPICON_NAME`, so `xcodegen` no longer drops signing and the icon. `UIBackgroundModes: processing` is removed (HealthKit background delivery is gated by the entitlement, which is present; an unused mode is an App Review rejection). The shared scheme skips `SnapUITests` by default, matching that test's own instructions.
- `.gitignore` gains the Apple signing files and Solana's default `id.json`, and a trailing newline.

### Docs

- `API.md` now documents the error envelope, `since` exclusivity, the 200-event page size, positive integer ids, `stay_quiet`, `data.reasoning`, optional-field omission, timestamp forms, the `slashed` split fields, and commitment ordering.
- `README.md` says where the backend lives. `DESIGN.md`'s slash row records the half/half model and the open treasury-vs-charity question. `IOS_SPEC.md`'s "not written yet" table is replaced with what exists, the launch hooks, and the test instructions.

## Not changed, and why

- **`Config.defaultBaseURL`** still points at the deployed Worker. The UI reviewer suggested shipping it empty so a fresh install runs the mock; the team pointed the app at the live Worker on purpose in `da343ca`, and the debug panel can clear it. The failure is now visible instead.
- **`WorkoutDTO` optionals** are still omitted rather than sent as `null`. Either could be what the Worker's schema wants; changing it blind risks breaking the path that `da343ca` reports as tested. It is documented in `API.md` and is probe item 4 above.
- **"half goes to charity"** copy is untouched. It is a product fact only the backend author can confirm.
- **`HKObserverQuery` on a background launch** is fixed by construction (registered in `SnapApp.init`), but that claim needs a device: end a Watch workout with the app force-quit and confirm the POST lands.
- **`TraceRow` re-animates when scrolled back into view** (its `@State shown` resets in the `LazyVStack`). Cosmetic; left.
- **No `LiveAPI` or `AppModel` unit tests.** Both need an injection seam (`URLProtocol` stub, `init(api:)`) that is a bigger change than this pass.
- **`SWIFT_VERSION: 5.0`** means none of the concurrency reasoning is compiler-checked; the `@Sendable` HealthKit handlers capturing a `@MainActor` class and the non-`Sendable` formatter statics are Swift 6 errors. Worth `SWIFT_STRICT_CONCURRENCY: targeted` after the demo.
- **A full `/trace` page with one malformed event** now counts 199 after the bad one is dropped, so the "fetch the next page immediately" fast path doesn't trigger; the regular one-second poll picks the rest up. Not worth threading a raw count through the API protocol.
- **`Keychain.lastWriteError`** is a mutable static; fine in Swift 5 mode, a strict-concurrency error later. Make `Keychain` `@MainActor` when the project moves to Swift 6.
- **The observer's completion handler** now waits on up to two short retries (3 s of sleep) before acknowledging a background delivery. That is inside iOS's budget for a HealthKit wake, but if deliveries ever stop arriving, this is the first thing to shorten.
- **The debug key** lives in UserDefaults (as the spec asked). It authorises `/debug/*` for any user; the Worker should scope it to the bearer token's own user.

## What was done well (worth keeping)

- The `ISO8601` seam: fractional-first parsing, plain encoding, pinned by a test with the exact epoch. This is the single most common Workers↔Swift bug and it is closed.
- `TimewarpBody`'s hand-written encoder so `{"now": null}` reaches the wire, with the reason in the comment.
- The trace drain's generation counter: a cancelled drain cannot clear the handle of the one that replaced it.
- The 401 latch, and the decision not to auto-wipe the session mid-demo, with the reasoning written down.
- The HKDIAG path: proving on a real HealthKit store that a builder-made workout is not flagged hand-entered, including the detail that "Allow" stays disabled until a category is switched on.
- Lime is used as a fill in all eight places and never as type; the countdown chose ink over the letter of the spec to keep that rule.
- Verdict states (`done.` / `missed.`) instead of a clock that keeps ticking after the decision.

## How this was verified

- No Swift toolchain exists on the review machine, so nothing was compiled. Every changed file was parsed with `tree-sitter-swift`; the only reported nodes are the known grammar limitation on declaration-level `#if DEBUG` inside a type body (present before this change). Every symbol used by the tests was checked against the source by hand, and a second reviewer read the full diff adversarially for compile errors before it was committed.
- **Before merging, run on a Mac:** `cd ios && xcodegen && xcodebuild test -scheme Snap -destination 'platform=iOS Simulator,name=iPhone 17 Pro'`, then the UI test with `-only-testing:SnapUITests`, then the two device checks above (background-launch workout delivery, and a workout ended while the network is down).
