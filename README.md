# Snap

Your gym bro in your texts. Snap knows when you said you'd work out, sees (via HealthKit) that you didn't, and texts you first — with money on the line.

Built at Hack the North 2026.

## The loop

commitment → missed workout detected → agent evaluates context → proactive text → reply → personalized response → workout detected → stake returned

## Start here

1. [`docs/DESIGN.md`](docs/DESIGN.md) — what we're building and every decision made so far
2. [`docs/API.md`](docs/API.md) — the contract between the app and the backend
3. Your task list: [`docs/BACKEND_TASKS.md`](docs/BACKEND_TASKS.md) or [`docs/IOS_TASKS.md`](docs/IOS_TASKS.md)
4. [`docs/ROADMAP.md`](docs/ROADMAP.md) — positioning, money model, competitions. Post-hackathon only; for the pitch and Devpost.

**Sat 2:00 PM EDT — initial Devpost submission due, with every sponsor prize listed.**

## Layout

- `ios/` — SwiftUI app (onboarding, HealthKit sync, "Snap's brain" trace screen)
- `backend/` — agent, messaging channel adapters (Telegram first, swappable), Solana stake escrow
- `docs/` — design decisions
