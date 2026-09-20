# Snap

Your gym bro in your texts. Snap knows when you said you'd work out, holds your money until you send a pic from the gym, and can tell when the pic is a screenshot.

Built at Hack the North 2026 by two people.

**Live:** `https://snap.snap-backend.workers.dev` · [API contract](docs/API.md) · [design decisions](docs/DESIGN.md)

commitment → deadline passes with no pic → agent evaluates context → proactive text → reply (or a 👍) → personalized response → pic arrives and checks out → stake returned

The photo is the verifier: a picture with you in it, on the gym floor. The vision model judges it, a screenshot doesn't pass, and every image is fingerprinted so the same one can't be spent twice. HealthKit sits underneath as a silent fallback for the day you train and forget to send anything.

---

## What it does

You text him a plan. He offers you a stake. He wakes himself up when the deadline passes, reads your history before deciding whether your excuse earns a reschedule, and settles the money off a picture you send from the gym — with your Watch as a silent backup.

```
USER > gym at 7 tonight
SNAP > before u get demotivated — put 5 bucks of sol on this.
SNAP > go and u get it all back. skip it and it's gone. deal?
USER > deal
       commitment_created · gym at 7 tonight · 0.05 SOL on it
       stake_held · on devnet · 628nqcPR…

       [19:25, nobody asked it to do this]
SNAP > yo, 18 mins over, bro. i see you.

USER > cant today bro, too much work
       refused reschedule_commitment — the new deadline is after end of day
SNAP > nah bro, can't push this any further. your sol's already on the line.

       workout_detected · traditional strength training · 45 min
       stake_released · 0.05 SOL back in your wallet
SNAP > ayyyeee!!! you did it bro!
```

**Two verifiers, and neither is your word for it.** A stake is released by a photo the vision model accepts — a real person, visibly training, not a screenshot, above 0.6 confidence, and never an image already spent — or by a covering HealthKit workout underneath. A workout counts only if it ran 30 minutes or longer, averages 2 active kcal/min, is one of 12 accepted types, and `wasUserEntered` is false, so opening Health → Add Data and inventing a session cannot release money. Whatever fails says why in the trace: `doesn't count as training`, `under 30 min`, `typed in by hand`, `barely moved`.

The fingerprint catches resending Monday's selfie and nothing cleverer — a re-crop hashes differently and gets through. That is why the watch is still there underneath.

## Model proposes, backend disposes

The model has six tools and cannot move money with any of them. Every proposed call goes through a pure guard function first, and settlement isn't the model's decision at all — whether a photo is proof is something the vision verdict answered, whether a workout covers a commitment is something HealthKit answered, and end of day is something the clock answered. All three settle in code; the model only gets to do the talking, and it is handed the outcome rather than asked for one.

The guard that matters most is the slash. Both models we tested tried to take the money at the 20-minute grace mark. It refused every time, because grace is a warning and the money moves at the end of the user's local day.

## Architecture

| | |
|---|---|
| `ios/` | SwiftUI app — onboarding, HealthKit sync, wallet, and the brain screen. **No chat.** The conversation is in iMessage. |
| `backend/` | Cloudflare Worker + Durable Objects. The agent, the guards, the alarm engine, the channel adapters and the Solana layer. |
| `brand/` | Mark, app icon, wordmark, Devpost banner. |
| `docs/` | [API contract](docs/API.md) · [design](docs/DESIGN.md) · [roadmap](docs/ROADMAP.md) · [review](docs/CODE_REVIEW.md) |

**The agent schedules its own future.** A Durable Object gets exactly one alarm, so wake-ups live in a key-sorted queue — `alarm:<14-digit-timestamp>:<kind>` — and a range scan finds everything due. That's what makes Snap proactive with no cron job anywhere.

**Timezones are resolved server-side, once.** The model names an hour on the user's clock and never converts; asked to do it itself, it turned "gym at 7" into 3am. `startOfWeek` and `endOfLocalDay` resolve the offset twice, because the offset on the target midnight can differ from the offset right now.

**Inbound messages are signed.** Standard Webhooks HMAC-SHA256 over `{id}.{timestamp}.{body}`, five-minute replay window. Unsigned, tampered and stale deliveries all 401.

**Two brains.** OpenAI by default with the Workers AI binding behind it — a wrong model name or a dead key degrades to Llama and writes a loud trace line, rather than the agent silently saying nothing.

## Solana

Real devnet transfers with real signatures. Stake, release and slash, each verified by fetching the transaction back from the cluster rather than trusting our own logs.

**It is custodial and we say so.** The backend holds every key, the escrow is a wallet rather than a PDA, and there is no on-chain program yet. We built the fallback path first on purpose so the loop was real end to end; the Anchor program drops in behind the same three calls.

## What's tested

```
npm test          # 9 suites, 202 checks
```

| suite | what it holds |
|---|---|
| guards | every stake rule in DESIGN.md, plus the model misbehaviours each was written for |
| time | `startOfWeek` / `endOfLocalDay` as properties over **20,720 instants across 14 zones** |
| competitions | the pot maths — *a winner never loses money*, asserted over eight shapes |
| photos, webhook, redaction, money, context, brain | vision, signing, credential scrubbing, formatting, agent context, brain fallback |

The time suite found a real bug: Egypt begins DST at midnight, so the clock reads 23:59 then 01:00 and the midnight we resolved never happens. Snap would have slashed a stake an hour before the user's day was over.

Agent behaviour, measured through the deployed Worker, 4 trials per phrase:

| phrase | outcome |
|---|---|
| `7pm gym, $5 on it` | commitment 4/4, replied 4/4 |
| `gym at 7` | offer 4/4, replied 4/4 |
| `gonna hit the gym at 6 tonight` | offer 4/4, replied 4/4 |
| `ill go later` | nothing 4/4 ✓ |
| `might go to the gym sometime` | nothing 4/4 ✓ |

A named time with no amount produces an **offer**, not a stake. Nobody's money moves without an explicit yes.

## Also built

**Competitions.** 1v1, group pots and a solo weekly pot, settled from HealthKit. Winners get 100% of their own stake back plus an equal share of what the skippers forfeited; the 15% rake comes out of the pot and never touches a winner.

## Running it

```bash
cd backend
npm install
npx wrangler dev -c wrangler.local.toml    # no Cloudflare account needed
npm test
```

`wrangler.local.toml` drops the `[ai]` binding, which is the only thing that forces a remote session, and sets the channel to `trace` so nothing is sent. Secrets go in `backend/.dev.vars`; never in `wrangler.toml`.
