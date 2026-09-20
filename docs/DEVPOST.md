# Snap — Devpost submission

Paste-ready. Section headings match Devpost's own.

---

# ⚠️ DO THIS FIRST — 60 seconds, needs your Devpost login

## The charity line is false

In **What it does**, the last line of the gym paragraph currently reads:

> Then you actually go to the gym. Your Apple Watch ends the workout, Snap syncs it, and the escrow releases your stake. **If you skip, your stake gets slashed and donated to a charity of your choice.**

Replace that bolded sentence with:

> If you skip, at the end of your local day the stake is gone — a real devnet transaction you can open in Solana Explorer.

The half-to-charity mechanic was proposed and reverted. A miss forfeits the whole stake to the treasury. The deployed backend, the iOS onboarding copy and Snap's own texts all say so; only Devpost still doesn't.

## Built With — replace the tags

Currently: `app`, `apple`, `b2c`, `consumer`, `gym`, `imessage`, `linq`, `openai`, `solana`.

Five of those nine are generic category words. Delete `app`, `b2c`, `consumer`, `gym`, `apple` and use:

```
typescript
swift
swiftui
healthkit
cloudflare-workers
cloudflare-durable-objects
workers-ai
solana
solana-web3js
devnet
openai
gpt-5
llama
imessage
linq
```

## Two more, if you have longer

- **Link the repo** in *Try it out*: `https://github.com/ryannzander/snap` — our repo links scored **0**.
- **Add the video.** Biggest single completeness gap, and the strongest predictor of winning in the backtest.

---

# The write-up

Everything below replaces the current text, section by section.

---

## Inspiration

A year ago Hugo and I were chuds who skipped the gym.

We had memberships. It came out of my bank account every month. We had a streak app too, and calendar reminders. We were mostly consistent, but sometimes we would skip. Some weeks we lowkey never went at all.

That's the part we kept coming back to. **Skipping the gym has no witness.** Nothing happens. The app asks "did you work out today?" and you either lie to it or you stop opening it, and both of those feel identical.

Then we found out how bad that question actually is. A systematic review of 173 studies found self-reported physical activity correlates with directly measured activity at **r = 0.37** — and about 60% of the accelerometer comparisons showed people over-reporting (Prince et al., *IJBNPA*, 2008). Every accountability app in this category asks a question whose answers track reality at 0.37, and then moves real money on the answer. StickK uses a referee. Beeminder uses the honor system. Forfeit makes you send a photo nobody checks.

So we built the friend instead. We gave it your HealthKit data so it can't be lied to, put it in your text thread, and attached money.

## What it does

You text Snap like a person. "gym at 7 tonight."

Snap texts back and **offers the stake** — you don't have to know the feature exists:

> before u get demotivated — put 0.05 sol on it, or name your own number. send a pic from the session and u get it all back. skip it and it's gone. deal?

That he offers first is a design decision with a paper behind it. Royer, Stehr & Sydnor (*AEJ: Applied*, 2015) ran deposit contracts on gym attendance at a Fortune-500 company and found they were at least as effective as reward incentives but had **much lower uptake** — people who'd benefit from a commitment device don't go find one. So Snap brings it up himself, and the amount is yours from 0.01 SOL up.

You say "deal". The SOL moves from your wallet into escrow, on devnet, with a real signature you can open in Solana Explorer. And Snap names a random gesture your proof photo has to have in it: **"3 fingers up in the pic."**

At 7:20 Snap **wakes itself up**. No photo, no workout. It pulls your context — nothing logged today, you skipped yesterday, 3/4 this week, a three-day run you just broke, 0.05 SOL in escrow — and texts first:

> yo, 18 mins over, bro. i see you.

You try the excuse you used yesterday:

> cant today bro, too much work

Snap reads the history, sees the same excuse on yesterday's record, and **refuses the reschedule**:

> nah bro, can't push this any further. your sol's already on the line.

You get one renegotiation per commitment, ever, and Snap decides whether the excuse earns it. Then you go, and you send a picture of yourself mid-set with three fingers up. A vision model checks it, the escrow releases your stake with another real signature, and Snap hypes the photo. Skip, and at end of your local day it's gone.

Four things make it not a gym app:

