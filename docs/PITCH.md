# Snap — the 3:30

Run sheet for Sunday 8:00 AM. Replaces the 5-minute shape in `DESIGN.md` § Demo.

**Split:** Ryan drives the phone and reads Snap's texts out loud. Hugo narrates and never touches the phone. One person talking at a time.

**Rehearse this five times.** Not the words — the *handoffs*. Every demo that dies, dies in a handoff.

---

## The 3:30

| clock | who | beat |
|---|---|---|
| **0:00–0:20** | Hugo | **The hook.** |
| **0:20–1:00** | Ryan → Hugo | **Commit live.** Stake locks on devnet. |
| **1:00–1:45** | phone → Ryan | **It texts first.** Nobody asked it to. |
| **1:45–2:30** | Ryan → Hugo | **The excuse, and the refusal.** ← *this is the beat that wins it* |
| **2:30–3:05** | Ryan | **The photo, the gesture, the payout.** |
| **3:05–3:30** | Hugo | **Architecture + the business, in one breath.** |

---

### 0:00–0:20 — the hook

> "Skipping the gym has no witness. Every accountability app asks 'did you work out today?' — and you either lie to it or you stop opening it.
>
> Snap is a gym bro who lives in your texts. He never asks. He holds your money, and if you don't go, he takes it."

Then straight to the phone. **No slides. No "so we built…". No team intro.** They can read your Devpost.

### 0:20–1:00 — commit live

Ryan texts, out loud: **"gym at 7 tonight"**

Snap comes back with the offer. Ryan reads it. Ryan says **"deal"**.

Hugo, over the top, while the brain screen fills:

> "He offered that himself — she never asked for a stake, and most people don't know the feature exists. That's deliberate. Deposit contracts beat reward incentives in the literature, but almost nobody goes and finds one, so Snap brings it up."

When the lock lands: **"That's a real transaction on Solana devnet. You can open it in Explorer."**

Snap also names a gesture — *"3 fingers up in the pic"*. **Don't explain it yet.** Let it sit. You'll pay it off at 2:30.

### 1:00–1:45 — it texts first

Hugo time-warps past the deadline. **Phone buzzes on stage.**

> "Nobody pressed anything. It woke itself up."

Ryan reads it: *"yo, 18 mins over, bro. i see you."*

Hugo, pointing at the brain screen:

> "That's the agent's own reasoning. It checked the history first — nothing logged today, skipped yesterday, 2 of 4 this week, 0.05 SOL in escrow — and decided to speak. It also logs the times it decides **not** to. It once declined to text at 2:30 in the morning because 'texting now would just wake them.'"

**The restraint line is the one that gets remembered.** Don't rush it.

### 1:45–2:30 — the excuse (the beat that wins it)

Ryan: **"cant today bro, too much work"**

Snap refuses. Ryan reads it: *"nah bro, can't push this any further. your sol's already on the line."*

Hugo:

> "One reschedule per commitment, ever, and the door shuts an hour before the deadline — an hour out you're rearranging your day, ten minutes out you're getting out of it.
>
> And the model didn't decide that. Every tool call it proposes goes through a guard function first. Both models we tested tried to take the money early; the guard refused every time. **The model does the talking. The backend does the money.**"

Optional, if the trace shows it: *"It also spotted she used that same excuse yesterday."*

### 2:30–3:05 — the photo

Ryan sends a real photo, mid-set, **three fingers up.**

Stake releases. Snap hypes it. Ryan reads it.

Hugo, and **volunteer the limitation before anyone asks**:

> "A vision model checked that: a real person, actually training, not a screenshot, and every image is fingerprinted so you can't spend the same one twice.
>
> But it cannot tell you that's *her* — no vision model can, and we're not going to pretend otherwise. So the stake named a random gesture the moment the money locked. A photo she already had can't have three fingers up in it, because nobody knew which gesture until the money moved. And her Watch is underneath the whole thing as the backstop."

### 3:05–3:30 — architecture and the business

One breath, naming sponsors as you go:

> "Cloudflare Workers and Durable Objects — one object per user, and it schedules its own alarms, so there's no cron job anywhere. OpenAI for the agent and the vision, Workers AI behind it as a fallback. Real iMessage through Linq. Solana devnet for the escrow — custodial today, on-chain program next.
>
> And the business is the thing we can prove: a brand funds a pot and buys an audience that *verifiably trained*. '12,000 people did 12 workouts this month' is a number no ad platform can sell."

**Stop talking.** Don't trail off into what's next. End on that sentence.

---

## The lines worth memorising

- *"Skipping the gym has no witness."*
- *"He never asks."*
- *"Nobody pressed anything. It woke itself up."*
- *"The model does the talking. The backend does the money."*
- *"It cannot tell you that's her, and we're not going to pretend otherwise."*
- *"An audience that verifiably trained."*

## Say this, not that

| ❌ don't say | ✅ say |
|---|---|
| "It can tell when you're lying" | "It checks the photo is real training, and the gesture proves it was taken now" |
| "It's on the blockchain" | "The escrow is auditable — a sponsor can watch their pot without trusting us" |
| "It's an AI fitness coach" | "It's not a coach. No plans, no macros. It holds your money." |
| "Fully verified" | "Two verifiers, and here's what each one can and can't prove" |
| nothing, about seeded data | "That week of history is seeded — the reasoning over it is real" |
| nothing, about the photo valve | If asked: "lenient mode is on; it rescues 'can't tell', it doesn't override a refusal, and the trace labels it" |

