# iOS — start here

Read `DESIGN.md` and `API.md` first. The Xcode project lives in `ios/`.

The app has three jobs. It has no chat UI — Snap lives in Messages.

## Build order

1. **Project + HealthKit permission.** SwiftUI app, HealthKit capability, background delivery entitlement, `NSHealthShareUsageDescription`. Read access to workouts (and write access, so a debug button can save a fake `HKWorkout` if there's no Apple Watch around).
2. **Workout sync.** `HKObserverQuery` on `HKWorkoutType` + `enableBackgroundDelivery(.immediate)`, then an `HKAnchoredObjectQuery` to fetch what's new, then `POST /workouts`. Resending is safe — the backend dedupes on `hkUuid`. Until the backend URL exists, point at a mock.
3. **Onboarding.** Name, weekly goal, HealthKit permission, `POST /onboard`, then one screen: "text Snap `yo 4821`" with a button that opens Messages / Telegram prefilled. Store the token in the Keychain.
4. **"Snap's brain" screen.** The main screen. Poll `GET /trace` and `GET /state`. Trace events animate in one at a time as a vertical feed — this is what judges watch on the mirrored screen while the text arrives on the phone. Above it: the open commitment, a countdown to the deadline, and the staked amount.
5. **Polish.** This screen is most of the Design score. One strong visual idea, done properly, beats several screens.
6. **Hidden debug panel** (long-press the logo): time-warp to "deadline + 1 min", save a fake workout, reset.
