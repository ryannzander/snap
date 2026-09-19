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
  → workout shows up in HealthKit → stake released, Snap hypes you up
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
| Slash destination | Snap's treasury wallet (ours). |
| Escrow | Small Anchor program (`stake` / `release` / `slash`), backend key is the oracle. **Cutoff: if not working on devnet by Sat 6 PM, fall back to a backend-held wallet doing plain transfers.** |
| Agent brain | OpenAI API with function calling. |
| Backend | TypeScript on Cloudflare Workers. One Durable Object per user (Agents SDK) holds memory + state. Durable Object **alarms** are what make Snap proactive — no cron. |
| Missed-workout detection | App uses `HKObserverQuery` + background delivery and POSTs workouts as they appear. Backend treats "nothing reported by deadline + grace" as missed. No silent push. |
| Agent trace | Every agent step is logged as a trace event and shown live on the "Snap's brain" screen. The agent can decide *not* to text, and that shows too. |
| Demo | Real HealthKit, real agent, unscripted messages. A debug time-warp endpoint moves the agent's clock past the deadline. |
| Voice | One persona: your gym bro. Lowercase, short, multiple texts in a row, never a paragraph. "bro", "nah", "😭", "lock in". Funny, not mean. Never sounds like an assistant. |
| Codex | One self-contained piece is built with Codex (the Anchor program + tests). Keep the prompt and the diff — the OpenAI prize asks for a concrete Codex story. |

## Prize mapping

- **Solana** — on-chain escrow that an AI agent releases or slashes based on real health data.
- **Cloudflare** — Workers + Durable Objects are the actual runtime: memory, tools, state, self-scheduled actions.
- **OpenAI** — the agent's reasoning and tool calls; Codex built the escrow program.
- **Linq** — the whole product happens in iMessage.
- **Rox** — acts on messy real-world data: HealthKit samples plus free-text excuses.

## Stake rules

- **Wallet:** at onboarding the backend creates a devnet wallet per user and airdrops into it. Staking happens by text — no wallet app. Custodial for the demo; say so to Solana judges, Phantom is the production path.
- **Size:** 0.05 SOL unless the user names an amount.
- **Timeline:** commitment time + 20 min grace → Snap texts a warning (not a slash). Slash happens at end of day, or at the renegotiated deadline. Texts in between carry the countdown ("36 mins left on your $5").
- **Renegotiation:** at most one per commitment. Same stake, new deadline. The agent decides whether the excuse earns it, using history — skipped yesterday → "nah. you said that yesterday 😭".
- **Morning check-in:** if there's no commitment for today, Snap texts first to ask the plan. Same alarm mechanism. No other unprompted texts.

## Demo

- Apple Watch starts a real workout on stage to close the loop. **The Watch's workouts only land in HealthKit on the iPhone it's paired with — that iPhone has to be the demo phone**, with the app installed and onboarded.
- iPhone mirrored to a laptop (QuickTime) so judges see the trace and the incoming text together.
