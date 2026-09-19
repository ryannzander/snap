# Snap — positioning, money, and competitions

Everything here is **post-hackathon**. Nothing in this file gets built before Sun 4 AM (see `DESIGN.md` → feature freeze). It exists so the Devpost write-up and the "what's next" 30 seconds of the pitch have a spine.

## Why Snap is different

The market already has every piece of Snap on its own. The combination is the product.

| Category | Who | How they verify | Voice |
|---|---|---|---|
| Money-stake apps | StickK, Beeminder, Forfeit, Pledgd, FineStreak | Referee, photo, GPS, honor system | None |
| AI coaches that text | Ryke AI, Tomo, BodyBuddy, Accountablo | You tell it in chat | Coach |
| AI in iMessage | Poke, Sidekicks | Nothing | Assistant |

What nobody does together:

1. **It never asks if you did it. It knows.** HealthKit is the referee. No photo, no honor system, no "did you go?"
2. **Ghosting doesn't work.** Stop replying and the money still moves. Every AI coach loses the user the moment the user goes quiet.
3. **Judgment, not rules.** Forfeit and Beeminder are deterministic. Snap negotiates, remembers yesterday's excuse, and decides.
4. **Anti-coach.** No plans, no macros, no encouragement. A friend who roasts you and holds your money. This ban is permanent.
5. **Transparent brain.** Snap shows why it texted and why it chose not to. No one else exposes the agent's reasoning to the user.

Not differentiators: being in iMessage (table stakes), and "it's on Solana" (a prize, not a pitch — sell what the chain enables below, not the chain).

One-liner to test: *"Every accountability app asks if you worked out. Snap already knows, and it wants its five bucks."*

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

### What stays true across all of them

- Verification is always HealthKit. No photos, no self-report, no "trust me." A comp that can be gamed is worth nothing to a sponsor.
- Same duration floor and workout-type filter as the core loop, so "it knows" stays credible.
- Snap's voice doesn't change. It instigates, it roasts, it never becomes a scoreboard bot.
- No new screens. Standing is one line on the brain screen; everything else is in the thread.

### On-chain shape (for the Solana story)

The existing escrow program grows one account type: a `competition` PDA holding the pot, the rule hash, the entrant list, and the oracle key. Sponsors and entrants deposit into it; the oracle calls `settle` with the winner set and payouts go out pro rata. Same oracle model as the single-commitment stake, so it's an extension of what's demoed, not a rewrite.

## Legal note, so it isn't a surprise later

Stakes + prizes + chance = gambling in a lot of places. Snap's comps are skill/effort based and verified, which helps, but: keep sponsored pots free-entry, keep user stakes as "your own money back or not" rather than "win other people's money" until there's a lawyer in the loop, and don't run anything cross-border on mainnet before then. Devnet for the hackathon makes all of this moot.
