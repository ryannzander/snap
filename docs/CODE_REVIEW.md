# Code review — full pass over the app and the backend

Date: 2026-09-19. Scope: every file in this repository (iOS app, tests, project config, docs, brand assets) **and** the backend on PR 2 (`backend/`: the Cloudflare Worker, Durable Objects, the agent, alarms, the Solana wallet layer), which is what the app talks to at `https://snap.snap-backend.workers.dev`.

Seven reviewers worked in parallel, each reading the whole of their area rather than sampling: iOS core code, iOS UI/UX, iOS tests and project config, a compile-by-eye pass over the iOS diff, and three on the backend (Solana and money, the agent and alarms, the HTTP contract against the app). Every finding below was cross-checked against the source before it was recorded, and the backend findings were also checked against the 24-comment discussion on PR 2, which records what was verified live. App-side fixes that were confirmed, small and safe were applied in this change. Backend findings are for PR 2's author; none of that code was changed here.

## Verdict

| Area | State |
|---|---|
| iOS code | Unusually disciplined for a hackathon build. Two HIGH findings on the HealthKit → network edge and a handful of MEDIUMs, all fixed here. |
| iOS UI/UX | Matches the spec beat for beat. Legibility on a mirrored screen and a silent dead end on a failed onboard were the real risks. Fixed. |
| iOS tests and config | 32 tests compile by hand-check; a few were tautological. Regenerating the project would have dropped signing and the app icon. Fixed; seven tests added. |
| Backend: HTTP layer | Careful. Uniform error envelope, constant-time token compare, correct and tested webhook signature verification, redaction written before the secret existed. One CRITICAL config trap (the webhook fails open when its secret is unset) and a link-code design that allows chat takeover. |
| Backend: agent | The thesis "model proposes, backend disposes" is real: every money rule is a pure, tested guard. But the two money moves that close the demo loop (release on a workout, slash at end of day) still depend on the model emitting the right tool call; the backend knows the answer and asks anyway. |
| Backend: Solana | Custodial plain transfers between three backend-held wallets, not the Anchor program (the design doc's pre-authorised fallback). Proven on devnet with real signatures from the deployed Worker. The Durable Object marks a stake settled *before* the chain call and swallows chain failures, so `/state` can say money moved when it did not. |
| Contract app ↔ backend | Field-by-field match once the charity split was removed from the app. Two app-side bugs found and fixed here (feed goes silent after a seed; a dead trace kind). `docs/API.md` is now the merged contract both PRs agree on. |
| Live verification | Not possible from this sandbox (all egress refused). What is known live comes from PR 2's thread: stake, release and slash confirmed on devnet from the Worker via a keyed RPC; the agent on `gpt-5.5`; Linq delivering for real; a full five-beat rehearsal passing. The one thing nobody has exercised is texting the live line with `yo <code>` from the demo phone. |

## The backend: what it is and how it was checked

PR 2 (`claude/blissful-wozniak-uuf7m1`, 30 commits) adds `backend/` and the backend's half of `docs/API.md`. Its own test suite runs clean here: 162 checks across 7 suites (guards 66, context 28, time 18, brain fallback 14, redaction 14, webhook signatures 13, money 9), and `tsc --noEmit` passes. One setup note: a clean clone cannot typecheck until `wrangler types` has run with a `.dev.vars` present, because the generated `Env` type only includes secrets it can see. Copy `.dev.vars.example` to `.dev.vars` first.

The PR description is stale in one important way: it says the devnet RPC still 403s Cloudflare Workers and `txSig` stays null. The thread shows that was fixed the same afternoon by setting a keyed RPC URL as a secret; stake (`67mS3LT6…`), release and slash all produced real signatures from inside the deployed Worker.

### Solana staking

**What holds the money.** No Anchor program. `@solana-program/system` transfers between three backend-held keypairs: the treasury funds each user wallet with 0.1 SOL at onboard; a stake moves 0.05 SOL from the user wallet to a single shared escrow wallet; release moves it back; slash moves it to the treasury. The source wallet always signs and pays the fee. Per-user seeds are 32 random bytes stored under one Durable Object key that no endpoint lists or projects; treasury and escrow seeds are secrets. Nothing logs or traces key material, and every error string is redacted before it reaches the trace. Library usage was verified against the installed `@solana/kit` by building and signing a real transfer offline.

| Finding | Severity | Where |
|---|---|---|
| **State claims money moved whether or not it did.** `settle` writes `released`/`slashed` and emits the `stake_released`/`stake_slashed` trace event, then fires the chain transfer in `waitUntil`. The chain wrapper catches every failure, traces a quiet `decision`, and returns null. So a failed transfer leaves `/state` saying settled with `txSig: null`, which the contract describes as "still confirming". No retry, and the guards refuse anything not `held`, so it can never be re-attempted. The same happens if the Durable Object is evicted mid-transfer or if confirmation times out after 30 s while the transaction lands anyway. | CRITICAL | `user-agent.ts` `onChain`, `settle`, `moveStake` |
| **End-of-day slash and workout release are not enforced by code.** The end-of-day alarm and the workout-arrival path both *know* whether a covering workout exists, then ask the model to decide and to copy the right `commitmentId` out of the context. The alarm record is deleted before it runs, so there is one chance. If the model stays quiet, fumbles the id, or the brain is down, the commitment stays `pending` with the stake `held` forever, and because only one open stake is allowed the user can never stake again. Worse, a fumbled release triggers the correction pass whose instruction is "it did NOT happen", so Snap texts the user that their workout didn't count while the judge watches it land. | HIGH | `user-agent.ts` `runAlarm` (`end_of_day`), `ingestWorkouts`, `dispatch` |
| **`create_commitment` can take money on the model's say-so.** The guard checks text, time and amount, not consent. The offer-and-accept flow is well designed and keeps `accept_offer` out of the model's tool list, but `create_commitment` walks around it. "Never take money without a yes" is prompt-only. | HIGH | `guards.ts` `guardCreate`, `tools.ts` |
| **`/onboard` is unauthenticated and unmetered, and each call sends 0.1 SOL from the treasury** and consumes one of 10 000 link codes. A curl loop drains the treasury in about a minute; once empty, every funding and slash fails and the wrapper hides it. | HIGH | `index.ts`, `user-agent.ts` `initialize` |
| **The escrow wallet's float is undocumented.** Nothing in code or docs funds the escrow, yet every release and slash pays a 5 000-lamport fee out of it and a transfer of the whole stake must leave it rent-exempt. Release and slash succeeded live, so someone funded it by hand; there is no low-balance check and the float drains by one fee per settlement. | HIGH (operational) | `user-agent.ts` `moveStake` |
| **User wallet is funded exactly once.** After one slash the wallet holds 0.049995 SOL and the next 0.05 stake fails on chain while `/state` says `held`. `/debug/seed` deliberately preserves the wallet, so rehearsals accumulate this. | MEDIUM | `fundUserWallet` |
| **`txSig` is overwritten on settle.** One field, up to three transactions; after release the lock signature survives only inside a trace event. The app's explorer link then shows the payout, not the lock. | MEDIUM | `moveStake` |
| **A renegotiated deadline is a hard wall.** `end_of_day` fires at the new deadline with zero grace (the grace alarm scheduled 20 min later is dead code), and the covering window ends at the same instant, so a workout that *starts* one minute late cannot release. | MEDIUM | `dispatch` (`reschedule_commitment`), `endOfDayFor` |
| The confirmation poll is up to 30 subrequests per transfer, inside the same invocation as an OpenAI call and a Linq send; the free plan caps at 50. | MEDIUM (plausible) | `wallet.ts` `confirm` |
| Missing wallet seeds make `moveStake` return silently with no trace at all. The default RPC URL is one known to 403 from Workers, and that failure is converted into a silent success on `/state`. | LOW | `moveStake`, `rpc()` |
| A workout already in progress when the commitment is made can release it (the window test is overlap, not "started after"). | LOW | `guards.ts` `findCoveringWorkout` |
| No test touches the money: nothing over `wallet.ts`, `moveStake`, `settle`, `onChain` or the stake status machine. | NIT | `backend/test/` |

**Rules that are enforced in code and tested:** 0.05 SOL default with the model only able to override inside 0.001–1 SOL; at most one renegotiation; no reschedule past end of day; warning (never a slash) at grace; slash only after the local end of day or the renegotiated deadline; release only on a workout of 30 minutes or more, of an accepted type, not hand-entered, with `wasUserEntered` sticky across resends; one open stake at a time; double-settle refused; the model never does timezone maths; whole stake to the treasury on a slash.

### The agent and alarms

**How a turn works.** Entry from the Linq webhook, `/debug/message`, a Durable Object alarm, or a workout arriving. Context is built (goal, this week's count, workouts, commitments, last 20 messages, all rendered on the user's local clock), the OpenAI brain is called with `tool_choice: required` and falls back to Workers AI on a throw, a `decision` event is traced with the model's reasoning, then **actions run before talking**: every non-message tool goes through its guard, and if any guard refuses, the model's drafted texts are discarded and a correction pass re-asks with only `send_messages`. Narrow second passes handle offer and acceptance; a follow-up pass speaks if nothing was said. At most four model calls per turn, so it always terminates.

| Finding | Severity | Where |
|---|---|---|
| **Time-warp and the alarm slot use different clocks.** Alarm timestamps are computed in the warped frame, but `setAlarm` fires on real time. A forward warp only delays alarms (hidden in the demo because the timewarp endpoint fires due alarms itself). A **backward** warp, for example re-rehearsing Saturday evening on Sunday morning, stores an alarm in the real past: it fires immediately, nothing is due in the warped frame, `rearm` sets the same past value, and the object loops forever until someone resets the clock. | HIGH | `now()`, `rearm`, `fireDueAlarms` |
| **`SNAP_CHANNEL` is dead config.** Nothing in `src/` reads it. The only thing that decides whether a real iMessage goes out is whether `LINQ_API_KEY` is set. Both wrangler files describe `trace` mode as the thing that makes it safe to drive the agent in a loop; it does not exist. Anyone who fills in `.dev.vars` and drives the agent locally is sending real texts against the 100/day sandbox budget. | HIGH | `wrangler.toml`, `wrangler.local.toml`, `channelFor` |
| **A reschedule can move the deadline earlier.** The guard bounds the new time only from above. "gym at 7" said at 21:00 resolves to tomorrow 07:00; a reschedule to "10 tonight" is accepted and, because a renegotiated deadline is the slash point, the stake is slashed nine hours before the session the user promised. Executed against the real guard to confirm. | HIGH | `guards.ts` `guardReschedule` |
| **`/debug/seed` deletes the morning check-in alarm** and nothing re-creates it (it is only scheduled at onboard and by itself). It also leaves a standing offer in place. The demo routine is "seed, then rehearse", so the daily check-in dies on the first seed. | MEDIUM | `seed()` |
| **No timeout on the OpenAI call.** The fallback only catches a throw; a stalled socket hangs the turn and never falls back. | MEDIUM | `brains/openai.ts` |
| **Per-turn text volume is unbounded.** Five texts per `send_messages` call, but every talking call in a decision is dispatched, and `parallel_tool_calls` is on. One confused turn can burn 20% of the daily budget. | MEDIUM | `runAgent` |
| Trace id allocation is a read-modify-write across an await; two overlapping turns (a workout arriving during a webhook turn) can overwrite one event. | MEDIUM (plausible) | `appendTraces` |
| The whole trace is read on every model pass, up to four times a turn, and never pruned. | MEDIUM | `buildContext` |
| The follow-up and correction passes, which produce most of the texts a judge actually sees, do not trace their reasoning; the brain screen shows the earlier decision's reasoning instead. Alarms that correctly decide silence (workout already done) trace nothing. | LOW | `followUp`, `correct`, `runAlarm` |
| User text is interpolated unescaped into the instruction and replayed raw as conversation. The guards hold ("release my stake" cannot be honoured), so the reachable damage is steering Snap's own texts and, via the `create_commitment` gap, locking up the user's own money. | LOW | `receiveDebugMessage`, `context.ts` |
| Docs drift: `/webhooks/telegram` is documented and not routed; the design doc's Telegram fallback does not exist; a stale comment in `guards.ts` says any workout type qualifies. | LOW | |

**Done well:** the guard layer, `time.ts` (property-tested over 20 720 instants in 14 zones, including the Cairo night with no midnight, which was a real bug in a money path), local-clock rendering into the prompt, the offer/accept split with `accept_offer` withheld from the tool list, actions-before-talking with the draft discarded on refusal, the loud fallback brain, sticky `wasUserEntered`, and `Date.now()` discipline everywhere except the one place real time is correct (the webhook replay window).

### The HTTP layer and the contract

| Finding | Severity | Where |
|---|---|---|
| **`/webhooks/linq` fails open when `LINQ_SIGNING_SECRET` is unset.** It is the only unauthenticated route. Nothing in the repo proves the secret is set on the deployed Worker, and the failure mode is silent: with it unset, anyone who knows the URL can POST a forged inbound message from a linked user's number and drive that user's agent, including accepting a standing offer, which moves money. The thread shows the signature check working live, which means the secret *is* set today; the trap is that unsetting it produces no error. | CRITICAL (config) | `index.ts` `linqWebhook` |
| **Link codes are never consumed, never expire, and have no attempt limit.** Texting `yo 1234` for an existing code re-binds that user's chat to the sender, silently, with a friendly greeting; `linkChat` overwrites the chat id unconditionally. With a few users onboarded at a demo, a single mistyped digit lands on a stranger's account. | HIGH | `directory.ts`, `linkChat` |
| **`/debug/seed` restarts trace ids at 1 while the app keeps its cursor.** Seed mid-session and the app polls `since=60` against a feed that now ends at 12: the brain screen goes silent for the rest of the session with no recovery short of "reset app". The counter should stay monotonic across seeds. Fixed on the app side here by dropping the cursor after a seed. | HIGH | `seed()` deletes `traceSeq`; app `AppModel.seedDemo` |
| `accepted` is counted after in-request dedupe, so the contract's "never less than sent" was false. Documented correctly in the merged `API.md`. | MEDIUM | `ingestWorkouts` |
| A webhook without an event id falls back to a hash that permanently silences a repeated message; no length cap on inbound text; the 500 path logs unredacted; redaction misses path-embedded keys. | MEDIUM | `index.ts`, `redact.ts` |
| A wrong `X-Debug-Key` returns `401 unauthorized`, the same code the app reads as "token is dead". The app happens not to route debug errors through that latch. | LOW | `index.ts` |

**Contract, field by field** (backend `types.ts` and validators versus the app's models and encoder): every field on `/onboard`, `/workouts`, `/state` and `/trace` matches. The app is deliberately more lenient than the wire in several places (optional `stake`, optional contact fields, unknown enum values, one malformed trace event dropped). `end` and `activeKcal` may be null or omitted and the backend treats both the same, so the app's omission is fine. `data.reasoning` is emitted on every decision path. Timestamps always carry fractional seconds and the app accepts both forms. `/debug/*` routes answer 404 when no `DEBUG_KEY` is configured, which is correct. `stay_quiet` is a tool, not a trace kind: silence arrives as a `decision` whose summary says so. The app's dead `stay_quiet` case and the doc line claiming it were removed here.

## What changed in this pass

### iOS code

| Finding | Severity | Fix |
|---|---|---|
| A failed workout POST was never retried: HealthKit does not re-fire an acknowledged delivery, and nothing else called `drain()`. The spec's "kill the network mid-sync and restore it" required a relaunch. | HIGH | `WorkoutSync.post` retries twice with short back-off; `AppModel` re-drains on every return to the foreground. |
| The HealthKit observer was registered from the root view's `.task`, which a background launch for a locked-phone delivery may never reach. | HIGH (plausible; needs a device test) | `SnapApp.init` calls `startWorkoutSyncIfOnboarded()` before any view exists. |
| An observer fire landing during an in-flight drain was dropped but still acknowledged. | MEDIUM | Drain coalesces: a fire during a drain sets `needsRedrain` and the loop goes round again. |
| Every cold launch of a linked phone flashed the link screen until the first `/state` landed. | MEDIUM | `linked` is persisted and the phase starts from it. |
| `MockAPI.shared` never reset, so a second demo run-through opened on a finished loop; `linked` was measured from process launch, so the mock skipped the link screen entirely. | MEDIUM | `MockAPI.reset()`; `linked` is measured from the onboard call. |
| Unknown `commitment.status` / `stake.status` values failed the entire `/state` decode. | MEDIUM | Both enums gain an `unknown` fallback; the card draws nothing for it. |
| One malformed trace event failed the entire feed. | MEDIUM | `/trace` decodes per element; bad events are dropped. |
| A scheme-less URL pasted into the debug panel silently ran the mock while the panel said "live". | MEDIUM | `Config.serverURL(from:)` requires `http(s)` and a host; the panel names the mock for anything else. |
| Keychain writes discarded their status and used delete-then-add. | MEDIUM | `SecItemUpdate` then `SecItemAdd`, `ThisDeviceOnly`, status surfaces in the debug panel. |
| Every `/state` poll republished an identical state, invalidating the whole screen twice a second. | HIGH (UI) | `SnapState` is `Equatable`; assigned only on change; the feed and countdown are their own views. |
| The app decoded and displayed a half-back stake split that the backend had reverted, and the deal page promised "half goes to charity". | HIGH (product) | Split fields, split line, mock args and tests removed; copy is "you skip, it's gone."; design docs restored to whole-stake-to-treasury. |
| Seeding on the backend restarts trace ids; the app kept its cursor and the feed went silent. | HIGH (demo) | `seedDemo` clears the feed cursor after a successful seed. |
| `stay_quiet` was modelled as a trace kind the backend never emits. | LOW | Removed; the test now checks silence arriving as a `decision`. |
| Polling cancellation landed in the debug panel as an error; an event with `id == 0` would be dropped; a seeded backlog drained at 350 ms per event; `stop()` never disabled background delivery; the anchored query mixed predicates; decode failures were reported as "HTTP 200"; trace timestamps used the device locale; `data.reasoning` was not decoded. | LOW | All fixed. |

### UI/UX

| Finding | Severity | Fix |
|---|---|---|
| A failed `/onboard` was a silent dead end and the debug panel was unreachable before a token existed. | CRITICAL | One in-voice line under the button after a failed attempt; long-press the progress dashes to open the debug panel; a local flag stops a double tap creating two users. |
| Cards were `#FFFFFF` on `#F3F3F1` (1.11:1); secondary type 3.2:1; unfilled dots 1.16:1. Illegible mirrored over QuickTime from two metres, the last item on the "Done means" list. | HIGH | `inkDim` to 4.6:1, `hairline` visible, new `surfaceAlt` for received bubbles, unselected chips and the secondary pill; trace text one step larger; goal dots 12 pt. |
| Every onboarding page change squashed the content to half height. | HIGH | Frame moved outside the identified subtree. |
| Tapping the link code replaced it with "copied" forever. | HIGH | Reverts after 1.6 s. |
| "reset app" was a one-tap session wipe two rows below the on-stage fallback button. | HIGH | Confirmation dialog. |
| The link screen was a dead end with no buttons when `/onboard` returned no contact. | HIGH | One source of truth per channel; a red line names the problem. |
| The feed opened at the top and yanked the reader back on every event; no empty state; HealthKit never-authorised was invisible; the name field's Done key did nothing; goal chips were 30–40 pt and read as a meter; the secondary pill was a stroked border; no accessibility labels. | MEDIUM | `.defaultScrollAnchor(.bottom)`; in-voice empty state; a red line when authorisation is undetermined; `onSubmit` advances; number restated large; pale fill; labels on the primary controls. |

### Tests and project

- Seven tests added; one vacuous test (`testTraceSinceIsExclusive`) made real; the split suite removed.
- `project.yml` carries `DEVELOPMENT_TEAM` and `ASSETCATALOG_COMPILER_APPICON_NAME` so `xcodegen` stops dropping signing and the icon; the unused `processing` background mode is removed; the shared scheme skips `SnapUITests` by default, matching that test's own instructions.
- `.gitignore` gains the Apple signing files and Solana's default `id.json`.

### Docs

- `docs/API.md` is now the merged contract: PR 2's version as the base (the backend author's, with the limits, `accepted` semantics, `workoutsThisWeek` rules, `/debug/message` and the error table), plus the app-side facts PR 2 lacked (timestamp forms, optional-field omission, unknown-value degradation, the seed/cursor behaviour, the whole-stake slash, ordering, `data.reasoning`, the error-code table with the two codes PR 2 omitted). It no longer claims a `stay_quiet` kind or a Telegram webhook that exists.
- `README.md` says where the backend lives. `DESIGN.md` and `IOS_SPEC.md` are back to whole-stake-to-treasury and no longer describe files as unwritten.
- `docs/verify-backend.sh` is the live probe that could not run from the sandbox.

## Not changed, and why

- **Backend code.** All of it is on PR 2, the backend author's branch. The findings above are for that PR.
- **`Config.defaultBaseURL`** still points at the deployed Worker; the team set it on purpose.
- **`HKObserverQuery` on a background launch** is fixed by construction but needs a device: end a Watch workout with the app force-quit and confirm the POST lands.
- **`TraceRow` re-animates when scrolled back into view.** Cosmetic.
- **No `LiveAPI` or `AppModel` unit tests.** Both need an injection seam that is a bigger change than this pass.
- **A full `/trace` page with one malformed event** counts 199 after the drop, so the immediate next-page fetch doesn't trigger; the one-second poll picks it up.
- **`Keychain.lastWriteError`** is a mutable static; fine in Swift 5 mode, a strict-concurrency error later.
- **The observer's completion handler** now waits on up to two short retries before acknowledging a background delivery. Inside iOS's budget, but the first thing to shorten if deliveries ever stop.
- **The debug key** lives in UserDefaults, as the spec asked.

## Before the demo

In priority order. Items 1–4 are backend or operator work; 5–7 are the app.

1. **Fix the two demo-loop money paths in code** (backend): settle deterministically at end of day and on a covering workout, and let the model only do the talking. Ten lines each. Until then, rehearse the release beat specifically and watch `/state` flip to `met`/`released`.
2. **Never warp the clock backwards.** Forward only, in small steps (past grace, then past end of day), or reset with `{"now": null}`. A backward warp hot-loops the Durable Object's alarm.
3. **Seed before every run, then re-check the morning alarm** is gone (it will be). Warp to an evening hour, never 2 am: the agent correctly stays quiet at night.
4. **Fund the escrow wallet and check its balance** before and after a release. Confirm `wrangler secret list` shows `LINQ_SIGNING_SECRET`, `SOLANA_RPC_URL`, both seeds, `OPENAI_API_KEY`, `DEBUG_KEY`. Do not rely on `SNAP_CHANNEL`; the switch is `LINQ_API_KEY`.
5. **Text the live line once** with `yo <code>` from the demo phone. Nobody has.
6. **Build and test the app on a Mac:** `cd ios && xcodegen && xcodebuild test -scheme Snap -destination 'platform=iOS Simulator,name=iPhone 17 Pro'`, then `-only-testing:SnapUITests`, then the two device checks (background-launch delivery; a workout ended while the network is down). Nothing here was compiled: every changed file was parsed, every test symbol hand-checked, and the diff read adversarially, but that is not a build.
7. **Start the Watch workout as strength training and run it 30 minutes**, or use the debug panel's 45-minute simulated one; anything shorter or exotic is refused by design, and the trace will say why.
