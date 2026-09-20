# Snap — the table demo

For Sunday. Judges walk up, you show them the thing, they interrupt, they leave, the next group arrives. You'll run this six to eight times.

**Split:** Ryan holds the phone and reads Snap's texts out loud. Hugo talks and never touches the phone. One voice at a time.

---

## Before anything: the budget

**The Linq sandbox is 100 messages a day.** Onboarding alone is 10, and a full run is 8–12 more.

That is **six to eight complete runs**, and then Snap goes silent for the rest of the day.

- **Onboard once, tonight.** Never `POST /debug/forget` on the demo user — it wipes the link and re-onboarding costs another 10.
- **Reset between judges with `POST /debug/seed`.** Clears commitments, workouts and the trace; keeps the profile, the token and the chat link. Costs nothing.
- **Practise on Telegram, demo on iMessage.** Telegram has no cap and is already linked on the phone. Every rehearsal run on the real line is a judge you can't show.
- **Count out loud.** Ryan keeps a tally. At two runs left, say so.

---

## "So what is it?"

They ask this while you're still unlocking the phone. Answer in one breath, already moving:

> "It's a gym bro who lives in your texts. He never asks if you worked out — he watches your Watch, judges a photo you can't fake, and takes your money at midnight if you didn't go."

Then show them. **Don't set up, don't explain the architecture, don't say "so we built".** The demo is the argument.

---

## The 3:30

Beats, not a script. Each one has a **skip line** — the single sentence that carries it if a judge is impatient or has already interrupted you past it.

### 1. Commit live · ~40s

Ryan texts out loud: **"gym at 7 tonight"**

Snap offers a stake. Ryan reads it. Ryan says **"deal"**.

Hugo, while the brain screen fills:

> "He offered that himself. She never asked for a stake — most people don't know the feature exists. That's deliberate: deposit contracts beat reward incentives in the research, but almost nobody goes and finds one. So Snap brings it up."

When the lock lands: **"Real transaction, Solana devnet. Open it in Explorer if you want."**

Snap also names a gesture — *"3 fingers up in the pic"*. **Leave it hanging.** You pay it off in beat 4.

> **Skip line:** "He offers the stake himself, and it locks on devnet for real."

### 2. It texts first · ~45s

Hugo time-warps past the deadline. **The phone buzzes on the table.**

> "Nobody pressed anything. It woke itself up."

Ryan reads: *"yo, 18 mins over, bro. i see you."*

Hugo, on the brain screen:

> "That's its own reasoning. It read the history first — nothing today, skipped yesterday, 2 of 4 this week, money in escrow — and decided to speak. It logs the times it decides **not** to, as well. It once refused to text at 2:30 in the morning because 'texting now would just wake them.'"

**This is the beat most likely to get a reaction.** Give the restraint line room.

> **Skip line:** "It texts you first, unprompted, and it shows you why — including the times it stayed quiet."

### 3. The excuse, and the refusal · ~45s

Ryan: **"cant today bro, too much work"**

Snap refuses. Ryan reads: *"nah bro, can't push this any further. your sol's already on the line."*

Hugo:

> "One reschedule per commitment, ever, and the door shuts an hour before the deadline. An hour out you're rearranging your day; ten minutes out you're getting out of it.
>
> And the model didn't decide that. Every tool call it proposes goes through a guard first. Both models we tested tried to take the money early — the guard refused every time. **The model does the talking. The backend does the money.**"

> **Skip line:** "It negotiates, but the rules are in code, not in the prompt."

### 4. The photo · ~35s

Ryan sends a real photo, mid-set, **three fingers up**. Stake releases. Snap hypes it.

Hugo — **volunteer the limitation before they find it**:

> "A vision model checked that: a real person, actually training, not a screenshot, and every image is fingerprinted so you can't spend the same one twice.
>
> But it cannot tell you that's *her*. No vision model can, and we're not going to pretend otherwise. So the stake named a random gesture the moment the money locked. A photo she already had can't have three fingers up in it — nobody knew which gesture until the money moved. And her Watch is underneath all of it as the backstop."

> **Skip line:** "The photo has to have a gesture in it that we picked at random after the money locked."

### 5. What's underneath · ~25s

Only if they're still with you. Name the sponsors as you go:

> "Cloudflare Workers and Durable Objects — one object per user, scheduling its own alarms, no cron anywhere. OpenAI for the agent and the vision, Workers AI behind it as a fallback. Real iMessage through Linq. Solana devnet for the escrow — custodial today, on-chain program next.
>
> And the business is the part we can prove: a brand funds a pot and buys an audience that *verifiably trained*."

---

## When they interrupt

They will, and that's good — an interrupted demo is an interested one. **Answer, then jump to the beat that answers it better.** Never restart.

| they say | go to |
|---|---|
| "what stops me faking the photo?" | **beat 4**, right now. It's your best beat, don't save it. |
| "what if I ignore it?" | **beat 2.** Time-warp and let the phone buzz. |
| "is the AI deciding this?" | **beat 3.** The guard line. |
| "is that real money?" | Devnet, real signature, open it in Explorer. Then carry on. |
| "how's it built?" | **beat 5**, then back to wherever you were. |

---

## "Can I try it?"

**Say yes immediately.** This is the best thing that can happen at a demo table, and the gesture is why.

