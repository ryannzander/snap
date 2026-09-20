# Snap — every feature, what it does, and how it performs

Audited against the merged tree and the deployed Worker on 2026-09-20. Nothing here is a plan; everything is running at `https://snap.snap-backend.workers.dev`.

**Performance is stated three ways on purpose:** *measured live* (run through the deployed Worker), *tested* (asserted in `npm test`), and *unverified* (built, never proven end to end). The last column is short and it is honest.

---

## The loop

You text a plan → Snap offers a stake → you agree → the money is held on devnet → the deadline passes → **Snap texts you first** → you send a pic with the gesture he asked for → a vision model judges it → the stake comes back. Don't go, and at the end of your local day it's gone.

> A motivator is something you can ignore.

---

## 1. The agent

### Proactive wake-ups, no cron job anywhere
A Durable Object gets exactly one alarm, so wake-ups live in a key-sorted queue — `alarm:<14-digit-timestamp>:<kind>` — and a range scan finds everything due. Three kinds fire:

| alarm | when | what it does |
|---|---|---|
| `grace` | deadline + your grace minutes | the first "yo, you're over" — a warning, never a slash |
| `end_of_day` | midnight in **your** timezone | the money moves, with or without you |
| `last_call` | an hour before the money moves | one final warning, never a second nag |
| `morning` | 09:00 local, if nothing is planned | he asks first |

**Measured live:** the grace warning fires and speaks; end-of-day settles with no model call required. **Tested:** the backward-warp hot loop is fixed — `rearm()` floors at `now + 1s`.

### Nine tools, and the model can't move money with any of them
`create_commitment`, `offer_stake`, `accept_offer`, `reschedule_commitment`, `send_messages`, `react`, `stay_quiet`, `release_stake`, `slash_stake`.

Three of them touch money. None reach the chain. Every proposed call goes through a pure guard first — `guardCreate`, `guardOffer`, `guardAccept`, `guardReschedule`, `guardRelease`, `guardSlash`, `guardMessages` — and refusals are traced with the arguments that caused them.

**Tested:** 89 checks in `guards`, one per rule in DESIGN.md plus the model misbehaviour each was written for. Both models we tried attempted to slash at the grace mark; refused every time.

### Settlement is code, not a decision
Whether a photo is proof, whether a workout covers a commitment, and when the day ends are answered by the vision verdict, HealthKit and the clock. All three settle in code and hand the model an **outcome** to talk about.

**Actions run before any talking.** The model writes its texts assuming every tool succeeded, so a refusal has to be known before a word is sent. Any acting turn throws the draft away and re-asks with the context rebuilt *after* the action.

**Measured live:** fixed three real misreports — a refused reschedule announced as *"alright, push it to tomorrow then"*, a granted one announced as refused, and *"4/4"* on a 3/4 week.

### Two brains
OpenAI `gpt-5.5` by default, Workers AI `llama-3.3-70b` behind it. A dead key degrades to Llama and writes a loud trace line rather than the agent silently saying nothing.

**Tested:** 14 checks in `brain`. **Measured live:** the fallback is what produced 0/4 on a prompt that scores 4/4 on the real model — which is how we learned to measure through the thing that ships.

### Agent reliability
Through the deployed Worker, 4 trials per phrase, on `gpt-5.5`:

| phrase | outcome |
|---|---|
| `7pm gym, $5 on it` | commitment 4/4, replied 4/4 |
| `gym at 7` | **offer** 4/4, replied 4/4 |
| `gonna hit the gym at 6 tonight` | **offer** 4/4, replied 4/4 |
| `ill go later` | nothing 4/4 ✓ |
| `might go to the gym sometime` | nothing 4/4 ✓ |

**20/20.** A named time with no amount produces an offer, not a stake — nobody's money moves without an explicit yes.

---

## 2. Verification

### The photo
A vision model checks a real person is visibly training, refuses screenshots before anything else, needs **0.6 confidence**, and every image is SHA-256 fingerprinted so the same one can't be spent twice.

**It does not check that the person is you.** No vision model can, and we don't claim it. Say that before a judge finds it.

