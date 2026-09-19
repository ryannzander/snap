# iOS app — build spec

Read `DESIGN.md` and `API.md` first. This file is everything needed to build `ios/` from its current state to demo-ready. `IOS_TASKS.md` is the short version of the same order.

## Before anything compiles

Xcode 27 is installed at `/Applications/Xcode.app`, but this Mac is pointed at the Command Line Tools and the Xcode license has not been accepted. `xcodebuild` refuses to run until Ryan does this once, in a terminal:

```sh
sudo xcode-select -s /Applications/Xcode.app/Contents/Developer
sudo xcodebuild -license accept
```

Then generate the project (XcodeGen is installed at `/opt/homebrew/bin/xcodegen`):

```sh
cd ios && xcodegen
```

`ios/project.yml` is the source of truth. Re-run `xcodegen` whenever files are added or removed. Commit the generated `Snap.xcodeproj` so the repo opens with a double-click.

In Xcode, set the signing team on the Snap target once. HealthKit needs a real device and a provisioning profile with the HealthKit capability; the simulator can run the UI and the mock, not background delivery.

## What already exists (none of it has been compiled yet)

| File | State |
|------|-------|
| `ios/project.yml` | Done. iOS 18 target, bundle id `com.ryanzander.snap`, portrait, light, HealthKit usage strings, entitlements. |
| `ios/Snap/Snap.entitlements` | Done. HealthKit + background delivery. |
| `ios/Snap/SnapApp.swift` | Done. `RootView` switches on `model.phase` (`.onboarding / .linking / .live`) and calls `model.start()`. |
| `ios/Snap/Config.swift` | Done. `baseURL` and `debugKey` in UserDefaults, editable from the debug panel. Empty `baseURL` → `MockAPI`. Put the Worker URL in `defaultBaseURL` once Hugo deploys. |
| `ios/Snap/Model/Models.swift` | Done. Codable types mirroring `API.md`, plus `Commitment.checkAt` and `Stake.sol`. |

These reference types that are **not written yet**: `AppModel`, `SnapAPI`, `LiveAPI`, `MockAPI`, `Theme`, `OnboardingView`, `LinkView`, `BrainView`.

## Files to write

### `API/SnapAPI.swift`

```swift
protocol SnapAPI: Sendable {
    func onboard(_ body: OnboardRequest) async throws -> OnboardResponse
    func postWorkouts(_ workouts: [WorkoutDTO]) async throws
    func state() async throws -> SnapState
    func trace(since: Int?) async throws -> [TraceEvent]
    func timewarp(to date: Date?) async throws
    func seed() async throws
}
```

### `API/LiveAPI.swift`

`URLSession`, JSON, `Authorization: Bearer <token>` on everything but `/onboard`, `X-Debug-Key` on `/debug/*`. Encode dates as ISO 8601. **Decode dates with and without fractional seconds** — a Workers backend will send `2026-09-19T23:24:00.000Z` and `ISO8601DateFormatter` rejects that unless `.withFractionalSeconds` is set. Non-2xx → throw an error carrying the status code and body text, so it can be shown in the debug panel.

### `API/MockAPI.swift`

An actor (`MockAPI.shared`) that plays the whole loop with no backend, so the UI can be built and polished now. `onboard` returns link code `4821`. `state` returns goal 4, 2 done, one pending commitment "gym at 7" due 2 minutes after first launch, 20 min grace, 0.05 SOL held, and `linked: true` after 5 seconds. `trace` emits the script below on a timer; `timewarp` jumps straight to `alarm_fired`.

```
commitment_created  "gym at 7 · 0.05 SOL on it"
stake_held          "0.05 SOL locked · 4xK…9fQ"
alarm_fired         "7:24 — checking on gym at 7"
context             "no workout today · skipped yesterday · 2/4 this week · 0.05 SOL staked"
decision            "intervene — firm"
message_sent        "bro"
message_sent        "7:24 and no workout 😭"
message_sent        "you said no excuses today"
message_received    "homework bro"
decision            "one reschedule left · allow 30 min"
message_sent        "30 mins then. push day. go."
workout_detected    "strength training started"
stake_released      "0.05 SOL back in your wallet"
message_sent        "that's my guy"
```

### `Model/Keychain.swift`

Small wrapper over `SecItemAdd / SecItemCopyMatching / SecItemDelete` for one generic-password item. Holds the API token only. Link code, contact, and name go in UserDefaults.

### `Model/AppModel.swift`

`@MainActor @Observable`. Owns the session, the API, and polling.

- `phase`: `.onboarding` when there's no token, `.linking` while `state.linked == false`, `.live` after.
- `start()`: load the session, build the API via `Config.makeAPI`, start `WorkoutSync`, start polling.
- Polling: `state()` every 2 s and `trace(since: lastId)` every 1 s while the app is active; stop in the background.
- **New trace events are queued and appended one at a time, ~350 ms apart**, even when several arrive in one response. The feed should look like thinking, not like a list refresh.
- `onboard(name:goal:)`, `reset()` (clears Keychain, UserDefaults session keys, and the HealthKit anchor), `reloadAPI()` after the debug panel changes the server.
- Last error is kept as a string and shown only in the debug panel. The main screen never shows an error dialog.

