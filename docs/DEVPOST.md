# Snap — Devpost submission

Paste each section into the matching Devpost field. Written against the
Ranked read of the current submission (#38 of 341, 71.8): evidence 0/100,
technical 59/100, 5 of 7 sections filled, no video, no repo link, generic tags.

---

## Inspiration

A year ago Hugo and I were chuds who skipped the gym.

We had memberships. It came out of my bank account every month. We had a streak app too, and calendar reminders. We were mostly consistent, but sometimes we would skip. Some weeks we lowkey never went at all.

That's the part we kept coming back to. **Skipping the gym has no witness.** Nothing happens. The app asks "did you work out today?" and you either lie to it or you stop opening it, and both of those feel identical.

Every accountability app asks if you worked out. That question is the whole problem. StickK uses a referee. Beeminder uses the honor system. Forfeit makes you send a photo. All of them are asking, and all of them can be lied to.

So we built the friend instead. We gave it your HealthKit data so it can't be lied to, put it in your text thread, and attached money.

## What it does

You text Snap like a person. "gym at 7 tonight."

Snap texts back and **offers the stake** — you don't have to know the feature exists:

> before u get demotivated — put 5 bucks of sol on this. go and u get it all back. skip it and it's gone. deal?

You say "deal". 0.05 SOL moves from your wallet into escrow, on devnet, with a real signature you can open in Solana Explorer.

At 7:20 Snap **wakes itself up**. No workout has come in from HealthKit. It pulls your context — nothing logged today, you skipped yesterday, 2/4 this week, 0.05 SOL in escrow — and texts first:

> yo, 18 mins over, bro. i see you.

You try the excuse you used yesterday:

> cant today bro, too much work

Snap reads the history, sees the same excuse on yesterday's record, and **refuses the reschedule**:

> nah bro, can't push this any further. your sol's already on the line.

You get one renegotiation per commitment, ever, and Snap decides whether the excuse earns it. Then you actually go. Your Watch ends the workout, HealthKit syncs it, and the escrow releases your stake with another real signature. Skip, and at end of your local day it's gone.

Three things make it not a gym app:

**It never asks.** HealthKit is the referee. A workout only counts if it ran 30 minutes or longer, is one of 12 accepted types, and `wasUserEntered` is false — so a judge who opens Health → Add Data and invents a session cannot release money. The trace says *why* a workout didn't count: `doesn't count as training`, `under 30 min`, `typed in by hand`.

**Ghosting doesn't work.** Stop replying and the money still moves. Every AI coach loses you the moment you go quiet; Snap's alarms don't care.

**You can see it think.** The app has no chat. It's onboarding, HealthKit sync, your wallet, and a brain screen — a live trace of every decision, including the ones where it chose to stay quiet. During testing it declined to text at 02:30 with the reason *"texting now would just wake them"*. Nothing else we've seen visualizes an agent's restraint.

## How we built it

**Cloudflare Workers + Durable Objects.** One `UserAgent` object per user owns all their state. A `Directory` object resolves link codes and chats. A `Competition` object holds multi-player pots.

**The agent schedules its own future.** A Durable Object gets exactly one alarm, so we built a key-sorted schedule queue — keys are `alarm:<14-digit-timestamp>:<kind>`, so a range scan finds everything due and the object re-arms to whichever wake-up comes first. That's what makes Snap proactive without a cron job anywhere.

**Model proposes, backend disposes.** The model gets six tools and cannot move money with any of them. Every call goes through a pure guard function first: `guardCreate`, `guardReschedule`, `guardRelease`, `guardSlash`. The slash guard is the one that matters — both models we tested tried to take the money at the 20-minute grace mark, and the guard refused every time, because DESIGN.md says grace is a warning and the money moves at end of the user's local day.

Settlement isn't the model's call at all. Whether a workout covers a commitment is something HealthKit answered; end of day is something the clock answered. Both settle in code, and the model gets a talking-only turn afterwards that it cannot sit out.

**Timezones, done once, server-side.** The model names an hour on the user's clock and never converts. Asked to do it itself, it turned "gym at 7" into 3am. `startOfWeek` and `endOfLocalDay` resolve the offset twice, because the offset on the target midnight can differ from the offset right now.

**Real messages.** Inbound is a signed Linq webhook — Standard Webhooks HMAC-SHA256 over `{id}.{timestamp}.{body}` with a five-minute replay window. Unsigned, tampered, and ten-minute-old deliveries all 401.

**Solana.** `@solana/kit` v8, devnet. Stake, release and slash are real transfers with real signatures. **It is custodial and we say so** — the backend holds the keys, there is no on-chain program yet, and the escrow is a wallet rather than a PDA. We built the fallback path first on purpose so the loop was real end to end; the Anchor program drops in behind the same three calls.

## Challenges we ran into

**`api.devnet.solana.com` returns 403 to Cloudflare Workers.** Not a rate limit — the Foundation RPCs block by provider, and Workers stamp a `CF-Worker` header on every subrequest that can't be stripped. We probed **11 devnet endpoints from inside the Worker**; every one failed (403 blocked, 401 needs key, 429, paid-only, 404). Solved with a keyed Helius endpoint.

**Our reliability numbers were measuring the wrong model.** "7pm gym, $5 on it" produced a commitment **0 times out of 4**. We built two compensating passes for it. Then we measured the same prompt against a real model and it scored **4/4** — every failure had been the Workers AI fallback, because the OpenAI key was never set. The lesson cost us hours: *measure through the thing that ships, not next to it.*

**A rehearsal that passed while doing nothing.** Our first full run "passed" — until we noticed every inbound webhook was being 401'd for want of a signature and we'd been reading seeded data back.

## Accomplishments that we're proud of

**The agent refuses a reschedule because you used that excuse yesterday.** Unprompted, off real history. That beat is the product.

Measured through the deployed Worker, 4 trials per phrase:

| phrase | outcome |
|---|---|
| `7pm gym, $5 on it` | commitment 4/4, replied 4/4 |
| `gym at 7` | **offer** 4/4, replied 4/4 |
| `gonna hit the gym at 6 tonight` | **offer** 4/4, replied 4/4 |
| `ill go later` | nothing 4/4 ✓ |
| `might go to the gym sometime` | nothing 4/4 ✓ |

20 out of 20 correct, and a named time with no amount produces an *offer* rather than a stake — nobody's money moves without an explicit yes.

**9 test suites, 202 checks**, including `startOfWeek` and `endOfLocalDay` asserted as properties over **20,720 instants across 14 timezones**. That suite found a real bug: Egypt begins DST at midnight, so the local clock reads 23:59 then 01:00 and the midnight we resolved never happens — Snap would have slashed a stake an hour before the user's day was over.

**Three verified devnet transactions**: stake, release, and slash, each fetched back from the cluster rather than trusted from our own logs.

## What we learned

Guards that quietly disagree with what the user was told are worse than no guards. Our worst bug: the model wrote its texts assuming every tool it called would succeed, so a reschedule the guards **refused** was announced to the user as *"alright, push it to tomorrow then"* — and the stake was slashed on the original deadline anyway. Actions now run before any talking, and a refusal throws out the model's draft and asks for the truth instead.

Four separate times, the code changed and the sentence describing it didn't. Every one was caught by reading what a person actually sees, never by a test.

## What's next for Snap

The Anchor program: one `competition` PDA holding the pot, the rule hash, the entrant list and the oracle key, so entrants and sponsors can audit payouts without trusting us. Then Phantom instead of custodial wallets.

The competition engine is already built — 1v1, group pots, and a weekly pot, settled from HealthKit, winners get 100% of their stake back plus an equal share of what the skippers forfeited. Sponsored pots are the business: a brand funds the pot and buys an audience that **provably trained**, which is a number no other channel can sell.

---

## Devpost fields to fix

**Built With** — replace the generic tags (`app`, `b2c`, `consumer`) with:

```
typescript, swift, swiftui, cloudflare-workers, durable-objects, healthkit,
solana, web3js, openai, gpt-5, llama, workers-ai, imessage, linq, devnet
```

**Repo** — link `https://github.com/ryannzander/snap` in the *Try it out* field. Ranked scored our repo links at 0.

**Video** — the single biggest completeness gap. Screen-record the five beats.

**Fix before submitting:** the current write-up says a slashed stake is *"donated to a charity of your choice."* It isn't — that mechanic was proposed and reverted, and a miss forfeits the whole stake to the treasury. Judges check.