**Tested:** 70 checks in `photos`, including every shape a model actually returns — fenced JSON, JSON buried in prose, stringified booleans, unreadable confidence. **Measured live:** verdicts through both models on real image URLs.

### The gesture — what stops someone else doing it for you
Every stake picks one at random the moment it locks: **2, 3 or 4 fingers up, a thumbs up, a peace sign, or an open palm.** The photo has to have it.

A picture you already had can't have it in it, because nobody knew which gesture until your money moved. Neither can one borrowed from a friend's camera roll. It turns *"prove you trained"* into **"prove you trained now"** — the half the vision model could never answer alone.

- Missing it is `unsure`, not `not_training` — Snap asks again instead of accusing you. Nothing moves either way, and the watch underneath still pays with no photo at all.
- An absent or unreadable answer counts as a miss, so the check can't become opt-in for whichever model is up.
- The **stage valve** (`lenient`) rescues a model that *hedged*. It deliberately does **not** rescue a missing gesture — that would switch the check off on the setting most likely to be on during a demo.

It is **not identity**: a friend beside you could hold up three fingers. It kills the cheap attack, which is the one anyone tries. The enrolled-selfie layer is in `ROADMAP.md`.

**Tested:** 43 checks in `challenge`. **Measured live:** stake locked → `4 fingers up in the pic` picked → verifier told → photo without it refused by name → stake still held.

### HealthKit underneath
Pays you when you trained and forgot to send anything. A session releases money when it:

| rule | value |
|---|---|
| ran at least | **15 minutes** |
| averaged at least | **2 active kcal/min** — *only when the source recorded energy* |
| is one of | 12 accepted `HKWorkoutActivityType` cases |
| `wasUserEntered` | **false** |

Opening Health → Add Data and inventing a session cannot release money. Pressing start and sitting in the car can't either — that's what the kcal floor closes.

**15 minutes is a fraud floor, not an effort bar.** It was 30, which punished the exact behaviour the stake is buying: drive there, warm up, feel awful, leave early — you still turned up, so you still get paid.

Whatever fails says why: `doesn't count as training`, `under 15 min`, `typed in by hand`, `barely moved`, `i asked for 3 fingers up in the pic — can't see it`.

**One bar, one place.** `findCoveringWorkout` used to keep a second copy of these rules and had fallen behind — a 45-minute session at 40 kcal released the stake through the watch while the trace said `barely moved`. It calls `disqualification` now.

**Measured live:** `45 min · 0 kcal → counts` (read as "sensor recorded nothing"), `45 min · 40 kcal → barely moved`, `45 min · 310 kcal → counts`.

---

## 3. Money

### The stake is yours to size
Snap opens with a number and says *"or name your own"*. **Floor 0.01 SOL, ceiling 1 SOL.** Under the floor is a refusal with the number said out loud, never a quiet round-up.

**Measured live:** *"before u get demotivated — put 0.1 sol on it, or name your own number."*

### Real devnet transactions
`@solana/kit` v8. Stake, release and slash are real transfers with real signatures, polled to `confirmed` against the cluster. If we stop waiting before the cluster answers, **the signature is kept anyway** — a receipt you can open in Explorer beats our certainty. An explicit rejection still throws.

**Custodial, and we say so.** The backend holds the keys, the escrow is a wallet rather than a PDA, there's no on-chain program yet. The fallback path was built first on purpose so the loop was real end to end; the Anchor program drops in behind the same three calls.

**Measured live:** stake, release and slash each verified on devnet with signatures, plus two competition payouts.

### Wallets
Custodial, one per user, funded on creation with **2 × (biggest dial stake + fee headroom)** so picking Hard never means the first offer bounces for want of money. Top-ups 0.01–1 SOL at a time, 2 SOL ceiling so devnet's treasury can't be drained through it.

**Tested:** 17 checks in `wallet` — the SOL→lamports conversion happens exactly once, because 0.1 isn't representable in binary.

---

## 4. The dial: easy / medium / hard

| | session target | grace before the first nudge | stake he opens with | morning check-in |
|---|---|---|---|---|
| easy | 30 min | 45 min | 0.02 SOL | no |
| medium | 45 min | 20 min | 0.05 SOL | yes |
| hard | 60 min | 10 min | 0.1 SOL | yes |

