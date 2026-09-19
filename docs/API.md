# API contract (iOS ↔ backend)

This is the seam between the two of us. Change it only by telling the other person.

Base URL: **`https://snap.snap-backend.workers.dev`**. JSON everywhere. Times are ISO 8601 UTC.
Auth: `Authorization: Bearer <token>` on everything except `/onboard` and `/webhooks/*`.

**Timestamps.** The backend serializes with `toISOString()`, which always emits fractional seconds (`2026-09-19T23:24:00.000Z`). The app accepts both forms and sends without them (`2026-09-19T23:24:00Z`). Accept both, everywhere.

**Optional fields.** The app omits a key rather than sending `null` for an absent optional (`end`, `activeKcal`). The backend treats missing and `null` identically on every field where both are legal.

**Unknown values degrade.** Any `status` or trace `kind` the app doesn't recognise decodes as `unknown` and draws a plain row rather than failing the response — so adding one is safe. Tell the other person anyway.

## POST /onboard

```json
{ "name": "Ryan", "weeklyGoal": 4, "timezone": "America/Toronto" }
```
→
```json
{ "userId": "uuid", "token": "opaque", "linkCode": "4821", "snapContact": { "telegram": "@snap_bro_bot", "imessage": "+1..." } }
```

The app then tells the user to text Snap `yo 4821`. That first inbound message links the chat to the user (and satisfies Linq's text-first rule), after which `/state` reports `linked: true`.

Limits: `name` ≤ 100 characters and non-empty after trimming, `weeklyGoal` a whole number 1–21, `timezone` a zone name the runtime knows. Anything else is a 400.

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
      "stake": { "lamports": 50000000, "status": "held", "txSig": "…" }
    }
  ]
}
```

`commitment.status`: `pending | met | missed | renegotiated`
`stake.status`: `none | held | released | slashed`
`stake` is always sent. `stake.txSig` is null until the chain transaction lands, stays null while `stake.status` is `none`, and stays null indefinitely if the chain call failed — the loop continues without it and the trace says so.

**`slashed` means the whole stake is forfeited, to Snap's treasury wallet.** A half-back-to-the-user split was briefly built and then withdrawn; nothing on the wire describes a partial refund, and nothing should imply one in copy.

Commitments come back oldest first, ordered by `dueAt`. The app shows the open one (`pending` or `renegotiated`), or the last one when none is open.

`workoutsThisWeek` counts from **Monday 00:00 in the user's own timezone**, not UTC, and counts only workouts that *qualify* — not every workout posted. A workout qualifies when it runs 30 minutes or longer, `wasUserEntered` is false, and its `type` is one of: `traditionalStrengthTraining`, `functionalStrengthTraining`, `coreTraining`, `crossTraining`, `highIntensityIntervalTraining`, `running`, `cycling`, `rowing`, `elliptical`, `stairClimbing`, `swimming`, `mixedCardio`.

This is deliberately the same bar that releases a stake: if a 30-minute walk cannot release your money, it must not fill a goal dot either. A workout still in progress (`end: null`) counts once it passes 30 minutes. Everything posted is still stored and still appears in the trace — one that does not qualify says why (`doesn't count as training`, `under 30 min`, `typed in by hand`).

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

`kind`: `commitment_created | alarm_fired | context | decision | message_sent | message_received | workout_detected | stake_held | stake_released | stake_slashed`

A turn where the agent looked and chose not to text is **not** its own kind — it arrives as a `decision` whose summary reads `stayed quiet — <reason>`.

A photo the user texts arrives as a `message_received` whose summary starts with `📷` (the caption, or `sent a photo`), with the URLs in `data.imageUrls`, followed by a `context` row `looked at the photo · <description>` (or a `decision` saying the photo could not be seen). The agent's reply follows as usual.

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

Seeds a plausible week of history for this user (2/4 done, skipped yesterday, one earlier excuse). Clears that user's workouts, commitments, trace and alarms first, so the demo can be rehearsed from the same starting point repeatedly. The chat link and the token survive.

```json
{ "workouts": 2, "commitments": 1 }
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

`imageUrl` makes it a **photo turn**: the backend fetches the image, describes it with the vision model, traces the look, and the agent reacts to the description. This is how the photo beat is rehearsed without spending the sandbox message budget. A photo never releases a stake — release still needs a covering HealthKit workout.

## Competitions

`ROADMAP.md` → "Competitions": a pot, a rule, a set of entrants, and an oracle that settles it from HealthKit. Three kinds — `solo`, `h2h`, `group` — differ only in how many people are in the entrant list.

**Verification is the same bar as a stake.** A workout counts toward a goal only if it would release a stake: 30 minutes or longer, `wasUserEntered` false, and an accepted type. A competition that counts a walk while the core loop refuses it would make "it knows" untrue the moment money is involved.

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

`message` is for the debug panel, not the user.

**A 401 on a call that used to work means the token is dead** — every subsequent call fails identically, so the app stops polling rather than spraying the same error once a second. Recovery is "reset app" in the debug panel, deliberately not automatic. Nothing else stops the poll.

## Webhooks (backend only)

- `POST /webhooks/linq` — Linq `message.received` (text parts, and image parts as photos), Standard Webhooks signature (`webhook-id` / `webhook-timestamp` / `webhook-signature`), 5-minute replay window, deliveries de-duplicated by event id. Always answers 200 for anything it cannot route, because a retry of an unroutable message is no more routable the second time.
- `POST /webhooks/telegram` — planned, **not routed yet** (currently 404).
