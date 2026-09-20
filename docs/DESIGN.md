# Snap — design decisions

Hack the North 2026. 2 people. Hacking ends **Sun Sep 20, 8:00 AM EDT**.

> **Sat 2:00 PM EDT: initial Devpost submission is due.** It must list both teammates, badge IDs, and every sponsor prize we want. Prizes can't be added afterwards.
> Enter: **Solana, OpenAI, Cloudflare (Best Agent with a Brain), Linq, Rox (Best AI Agent)**.

## The one loop

```
text "gym at 7, $5 on it"
  → agent parses commitment, stake locked on Solana
  → 7:00 + grace passes, no workout reported from HealthKit
  → agent wakes itself, pulls context (skipped yesterday, goal 4x/wk, money on the line)
  → decides whether/how to intervene
  → texts you first
  → you reply with an excuse → it negotiates ("30 mins then. push day. go.")
  → you send a pic from the floor → it checks out → stake released, Snap hypes you up
  → or you skip → stake slashed to Snap's treasury
```

Nothing outside this loop gets built. No leaderboards, calories, feeds, or settings screens.

## Settled

| # | Decision |
|---|----------|
| Client | Native SwiftUI app on a physical iPhone. Three jobs only: onboarding, HealthKit → backend sync, "Snap's brain" trace screen. |
| Where Snap lives | In the message thread, not in the app. The app never has a chat UI. |
| Messaging | One `Channel` interface, two adapters. **Telegram** for development (no caps). **Linq** (real iMessage) for the demo. Linq sandbox: 100 msgs/day, and the user must text Snap first — so onboarding ends with "text Snap `yo <code>`". |
| Commitments | Made by texting in plain language. The agent turns them into structured commitments via tool calls. App only displays them. |
| Solana | **Commitment staking.** Money is locked when you commit, returned when HealthKit confirms the workout, slashed when you skip. Devnet. |
| Slash destination | Snap's treasury wallet (ours). The whole stake. (A half-back-to-the-user split was built, deployed and then withdrawn on Saturday evening; the app copy, the wire and this row all say the whole stake again.) |
| Escrow | Small Anchor program (`stake` / `release` / `slash`), backend key is the oracle. **Cutoff: if not working on devnet by Sat 6 PM, fall back to a backend-held wallet doing plain transfers.** |
| Agent brain | OpenAI API with function calling. |
| Backend | TypeScript on Cloudflare Workers. One Durable Object per user (Agents SDK) holds memory + state. Durable Object **alarms** are what make Snap proactive — no cron. |
| Missed-workout detection | App uses `HKObserverQuery` + background delivery and POSTs workouts as they appear. Backend treats "nothing reported by deadline + grace" as missed. No silent push. |
| Agent trace | Every agent step is logged as a trace event and shown live on the "Snap's brain" screen. The agent can decide *not* to text, and that shows too. |
| Demo | Real HealthKit, real agent, unscripted messages. A debug time-warp endpoint moves the agent's clock past the deadline. |
| Voice | One persona: your gym bro. Lowercase, short, multiple texts in a row, never a paragraph. "bro", "nah", "😭", "lock in". Funny, not mean. Never sounds like an assistant. |
| Proof | A photo, sent in the thread. There is no upload button in the app: the verifier lives in the conversation, which is also where the roast for a bad one lands. |
| Tapbacks | Both directions. Snap reacts to your texts the way a person does, and a 👍 or ❤️ on a stake he offered **is** the yes that locks it — decided in the backend, not by the model, and explained in the thread's onboarding before it can ever cost anyone anything. |
| Codex | One self-contained piece is built with Codex (the Anchor program + tests). Keep the prompt and the diff — the OpenAI prize asks for a concrete Codex story. |

## Prize mapping

- **Solana** — on-chain escrow that an AI agent releases or slashes based on real health data.
- **Cloudflare** — Workers + Durable Objects are the actual runtime: memory, tools, state, self-scheduled actions.
- **OpenAI** — the agent's reasoning and tool calls; Codex built the escrow program.
- **Linq** — the whole product happens in iMessage.
- **Rox** — acts on messy real-world data: HealthKit samples plus free-text excuses.