**The money is the loss kind, not the reward kind.** Patel et al. (*Annals of Internal Medicine*, 2016) randomized 281 adults across four arms on a 7,000-step goal. Paying $1.40 for each successful day got people to goal on 35% of days. A lottery of the same expected value got 36%. Control got 30%. But allocating $42 up front and **removing $1.40 for each missed day got 45%** — the only arm that significantly beat control. Same money, same expected value, different frame. Snap's stake is that frame: it's allocated to you the moment you commit, and taken back when you don't go.

**It never asks.** The photo is the verifier and a vision model judges it — a real person, visibly training, not a screenshot, above 0.6 confidence, and every image is fingerprinted so the same one can't be spent twice. HealthKit sits underneath as a silent backstop for the day you train and forget to send anything: 15 minutes, 2 active kcal/min, one of 12 accepted types, and `wasUserEntered` false — so a judge who opens Health → Add Data and invents a session cannot release money. The trace says *why* something didn't count: `doesn't count as training`, `under 15 min`, `typed in by hand`, `barely moved`.

**The gesture is how it knows the photo is from now.** A vision model can tell you someone is training. It cannot tell you it's *you*, and we don't claim it can. So the stake picks a random gesture the moment it locks — 2, 3 or 4 fingers, a thumbs up, a peace sign, an open palm — and the photo has to have it. A picture you already had can't, because nobody knew which gesture until your money moved. Neither can one borrowed from a friend. It's the challenge–response idea from biometric anti-spoofing, pointed at a gym selfie: it turns *prove you trained* into **prove you trained now**.

**Ghosting doesn't work.** Stop replying and the money still moves — the end-of-day settlement requires no message, no model call and no user. This is the one with the most literature behind it. Eysenbach's "law of attrition" (*JMIR*, 2005) is the foundational statement that eHealth users stop using the thing; a secondary analysis of an app-based physical activity RCT found **49–59% of participants had gone non-use within 14 days**. Every conversational fitness product fails the moment you go quiet, because the product *is* the reply. Snap's alarms don't care.

**You can see it think.** The app has no chat. It's onboarding, HealthKit sync, your wallet, and a brain screen — a live trace of every decision, including the ones where it chose to stay quiet. During testing it declined to text at 02:30 with the reason *"texting now would just wake them"*. Nothing else we've seen visualizes an agent's restraint.

## How we built it

**Cloudflare Workers + Durable Objects.** One `UserAgent` object per user owns all their state. A `Directory` object resolves link codes and chats. A `Competition` object holds multi-player pots.

**The agent schedules its own future.** A Durable Object gets exactly one alarm, so we built a key-sorted schedule queue — keys are `alarm:<14-digit-timestamp>:<kind>`, so a range scan finds everything due and the object re-arms to whichever wake-up comes first. Three kinds fire: the grace warning, end of day in *your* timezone, and a morning check-in when nothing is planned. That's what makes Snap proactive without a cron job anywhere.

**Model proposes, backend disposes.** The model gets nine tools. Three of them touch money and **none of them reach the chain** — every call goes through a pure guard function first: `guardCreate`, `guardOffer`, `guardAccept`, `guardReschedule`, `guardRelease`, `guardSlash`. The slash guard is the one that matters. Both models we tested tried to take the money at the 20-minute grace mark, and the guard refused every time, because DESIGN.md says grace is a warning and the money moves at end of the user's local day.

Settlement isn't the model's call at all. Whether a photo is proof is something the vision verdict answered; whether a workout covers a commitment is something HealthKit answered; end of day is something the clock answered. All three settle in code, and the model gets a talking-only turn afterwards that it cannot sit out.

**No plans, no macros, no coaching — on purpose, and this is the part with an argument behind it.** The obvious objection to paying people to exercise is motivation crowding-out: extrinsic rewards can undermine the intrinsic kind. Ng et al.'s meta-analysis of 184 datasets (*Perspectives on Psychological Science*, 2012) is clear that **controlling** climates — external pressure, tangible rewards — thwart the psychological needs that predict adherence, while autonomy-supportive ones help. Two things keep Snap on the right side of that line. It's your own money at an amount you choose, which is a self-imposed constraint rather than someone paying you to comply. And he never tells you what to train. The easy/medium/hard dial sets a session target you picked and how hard he pushes; it does not prescribe a single set. A product that takes your money *and* directs your behaviour is exactly the controlling climate that meta-analysis warns about.

