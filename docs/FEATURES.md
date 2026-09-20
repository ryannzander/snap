# What Snap actually does

Everything in this file is built, deployed and reachable at `https://snap.snap-backend.workers.dev`. Nothing here is a plan.

---

## The loop

You text a plan → Snap offers a stake → you agree → the money is held on devnet → the deadline passes → **Snap texts you first** → you send a pic from the gym → a vision model judges it → the stake comes back. Don't go, and at the end of your local day it's gone.

The whole product is in one sentence: **a motivator is something you can ignore.**

## The six things a judge should look for

### 1. It texts first, with no cron job anywhere
A Durable Object gets exactly one alarm, so wake-ups live in a key-sorted queue — `alarm:<14-digit-timestamp>:<kind>` — and a range scan finds everything due. Three kinds fire: `grace` (the first "where are you"), `end_of_day` (the money moves), `morning` (no plan today, so he asks). The agent schedules its own future.

### 2. The model can't move money
Nine tools. Three of them touch money and none of them reach the chain. Every proposed call goes through a pure guard first — `guardCreate`, `guardOffer`, `guardAccept`, `guardReschedule`, `guardRelease`, `guardSlash`. Both models we tested tried to take the money at the grace mark; it was refused every time, because grace is a warning and the money moves at end of day.

Settlement isn't the model's call at all: whether a photo is proof, whether a workout covers a commitment, and when the day ends are answered by the vision verdict, HealthKit and the clock. The model gets handed the outcome and only does the talking — and **actions run before any talking**, so a refused reschedule can't be announced as a yes.

### 3. Two verifiers, and neither is your word for it
- **The photo.** A vision model checks a real person is visibly training, refuses screenshots, needs 0.6 confidence, and every image is SHA-256 fingerprinted so Monday's selfie can't be spent twice. **It does not check that the person is you** — say that before a judge finds it.
- **The gesture.** Every stake names one at random the moment it locks — *3 fingers up in the pic* — and the photo has to have it. A picture you already had can't, because nobody knew which gesture until your money moved. That's what turns "prove you trained" into "prove you trained *now*", and it's the answer to the first thing a skeptical judge tries: sending a gym photo that isn't theirs. Miss the gesture and nothing moves; it's `unsure`, not an accusation, so Snap asks again instead of roasting you.
- **HealthKit underneath.** Pays you when you trained and forgot to send anything. `wasUserEntered: true` never releases money — opening Health → Add Data and inventing a session doesn't work — and a session nobody moved in ("barely moved", under 2 active kcal/min) doesn't either.

Whatever fails says why, in the trace: `doesn't count as training`, `under 15 min`, `typed in by hand`, `barely moved`, `i asked for 3 fingers up in the pic — can't see it`.

### 4. The floor catches fakes, not bad days
15 minutes releases the money. It used to be 30, which punished the exact behaviour the stake is buying: drive there, warm up, feel awful, leave early — you still turned up, so you still get paid. What you were *aiming* for is the intensity target, and Snap says it out loud without ever enforcing it with money.

### 5. It negotiates, and it remembers
One reschedule per commitment, ever, and only while there's more than an hour left — inside the last hour you're weaselling, not rearranging. Snap reads your history before deciding: the same excuse you used yesterday gets called. Every move is logged, and "third one this week bro" comes off the log.

### 6. You can watch it think
The app has no chat — the conversation is in iMessage. The app is onboarding, HealthKit sync, your wallet, and a live trace of every decision **including the ones where it stayed quiet**. In testing it declined to text at 02:30 with the reason *"texting now would just wake them"*.

---

## The dial: easy / medium / hard

Picked at onboarding. It moves how hard Snap pushes, and nothing else.

**Known gap for the demo:** the iOS onboarding flow doesn't offer the picker yet, so a user created through the app is always `medium`. Onboard the demo user by curl with `"intensity":"hard"`, or leave the dial out of the pitch.

| | session target | grace before the first nudge | stake he opens with | texts first in the morning |
|---|---|---|---|---|
| easy | 30 min | 45 min | 0.02 SOL | no |
| medium | 45 min | 20 min | 0.05 SOL | yes |
| hard | 60 min | 10 min | 0.1 SOL | yes |

It also swaps the voice he's handed for the turn. **The target is not a gate** — coming in under it is something he says, never something that keeps your money. Release is the same 15-minute floor for everyone.

**It does not tell you what to train.** No sets, no macros, no push day. That's the line between a friend who holds your money and the twenty GPT wrappers in the same room.

## The money

- **Yours to size.** Snap opens with the dial's number and says "or name your own" — anything from **0.01 SOL** up to 1 SOL.
- **Real devnet transfers**, real signatures, each polled to `confirmed` against the cluster rather than trusted from our own logs. If we stop waiting before the cluster answers, the signature is kept anyway — a receipt you can open in Explorer beats our certainty.
- **Custodial, and we say so.** The backend holds the keys, the escrow is a wallet rather than a PDA, there's no on-chain program yet. The fallback path was built first on purpose so the loop was real end to end; the Anchor program drops in behind the same three calls.
- A new wallet is funded to cover the hardest mode's stake plus fees, so picking hard never means the first offer bounces.

## Competitions

1v1, group pots and a solo weekly pot, settled from HealthKit. Three goal shapes: sessions, active hours, distinct active days.

Winners get **100% of their own stake back**, plus an equal share of what the skippers forfeited. The 15% rake comes out of the forfeited pot and never touches a winner. Asserted over eight shapes in the test suite, as the property *a winner never loses money*.

## The plumbing that keeps it honest

- **Inbound is signed.** Standard Webhooks HMAC-SHA256 over `{id}.{timestamp}.{body}`, five-minute replay window. Unsigned, tampered and stale deliveries all 401.
- **Timezones resolved server-side, once.** The model names an hour on your clock and never converts — asked to do it itself, it turned "gym at 7" into 3am. `startOfWeek` and `endOfLocalDay` resolve the offset twice, because the offset on the target midnight can differ from the offset now.
- **Two brains.** OpenAI by default with Workers AI behind it. A dead key degrades to Llama and writes a loud trace line rather than the agent silently saying nothing.
- **Tapbacks.** He reacts like a person — 😂 at a bad excuse, 👍 when there's nothing to add — and a 👍 from you on an offer *is* your yes; the money is locked by the time he speaks.
- **Opt-out** is honoured on the inbound path. **Credentials are scrubbed** from anything that reaches a trace or an error body.
- **Onboarding copy is fixed text, not a model turn** — the one message that explains how money moves can never be improvised.

## What's tested

```
npm test          # 13 suites, 427 checks
```

`startOfWeek` / `endOfLocalDay` are asserted as properties over **20,720 instants across 14 zones**. That suite found a real bug: Egypt begins DST at midnight, so the clock reads 23:59 then 01:00 and the midnight we resolved never happens — Snap would have slashed a stake an hour before the user's day was over.

Agent behaviour, measured **through the deployed Worker**, 4 trials per phrase:

| phrase | outcome |
|---|---|
| `7pm gym, $5 on it` | commitment 4/4, replied 4/4 |
| `gym at 7` | offer 4/4, replied 4/4 |
| `gonna hit the gym at 6 tonight` | offer 4/4, replied 4/4 |
| `ill go later` | nothing 4/4 ✓ |
| `might go to the gym sometime` | nothing 4/4 ✓ |

20 out of 20. A named time with no amount produces an **offer**, not a stake — nobody's money moves without an explicit yes.
