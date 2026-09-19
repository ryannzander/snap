# Snap

Your gym bro in your texts. Snap knows when you said you'd work out, holds your money until you send a pic from the gym, and can tell when the pic is a screenshot.

Built at Hack the North 2026.

## The loop

commitment → deadline passes with no pic → agent evaluates context → proactive text → reply (or a 👍) → personalized response → pic arrives and checks out → stake returned

The photo is the verifier: a picture with you in it, on the gym floor. The vision model judges it, a screenshot doesn't pass, and every image is fingerprinted so the same one can't be spent twice. HealthKit sits underneath as a silent fallback for the day you train and forget to send anything.

The first text you ever get explains all of it: what Snap does, that the pic is how you get paid, and that tapping 👍 on an offer is how you agree to a stake. The money it comes out of lives in the app's wallet screen — balance, what's locked, where it went, and a button to add more.

## Layout

- `ios/` — SwiftUI app (onboarding, HealthKit sync, "Snap's brain" trace screen)
- `backend/` — agent, messaging channel adapters (Telegram first, swappable), Solana stake escrow. **Lives in a separate repository**; this one holds only the app, which talks to the deployed Worker in `ios/Snap/Config.swift`.
- `brand/` — the mark, app icon, wordmark and Devpost banner. `brand/snap-icon.png` is what ships in the app's asset catalog.
- `docs/` — design decisions. [`docs/CODE_REVIEW.md`](docs/CODE_REVIEW.md) is the last full review of this repo.
