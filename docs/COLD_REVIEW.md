# Cold review — Snap, read from scratch the night before demo

Reviewer had no prior context: read `README.md`, `docs/DESIGN.md`, `docs/API.md`, `docs/ROADMAP.md`,
`docs/FEATURES.md`, then
`backend/src/` (`user-agent.ts`, `agent/*`, `vision.ts`, `competitions/*`, `solana/wallet.ts`) and the parts of
`ios/` the claims depend on. Every factual claim below was checked against the code or by running it. The test
suite was executed (`npm install && npx wrangler types && npm test` with a dummy `.dev.vars`).

## 1. Rating

**7 / 10.** The engineering is genuinely above hackathon median — money rules are pure guarded functions, the
agent settles from alarms with no model in the money path, and the devnet transactions are real — but the
headline verifier proves *someone* trained rather than *you*, the pitch claims judgment where the code is a
rules engine, and five verifiable claims in the README and the shipped app are wrong today.

## 2. What actually differentiates this — and what doesn't survive a skeptical judge

**Real, and the thing to lead with:** the money moves without the model *and* without the user. The end-of-day
alarm (`user-agent.ts` `runAlarm` → `end_of_day`) and the workout-arrival path (`ingestWorkouts`) both call
`settle()` in code and then hand the model a *fact* to talk about (`announce`). Every proposed tool call passes a
pure guard first (`agent/guards.ts`), and refusals are traced with their arguments. Two people built a Durable
Object alarm queue (`alarm:<14-digit>:<kind>` + range scan), property-tested time maths over 20,720 instants in
14 zones (verified — the time suite prints exactly that), and real devnet stake/release/slash a judge can open
in Explorer. That is the pitch. It is not what the README leads with.

Taking the five claimed differentiators in turn:

| Claim | Verdict |
|---|---|
| **The photo is judged, not trusted** | **Real but oversold.** `vision.ts` does what it says: screenshots refused before anything else, `unsure` below 0.6, SHA-256 fingerprint spent only on payout, settlement in code before the model speaks. But `VERIFY_PROMPT` asks whether *"a real person"* is training — not whether it is *this* person. Any gym photo of anybody, first time it is sent, releases the stake. "It can tell when you're lying" (ROADMAP one-liner) does not survive one judge with a phone. |
| **Ghosting doesn't work** | **Real, and the strongest one.** Verified: no model call is required to slash. Demo it explicitly — warp past end of day while ignoring the thread. |
| **It negotiates rather than following rules** | **Marketing.** One reschedule ever (`MAX_RENEGOTIATIONS = 1`), door shut an hour out (`RESCHEDULE_LEAD_MS`), measured against the current deadline, never past end of day. That is Beeminder with a voice. Worse for the pitch: the 2:00 demo beat is the agent *refusing*, so the only negotiation a judge sees is a rules engine saying no in slang. Judgment exists only more than an hour out, and the demo never shows it. |
| **Refuses to be a coach** | **Real as discipline, invisible as a differentiator.** No plans, no macros — true in the prompt and the product. But three minutes on stage cannot show an absence, and `intensity.targetMin` (30/45/60 min) is a coaching number that, today, no user can choose (see §5). |
| **It shows its reasoning** | **Half.** What the trace genuinely shows is *what it did* and *why the backend refused* — `refused reschedule_commitment — there is less than an hour left`, with the arguments attached. The model's own reasoning is `message.content` from a `tool_choice: 'required'` call (`brains/openai.ts:56`), which is frequently null, and the follow-up and correction passes — which write most of the texts a judge reads — trace no reasoning at all. Claim the guard's reason, not the model's mind. |

Correctly self-assessed already: iMessage is table stakes, "it's on Solana" is a prize not a pitch, and the
README admits a re-crop beats the fingerprint. Keep all three admissions; they buy credibility cheaply.

## 3. Tweaks to what already exists

No new features. Ordered by value per minute.

1. **`ios/Snap/Health/WorkoutSync.swift:232` — `minimumSessionSec = 30 * 60` is the retired floor.** The backend
   moved to 15 (`agent/guards.ts` `MIN_WORKOUT_SEC`) but the app still gates `endSession()` at 30, and
   `BrainView.swift:564` prints **"training · counts at 30 min"** with `done` disabled until then
   (`:577`, and the a11y hint at `:579`). The README paragraph "leave after twenty minutes and you still get
   paid" is contradicted by the phone in your hand. Change the constant to `15 * 60`, update the two strings,
   and leave `warpSession(back: 31*60)` alone. This is the single most visible inconsistency in the repo.
