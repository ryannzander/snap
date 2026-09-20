# Snap — Devpost submission

Paste-ready, section by section. Hugo's draft with the facts corrected and the two empty sections filled.

---

## Inspiration

A year ago Hugo and I were the guys who skipped the gym.

We had memberships. It came out of my bank account every month. We had a streak app too, and calendar reminders. We were mostly consistent, but sometimes we would skip. Some weeks we lowkey never went at all.

That's the part we kept coming back to. **Skipping the gym has no witness.** Nothing happens. The app asks "did you work out today?" and you either lie to it or you stop opening it, and both of those feel identical.

Every accountability app asks if you worked out. That question is the whole problem — and it's worse than it looks. A review of 173 studies found self-reported physical activity correlates with what people actually did at **r = 0.37**. Every app in this category is moving real money on an answer that barely tracks reality.

So we built the friend instead. We gave it your HealthKit data so it can't be lied to, put it in your text thread, and attached money.

## What it does

You text Snap like a person: **"gym at 7 tonight."**

Snap texts back and **offers the stake** — you don't have to know the feature exists:

> before u get demotivated — put 0.05 sol on it, or name your own number. send a pic from the session and u get it all back. skip it and it's gone. deal?

You say "deal". The SOL moves into escrow on devnet with a real signature you can open in Solana Explorer. And Snap names a random gesture your proof photo has to have in it: **"open hand up in the pic."**

At 7:25 Snap **wakes itself up**. No photo, no workout. It pulls your context — nothing logged today, you skipped yesterday, 3/4 this week, 0.05 SOL in escrow — and texts first:

> 7:25 bro 😭 send the gym-floor pic now — you in it, open hand up in the pic. that's how the 0.05 sol comes back.

You try an excuse:

> cant today bro, too much work

Snap reads your history, finds the same excuse on yesterday's record, and refuses:

> nah bro we are inside the lock now 😭 too much work is the same villain from yesterday. no move on this one — train tonight or the 0.05 sol is gone end of day.

You get one renegotiation per commitment, ever, and only while there's more than an hour left. Snap decides whether the excuse earns it.

Then you go, and you send a photo of yourself mid-set with an open hand up. A vision model checks it and the escrow releases your stake. **Skip, and at the end of your local day it's gone** — a real devnet transaction, forfeited to the treasury.

Four things make it not a gym app:

**It never asks.** The photo is the verifier and a vision model judges it: a real person, visibly training, not a screenshot, and every image is fingerprinted so the same one can't be spent twice. HealthKit sits underneath as a silent backstop for the day you train and forget to send anything — and a workout typed into the Health app by hand can never release money.

**The gesture is how it knows the photo is from *now*.** A vision model can tell you someone is training. It cannot tell you it's *you*, and we're not going to claim it can. So the stake picks a random gesture the moment the money locks. A photo you already had can't have it in it, because nobody knew which gesture until your money moved.

**Ghosting doesn't work.** Stop replying and the money still moves — settlement needs no message, no model call and no user. Every AI coach loses you the moment you go quiet.

**You can see it think.** The app has no chat at all; the conversation lives in iMessage. The app is onboarding, HealthKit sync, your wallet, and a live trace of every decision — including the ones where it chose to stay quiet. During testing it declined to text at 02:30 with the reason *"texting now would just wake them."*

## How we built it

**iOS (SwiftUI).** Onboarding, HealthKit sync, the wallet, the schedule and streak screen, and the brain trace.

**Backend (TypeScript on Cloudflare Workers).** One Durable Object per user holds their memory and state. A second holds multi-player competition pots.

**The agent schedules its own future.** A Durable Object gets exactly one alarm, so we built a key-sorted schedule queue — keys are `alarm:<14-digit-timestamp>:<kind>` — and a range scan finds everything due. Three kinds fire: the grace warning, a last call an hour before the money goes, and the slash at end of your local day.

**Model proposes, backend disposes.** The agent gets nine tools and **none of them reach the chain**. Every call passes a pure guard function first. Both models we tested tried to take the money at the grace mark; the guard refused every time, because grace is a warning and the money moves at end of day. Settlement isn't the model's call at all — the vision verdict, HealthKit and the clock answer it, and the model gets handed the outcome to talk about.

**No coaching, on purpose.** No plans, no macros, no prescribed sets. A meta-analysis of 184 datasets shows controlling climates — external pressure plus tangible rewards — undermine the motivation that predicts adherence. It's your own money at an amount you choose, and Snap never tells you what to train. Taking your money *and* directing your training is exactly the combination the literature warns about.

**Messaging.** Real iMessage through Linq, with Telegram as the development channel. Inbound is a signed webhook — HMAC-SHA256 over `{id}.{timestamp}.{body}` with a five-minute replay window.