It also swaps the voice the model is handed for the turn.

**The target is not a gate.** Coming in under it is something Snap says, never something that keeps your money. Release is the same 15-minute floor for everyone, and `disqualification` doesn't know the dial exists.

**It does not tell you what to train.** No sets, no macros, no push day — `ROADMAP.md` calls that ban permanent, and it's the line between a friend who holds your money and the twenty GPT wrappers in the same room.

**Tested:** 29 checks in `intensity`, including that no mode's voice mentions sets, reps, macros or body parts. **Measured live:** one fresh user per mode, no top-up — easy offered 0.02, medium 0.05, hard 0.1, and the texts said 0.02, 0.05 and 0.1.

⚠️ **Known gap:** iOS onboarding doesn't offer the picker yet, so a user created through the app is always `medium`. Onboard the demo user by curl with `"intensity":"hard"`, or leave the dial out of the pitch.

---

## 5. The stake never vanishes out of silence

An hour before the money moves, Snap says so **once** — *"50 mins then the 0.02 sol is gone"*, and what gets it back. Live: *"if the day cooked you, it's cooked — but this is the door rn."*

Skipped when there is no room for it (a commitment made at 23:30 gets no last call at 23:00) and never fired on a session already covered by a photo or the watch.

Without it the shape of a bad day was: a nudge twenty minutes past the deadline, then nothing at all, then your money gone at midnight. That silence reads as a trap rather than a deal, and the whole product rests on the deal being one you would take again tomorrow.

## 6. It knows the run you just lost

A live streak is the number on your home screen, counted by **the same rule the iOS app uses**, ported line for line rather than reinvented — two implementations of one number is how "2/4 this week" ends up meaning different things on the phone and in the thread.

But the line that actually works is the other one: *"you had 3 days going and you binned it yesterday."* The loss is worth more than the number, which is the same reason the stake is allocated up front rather than paid at the end. One lost session is a Tuesday, and he is told not to call that a streak.

The seeded demo week is three consecutive days, yesterday skipped, today still open — so the sentence has data behind it.

## 7. Negotiation

One reschedule per commitment, ever, and only while there's more than an hour left — an hour out you're rearranging your day, ten minutes out you're weaselling. Snap reads your history first: the same excuse you used yesterday gets called.

- Every move is logged and shown. *"third one this week bro"* comes off that log.
- The model's context now says **whether the door is still open** — `can still be moved, but only until 18:00 their time` / `locked — they already used their move`. It used to have to call the tool and get refused to find out.
- A renegotiated deadline **is** the slash point, and it gets a warning first. Grace used to be scheduled *after* the slash and deleted on the way past, so the one commitment someone had already negotiated over was the one taken in silence.

**Tested:** inside the 89 `guards` checks. **Measured live:** the refusal beat — *"nah bro, can't push this any further. your sol's already on the line."*

---

## 8. Competitions

`POST /competitions`, `/competitions/join`, `GET /competitions`, `GET /competitions/<id>`, `POST /competitions/<id>/settle`. One Durable Object, one settlement path.

- **Three kinds:** `solo` (a weekly pot against yourself), `h2h` (1v1), `group`.
- **Three goal shapes:** `workouts`, `activeHours`, `activeDays` — all settled from the same verification bar as the core loop.
- **Winners get 100% of their own stake back**, plus an equal share of what the skippers forfeited. The 15% rake comes out of the forfeited pot and never touches a winner. Shares are equal, not proportional to stake.

**Tested:** 19 checks in `competitions`, including the property *a winner never loses money* across eight competition shapes, and that every lamport staked comes back out. **Measured live:** two devnet payouts settled.

---

## 9. The thread