---

## Numbers, if you're asked

| | |
|---|---|
| Agent reliability | **20/20** across 5 phrases × 4 trials, through the deployed Worker |
| Tests | **13 suites, 444 checks** |
| Time correctness | 20,720 instants × 14 timezones — found a real Egypt DST bug that would have slashed a stake an hour early |
| Why not self-report | Self-reported vs measured activity: **r = 0.37** across 173 studies (Prince 2008) |
| Why loss framing | 45% of days on goal vs 30% control, same money as the gain arm (Patel 2016, *Annals*) |
| Devnet RPC | We probed **11 endpoints** from inside the Worker; every Foundation one 403s a Cloudflare Worker |

---

## Q&A — the six they'll actually ask

**"What stops me sending a photo of someone else?"**
> The gesture. It's picked at random when the money locks, so a photo you already had can't satisfy it. It proves the photo is from *now*, not that it's you — and I'd rather say that than claim face matching we haven't built. The Watch underneath is what ties it to your body. Enrolled-selfie matching is the next layer.

**"Isn't this StickK / Forfeit / Beeminder?"**
> They all ask. StickK uses a human referee, Beeminder uses the honor system, Forfeit takes a photo nobody checks. And all of them lose you the moment you stop replying. Our settlement needs no message, no model call and no user — the alarm fires and the money moves.

**"Why does this need a blockchain?"**
> For the demo it doesn't, and I'll say that plainly — it's custodial and the escrow is a wallet, not a PDA. It matters for the next thing: a sponsor funding a pot wants to audit the payout without trusting us. That's a real reason, and it's the only one I'll give you.

**"Doesn't paying people undermine intrinsic motivation?"**
> Good question, and it's the right objection. Two things. It's their own money at an amount they choose, so it's a self-imposed constraint rather than us paying them to comply. And in exercise specifically the field experiments don't find crowding-out — Charness & Gneezy found post-payment gym attendance about double baseline, and a smoking deposit contract still showed an effect in surprise tests six months after it ended. It's also why we refuse to do coaching: taking your money *and* telling you what to train is the combination the motivation literature actually warns about.

**"What if I just ignore it?"**
> That's the whole design. Ignoring it is the *expensive* option.

**"How do you make money?"**
> Skippers' forfeits, a rake on competition pots, and sponsored pots — which is the real one. And a discount code that only reaches people who verifiably trained twelve times last month is worth more to a brand than any ad, because nobody else can issue it honestly.

---

## Failure drills — rehearse these too

| what breaks | what you do | what you say |
|---|---|---|
| **Snap's text doesn't arrive** | Read it off the brain screen instead — it's already there | "That's the live trace — the message is out, the carrier's just slow" |
| **Photo doesn't verify** | Start the Watch workout instead | "The Watch is the backstop — this is the day you train and forget to send a pic" — *this is a feature, demo it deliberately* |
| **Vision model unreachable** | Debug panel → `always` | Say it out loud: "I'm overriding the verifier here, and the trace marks it" |
| **Wifi dies** | Phone hotspot, already paired | keep talking |
| **Everything dies** | The 60-second screen recording | "Here's a clean run from this morning" — **don't apologise, don't debug on stage** |

**Never debug in front of judges.** Move to the fallback inside five seconds and keep narrating. A smooth fallback reads as preparation; ten seconds of silence reads as a broken product.

---

## Pre-flight

### Tonight — before you sleep

- [ ] **Text `yo <code>` to +1 (310) 279-6028 from the demo phone and watch the onboarding messages land.** This is the only link in the chain never confirmed end to end. Inbound is proven; a Snap text arriving on a real handset is not. **If one thing gets done tonight, this is it.**
- [ ] Record the 60-second clean run. It's the fallback *and* the Devpost video — and the video is the strongest predictor of winning in the backtest.
- [ ] Devpost: charity line, tags, repo link. Paste from `docs/DEVPOST.md`.
- [ ] Confirm the demo phone is the one the Watch is paired with, app installed, onboarded, linked on Linq **and** Telegram.

### 10 minutes before you walk up

- [ ] Hotspot on, venue wifi off
- [ ] `POST /debug/seed` — seeded week
- [ ] `POST /debug/demo` → `photoMode: lenient`
- [ ] One `POST /debug/message` with a photo URL — confirm the verifier answers
- [ ] Escrow wallet balance covers the stake plus fees
- [ ] Phone volume **up** — the buzz at 1:00 is half the beat
- [ ] Brain screen open, scrolled to bottom
- [ ] Screen recording open in another tab
- [ ] **Never** time-warp to a time earlier than now — it hot-loops the alarm

---

## The one thing to remember

If you get 30 seconds instead of 3:30, say this:

> **"Every accountability app asks if you worked out. Snap doesn't ask — it watches your Watch, judges a photo you can't fake, and takes your money at midnight if you didn't go. A motivator is something you can ignore. This isn't."**
