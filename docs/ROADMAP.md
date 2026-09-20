# Snap — positioning, money, and competitions

Everything here is **post-hackathon**. Nothing in this file gets built before Sun 4 AM (see `DESIGN.md` → feature freeze). It exists so the Devpost write-up and the "what's next" 30 seconds of the pitch have a spine.

## Why Snap is different

The market already has every piece of Snap on its own. The combination is the product.

| Category | Who | How they verify | Voice |
|---|---|---|---|
| Money-stake apps | StickK, Beeminder, Forfeit, Pledgd, FineStreak | Human referee, unchecked photo, GPS, honor system | None |
| AI coaches that text | Ryke AI, Tomo, BodyBuddy, Accountablo | You tell it in chat | Coach |
| AI in iMessage | Poke, Sidekicks | Nothing | Assistant |

What nobody does together:

1. **The photo is the referee, and it is judged, not trusted.** Everyone else who takes a photo takes it on trust or pays a human to look. Snap's vision model checks that a person is actually in a training setting, refuses screenshots, and fingerprints every image so the same picture cannot be spent twice. **It does not check that the person is you** — say so out loud, because a judge will test it. Two things cover that instead: every stake names a random gesture when it locks (*3 fingers up in the pic*), which a photo you already had cannot have in it, and HealthKit sits underneath as a fallback that pays you when you trained and forgot. No honor system, and no "did you go?"
2. **Ghosting doesn't work.** Stop replying and the money still moves. Every AI coach loses the user the moment the user goes quiet.
3. **Judgment, not rules.** Forfeit and Beeminder are deterministic. Snap negotiates, remembers yesterday's excuse, and decides.
4. **Anti-coach.** No plans, no macros, no encouragement. A friend who roasts you and holds your money. This ban is permanent.
5. **Transparent brain.** Snap shows why it texted and why it chose not to. No one else exposes the agent's reasoning to the user.

Not differentiators: being in iMessage (table stakes), and "it's on Solana" (a prize, not a pitch — sell what the chain enables below, not the chain).

One-liner to test: *"Every accountability app takes your word for it. Snap wants the picture — taken right now, with the gesture he asked for — and it's holding five bucks."*

The old version ended *"and it can tell when you're lying"*. It cannot tell that the person in the photo is you, and a one-liner that overclaims is the one a judge spends the Q&A on.

## Money

**Rule: winners get 100% back.** Loss aversion only works when success costs nothing. Every competitor returns the full stake on success; a haircut on winners turns the stake into a fee and people stop staking. Snap makes money from skippers and from pots, never from a successful workout.

| Model | Per $5 stake, skip | Per $5 stake, success |
|---|---|---|
| Hackathon (per-commitment, slash → treasury) | $5.00 | $0 |
| Weekly pot, 15% rake | $0.75 (rest to winners) | $0.75 of the pot |
| Optional house fee, 3–5% per stake | $0.15–0.25 + slash | $0.15–0.25 |

The weekly pot is the default post-hackathon model: everyone stakes for the week, hit your goal and you get your stake back plus a share of what the skippers lost, Snap takes a cut of the pot. DietBet and StepBet have run this for a decade. It earns on every player every week and grows with every friend you drag in.

## Competitions