## Stake rules

- **Verification:** the **photo is the verifier**. A picture with them in it, in a training setting, releases the stake — checked by the vision model, fingerprinted so the same one cannot pay twice, and settled in code before the agent speaks. A screenshot, an empty room, a photo with nobody in it, or anything the model is under 0.6 confident about does not pass. **HealthKit is the silent fallback**: someone who trained and forgot to send a picture still gets paid, and the app tells them that is what happened. The fallback is never advertised in onboarding — a user who knows about it hears "the pic is optional".
- **Wallet:** at onboarding the backend creates a devnet wallet per user and funds it from the treasury. The app has a wallet screen — balance, what is locked, where it went, and an "add money" button (`POST /wallet/topup`) — because a stake nobody can see the source of is a stake nobody trusts. Staking itself still happens by text: the wallet screen hands you the thread with the words typed, it does not have a stake button. Custodial for the demo; say so to Solana judges, Phantom is the production path.
- **Covering the stake:** a stake larger than the wallet is refused before anything is offered or locked, and Snap says so and points at the app. Never a stake that "locked" against money that is not there.
- **Size:** 0.05 SOL unless the user names an amount.
- **Timeline:** commitment time + 20 min grace → Snap texts a warning (not a slash). Slash happens at end of day, or at the renegotiated deadline. Texts in between carry the countdown ("36 mins left on your $5").
- **Renegotiation:** at most one per commitment, **and the door shuts an hour before the session**. Same stake, new deadline. Inside the last hour the answer is no, whatever the excuse — an hour out you are rearranging your day, ten minutes out you are weaselling, and that is the window every excuse arrives in. Before that, the agent still decides whether the excuse earns it, using history — skipped yesterday → "nah. you said that yesterday 😭".
- **The move log:** every accepted move is written down and shown to both sides — on the plan card, and to the agent as a week-wide count. The limit stops one session being moved twice; the log is what lets Snap say "third one this week".
- **Morning check-in:** if there's no commitment for today, Snap texts first to ask the plan. Same alarm mechanism. No other unprompted texts.

## Demo

- Apple Watch starts a real workout on stage to close the loop. **The Watch's workouts only land in HealthKit on the iPhone it's paired with — that iPhone has to be the demo phone**, with the app installed and onboarded.
- iPhone mirrored to a laptop (QuickTime) so judges see the trace and the incoming text together.
- **Demo phone = whichever iPhone the Apple Watch is paired with.** That phone needs the build installed, onboarded, and linked to Snap on both Linq and Telegram by Saturday night. No Watch on the day → debug panel's simulated workout, and say it's simulated.
- **Seeded history:** a debug action seeds a plausible week for the demo user (2/4 done, skipped yesterday, one earlier excuse). Seeded data, real reasoning — say so if asked.
- **Fallbacks:** Telegram already linked on the demo phone as a second channel; phone hotspot, not venue wifi; 60-second screen recording of a clean run done by Sun 6 AM (also the Devpost video).
- **Feature freeze: Sun 4 AM.** Last four hours are rehearsal and polish only.

### The 5 minutes (no slides, rehearse 5+ times)

| Time | Beat |
|------|------|
| 0:00 | "Snap is a gym bro who texts you first — and takes your money if you skip." |
| 0:20 | Text the commitment + stake live. Trace shows the lock on Solana. |
| 1:00 | Time-warp past the deadline. Phone buzzes. Brain screen shows why it decided to text. |
| 2:00 | Reply with an excuse. Past the deadline it refuses to move the session — the door shut an hour out — and says so. |
| 3:00 | Send a photo. A screenshot gets roasted; the real one releases the stake on the spot. Fall back to the Watch workout if the vision model is unreachable. |
| 4:00 | 30 seconds of architecture, naming each sponsor's piece. |