It's also worth saying that in exercise specifically, the field experiments don't find crowding-out: Charness & Gneezy (*Econometrica*, 2009) paid people to attend a gym for a month and found post-payment attendance roughly **double** the baseline, entirely among people who weren't previously regular. Giné, Karlan & Zinman (*AEJ: Applied*, 2010) ran a forfeit-your-deposit contract for smoking cessation and the effect was still there in **surprise tests six months after the contract ended**.

**Timezones, done once, server-side.** The model names an hour on the user's clock and never converts. Asked to do it itself, it turned "gym at 7" into 3am. `startOfWeek` and `endOfLocalDay` resolve the offset twice, because the offset on the target midnight can differ from the offset right now.

**Real messages.** Inbound is a signed Linq webhook — Standard Webhooks HMAC-SHA256 over `{id}.{timestamp}.{body}` with a five-minute replay window. Unsigned, tampered, and ten-minute-old deliveries all 401.

**Solana.** `@solana/kit` v8, devnet. Stake, release and slash are real transfers with real signatures. **It is custodial and we say so** — the backend holds the keys, there is no on-chain program yet, and the escrow is a wallet rather than a PDA. We built the fallback path first on purpose so the loop was real end to end; the Anchor program drops in behind the same three calls.

## Challenges we ran into

**`api.devnet.solana.com` returns 403 to Cloudflare Workers.** Not a rate limit — the Foundation RPCs block by provider, and Workers stamp a `CF-Worker` header on every subrequest that can't be stripped. We probed **11 devnet endpoints from inside the Worker**; every one failed (403 blocked, 401 needs key, 429, paid-only, 404). Solved with a keyed Helius endpoint.

**Our reliability numbers were measuring the wrong model.** "7pm gym, $5 on it" produced a commitment **0 times out of 4**. We built two compensating passes for it. Then we measured the same prompt against a real model and it scored **4/4** — every failure had been the Workers AI fallback, because the OpenAI key was never set. The lesson cost us hours: *measure through the thing that ships, not next to it.*

**A rehearsal that passed while doing nothing.** Our first full run "passed" — until we noticed every inbound webhook was being 401'd for want of a signature and we'd been reading seeded data back.

**The verification bar was punishing the behaviour we were paying for.** The workout floor was 30 minutes, which made it both a fraud check and an effort bar. Drive to the gym, warm up, feel terrible, leave after twenty minutes — you turned up, which is the thing the stake exists to buy, and Snap answered with *"under 30 min"* and kept your money. Somebody told "doesn't count" after a real session never stakes again. It's 15 minutes now and it's a fraud check only; what you were *aiming* for is a target Snap says out loud and never enforces with money.

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

**13 test suites, 444 checks**, including `startOfWeek` and `endOfLocalDay` asserted as properties over **20,720 instants across 14 timezones**. That suite found a real bug: Egypt begins DST at midnight, so the local clock reads 23:59 then 01:00 and the midnight we resolved never happens — Snap would have slashed a stake an hour before the user's day was over.

**Three verified devnet transactions**: stake, release, and slash, each confirmed against the cluster rather than trusted from our own logs.

## What we learned

Guards that quietly disagree with what the user was told are worse than no guards. Our worst bug: the model wrote its texts assuming every tool it called would succeed, so a reschedule the guards **refused** was announced to the user as *"alright, push it to tomorrow then"* — and the stake was slashed on the original deadline anyway. Actions now run before any talking, and a refusal throws out the model's draft and asks for the truth instead.

The same failure has a documentation form, and we hit it four separate times: the code changed and the sentence describing it didn't. Every one was caught by reading what a person actually sees, never by a test. The last one nearly shipped: the gesture was enforced from the stored commitment but dropped by the projection that builds the model's context — so Snap would have refused a photo for missing a gesture he never asked for.