Hand them the phone and let them try to beat it:

- **They send a gym photo off Google.** It fails, and Snap says why: *"i asked for 3 fingers up in the pic — can't see it."* That is the whole product in one interaction and you didn't have to claim anything.
- **They send a screenshot of a workout app.** Refused as a screenshot before anything else is even weighed.
- **They send the same photo twice.** Fingerprinted — refused as a replay.
- **They type a workout into the Health app by hand.** `wasUserEntered` — never releases money.

What to say while they're trying: **nothing.** Let the phone do it. Then:

> "None of that is a rule we wrote for a demo — the trace tells you which check failed and why, every time."

**Budget note:** a judge playing costs 2–4 messages per attempt. If you're under two runs left, say "we're near our sandbox cap for the day" and let them watch instead. That's an honest sentence and it costs you nothing.

---

## Say this, not that

| ❌ | ✅ |
|---|---|
| "It can tell when you're lying" | "It checks the photo is real training, and the gesture proves it was taken now" |
| "It's on the blockchain" | "The escrow is auditable — a sponsor can watch their pot without trusting us" |
| "It's an AI fitness coach" | "It's not a coach. No plans, no macros. It holds your money." |
| nothing, about seeded history | "That week of history is seeded — the reasoning over it is real" |
| nothing, about the photo valve | If asked: "lenient mode is on; it rescues 'can't tell', it never overrides a refusal, and the trace labels it" |

---

## Answers worth having cold

**"Isn't this StickK / Forfeit / Beeminder?"**
> They all ask. StickK uses a human referee, Beeminder the honor system, Forfeit takes a photo nobody checks. And every one of them loses you the moment you stop replying. Our settlement needs no message, no model call and no user.

**"Why does this need a blockchain?"**
> For this demo it doesn't, and I'll say that plainly — it's custodial and the escrow is a wallet, not a PDA. It matters for the next thing: a sponsor funding a pot wants to audit the payout without trusting us.

**"Doesn't paying people undermine motivation?"**
> It's their own money at an amount they pick, so it's a self-imposed constraint, not us paying them to comply. And in exercise the field experiments don't find crowding-out — Charness & Gneezy found post-payment gym attendance about double baseline, and a smoking deposit contract still showed an effect in surprise tests six months after it ended. It's also exactly why we refuse to coach: taking your money *and* telling you what to train is the combination the literature warns about.

**"How do you make money?"**
> Forfeits, a rake on competition pots, and sponsored pots — the real one. A discount code that only reaches people who verifiably trained twelve times last month is worth more to a brand than an ad, because nobody else can issue it honestly.

**Numbers, if pressed:** 20/20 agent reliability through the deployed Worker · 13 suites, 444 checks · 20,720 instants across 14 timezones, which found a real Egypt DST bug that would have slashed a stake an hour early · self-report correlates with measured activity at r = 0.37 across 173 studies · loss-framed incentives hit 45% of days on goal vs 30% control on the same money.

---

## When it breaks

| what breaks | what you do | what you say |
|---|---|---|
| Snap's text doesn't arrive | Read it off the brain screen | "That's the live trace — it's sent, the carrier's slow" |
| Photo doesn't verify | Start the Watch workout | "The Watch is the backstop — this is the day you train and forget to send a pic." **Demo it deliberately; it's a feature.** |
| Vision model unreachable | Debug panel → `always` | Say it: "I'm overriding the verifier here, and the trace marks it" |
| Wifi dies | Hotspot, already paired | keep talking |
| Everything dies | The 60-second recording | "Here's a clean run from this morning" |

**Never debug in front of a judge.** Move to the fallback inside five seconds and keep talking. A smooth fallback reads as preparation.

---

## Pre-flight

### Tonight

- [ ] **Text `yo <code>` to +1 (310) 279-6028 from the demo phone and watch the onboarding messages land.** Inbound is proven; a Snap text arriving on a real handset is the one link nobody has ever watched work, and the whole demo runs through it. **If one thing gets done tonight, it's this.**
- [ ] Record the 60-second clean run — it's the fallback *and* the Devpost video, and the video is the strongest predictor in that backtest.
- [ ] Devpost: charity line, tags, repo link. Paste from `docs/DEVPOST.md`.
- [ ] Demo phone is the one the Watch is paired with; app installed, onboarded, linked on Linq **and** Telegram.
- [ ] Run it twice on Telegram end to end. Time yourself.

### Each morning reset

- [ ] `POST /debug/seed` — seeded week, costs no messages
- [ ] `POST /debug/demo` → `photoMode: lenient`
- [ ] One `/debug/message` with a photo URL — confirm the verifier answers
- [ ] Escrow balance covers the stake plus fees
- [ ] Phone volume **up** — the buzz in beat 2 is half the beat
- [ ] Brain screen open, scrolled to the bottom
- [ ] **Never** time-warp to a time earlier than now — it hot-loops the alarm

### Between judges

- [ ] `POST /debug/seed`
- [ ] Tally the messages left

---

## If you get 20 seconds

> "Every accountability app asks if you worked out. Snap doesn't ask — it watches your Watch, judges a photo you can't fake, and takes your money at midnight if you didn't go. A motivator is something you can ignore. This isn't."
