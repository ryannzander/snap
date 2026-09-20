# Snap — Devpost submission

Paste-ready, section by section.

---

## Inspiration

A year ago Hugo and I were chuds who skipped the gym.

We had memberships. It came out of my bank account every month. We had a streak app too, and calendar reminders. We were mostly consistent, but sometimes we would skip. Some weeks we lowkey never went at all.

That's the part we kept coming back to. Skipping the gym has no witness. Nothing happens. The app asks "did you work out today?" and you either lie to it or you stop opening it, and both of those feel identical.

Every accountability app asks if you worked out. That question is the whole problem, and it's worse than we thought. There's a review of 173 studies that put the correlation between what people say they did and what they actually did at r = 0.37. So every app in this space is moving real money on an answer that's barely better than a guess.

We built the friend instead. Gave it your HealthKit data so it can't be lied to, put it in your text thread, and attached money.

## What it does

You text Snap like a person. "gym at 7 tonight."

He texts back and offers the stake himself, so you don't have to know the feature exists:

> before u get demotivated — put 0.05 sol on it, or name your own number. send a pic from the session and u get it all back. skip it and it's gone. deal?

You say "deal". The SOL moves into escrow on devnet with a real signature you can open in Explorer. Then he names a random gesture your photo has to have in it. "open hand up in the pic."

At 7:25 he wakes himself up. No photo, no workout. He pulls your context (nothing logged today, you skipped yesterday, 3/4 this week, 0.05 SOL in escrow) and texts first:

> 7:25 bro 😭 send the gym-floor pic now — you in it, open hand up in the pic. that's how the 0.05 sol comes back.

You try an excuse:

> cant today bro, too much work

He reads your history, finds the same excuse on yesterday, and says no:

> nah bro we are inside the lock now 😭 too much work is the same villain from yesterday. no move on this one — train tonight or the 0.05 sol is gone end of day.

One renegotiation per commitment, ever, and only while there's more than an hour left. He decides whether the excuse earns it.

Then you actually go, and you send a photo of yourself mid-set with an open hand up. A vision model checks it and the escrow releases. Skip and at the end of your local day the stake is gone, forfeited to the treasury on a transaction you can go look at.

Four things make it not a gym app.

It never asks. The photo is what verifies you, and a vision model judges it: a real person, visibly training, not a screenshot. Every image gets fingerprinted so you can't send Monday's selfie again on Tuesday. HealthKit sits underneath as a quiet backstop for the day you train and forget to send anything, and a workout you typed into the Health app by hand can never release money.

The gesture is how he knows the photo is from now. A vision model can tell you someone is training. It can't tell you it's *you*, and we're not going to say it can. So the stake picks a gesture at random the second the money locks. A photo you already had can't have it in it, because nobody knew which one it would be until your money moved.

Ghosting doesn't work. Stop replying and the money still moves. Settlement needs no message, no model call, nobody. Every AI coach loses you the moment you go quiet.

You can watch him think. The app has no chat in it at all, the conversation lives in iMessage. The app is onboarding, HealthKit sync, your wallet, and a live trace of every decision he makes, including the ones where he decides to say nothing. During testing he declined to text at 2:30am and the reason he gave was "texting now would just wake them."

## How we built it

iOS in SwiftUI. Onboarding, HealthKit sync, the wallet, a schedule screen with your streak on it, and the brain trace.

Backend is TypeScript on Cloudflare Workers. One Durable Object per user holds their memory and state, and another one holds competition pots.

The agent schedules its own future. A Durable Object only gets one alarm, so we built a sorted queue on top of it. The keys look like `alarm:<14-digit-timestamp>:<kind>`, which means a range scan finds everything that's due and the object re-arms to whatever comes next. Three kinds fire: the grace warning, a last call an hour before the money goes, and the slash at end of your local day.

Model proposes, backend disposes. The agent has nine tools and none of them touch the chain. Every call it wants to make goes through a pure guard function first. Both models we tested tried to take the money at the 20 minute grace mark and the guard said no every time, because grace is a warning and the money moves at end of day. Settlement isn't the model's call anyway. The vision verdict, HealthKit and the clock decide it, and the model just gets told what happened so it can talk about it.

No coaching, and that was deliberate. No plans, no macros, no sets. There's a meta-analysis over 184 datasets showing that controlling setups, external pressure plus tangible rewards, wreck the kind of motivation that actually predicts whether someone sticks with it. It's your money at an amount you picked, and he never tells you what to train. Taking your money and directing your training is the exact combination that research warns about.

Messaging is real iMessage through Linq, with Telegram as the dev channel. Inbound is a signed webhook, HMAC-SHA256 over `{id}.{timestamp}.{body}`, five minute replay window.

