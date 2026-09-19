# Snap

Your gym bro in your texts. Snap knows when you said you'd work out, sees (via HealthKit) that you didn't, and texts you first — with money on the line.

Built at Hack the North 2026.

## The loop

commitment → missed workout detected → agent evaluates context → proactive text → reply → personalized response → workout detected → stake returned

## Layout

- `ios/` — SwiftUI app (onboarding, HealthKit sync, "Snap's brain" trace screen)
- `backend/` — agent, messaging channel adapters (Telegram first, swappable), Solana stake escrow
- `docs/` — design decisions