**Say the limit out loud before someone finds it.** Our vision model checks that a person is training, not that the person is you. We could have written "it knows it's you" and most people would not have checked. Instead we built the gesture, said plainly what it does and doesn't prove, and put the face-matching layer in the roadmap. A limitation you volunteer reads as rigour; the same one discovered reads as the demo being fake.

## What's next for Snap

The Anchor program: one `competition` PDA holding the pot, the rule hash, the entrant list and the oracle key, so entrants and sponsors can audit payouts without trusting us. Then Phantom instead of custodial wallets. Then identity — an enrolled selfie at onboarding, compared against every gym photo in the same call that judges the session, with a non-match treated as *"can't tell"* rather than an accusation.

The competition engine is already built — 1v1, group pots, and a weekly pot, settled from HealthKit. Winners get 100% of their stake back plus an equal share of what the skippers forfeited, and the 15% rake never touches a winner. That design is the competition arm of a trial that worked: STEP UP (*JAMA Internal Medicine*, 2019) randomized 602 adults across gamified support, collaboration and competition, and all three beat control with impact sustained into follow-up — on self-reported step goals. Ours settles from sensor data.

**Sponsored pots are the business.** A brand funds the pot and buys an audience that *provably trained* — "12,000 people did 12+ workouts in the Gymshark 30" is a number no other channel can sell. The same asset sells one person at a time, too: a discount code that only reaches people who verifiably trained twelve times last month is customer acquisition aimed at exactly the person who buys gym clothes, and nobody else can issue it honestly.

---

## The evidence

We didn't invent the mechanics. We implemented the ones with randomized trials behind them and built the verification layer they assume.

| what we built | what it rests on |
|---|---|
| The stake is allocated up front and lost on a miss | Patel MS, Asch DA, Rosin R, et al. *Framing Financial Incentives to Increase Physical Activity Among Overweight and Obese Adults: A Randomized, Controlled Trial.* Annals of Internal Medicine, 2016;164(6):385–394. Loss-framed 45% of days vs 35% gain, 36% lottery, 30% control. |
| Forfeiting a deposit produces change that outlasts the contract | Giné X, Karlan D, Zinman J. *Put Your Money Where Your Butt Is: A Commitment Contract for Smoking Cessation.* AEJ: Applied Economics, 2010;2(4):213–235. Effect held in surprise tests at 12 months. |
| Short-run money builds a lasting gym habit | Charness G, Gneezy U. *Incentives to Exercise.* Econometrica, 2009;77(3):909–931. Post-incentive attendance ≈2× baseline, entirely among non-regulars. |
| Snap offers the stake rather than waiting to be asked | Royer H, Stehr M, Sydnor J. *Incentives, Commitments, and Habit Formation in Exercise.* AEJ: Applied Economics, 2015;7(3):51–84. Deposit contracts as effective as rewards, far lower uptake. |
| HealthKit instead of "did you work out?" | Prince SA, Adamo KB, Hamel ME, et al. *A comparison of direct versus self-report measures for assessing physical activity in adults: a systematic review.* IJBNPA, 2008;5:56. 173 studies, mean r = 0.37. |
| Settlement that needs no reply | Eysenbach G. *The Law of Attrition.* JMIR, 2005;7(1):e11. Plus app-RCT attrition data: 49–59% non-use within 14 days. |
| A daily loop rather than a two-week challenge | Lally P, van Jaarsveld CHM, Potts HWW, Wardle J. *How are habits formed: Modelling habit formation in the real world.* European Journal of Social Psychology, 2010;40(6):998–1009. Median 66 days to automaticity, range 18–254. |
| Competitions and pots | Patel MS, Small DS, Harrison JD, et al. *STEP UP Randomized Clinical Trial.* JAMA Internal Medicine, 2019;179(12):1624–1632. 602 adults, all three gamified arms beat control. |
| The anti-coach ban | Ng JYY, Ntoumanis N, Thøgersen-Ntoumani C, et al. *Self-Determination Theory Applied to Health Contexts: A Meta-Analysis.* Perspectives on Psychological Science, 2012;7(4):325–340. 184 datasets; controlling climates thwart the needs that predict adherence. |
| The randomized gesture | Challenge–response liveness detection, the standard defence against replay in biometric anti-spoofing. Established principle; **we have measured no accuracy of our own on gym photos and don't claim one.** |
