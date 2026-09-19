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

`ios/project.yml` is the source of truth. Re-run `xcodegen` whenever files are added or removed. Commit the generated `Snap.xcodeproj` so the repo opens with a double-click. The team id and the app-icon setting are in `project.yml` so regenerating keeps signing and the icon; if you change signing in Xcode, change it there too.

In Xcode, set the signing team on the Snap target once. HealthKit needs a real device and a provisioning profile with the HealthKit capability; the simulator can run the UI and the mock, not background delivery.

## What exists

Everything below is written, builds, and has been run on a simulator and a device. The per-file sections that follow are the spec each file was built to; where the code deliberately differs (the countdown is ink rather than lime so lime stays a fill; settled commitments show a verdict instead of a clock) the code is right and this document says so inline.

Unit tests live in `ios/SnapTests` and run with the `Snap` scheme. `ios/SnapUITests` proves on a real HealthKit store that a simulated workout is not flagged hand-entered; it drives a system permission sheet, so it is skipped by default — run it with `-only-testing:SnapUITests`.

Launch hooks (DEBUG only): `SNAP_PAGE=<hello|name|goal|deal|health>`, `SNAP_PHASE=<linking|live>` (forces `MockAPI`), `SNAP_TIMEWARP=1`, `SNAP_HKDIAG=1`.

## Files

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

Five pages, one idea each. Every page has the same shape as the reference check-in: back chevron,
progress dashes and a "start over" cross across the top; an illustration; the question in grey;
the explanation; the answer as a big statement at the bottom; the circular next button bottom-right.
Everything is centred. The hello page is a cover and shows no chrome.

1. **`meet snap.`** — the line up top, the mark filling the bottom of the screen, one pill button.
2. **`what should snap call you?`** — centred name field with an underline.
3. **`how many days a week?`** — the dumbbell, then "every week / i'll train 4 days." over a 1–7 slider (`SnapSlider`, snapping, haptic per step). The sentence rewrites itself as the thumb moves.
4. **`put money on it.`** — laid out like the reference's plan page: the headline, "0.05 SOL" in the gradient, then a white card of three rows (text a plan · he checks, not asks · show up, get it back) with the stake row marked by a `SOL` pill.
5. **`i need to see your workouts.`** — the reason on screen, then the HealthKit sheet over it. Denied permission still continues — the app just won't sync. A "skip for now" link does the same thing without asking.

Page 5's button requests HealthKit permission, then calls `onboard`.

`SNAP_PAGE=goal` as a launch environment variable opens straight onto a page (DEBUG only), so
a screen can be iterated on without clicking through the flow. `SNAP_PHASE=linking` does the
same for the link screen.

### `Views/LinkView.swift`

"last thing. text snap." and the code, huge, in the app's one gradient: `yo 4821` (tap to copy). Two buttons: **iMessage** opens `sms:<number>&body=yo%204821`, **Telegram** opens `https://t.me/<bot>?start=4821`. Show only the buttons whose contact came back from `/onboard`. The screen advances by itself when `state.linked` turns true. `ThreadLink` at the bottom of this file is the one place that builds those URLs; the today screen's `+` uses it too, with nothing pre-filled.

### `Views/BrainView.swift`

The live app: two screens and a bottom bar — **today · + · brain**. The `+` opens the message thread (iMessage first, Telegram otherwise), because a new plan is a text, never a form.

**today** is the reference's home screen, top to bottom:

1. **Header.** Streak pill (`flame 2/4`, workouts this week over the goal), the greeting (`good evening.`, by hour), and an ink circle with the first letter of your name. Long-press anywhere in the header for the debug panel; nothing on screen advertises it.
2. **Week strip.** Sunday to Saturday with today in a hairline box. It's a calendar, not a scoreboard.
3. **Plan card.** The dark gradient card. Kicker (`today's plan`), the commitment text in white, then a live countdown to `checkAt` using `TimelineView(.periodic(from: .now, by: 1))` — white, then counting **up** in red with "late" once passed. `met` shows `done.`, `missed` shows `missed.` in red. A white "text snap" pill at the bottom. With no open commitment: "no plan yet / what's the move today?".
4. **Stake card.** White, only when a stake exists: `0.05 SOL on the line.`, where it is (`held · solana devnet`, `released · back in your wallet`, or `slashed · gone`), a status pill (the gradient for `held`, ink for `released`, red for `slashed`), one line of what happens next, and the explorer receipt as an outline pill when the backend sent a signature (labelled `mock` on the mock).
5. **`SNAP'S BRAIN`** section label, the last three trace rows, and a "see everything" pill that switches to the brain tab.

**brain** is the full trace and nothing else. Each row: time (`HH:mm:ss`, monospaced, dim), a glyph per `kind`, the `summary`. Rows enter from the bottom with opacity + slight offset and the feed auto-scrolls to the newest. `message_sent` rows are ink bubbles on the right, `message_received` grey bubbles on the left, so the conversation is readable inside the trace. `decision` rows are white cards with a lavender bolt — the only cards in the feed.

### `Views/DebugPanel.swift`

Sheet from the long-press. Server URL and debug key fields (save → `reloadAPI()`), then: **Time-warp to check time** (`timewarp(to: checkAt + 60 s)`), **Reset clock** (`timewarp(to: nil)`), **Seed demo history**, **Save simulated workout**, **Reset app**. Last error string at the bottom.

## Look

Light only, and monochrome. Paper (`#F2F2F2`), white cards, near-black ink (`#141414`), grey secondary type (`#6B6B6B`, 4.9:1 on paper), hairlines (`#D9D9D9`). One colour in the whole app: a lavender-to-rose diagonal gradient (`#8C8BD8` → `#D990B4`) that appears only where money is on the line — the `0.05 SOL` line on the deal page, the code card, the `held` stake pill. One warning red for "late" and "missed" (`#D0342C`, `#FF6B5E` on the dark card). The system face, bold and lowercase, for everything the user reads; tabular digits for the countdown; monospaced for the trace. Big-radius cards (36 pt) with a faint lift, one dark gradient card per screen, a thick ink slider with a white thumb, tracked uppercase for section labels and nowhere else. The mark is Snap himself: a speech bubble with its eyes closed, happy, drawn in code (`SnapMark`) and shipped as `brand/snap-mark.svg`. Lowercase copy throughout, same voice as Snap's texts.

## Done means

- [ ] Fresh install with no server URL: onboarding → link screen → brain screen plays the full mock script, staggered, with the countdown flipping to red "late".
- [ ] With Hugo's URL: onboard against the real backend, text the code, link screen advances on its own.
- [ ] A workout ended on the paired Watch appears as `workout_detected` in the trace without touching the phone.
- [ ] Killing the network mid-sync and restoring it resends the workout (anchor not advanced on failure).
- [ ] Time-warp from the debug panel makes the phone buzz with Snap's text while the trace shows why.
- [ ] Mirrored to a laptop over QuickTime, the trace is legible from two metres away.
