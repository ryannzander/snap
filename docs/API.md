# API contract (iOS ↔ backend)

This is the seam between the two of us. Change it only by telling the other person.

Base URL: **`https://snap.snap-backend.workers.dev`**. JSON everywhere. Times are ISO 8601 UTC.
Auth: `Authorization: Bearer <token>` on everything except `/onboard` and `/webhooks/*`.

## POST /onboard

```json
{ "name": "Ryan", "weeklyGoal": 4, "timezone": "America/Toronto" }
```
→
```json
{ "userId": "uuid", "token": "opaque", "linkCode": "4821", "snapContact": { "telegram": "@snap_bro_bot", "imessage": "+1..." } }
```

The app then tells the user to text Snap `yo 4821`. That first inbound message links the chat to the user (and satisfies Linq's text-first rule), after which `/state` reports `linked: true`.

Limits: `name` ≤ 100 characters, `weeklyGoal` a whole number 1–21, `timezone` a valid IANA name. Anything else is a 400.

## POST /workouts

Idempotent on `hkUuid` — the app can resend freely.

```json
{ "workouts": [ { "hkUuid": "…", "type": "traditionalStrengthTraining", "start": "…", "end": "…", "durationSec": 2700, "activeKcal": 310, "source": "com.apple.health.<uuid>", "wasUserEntered": false } ] }
```
→ `{ "accepted": 1 }`

`end` may be null for a workout still in progress. `activeKcal` may be null or omitted.

`accepted` is how many workouts in the request were stored — **resends included**, so `accepted` always equals the number sent. It is not a count of new ones, and `accepted` < sent never happens.

Limits: at most 500 workouts per request, 1 MB of body. Over either is a 400 and nothing is stored.

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
`stake.txSig` is null until the chain transaction lands, and stays null while `stake.status` is `none`.

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

`summary` is always display-ready. `data` is optional detail.

`since` is **exclusive**: pass the `id` of the last event you received and you get events with a strictly greater `id`. Omit it on the first poll. At most 200 events come back per call — if you get exactly 200, poll again straight away rather than waiting out the interval.

## POST /debug/timewarp

Demo only. Requires header `X-Debug-Key`.

```json
{ "now": "2026-09-20T23:24:00Z" }
```

Sets the agent's clock for this user and fires any alarm that is now due. `{ "now": null }` resets.

## POST /debug/seed

Demo only. Requires header `X-Debug-Key`. No body. Seeds a plausible week of history for this user (2/4 done, skipped yesterday, one earlier excuse).

## POST /debug/message

Demo only. Requires header `X-Debug-Key` **and** the bearer token.

```json
{ "text": "gym at 7 tonight" }
```

Delivers a message to the agent exactly as an inbound text does, without the channel vendor in the path. Use it when the messaging channel is unavailable, or to drive the loop without spending the sandbox message budget.

```json
{ "optedOut": false, "ran": true }
```

Unlike the webhook, this **waits for the turn to finish** before responding — there is no delivery service retrying, so the caller gets the decision back rather than having to poll. Expect it to take as long as the model does, up to about 30 seconds. Poll `GET /trace` afterwards for what happened.

`ran` is `false` when no model is configured, and `optedOut` is `true` when the user has opted out — in both cases the message is still recorded.

`text` must be a non-empty string of at most 1000 characters.

## Errors

Every non-2xx response has the same body:

```json
{ "error": { "code": "bad_request", "message": "weeklyGoal must be a whole number between 1 and 21" } }
```

`code`: `bad_request | unauthorized | not_found | method_not_allowed | payload_too_large | internal_error`

`message` is for the debug panel, not the user. A 401 on a call that used to work means the token is dead — onboard again.

## Webhooks (backend only)

- `POST /webhooks/telegram`
- `POST /webhooks/linq` — Linq `message.received`