Three kinds, one engine. Every competition is: a pot, a rule ("N verified workouts between start and end"), a set of entrants, and an oracle (Snap's backend) that settles it from HealthKit data. Entry, trash talk, and results all happen by text — there is still no leaderboard screen in the app; the brain screen shows your standing as one line.

### 1. House competitions (run by Snap)

- **Weekly pot.** The money model above, framed as a game. "snap put me in this week" → stake locked, goal is your own weekly target.
- **1v1.** "snap, me vs @tyler, 4 workouts by sunday, $10." Both stake, loser's stake goes to the winner minus rake. Snap texts both of them, and it's allowed to instigate: "tyler just hit 3/4. you're at 1 😭".
- **Group pots.** Same thing for a group chat. Last one standing takes the pot, or everyone who hits the goal splits it.

### 2. Sponsored competitions (run by brands)

A brand funds the pot; users enter free or with a stake; Snap settles it.

- **What the brand buys:** an audience that provably trained. Not impressions — verified behavior. "12,000 people did 12+ workouts in the Gymshark 30" is a number no other channel can sell.
- **What the user sees:** the sponsor's name inside Snap's normal texts, never an ad. "gymshark 30 is live. 12 sessions this month, they put up $20k. you in?" → "4/12. 9 days left."
- **Sponsor targets:** apparel (Gymshark, Alphalete), drinks (Celsius, Alani), gym chains (a local chain sponsoring its own members), and protocol foundations for launch.
- **Revenue:** flat sponsorship fee + a rake on any user-side stakes. Free-entry pots (sponsor money only) sidestep most gambling rules — "no purchase necessary" — so that's the default for sponsored comps.
- **Why the chain matters here:** the sponsor's pot sits in an on-chain escrow they can watch. Deposit, entrants, and payouts are auditable without trusting Snap. This is the first place Solana is a product feature, not a prize.

### 3. Ranked and fantasy (against other people)

- **Ranked.** A ladder built from verified workouts, stake size, and hit rate. Tiers with gym-bro names (Bronze → Silver → Gold → Locked In). Rank decays when you skip. Snap references it in texts: "you're about to drop out of gold. 2 sessions to hold it."
- **Fantasy.** Draft your friends. Their verified workouts score points for your team each week; skips cost you. Snap texts the league: "ryan's team is carried entirely by his mom." Fantasy is the growth loop — you can't play without inviting the people you draft, and they can't score without onboarding HealthKit.
- **Seasons.** Monthly. Season pot from house rake + a sponsor. Top of the ladder at season end splits it.

### 4. Live challenges — the one HealthKit cannot judge

Everything above verifies *that you trained*. None of it verifies *what you did*. A 45-minute strength session and 45 minutes of half-hearted machine circuits are the same row in HealthKit, and a bench PR is not a HealthKit data type at all.

Live challenges are the answer to that, and they are a game rather than a feature: two to eight people on a video call, phones propped up, everyone doing the same exercise. Each phone counts its own reps from the camera. Loser's stake goes to the winner.

**Pose counting is cheap and needs no data.** Apple's Vision framework ships `VNDetectHumanBodyPoseRequest` — 19 joints, on-device, no model to train and nothing to collect. A pushup rep is the elbow angle crossing a threshold and returning. Depth is the same measurement: if the elbow never passes ~90° at the bottom, score it half. Form scoring is joint-angle heuristics, not machine learning, which is why this is days of work rather than a research project.

**The video call is not garnish — it is the verification.** This is the part worth being clear-eyed about. A rep count posted by our own app is self-reported by software we control, which is *strictly weaker* than HealthKit. What makes a live challenge trustworthy is the opponent watching you do it. Pose counting without the call is a worse version of what Snap already has; the call without pose counting is just a video chat. Both or neither.

**It plugs into the engine that already exists.** The `Competition` object already holds a pot, a rule, an entrant list and an oracle, and already settles pro rata with the rake coming out of what the skippers forfeited. A live challenge is one more goal type — `reps`, with an exercise — and a settlement that reads final counts instead of HealthKit. No new money path.

**What it costs, honestly:**

| piece | size |
|---|---|
| Pose counting + form scoring on-device | ~1 day of iOS |
| Multi-party video (WebRTC, signalling, TURN) | the real cost — days, and the first thing to buy rather than build |
| Backend: `reps` goal type, live scoreboard | small, the engine is there |

**Why it is worth it anyway.** It is the first thing in this document that is inherently viral: you cannot do a 1v1 without inviting someone, and a 4v4 drags in six people who each need the app. It is also the only feature here a spectator can understand in three seconds, which matters more for growth than anything about escrow.

**Where it does not go.** This stays a side mode, not the main loop. Snap's claim is that it never asks — filming yourself is asking, with extra steps, and the day the core loop requires a camera is the day we become Forfeit with more steps. The daily commitment stays passive and sensor-verified; live challenges are what you do *because you want to*, on a Friday night, for money.

### 5. Kaggle-shaped seasons

Competitions today are a pot and a goal. The Kaggle shape adds a **public leaderboard with a deadline and a prize table** — first, second, third, and a long tail who all beat the bar.

- A month-long season, one verified metric (sessions, active hours, distinct days), a live board, and a sponsor funding the top of the table.
- **The Kaggle part that matters is the leaderboard, not the prize.** People refresh a board. A pot you cannot see yourself climbing is a bet; a board you can is a game.
- It reuses the competition engine exactly as built — `progressFor` already computes every metric a season would rank on. What is missing is the board itself and a season long enough for it to mean something.

### What stays true across all of them

- Verification is the same as the core loop: a checked photo, with HealthKit underneath. No self-report, no "trust me." A comp that can be gamed is worth nothing to a sponsor — and a pot is exactly where someone would try a recycled photo, which is what the fingerprint is for.
- Same bar as the core loop, so the claim stays credible.
- Snap's voice doesn't change. It instigates, it roasts, it never becomes a scoreboard bot.
- No new screens. Standing is one line on the brain screen; everything else is in the thread.

### On-chain shape (for the Solana story)

The existing escrow program grows one account type: a `competition` PDA holding the pot, the rule hash, the entrant list, and the oracle key. Sponsors and entrants deposit into it; the oracle calls `settle` with the winner set and payouts go out pro rata. Same oracle model as the single-commitment stake, so it's an extension of what's demoed, not a rewrite.

## Verification, the next layer: identity

The gesture (built) proves the photo is from *now*. It does not prove it is *you*: a friend standing next to you could hold up three fingers. Closing that is one more layer, and it is deliberately not built yet.

- **Not photo ID.** Storing a government document proves you own a document, not that you are the person in the gym photo, and it turns a hackathon demo into a compliance problem. It is the obvious idea and the wrong one.
- **An enrolled selfie is the right one.** One face shot at onboarding, and every gym photo is compared against it by the vision model in the same call that judges the session. Same cost, one more question.
- **It must not be a new way to lose money.** A face the model cannot match in a dim mirror selfie is `unsure`, exactly like a missing gesture — nothing moves, Snap asks again, and the watch underneath still pays you. A verifier that wrongly accuses someone who actually trained is worse than one that occasionally lets a cheat through; someone told "that isn't you" after a real session never stakes again.
- **What it needs:** an enrollment screen in the app, a reference image held per user, and a two-image vision call. The backend already routes every photo through one place, so it drops in behind `describePhoto`.

## Perks and partnerships

### Perks — what a verified streak is actually worth

The sponsored pot sells proof in bulk. This sells it one person at a time, and it is the cheaper thing to launch.

Snap is the only app in this category that can answer *"did this person really train twelve times last month?"* with something better than a self-report. That answer is worth money to anyone selling to people who train — which is the whole industry.

- **The shape:** hit a bar Snap can verify — 12 verified sessions in a month, an 8-week streak, a competition won — and a code lands in the thread. `"20% off alphalete. you earned it, don't waste it."` Not a coupon blast: a reward with a receipt behind it, sent in his voice, at the moment it means something.
- **Why a brand pays more for this than for an ad:** a discount code given to everyone is a discount. A code that only reaches people who provably trained twelve times is customer acquisition aimed at the exact person who buys gym clothes, and the brand can audit the bar. Nobody else can issue that code honestly.
- **Why it fits the anti-coach ban:** a perk is not advice. Snap never tells you what to train; he tells you what you earned.
- **Tiers, if it works:** the bar rises with the reward. A free month of a gym chain for a 12-week streak costs the chain almost nothing — that person is already showing up — and it is worth more to them than any ad.
- **What it needs:** a `perks` table keyed on the same verified counters competitions already settle from, plus the brand relationship. The verification is built; the deal is the work.

### Content and referrals

Same principle: pay for the thing you can verify.

- **Referrals** are the clean one. A friend you brought in who *stakes and trains* is worth a cut of the rake on their first month. It settles from data Snap already holds, and it cannot be farmed by signups that never stake.
- **Content** is the messy one. Posting a clip about Snap is not verifiable the way a workout is, so it is a manual bounty, not a mechanic — a monthly pot for the best clips, judged by us, paid in SOL. Worth doing for reach; worth being honest that it is marketing spend rather than a settled competition.

## Legal note, so it isn't a surprise later

Stakes + prizes + chance = gambling in a lot of places. Snap's comps are skill/effort based and verified, which helps, but: keep sponsored pots free-entry, keep user stakes as "your own money back or not" rather than "win other people's money" until there's a lawyer in the loop, and don't run anything cross-border on mainnet before then. Devnet for the hackathon makes all of this moot.