Solana is `@solana/kit` v8 on devnet. Stake, release and slash are real transfers with real signatures. It's custodial and we say so. The backend holds the keys, the escrow is a wallet rather than a PDA, and there's no on-chain program yet.

## Challenges we ran into

Making the agent proactive without a cron job. A scheduler that fires at a set time is the easy choice and the wrong one, because then it's your scheduler being proactive and not the agent. Durable Object alarms let each user's agent pick its own times. The catch is that an object only gets one alarm, hence the sorted queue.

Linq's sandbox forced us into better onboarding. You can't text a user who hasn't texted you first. Instead of switching platforms we made onboarding end with "text Snap `yo 4821`", which turned out better anyway, because your first ever message with Snap happens in the thread where he lives.

`api.devnet.solana.com` returns 403 to Cloudflare Workers. It's not a rate limit. Workers stamp a `CF-Worker` header on every subrequest and you can't strip it. We probed 11 devnet endpoints from inside the Worker and every single one failed. Fixed with a keyed provider.

Our reliability numbers were measuring the wrong model. "7pm gym, $5 on it" produced a commitment 0 times out of 4, and we built two whole compensating passes to work around it. Then we ran the same prompt against the real model and it went 4/4. Every failure had been the fallback model, because the API key was never set. That one cost us hours. Measure through the thing that ships.

The verification bar was punishing the exact behaviour we were paying for. The workout floor was 30 minutes, which made it a fraud check and an effort bar at the same time. Drive to the gym, warm up, feel awful, leave after twenty minutes. You turned up, which is the thing the stake exists to buy, and Snap told you "under 30 min" and kept your money. It's 15 minutes now and it only catches fakes.

## Accomplishments that we're proud of

He refuses a reschedule because you used that excuse yesterday. Unprompted, off real history. That beat is the product.

Measured through the deployed Worker, 4 trials each:

| phrase | outcome |
|---|---|
| `7pm gym, $5 on it` | commitment 4/4 |
| `gym at 7` | offer 4/4 |
| `gonna hit the gym at 6 tonight` | offer 4/4 |
| `ill go later` | nothing 4/4 |
| `might go to the gym sometime` | nothing 4/4 |

20 out of 20. A named time with no amount gets you an offer, not a stake. Nobody's money moves without a yes.

14 test suites, 518 checks. `startOfWeek` and `endOfLocalDay` are asserted as properties over 20,720 instants across 14 timezones, and that suite found a real bug: Egypt starts DST at midnight, so the clock reads 23:59 then 01:00 and the midnight we were resolving to never happens. Snap would have taken a stake an hour before the user's day was over.

Stake, release and slash are all real devnet transactions, each one confirmed against the cluster instead of trusted from our own logs.

## What we learned

Once an agent can schedule its own future, the question stops being "what should it answer" and starts being "what should it decide to do when nobody asked."

Showing the reasoning turned out to be the interface. We built the trace as a debugging tool and it became the best screen in the app, because an agent that tells you why it chose not to text you is easier to trust than one that only shows you its output.

Guards that quietly disagree with what the user was told are worse than no guards. Our worst bug: the model wrote its texts assuming every tool it called would work, so a reschedule the guards refused got announced to the user as "alright, push it to tomorrow then", and then the stake got slashed on the original deadline anyway. Actions run before any talking now, and a refusal throws the draft out and asks again.

Say the limit out loud before someone finds it. Our vision model checks that a person is training, not that the person is you. We could have written "it knows it's you" and most people would never have checked. Instead we built the gesture, said exactly what it does and doesn't prove, and put face matching in the roadmap. A limitation you volunteer reads as rigour. The same one discovered reads as a fake demo.

## What's next for Snap

The Anchor program. One `competition` PDA holding the pot, the rule hash, the entrant list and the oracle key, so entrants and sponsors can audit payouts without trusting us. Then Phantom instead of custodial wallets.

Identity. An enrolled selfie at onboarding, compared against every gym photo in the same call that judges the session. A non-match would be treated as "can't tell" rather than an accusation, because wrongly telling someone who actually trained that it wasn't them is worse than occasionally letting a cheat through.

Live challenges. Two to eight people on a video call, phones propped up, everyone doing the same exercise, each phone counting its own reps off Apple's Vision framework. Loser's stake goes to the winner. It's the first thing on this list that's inherently viral, because you can't do a 1v1 without inviting someone.

Sponsored pots are the business. A brand funds the pot and buys an audience that provably trained. "12,000 people did 12+ workouts this month" is a number no other channel can sell you. It works one person at a time too: a discount code that only reaches people who verifiably trained twelve times last month is acquisition pointed straight at the person who buys gym clothes, and nobody else can issue that code honestly.
