# Co-builder script

Your three segments, word for word. Timings are clock positions in the run, not durations.

Two things in the outline as written would have broken on stage. Both are fixed below, and the reasons are at the bottom so you can argue with me if you disagree.

---

## 1:15 — Proof (about 35 seconds)

You have the phone. Four sends, escalating. Say almost nothing between them and let the screen do it.

**Send 1. A screenshot of a workout app.**

> "First thing anyone tries."

Snap refuses it before he weighs anything else, because a screenshot is the single most likely fake.

**Send 2. A real gym photo, no gesture in it.**

> "Real gym. Real person. Not from tonight."

He names what's missing: *"i asked for an open hand up in the pic — can't see it."*

> "He picked that gesture when the money locked. A photo I already had can't have it."

**Send 3. The real one. You, mid-set, gesture up.**

Say nothing. Let him reply. He hypes the picture and tells you the money came back.

**Send 4. The same photo again, immediately.**

> "Then I'll just send it twice."

*"you already sent me that exact photo."*

> "Every image is fingerprinted the moment it pays out."

**If you're behind on time, cut send 2.** Screenshot, real one, replay. That's still the whole argument.

---

## 1:50 — App tour (about 25 seconds)

Four tabs along the bottom. Don't linger, one line each.

**today** — "Your next deadline and what's on it."

**streak** — "Days in a row. Same rule the backend uses, so the number here and the number he says are one number."

**wallet** — "What's locked, what came back, and every transaction is a real one you can open in Explorer."

**brain** — "Everything he decided and why. Including the times he decided to say nothing."

Land on **brain** and stop there. It's the screen nobody else has.

> "There's no chat in this app. The conversation is in iMessage. This is just the part where you can see him think."

---

## 2:15 — How it works (about 30 seconds)

Name the sponsor pieces as you go. One breath.

> "Every user gets a Durable Object on Cloudflare, and it sets its own alarm for your deadline. That's how he texts first with no cron job anywhere.
>
> The messages are real iMessage through Linq. OpenAI runs the agent and looks at the photo, with Workers AI behind it as a fallback.
>
> Solana holds the stake on devnet. It's custodial and we say so, the escrow is a wallet rather than a PDA, and the on-chain program is next.
>
> HealthKit is the backstop underneath all of it. Train and forget to send a pic, and your watch pays you anyway."

Then hand back.

---

## The two fixes, and why

**"Snap replies 'verified, $5 back'" — he never says that.**

Stakes are in SOL and he speaks in SOL. He also doesn't announce verdicts like a receipt; he reacts to the photo first and then tells you about the money. A real one from a live run:

> bro the watch snitched in a good way 😭
> i can see the gym happened, so the 0.05 sol came back.

Don't put words in his mouth on stage. Say "and the stake comes back" and let him say it his way.

**"Send an old pic and it's rejected as a replay" — not reliably.**

The fingerprint is only spent when a photo *actually pays out*. That's deliberate: burning it earlier would disqualify a picture that was sent with nothing on the line, or one sent a beat early in rehearsal. So an old photo off your camera roll has never been spent, doesn't trip the replay check, and gets judged on whether it's training and whether it has the gesture.

Which means the replay beat has to come **after** the payout, by re-sending the exact photo that just paid. That version is guaranteed to fire, and it's the better story anyway: you're not showing him an old photo, you're trying to spend the same one twice in front of everyone.

Also worth knowing if someone pushes: the fingerprint catches a byte-identical resend and nothing cleverer. Re-crop it and the hash changes and it gets through. That's why the gesture exists and why the watch is underneath. Say that if asked, don't volunteer it.

---

## If something dies

| what | do | say |
|---|---|---|
| Photo doesn't verify | Start the Watch workout | "The watch is the backstop. This is the day you train and forget to send a pic." Demo it on purpose, it's a feature. |
| A text is slow | Read it off the brain screen | "That's the live trace, it's sent." |
| Vision model unreachable | Debug panel, `always` | Say out loud that you're overriding it. The trace marks it either way. |

Never debug in front of a judge. Move inside five seconds and keep talking.