**Solana.** `@solana/kit` v8 on devnet. Stake, release and slash are real transfers with real signatures. **It's custodial and we say so** — the backend holds the keys, the escrow is a wallet rather than a PDA, and there's no on-chain program yet.

## Challenges we ran into

**Making the agent proactive without a cron job.** A scheduler firing at a set time is the easy choice and the wrong one. Durable Object alarms let each user's agent schedule its own times — but an object gets exactly one alarm, so we built the sorted queue above to fan one alarm out into many.

**Linq's sandbox forced us to design better onboarding.** You can't text a user who hasn't texted you first. Instead of switching platforms, onboarding now ends with *"text Snap `yo 4821`"* — which turned out better anyway, because your very first message with Snap is in the thread where he lives.

**`api.devnet.solana.com` returns 403 to Cloudflare Workers.** Not a rate limit — Workers stamp a `CF-Worker` header on every subrequest that can't be stripped. We probed **11 devnet endpoints from inside the Worker** and every one failed. Solved with a keyed provider.

**Our reliability numbers were measuring the wrong model.** "7pm gym, $5 on it" produced a commitment **0 times out of 4**, and we built two compensating passes for it. Then we measured the same prompt against the real model and it scored **4/4** — every failure had been the fallback model, because the API key was never set. *Measure through the thing that ships, not next to it.*

**The verification bar was punishing the behaviour we were paying for.** The workout floor was 30 minutes, which made it both a fraud check and an effort bar. Drive to the gym, warm up, feel terrible, leave after twenty minutes — you turned up, which is the thing the stake exists to buy, and Snap answered with "under 30 min" and kept your money. It's 15 minutes now and it's a fraud check only.

## Accomplishments that we're proud of

**The agent refuses a reschedule because you used that excuse yesterday.** Unprompted, off real history. That beat is the product.

Measured through the deployed Worker, 4 trials per phrase:

| phrase | outcome |
|---|---|
| `7pm gym, $5 on it` | commitment 4/4 |
| `gym at 7` | **offer** 4/4 |
| `gonna hit the gym at 6 tonight` | **offer** 4/4 |
| `ill go later` | nothing 4/4 ✓ |
| `might go to the gym sometime` | nothing 4/4 ✓ |

**20 out of 20**, and a named time with no amount produces an *offer* rather than a stake — nobody's money moves without an explicit yes.

**14 test suites, 518 checks**, including `startOfWeek` and `endOfLocalDay` asserted as properties over **20,720 instants across 14 timezones**. That suite found a real bug: Egypt begins DST at midnight, so the local clock reads 23:59 then 01:00 and the midnight we resolved never happens — Snap would have slashed a stake an hour before the user's day was over.

**Real devnet transactions** for stake, release and slash, each confirmed against the cluster rather than trusted from our own logs.

## What we learned

Once an agent can schedule its own future, the question stops being *"what should it answer?"* and becomes *"what should it decide to do, unprompted?"*

**Showing the reasoning turned out to be the interface.** We expected the trace to be a debugging tool. It became the product's best screen, because an agent that explains why it chose *not* to text you is more trustworthy than one that only shows its output.

**Guards that quietly disagree with what the user was told are worse than no guards.** Our worst bug: the model wrote its texts assuming every tool it called would succeed, so a reschedule the guards **refused** was announced to the user as *"alright, push it to tomorrow then"* — and the stake was slashed on the original deadline anyway. Actions now run before any talking, and a refusal throws out the draft and asks for the truth instead.

**Say the limit out loud before someone finds it.** Our vision model checks that a person is training, not that the person is you. We could have written "it knows it's you" and most people wouldn't have checked. Instead we built the gesture, said plainly what it does and doesn't prove, and put face matching in the roadmap. A limitation you volunteer reads as rigour; the same one discovered reads as the demo being fake.

## What's next for Snap

**The Anchor program.** One `competition` PDA holding the pot, the rule hash, the entrant list and the oracle key, so entrants and sponsors can audit payouts without trusting us. Then Phantom instead of custodial wallets.

**Identity.** An enrolled selfie at onboarding, compared against every gym photo in the same call that judges the session — with a non-match treated as "can't tell" rather than an accusation, because wrongly telling someone who actually trained that it wasn't them is worse than occasionally letting a cheat through.

**Live challenges.** Two to eight people on a video call, phones propped up, everyone doing the same exercise, each phone counting its own reps from Apple's Vision framework. Loser's stake goes to the winner. It's the first thing here that's inherently viral — you can't do a 1v1 without inviting someone.

**Sponsored pots are the business.** A brand funds the pot and buys an audience that *provably trained* — "12,000 people did 12+ workouts this month" is a number no other channel can sell. The same asset works one person at a time: a discount code that only reaches people who verifiably trained twelve times last month is customer acquisition aimed at exactly the person who buys gym clothes, and nobody else can issue it honestly.