2. **`backend/src/agent/context.ts:286` prints "0.05 SOL SOL".** `solText()` already appends the unit. The model
   reads that line on every turn to pick the number it speaks. Drop the trailing ` SOL`.
3. **`backend/src/vision.ts:96` — the photo verifier runs on whatever `OPENAI_MODEL` says.** `wrangler.toml`
   sets it to `gpt-5.5` for the *conversation* brain; the `gpt-4o` default only applies when it is unset. The
   verifier is the headline feature and it silently inherits a config knob meant for something else. Read
   `env.OPENAI_VISION_MODEL || 'gpt-4o'` instead and add the var to `wrangler.toml`. One line, removes a whole
   class of stage failure.
4. **`renderContext` (`agent/context.ts:246-262`) should say whether the door is open.** Each open commitment
   renders `reschedules used 0/1` but never whether it can still be moved. Add one clause —
   `can still be moved until 18:00 their time` / `locked — cannot be moved`. Makes the 2:00 refusal beat land in
   voice every time instead of relying on the model to call the tool and get refused, and gives the brain
   screen a reason line whether or not the model tries.
5. **`user-agent.ts:1870` — the decision row falls back to raw tool names.** When `reasoning` is null the brain
   screen shows `send_messages + offer_stake`, which reads as debug output on the screen you are selling as the
   transparent brain. Map the eight names to phrases (`offered a stake, waiting on a yes`, `held the line`,
   `stayed quiet`) in the same place the fallback is chosen.
6. **Say the photo's limit out loud, in one line, before a judge finds it.** `FEATURES.md` §3 already gets the
   wording right — *"a real person is visibly training"* — but README line 11 ("a picture with **you** in it")
   and `ROADMAP.md:17`/:25 still imply identity, and the one-liner you plan to say on stage is the ROADMAP one.
   Rewrite those two to what the code does: *"the model checks that a person is
   training and that the image isn't a screenshot or one we've already paid for. It doesn't check that it's
   you — HealthKit underneath is what makes it your body."* Costs a sentence, buys the whole verification story.
7. **A renegotiated deadline gets zero grace.** `dispatch` → `reschedule_commitment` schedules `end_of_day` at
   the new due time and a `grace` alarm 20 minutes later that `settle()` immediately deletes. DESIGN's
   "20 min grace → warning" quietly stops applying to exactly the commitment someone already negotiated. Either
   schedule `end_of_day` at `newDue + graceMin * 60_000`, or have Snap say it when granting the move
   ("8pm. no grace on a second chance").
8. **README's workout rule is one qualifier short.** `disqualification()` (`guards.ts:323`) only applies the
   2 kcal/min floor when the source recorded energy above zero — deliberate, documented, and correct. The README
   states it unconditionally. Add "when the source recorded it". Worth knowing on stage: the debug simulated
   workout (`WorkoutSync.saveStrengthTraining`) writes no energy samples, so the sit-in-the-car check does **not**
   fire on the no-Watch demo path. If a judge asks you to prove it, use a real Watch session.
9. **Stale comments that contradict shipped behaviour**, in the two files a curious judge opens first:
   `user-agent.ts:778-780` ("a photo is a hype beat, and the money still only moves on the watch") and
   `onboarding.ts:32` ("that the watch is what counts"). Both predate the photo becoming the verifier. Two-minute fix.
10. **Operational, not code: the Linq sandbox is 100 messages/day and onboarding alone spends 10.** Nothing in
    the repo counts them. Rehearse the photo beat through `POST /debug/message` with `{"imageUrl": ...}` — the
    route already supports it (`index.ts` `debugMessage`) — not through the real line, and keep a known-good
    image URL in the run sheet as the on-stage fallback.

## 4. The three things most likely to embarrass them on stage

1. **A judge sends a gym photo that isn't of them, and it pays out.** The verifier has no identity check, and
   the fingerprint only catches byte-identical resends. This is the first thing a skeptical judge tries because
   the pitch invites it. *What to do:* pre-empt it in one sentence before the photo beat (tweak 6) and name the
   fix you'd build — the photo proves a session happened, HealthKit underneath proves it was this body, and the
   two together are what a re-sent or borrowed photo can't fake. Volunteered, it reads as rigour. Discovered, it
   reads as the demo being fake.
2. **The app contradicts the pitch on the 15-minute floor.** You will say "a bad day you turned up for still
   pays" and the screen behind you says "counts at 30 min" with the button greyed out. Anyone who read the
   README on the way in sees it. *What to do:* tweak 1, three lines, do it before the freeze.