### `Health/WorkoutSync.swift`

- Authorization: read `HKObjectType.workoutType()` and active energy; share `workoutType()` (for the simulated workout).
- `HKObserverQuery` on workouts + `enableBackgroundDelivery(for:frequency: .immediate)`. Call the observer's completion handler every time, including on failure, or iOS stops delivering.
- On each fire, run an `HKAnchoredObjectQuery` from the saved anchor (archive `HKQueryAnchor` with `NSKeyedArchiver` into UserDefaults), map to `WorkoutDTO`, `postWorkouts`, and only then save the new anchor. A failed POST must leave the anchor where it was so the next fire resends.
- First run with no anchor: only send workouts from the last 7 days.
- `type`: the `HKWorkoutActivityType` case name as a string (`traditionalStrengthTraining`, `running`, `cycling`, `walking`, `highIntensityIntervalTraining`, …), `other` for anything unmapped.
- `saveSimulatedWorkout()`: a 45-minute strength workout ending now, via `HKWorkoutBuilder`. Debug panel only.
- A workout the Watch is still recording does not appear in HealthKit until it ends. For the demo, a 60-second Watch workout is started and **ended**; the sync fires on end.

### `Views/Theme.swift`

Colors, fonts, spacing. See "Look" below.

### `Views/OnboardingView.swift`

Five pages, one idea each, with progress dashes and a back chevron across the top and a
circular next button bottom-right. Structure borrowed from Stoic; layouts are Snap's.

1. **`meet snap.`** — the mark, the line, one pill button.
2. **`what do i call you?`** — name field.
3. **`how many days a week?`** — 1–7 selector, default 4. These become the dots on the brain screen.
4. **`here's the deal.`** — three numbered rows: you text a plan · he watches your workouts · you go you get it back, you skip he keeps it. The stake gets its own beat so nobody is surprised by it later.
5. **`i need to see your workouts.`** — the reason on screen, then the HealthKit sheet over it. Denied permission still continues — the app just won't sync. A "skip for now" link does the same thing without asking.

Page 5's button requests HealthKit permission, then calls `onboard`.

`SNAP_PAGE=goal` as a launch environment variable opens straight onto a page (DEBUG only), so
a screen can be iterated on without clicking through the flow. `SNAP_PHASE=linking` does the
same for the link screen.

### `Views/LinkView.swift`

"text snap" and the code, huge: `yo 4821`. Two buttons: **iMessage** opens `sms:<number>&body=yo%204821`, **Telegram** opens `https://t.me/<bot>?start=4821`. Show only the buttons whose contact came back from `/onboard`. The screen advances by itself when `state.linked` turns true.

### `Views/BrainView.swift`

The only screen that matters. Top to bottom:

1. **Header.** `snap` wordmark (long-press opens the debug panel), and one dot per weekly-goal workout, filled for each done.
2. **Commitment card.** The commitment text; a live countdown to `checkAt` using `TimelineView(.periodic(from: .now, by: 1))` — counting down in the accent color, then counting **up** in red with "late" once passed; a stake pill: `0.05 SOL · held`, changing color for `released` / `slashed`. With no open commitment: "no plan yet. text snap."
3. **Trace feed.** Fills the rest of the screen. Each row: time (`HH:mm:ss`, monospaced, dim), a glyph per `kind`, the `summary`. Rows enter from the bottom with opacity + slight offset and the feed auto-scrolls to the newest. `message_sent` and `message_received` rows are drawn as small chat bubbles (right / left) so the conversation is readable inside the trace. `decision` rows are the brightest thing on screen.

### `Views/DebugPanel.swift`

Sheet from the long-press. Server URL and debug key fields (save → `reloadAPI()`), then: **Time-warp to check time** (`timewarp(to: checkAt + 60 s)`), **Reset clock** (`timewarp(to: nil)`), **Seed demo history**, **Save simulated workout**, **Reset app**. Last error string at the bottom.

## Look

Light only. Off-white paper (`#F3F3F1`), near-black ink (`#0B0C0A`), one acid-lime accent (`#C8FF1E`) used **as a fill, never as type** — lime on white is illegible, so it only ever sits behind ink. One warning red (`#D92E22`). Avenir Next Heavy for statements, rounded heavy numerals for the countdown, monospaced for the trace. Soft high-radius cards, no borders, no gradients, no tab bar, no navigation bar. The one visual idea is the trace: a live stream of an agent thinking, with the countdown above it as the only large element. Lowercase copy throughout, same voice as Snap's texts.

## Done means

- [ ] Fresh install with no server URL: onboarding → link screen → brain screen plays the full mock script, staggered, with the countdown flipping to red "late".
- [ ] With Hugo's URL: onboard against the real backend, text the code, link screen advances on its own.
- [ ] A workout ended on the paired Watch appears as `workout_detected` in the trace without touching the phone.
- [ ] Killing the network mid-sync and restoring it resends the workout (anchor not advanced on failure).
- [ ] Time-warp from the debug panel makes the phone buzz with Snap's text while the trace shows why.
- [ ] Mirrored to a laptop over QuickTime, the trace is legible from two metres away.