- **Inbound is signed.** Standard Webhooks HMAC-SHA256 over `{id}.{timestamp}.{rawBody}`, five-minute replay window, secret rotation supported. Unsigned, tampered and stale deliveries all 401. **Tested:** 13 checks in `webhook`.
- **Tapbacks.** ❤️ 👍 👎 😂 ‼️ ❓ both ways. A 👍 from you on an offer *is* your yes — the money is locked by the time he speaks. **Tested:** 57 checks in `reactions`.
- **Onboarding copy is fixed text, not a model turn.** The one message explaining how money moves can never be improvised. `help` replays it without the greeting.
- **Opt-out** is honoured on the inbound path, before any model call.
- **Credentials are scrubbed** from anything reaching a trace or an error body. **Tested:** 14 checks in `redaction`.
- **`SNAP_CHANNEL = "trace"`** is checked before the Linq adapter, so a local run can't spend the sandbox's 100-a-day budget even with a real key in `.dev.vars`.

⚠️ **Unverified:** outbound delivery to a real phone. Inbound is confirmed working (4 webhook deliveries, 393 requests, no send failures), but nobody has watched a Snap text land on a handset.

---

## 10. Timezones

The model names an hour on your clock and never converts — asked to do it itself, it turned "gym at 7" into 3am. `startOfWeek` and `endOfLocalDay` resolve the offset **twice**, because the offset on the target midnight can differ from the offset right now. Deadlines render into the model's context as local stamps, not raw UTC.

**Tested:** 18 checks in `time`, as properties over **20,720 instants across 14 zones**. That suite found a real bug: Egypt begins DST at midnight, so the clock reads 23:59 then 01:00 and the midnight we resolved never happens — Snap would have slashed a stake an hour before the user's day was over.

---

## 11. The brain screen

The app has **no chat** — the conversation is in iMessage. The app is onboarding, HealthKit sync, your wallet, and a live trace of every decision.

Fifteen event kinds: `commitment_created`, `alarm_fired`, `context`, `decision`, `message_sent`, `message_received`, `workout_detected`, `stake_held`, `stake_released`, `stake_slashed`, `reaction_sent`, `reaction_received`, `photo_accepted`, `photo_rejected`, `wallet_funded`.

Including the decisions where it stayed quiet. In testing it declined to text at 02:30 with the reason *"texting now would just wake them"*.

When the model returns no reasoning of its own — `message.content` on a `tool_choice: 'required'` call is frequently null — the row now reads *"put a stake on the table, waiting on a yes"* rather than `send_messages + offer_stake`. What it shows honestly is *what it did* and *why the backend refused*, with arguments attached. Claim the guard's reason, not the model's mind.

---

## 12. Demo controls

`POST /debug/message`, `/debug/timewarp`, `/debug/seed`, `/debug/forget`, `/debug/demo`. All gated on the user's bearer token **plus** `X-Debug-Key`; with no `DEBUG_KEY` configured the routes 404 rather than advertising themselves with a 401.

- `/debug/message` delivers a text or a photo straight to the agent without the vendor in the path — which is how agent reliability became measurable at all.
- `/debug/demo` sets `photoMode` (`strict` / `lenient` / `always`) and `allowReplay`. Every override is marked in the trace when used.
- Never call `/debug/timewarp` with a time earlier than real now.

---

## Test suite

```
npm test          # 13 suites, 488 checks
```

| suite | checks |
|---|---|
| guards | 89 |
| photos | 70 |
| reactions and the explainer | 57 |
| context | 52 |
| photo challenges | 43 |
| intensity | 29 |
| competitions | 19 |
| time | 18 |
| wallet top-ups | 17 |
| brain fallback | 14 |
| redaction | 14 |
| webhook signatures | 13 |
| money | 9 |

No jest, no vitest — a 90-line harness, compiled with `tsc` and run on Node.

---

## What is not proven

Said plainly, because a demo that hides these is worse than one that names them.

| | status |
|---|---|
| Outbound Linq delivery to a real handset | **never seen work.** Inbound is confirmed. |
| Intensity picker in iOS onboarding | not built — every app user is `medium` |
| iOS still says "counts at 30 min" | contradicts the 15-minute floor on screen |
| Identity — that the person in the photo is *you* | the gesture proves *when*, not *who* |
| The fingerprint | catches a byte-identical resend; a re-crop gets through |
| On-chain program | none. Custodial, escrow is a wallet, not a PDA |
