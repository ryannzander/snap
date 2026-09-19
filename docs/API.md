# API contract (iOS ↔ backend)

This is the seam between the two of us. Change it only by telling the other person.

Base URL: the deployed Worker (`https://snap.<account>.workers.dev`). JSON everywhere. Times are ISO 8601 UTC.
Auth: `Authorization: Bearer <token>` on everything except `/onboard` and `/webhooks/*`.

**Timestamps.** The backend emits fractional seconds (`2026-09-19T23:24:00.000Z`); the app accepts both forms and sends without them (`2026-09-19T23:24:00Z`). Accept both.

**Optional fields.** The app omits a key rather than sending `null` for an absent optional (`end`, `activeKcal`). Treat missing and `null` the same.

## Errors

Every non-2xx response carries one envelope. The app shows it in the debug panel only.

```json
{ "error": { "code": "bad_request", "message": "weeklyGoal must be 1-21" } }
```

A `401` means the token is dead: the app stops polling until "reset app" in the debug panel. Nothing else stops it.

## POST /onboard

```json
{ "name": "Ryan", "weeklyGoal": 4, "timezone": "America/Toronto" }
```
→
```json
{ "userId": "uuid", "token": "opaque", "linkCode": "4821", "snapContact": { "telegram": "@snap_bro_bot", "imessage": "+1..." } }
```

The app then tells the user to text Snap `yo 4821`. That first inbound message links the chat to the user (and satisfies Linq's text-first rule).

## POST /workouts

Idempotent on `hkUuid` — the app can resend freely.

```json
{ "workouts": [ { "hkUuid": "…", "type": "traditionalStrengthTraining", "start": "…", "end": "…", "durationSec": 2700, "activeKcal": 310, "source": "com.apple.health.<uuid>", "wasUserEntered": false } ] }
```
→ `{ "accepted": 1 }`

`end` may be null for a workout still in progress.

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

`stake` may be absent and `txSig` may be `null` until the chain transaction lands. A value the app doesn't know for either `status` decodes as `unknown` and draws nothing, so adding one is safe — tell the other person anyway.

On `slashed` the stake also carries the split. A miss returns half and forfeits half; the two always sum to `lamports`, and an odd lamport goes back to the user.

```json
"stake": { "lamports": 50000001, "status": "slashed", "txSig": "…",
           "refundedLamports": 25000001, "forfeitedLamports": 25000000 }
```

Commitments are ordered oldest first; the app shows the open one, or the last one when none is open.

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

`kind`: `commitment_created | alarm_fired | context | decision | message_sent | message_received | workout_detected | stake_held | stake_released | stake_slashed | stay_quiet`

`summary` is always display-ready. `data` is optional detail; on `decision` the app shows `data.reasoning` under the summary when present. An unknown `kind` still renders (as a plain row), and one malformed event is dropped without losing the rest of the page.

`since` is exclusive: return events with `id > since`. Ids are positive integers, increasing. At most **200** events per response — the app treats a full page as "more waiting" and fetches again immediately.

## POST /debug/timewarp

Demo only. Requires header `X-Debug-Key`.

```json
{ "now": "2026-09-20T23:24:00Z" }
```

Sets the agent's clock for this user and fires any alarm that is now due. `{ "now": null }` resets.

## POST /debug/seed

Demo only. Requires header `X-Debug-Key`. No body. Seeds a plausible week of history for this user (2/4 done, skipped yesterday, one earlier excuse).

## Webhooks (backend only)

- `POST /webhooks/telegram`
- `POST /webhooks/linq` — Linq `message.received`
