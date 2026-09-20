# API contract (iOS ↔ backend)

This is the seam between the two of us. Change it only by telling the other person.

Base URL: **`https://snap.snap-backend.workers.dev`**. JSON everywhere. Times are ISO 8601 UTC.
Auth: `Authorization: Bearer <token>` on everything except `/onboard` and `/webhooks/*`.

**Timestamps.** The backend serializes with `toISOString()`, which always emits fractional seconds (`2026-09-19T23:24:00.000Z`). The app accepts both forms and sends without them (`2026-09-19T23:24:00Z`). Accept both, everywhere.

**Optional fields.** The app omits a key rather than sending `null` for an absent optional (`end`, `activeKcal`). The backend treats missing and `null` identically on every field where both are legal.

**Unknown values degrade.** Any `status` or trace `kind` the app doesn't recognise decodes as `unknown` and draws a plain row rather than failing the response — so adding one is safe. Tell the other person anyway.

## POST /onboard

```json
{ "name": "Ryan", "weeklyGoal": 4, "timezone": "America/Toronto", "intensity": "medium" }
```
→
```json
{ "userId": "uuid", "token": "opaque", "linkCode": "4821", "snapContact": { "telegram": "@snap_bro_bot", "imessage": "+1..." } }
```

The app then tells the user to text Snap `yo 4821`. That first inbound message links the chat to the user (and satisfies Linq's text-first rule), after which `/state` reports `linked: true`.

Linking sends the thread's onboarding: what Snap does, that a plan is a text, that the money is theirs and comes back if they train, that a 👍 is how they agree to a stake, that the watch is the referee, and that the wallet lives in the app. It is fixed copy, not a model turn — the one message that explains how money moves can never be improvised. Texting `help` (or "how does this work") replays it without the greeting.

Limits: `name` ≤ 100 characters and non-empty after trimming, `weeklyGoal` a whole number 1–21, `timezone` a zone name the runtime knows. Anything else is a 400.

`intensity` is **optional and additive** — omit it and the user is `medium`, exactly as before. It is `easy`, `medium` or `hard`; anything else is a 400 (`intensity must be easy, medium or hard`). It is the pressure dial, and it moves three things and nothing else:

| | grace before the first "where are you" | default stake when no amount is named | morning check-in |
|---|---|---|---|
| `easy` | 45 min | 0.02 SOL | no |
| `medium` | 20 min | 0.05 SOL | yes |
| `hard` | 10 min | 0.1 SOL | yes |

It also picks the voice Snap is handed for the turn. It does **not** choose workouts, sets, body parts or a plan — see `ROADMAP.md`, "Anti-coach".

A new wallet is funded to cover the hardest mode's stake plus fees, so picking `hard` never means the first offer is refused for want of money.

`token` is opaque to the app. Store it in the Keychain and send it on everything below.

## POST /workouts

Idempotent on `hkUuid` — the app can resend freely.

```json
{ "workouts": [ { "hkUuid": "…", "type": "traditionalStrengthTraining", "start": "…", "end": "…", "durationSec": 2700, "activeKcal": 310, "source": "com.apple.health.<uuid>", "wasUserEntered": false } ] }
```
→ `{ "accepted": 1 }`

`end` may be null or omitted for a workout still in progress. `activeKcal` and `source` may be null or omitted. `wasUserEntered` may be omitted, and absent means `false`.

`accepted` is how many workouts the request stored — **resends included**, so a resend never looks like a rejection. Duplicate `hkUuid`s *within one request* are collapsed first (last one wins), so `accepted` is the number of distinct `hkUuid`s sent, not the array length.

A resend merges forwards only: `end` and `activeKcal` never go back to null, `durationSec` never shrinks, and `wasUserEntered: true` is sticky — once a sample is known to be hand-typed, a later resend cannot turn it back into a stake-releasing one.

Limits: at most 500 workouts per request (over that is a 400), and 1 MB of body (over that is a **413 `payload_too_large`**). Nothing is stored in either case.

`source` is the bundle id of whatever wrote the sample — an Apple Watch, Strava, Hevy, or Snap itself. `wasUserEntered` is true when a human typed the workout into the Health app instead of recording it.

**A workout with `wasUserEntered: true` must never release a stake.** Anyone can open Health → Workouts → Add Data and invent one, and "Snap knows rather than asks" has to survive a judge trying exactly that. Treat it as absent for release, but still store it so the trace can say why it was ignored.

## GET /state

Everything the app needs to draw its one screen.

```json
{
  "weeklyGoal": 4,
  "workoutsThisWeek": 2,
  "linked": true,
  "commitments": [
    {
      "id": "c_123",
      "text": "gym at 7",
      "dueAt": "…",
      "graceMin": 20,
      "status": "pending",
      "stake": { "lamports": 50000000, "status": "held", "txSig": "…" },
      "reschedules": [],
      "proof": null,
      "verifiedBy": null
    }
  ]
}
```

`commitment.status`: `pending | met | missed | renegotiated`
`stake.status`: `none | held | released | slashed`
`commitment.verifiedBy`: `photo | watch | null`

`reschedules` is every time the session was moved, oldest first: `{ "at", "from", "to" }`. The app prints the list on the plan card — moving a session is allowed, doing it quietly is not. It may be absent on a commitment stored before the log existed; treat that as empty.

**The photo is the verifier.** `proof` is null until a photo the user texted passes verification, and then it is `{ "at": "…", "description": "one sentence of what the model saw" }`. An open commitment with `proof: null` is the app's cue to ask for a picture; a settled one carries `verifiedBy` so the app can say which verifier paid. `description` is shown to the user — being told what Snap thought he was looking at is the difference between a verdict and a black box.

`verifiedBy: "watch"` means they trained, never sent a picture, and HealthKit covered them anyway (see **Verification** below). It is worth surfacing: that line is the only place a user learns the fallback exists. An unknown value degrades to null rather than failing the response.
`stake` is always sent. `stake.txSig` is null until the chain transaction lands, stays null while `stake.status` is `none`, and stays null indefinitely if the chain call failed — the loop continues without it and the trace says so.

**`slashed` means the whole stake is forfeited, to Snap's treasury wallet.** A half-back-to-the-user split was briefly built and then withdrawn; nothing on the wire describes a partial refund, and nothing should imply one in copy.

Commitments come back oldest first, ordered by `dueAt`. The app shows the open one (`pending` or `renegotiated`), or the last one when none is open.

`workoutsThisWeek` counts from **Monday 00:00 in the user's own timezone**, not UTC, and counts a session verified by *either* verifier. Qualifying workouts count, and a photo-verified commitment adds one more **only on a local day that has no qualifying workout of its own** — someone who trains with a watch on and also sends a picture did one session, and counting it twice would flatter the goal.

A workout qualifies when it runs 30 minutes or longer, `wasUserEntered` is false, and its `type` is one of: `traditionalStrengthTraining`, `functionalStrengthTraining`, `coreTraining`, `crossTraining`, `highIntensityIntervalTraining`, `running`, `cycling`, `rowing`, `elliptical`, `stairClimbing`, `swimming`, `mixedCardio`.

A workout also has to average at least **2 active kcal/min**. Type, duration and `wasUserEntered` together still let someone press start on the Watch, sit in a car for 45 minutes and release a stake — the session is genuinely *recorded*, nobody typed it, and nobody moved. Active energy excludes basal metabolism, so sitting reads near zero while real strength work runs 5-8 kcal/min and running 10-15.

That floor is only applied when `activeKcal` is actually present **and above zero**. A source that records no calories (some Strava and Hevy exports) is never rejected for it, and an exact zero is read as "the sensor recorded nothing" rather than "nobody moved" — failing an honest workout costs far more than missing a lazy cheat.

This is deliberately the same bar that releases a stake: if a thing cannot release your money it must not fill a goal dot either. A workout still in progress (`end: null`) counts once it passes 30 minutes. Everything posted is still stored and still appears in the trace — one that does not qualify says why (`doesn't count as training`, `under 30 min`, `typed in by hand`, `barely moved`).

## Rescheduling

One move per commitment, ever, **and only while more than an hour is left before the deadline**. Inside the last hour — or at any point after it has passed — the answer is no, whatever the excuse. An hour out you are rearranging your day; ten minutes out you are getting out of it, and that is the window every excuse ever invented arrives in.

The new time must also be more than an hour away, or one move would hand back exactly what the window takes away, and it must still land before end of local day — the slash lands there regardless, so a move past midnight would put the deadline after the consequence.

Refusals come back through the normal refusal path: the trace says `refused reschedule_commitment — <reason>` and Snap tells the user, rather than silently agreeing and then slashing on the original deadline.

Every accepted move is appended to `commitment.reschedules` and shown to both sides — the app prints it on the plan card, and the agent sees each move on their clock plus a week-wide `sessions moved this week: N`, so a pattern can be called out ("third one this week bro") instead of only a per-commitment limit being enforced.

## Verification

A stake is released by a **verified photo**, or by a covering HealthKit workout as a silent fallback. Nothing else — a model that decides someone trained because they said so is the failure the guards exist to prevent.

### The photo

The user texts a picture. The backend fetches it, asks the vision model for a verdict, and **moves the money before the agent says a word** — a turn that decides for itself whether a picture counts is a turn that can be talked into paying out.

A photo is proof only when a real person is visibly in it, in a setting that reads as training. These are refused, in this order:

| refused | because |
|---|---|
| a screenshot, or a photo of a screen | a workout summary, a watch face, somebody else's post — the likeliest fake, refused however confident the model is about what is in it |
| nobody in the shot | an empty rack is a room, not a session |
| not training | a meal, a pet, a selfie somewhere that is not a gym |
| below 0.6 confidence | a coin flip must not release a stake — this is `unsure`, which gets a second chance in Snap's voice rather than a roast |
| a photo already counted | every image is fingerprinted (SHA-256 of the bytes); the same picture cannot release two stakes |

The fingerprint catches the obvious attack — sending Monday's gym selfie again on Tuesday — and nothing else. A re-crop, a re-save or a screenshot of the same photo hashes differently and gets through. This raises the cost of cheating; it does not close it. The honest defence is that the watch is still there underneath.

Each outcome writes a trace event (`photo_accepted` / `photo_rejected`) and hands the agent what already happened, so Snap says what the backend did rather than deciding it.

### The watch

HealthKit is the fallback, not the pitch. A covering workout still releases the stake for someone who trained and forgot to send a picture, and the app then says `verifiedBy: "watch"` — "no pic, but your watch covered you". It is deliberately **not** mentioned in the thread's onboarding: a user told up front that the watch will cover them hears "the pic is optional", which is the one thing it must not sound like. They find out the first time it saves them.

A commitment with either verifier can never be slashed.

## GET /wallet

The money, from the app's side. Everything a stake comes out of and goes back into.

```json
{
  "address": "7Xc…",
  "cluster": "devnet",
  "balanceLamports": 150000000,
  "heldLamports": 50000000,
  "funded": true,
  "entries": [
    { "id": 3, "kind": "held", "lamports": 50000000, "label": "gym at 7", "at": "…", "txSig": "…" },
    { "id": 2, "kind": "funded", "lamports": 200000000, "label": "you added money", "at": "…", "txSig": "…" }
  ]
}
```

`balanceLamports` is read from the chain and is **null when the RPC could not be reached**. Null is not zero, and the app must not draw it as one: one means "we can't see it", the other means "it's empty", and under a stake those read very differently.

`heldLamports` is what has already *left* the wallet into escrow — the sum of open commitments whose `stake.status` is `held`, plus competition entries that have not settled. It is never part of `balanceLamports`; adding the two is what the user thinks of as "my money", and the app says so rather than showing one number.

`entries` is the ledger, newest first, at most 40: `kind` is `funded | held | released | slashed`, `lamports` is always positive (the kind says which way it went), and `txSig` is null until the chain confirms — same rule as `stake.txSig`. An unknown `kind` still renders as a row.

The wallet is **custodial on devnet**: the backend holds the key, and the address is the one it holds. It is created at `/onboard` and funded from Snap's treasury in the background, so a new user can stake within seconds of linking.

## POST /wallet/topup

Adds money. On devnet the source is Snap's treasury — there is no card to charge, and the public faucet rate-limits too hard to put on a stage.

```json
{ "sol": 0.1 }
```
→ the same body as `GET /wallet`, plus `addedLamports` and `txSig`.

Limits: 0.01 to 1 SOL per call, and the call is refused if it would put the wallet over a 2 SOL ceiling (a 400 either way). **The response is the wallet as it actually is afterwards** — the app must draw that, never a locally guessed balance, because a top-up that failed on-chain plus an optimistic number on screen is how someone agrees to a stake they cannot cover.

`503 chain_unavailable` means the transfer did not land and no money moved. Nothing is recorded in that case.

**A stake is refused when the wallet cannot cover it**, leaving 0.005 SOL of fee headroom: the agent's `create_commitment`, `offer_stake` and `accept_offer` all fail the guard, the trace says how much is there and how much was needed, and Snap tells the user to top up instead of pretending the money locked. When the chain is unreachable the check passes rather than telling a user they are broke on a devnet hiccup.

## GET /trace?since=<eventId>

The "Snap's brain" feed. Poll every 1–2 s. (WebSocket at `/trace/ws` is a stretch goal — same event shape.)

```json
{ "events": [
  { "id": 41, "ts": "…", "kind": "alarm_fired", "summary": "7:24 — checking on gym at 7" },
  { "id": 42, "ts": "…", "kind": "context", "summary": "no workout today · skipped yesterday · 2/4 this week · 0.05 SOL staked" },
  { "id": 43, "ts": "…", "kind": "decision", "summary": "intervene — firm", "data": { "reasoning": "…" } },
  { "id": 44, "ts": "…", "kind": "message_sent", "summary": "bro" }
] }
```

`kind`: `commitment_created | alarm_fired | context | decision | message_sent | message_received | reaction_sent | reaction_received | photo_accepted | photo_rejected | workout_detected | stake_held | stake_released | stake_slashed | wallet_funded`

A turn where the agent looked and chose not to text is **not** its own kind — it arrives as a `decision` whose summary reads `stayed quiet — <reason>`.

A tapback is `reaction_sent` (Snap reacted to them) or `reaction_received` (they reacted to Snap). The summary is `<emoji> on: <the message it was aimed at>`, or just `<emoji>` when the backend does not know which message. Snap's own tapbacks always name the user's last message, because that is the only one he reacts to. An inbound tapback is matched against the last ten texts Snap sent, by the id the channel returned for each — a tapback on something older, or delivered through a channel that does not return ids, arrives unlabelled rather than mislabelled. A removed tapback reads `<emoji> took back on: …`. `data` carries `{ emoji, name, targetMessageId, removed }`, where `name` is one of the six iMessage slots (`love | like | dislike | laugh | emphasize | question`) or null for an emoji outside them. The app draws these as a small capsule tucked against the bubble they belong to — Snap's on the right, the user's on the left.

A photo the user texts arrives as a `message_received` whose summary starts with `📷` (the caption, or `sent a photo`), with the URLs in `data.imageUrls`, followed by a `context` row `looked at the photo · <description>` (or a `decision` saying the photo could not be seen). Then the verdict: `photo_accepted` (`proof · 0.05 SOL back on "gym at 7"`, or `proof · nothing on the line for it`) or `photo_rejected` (`not proof · that's a screenshot`). The agent's reply follows as usual, and it is told which of those happened rather than deciding it.

`summary` is always display-ready. `data` is optional detail, and its contents are not part of this contract with one exception: on `decision`, `data.reasoning` is the agent's own words and the app shows it under the summary when present. Anything else in `data`, or a `data` that isn't an object, must be ignored rather than treated as fatal. An unknown `kind` still renders as a plain row, and one malformed event is dropped without losing the rest of the page.

`id` is a positive integer starting at 1 and increasing. `since` is **exclusive**: pass the `id` of the last event you received and you get events with a strictly greater `id`. Omit it on the first poll. It must be a whole number between 0 and 1000000000000, or you get a 400.

At most **200** events come back per call — if you get exactly 200, poll again straight away rather than waiting out the interval.

**`POST /debug/seed` restarts ids at 1.** It clears the trace feed, so a client holding a `since` cursor from before the seed will see nothing afterwards. Reset the cursor (and the on-screen feed) whenever you seed.

## POST /debug/timewarp

Demo only. Requires header `X-Debug-Key` **and** the bearer token — it is not a way in, it is a way to move one user's clock. With no `DEBUG_KEY` configured on the Worker the route answers 404 rather than advertising itself with a 401.

```json
{ "now": "2026-09-20T23:24:00Z" }
```

Sets the agent's clock for this user and fires any alarm that is now due. `{ "now": null }` resets to real time — send an explicit `null`, not an omitted key.

```json
{ "now": "2026-09-20T23:24:00.000Z", "fired": 2 }
```

## POST /debug/seed

Demo only. Requires header `X-Debug-Key` **and** the bearer token; 404 when `DEBUG_KEY` is unset. No body.

Seeds a plausible week of history for this user (2/4 done, skipped yesterday, one earlier excuse). Clears that user's workouts, commitments, trace, spent photo fingerprints and alarms first, so the demo can be rehearsed from the same starting point repeatedly, then re-books the morning check-in. The chat link and the token survive.

```json
{ "workouts": 2, "commitments": 1 }
```

## POST /debug/forget

Demo only. Requires header `X-Debug-Key` **and** the bearer token; 404 when `DEBUG_KEY` is unset. No body.

The server half of the app's "reset app". Deletes everything stored for this user — profile, token, commitments, workouts, trace, fingerprints — disarms the alarm, and releases the chat binding and link code so the thread is free for whoever onboards next.

Unlike `/debug/seed`, nothing survives: the bearer token used to call it is invalid immediately afterwards. Without it a phone-side reset leaves the agent running — its alarms keep firing and it keeps texting the thread about a commitment made before the reset.

The chat is only released if it is still bound to this user, so a reset that races a re-link cannot cut the new thread loose.

```json
{ "channel": "linq", "chatId": "+15555550123", "linkCode": "4821" }
```

## POST /debug/message

Demo only. Requires header `X-Debug-Key` **and** the bearer token; 404 when `DEBUG_KEY` is unset.

```json
{ "text": "gym at 7 tonight" }
```

Delivers a message to the agent exactly as an inbound text does, without the channel vendor in the path. Use it when the messaging channel is unavailable, or to drive the loop without spending the sandbox message budget.

```json
{ "optedOut": false, "ran": true }
```

Unlike the webhook, this **waits for the turn to finish** before responding — there is no delivery service retrying, so the caller gets the decision back rather than having to poll. Expect it to take as long as the model does, up to about 30 seconds. Poll `GET /trace` afterwards for what happened.

`ran` is `false` when no model is configured, and `optedOut` is `true` when the user has opted out — in both cases the message is still recorded.

`text` must be a non-empty string of at most 1000 characters — unless `imageUrl` is sent, in which case `text` may be empty and acts as the caption.

```json
{ "text": "pump check", "imageUrl": "https://example.com/gym.jpg" }
```

`imageUrl` makes it a **photo turn**: the backend fetches the image, verifies it with the vision model, traces the verdict, settles the stake if it passed, and the agent reacts. This is how the photo beat is rehearsed without spending the sandbox message budget — and it is the only way to drive verification from a script, since there is no upload endpoint. **It moves real money**, so the same picture will not work twice.

## Competitions

`ROADMAP.md` → "Competitions": a pot, a rule, a set of entrants, and an oracle that settles it from HealthKit. Three kinds — `solo`, `h2h`, `group` — differ only in how many people are in the entrant list.

**Verification is the same bar as a stake.** A session counts toward a goal only if it would release a stake — a verified photo, or a qualifying workout (30 minutes or longer, `wasUserEntered` false, an accepted type). A competition that counts a walk while the core loop refuses it would make "it knows" untrue the moment money is involved.

### POST /competitions

Creates one and enters you into it. The creator is always the first entrant.

```json
{
  "kind": "h2h",
  "name": "me vs tyler, 3 sessions by sunday",
  "goal": { "type": "workouts", "target": 3 },
  "sol": 0.1,
  "days": 7
}
```

`kind`: `solo | h2h | group` (default `group`). `h2h` is capped at two entrants.
`goal.type`: `workouts` (sessions) | `activeHours` (summed duration) | `activeDays` (distinct local days).
`sol`: entry stake, default 0.05, between 0.001 and 1.
`days`: 1–90, default 7.

Returns the competition (below). Entering locks the stake into escrow immediately.

### POST /competitions/join

```json
{ "joinCode": "Y9QT8P" }
```

Six characters, no vowels and no `0/1/I/O`, so it survives being read aloud or typed from a screenshot. Joining twice is a no-op rather than a second stake.

### GET /competitions

`{ "competitions": [ … ] }` — every competition you are in, each with live standings.

### GET /competitions/&lt;id&gt;

```json
{
  "id": "comp_5aa4c7b7",
  "kind": "h2h",
  "name": "me vs tyler, 3 sessions by sunday",
  "goal": { "type": "workouts", "target": 3 },
  "entryLamports": 100000000,
  "rakeBps": 1500,
  "joinCode": "Y9QT8P",
  "startsAt": "…", "endsAt": "…",
  "status": "open",
  "entrants": [ { "userId": "…", "name": "Ryan", "stakeLamports": 100000000, "entryTxSig": "…" } ],
  "standings": [ { "userId": "…", "name": "Ryan", "progress": 3, "met": true, "stakeLamports": 100000000 } ]
}
```

`standings` are recomputed from HealthKit on every read, never stored. `progress` is in the goal's own unit — sessions, hours (two decimals) or days.

`status`: `open | settled`. A settled competition also carries `potLamports`, `rakeLamports`, `settledAt`, and per-entrant `progress`, `met`, `payoutLamports`, `payoutTxSig`.

### POST /competitions/&lt;id&gt;/settle

Demo only — requires `X-Debug-Key` as well as the bearer token, because settling early moves real money. A competition settles itself when `endsAt` passes; this is the button for the stage.

Settling twice is safe: a settled competition returns unchanged rather than paying out again.

### How the money splits

**Winners get 100% of their own stake back**, always. The rake comes out of what the skippers forfeited, never out of a winner — a haircut on winners turns the stake into a fee and people stop staking.

| | |
|---|---|
| pot | sum of the losers' stakes |
| rake | 15% of the pot, to the house |
| each winner | their own stake + an equal share of the rest |
| nobody wins | the whole pot goes to the house |
| everybody wins | no pot, no rake, everyone gets exactly their stake back |

Shares are **equal, not proportional to stake** — a competition is a contest of showing up, and paying the biggest wallet the biggest share would make it a contest of wallets. Leftover lamports from integer division go to the house rather than to whichever winner sorts first, so the books always balance exactly.

## Errors

Every non-2xx response has the same body:

```json
{ "error": { "code": "bad_request", "message": "weeklyGoal must be a whole number between 1 and 21" } }
```

| status | `code` | when |
|---|---|---|
| 400 | `bad_request` | anything that failed validation |
| 401 | `unauthorized` | missing, malformed or wrong bearer token — or a wrong `X-Debug-Key` on a `/debug/*` route |
| 401 | `bad_signature` | `/webhooks/linq` only |
| 404 | `not_found` | no such route, or a `/debug/*` route with no `DEBUG_KEY` configured |
| 405 | `method_not_allowed` | right path, wrong verb |
| 409 | `already_onboarded` | `/onboard` for a user that already exists |
| 413 | `payload_too_large` | body over 1 MB |
| 500 | `internal_error` | anything unhandled |
| 503 | `chain_unavailable` | `/wallet/topup` only — devnet would not take the transfer, or no treasury is configured. No money moved. |

`message` is for the debug panel, not the user.

**A 401 on a call that used to work means the token is dead** — every subsequent call fails identically, so the app stops polling rather than spraying the same error once a second. Recovery is "reset app" in the debug panel, deliberately not automatic. Nothing else stops the poll.

## Webhooks (backend only)

- `POST /webhooks/linq` — Linq `message.received` (text parts, and image parts as photos), Standard Webhooks signature (`webhook-id` / `webhook-timestamp` / `webhook-signature`), 5-minute replay window, deliveries de-duplicated by event id. Always answers 200 for anything it cannot route, because a retry of an unroutable message is no more routable the second time.

  Tapbacks arrive here too, as `message.reaction` / `reaction.received` / `reaction.removed`, or as a `reaction`/`tapback` part inside an ordinary delivery — Linq has used both shapes, so both are read. A reaction is routed apart from messages: it can never carry a link code, an unlinked chat is ignored, and the agent's turn on one is told plainly that a tapback is usually not worth answering.

  **A 👍 or ❤️ on a standing stake offer is an acceptance** and locks the money, decided in the backend rather than by the model — "did they agree?" is not a judgement call when the answer is a thumbs up. Nothing else about the six reaction slots moves money. This is said out loud in the thread's onboarding, because a tapback that quietly takes money and was never explained is a trap.
- `POST /webhooks/telegram` — planned, **not routed yet** (currently 404).