3. **The photo beat fails silently and the recovery isn't rehearsed.** Three failure paths converge on it: a
   Linq media fetch that 403s (`fetchImage` → `unseen` → nothing moves), a vision call on an unintended model
   (tweak 3), and the Workers AI fallback, whose stringified JSON is the flakiest parse in the repo
   (`readVerdict` handles it, but it is the path you've exercised least). *What to do:* pin the vision model,
   fire one `/debug/message` with a real photo URL minutes before you walk up, and rehearse the spoken handoff
   to the Watch workout — DESIGN already names that fallback at the 3:00 beat; make sure both of you can say it
   without looking like a save.

## 5. Claims the code does not support

Checked, not assumed.

| Claim | Where | What the code does |
|---|---|---|
| "The model has **six tools** and cannot move money with any of them" | `README.md:47`, repeated as "Six tools, and none of them reach the chain" in `FEATURES.md` §2 | `TOOLS` in `agent/tools.ts` has **eight** (plus `accept_offer`, deliberately withheld = nine callable). And three of them move money when their guard passes: `create_commitment` locks a stake, `release_stake` and `slash_stake` settle. The six is presumably the six *guards* `FEATURES.md` lists one line later. The true claim — stronger, and free — is that the *settlement paths that matter* (photo, watch, end of day) run in code and hand the model an outcome. Fix it in both files; it is the sentence a Cloudflare or OpenAI judge is most likely to probe. |
| "`npm test` — **9 suites, 202 checks**" | `README.md:77-85` | Ran it: **12 suites, 385 checks**, all passing (guards 89, photos 57, reactions 57, context 49, intensity 29, competitions 19, time 18, wallet 17, brain 14, redaction 14, webhook 13, money 9). The README table omits intensity, reactions and wallet. `FEATURES.md` says 12 suites / **380** checks — right shape, five short. Print the number from a run rather than from memory, or say "380+". |
| "`wrangler.local.toml` … sets the channel to `trace` so nothing is sent" | `README.md:114`, and the same comment in `wrangler.toml:41-44` | **`SNAP_CHANNEL` is read nowhere in `src/`.** The only switch is `channelFor()` (`user-agent.ts:1135`): with `LINQ_API_KEY` present in `.dev.vars`, a local run sends real iMessages against the 100/day budget. This was flagged in `docs/CODE_REVIEW.md:54` and is still true. |
| "Stake, release and slash, each **verified by fetching the transaction back from the cluster**" | `README.md:70`, and `FEATURES.md` → "The money" | `confirm()` (`solana/wallet.ts:108`) polls `getSignatureStatuses` — cluster-side confirmation, not fetching the transaction. Worse, when it times out after 30 s it *throws*, `onChain` swallows it, and the signature is discarded even though the transfer may have landed: `txSig` stays null and the trace's explorer line never appears. The comment at `wallet.ts:120` ("the caller keeps the signature either way") is not what `moveStake` does. |
| The intensity dial is "**chosen once at onboarding, changeable any time**" — and `FEATURES.md` sells the whole easy/medium/hard table as "**Picked at onboarding**" | `agent/intensity.ts:2`, `FEATURES.md` → "The dial" | Neither half holds end to end. `OnboardingView` has five pages (hello, name, goal, deal, health) and no intensity picker; `OnboardRequest` is never given one from iOS, so **every user created through the app is `medium`** and easy/hard are unreachable on stage. There is also no route that changes it afterwards — `/onboard` is the only writer. Backend, validation and tests are all correct and complete; the app just never calls them. Either onboard the demo user by curl with `"intensity":"hard"` and say so, or keep the dial out of the pitch. |
| iOS "30-minute floor" | `WorkoutSync.swift:230-232`, `BrainView.swift:566` | Contradicts `MIN_WORKOUT_SEC = 15 * 60` and the README paragraph built on it. See §3.1. |

Two smaller ones, accurate but worth tightening: "averages 2 active kcal/min" (`README.md:39`) applies only when
the source recorded energy; and "12 accepted types" is correct — `ACCEPTED_WORKOUT_TYPES` has exactly 12.

One setup note, since a judge may clone the repo: `npm test` fails to compile on a clean checkout with 23
`Property 'DEBUG_KEY' does not exist on type 'Env'` errors, because the generated `Env` type only carries the
secrets `wrangler types` can see and `.dev.vars` is gitignored. `backend/.dev.vars.example` is committed and
correct; the README's "Running it" block just never says to copy it. Add
`cp .dev.vars.example .dev.vars` above `npm install` — one line, and it is the first thing anyone who clones
this repo will hit.
