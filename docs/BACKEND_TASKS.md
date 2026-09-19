# Backend — start here

Read `DESIGN.md` (5 min) and `API.md` (the contract with the iOS app) first. Everything backend lives in `backend/`.

## Do these right now (they have waiting time)

1. **Linq sandbox** — sign up with your school email: https://dashboard.linqapp.com/sandbox-signup. Docs: https://docs.linqapp.com/channel/imessage/llms-full.txt
2. **Cloudflare account** (free plan is enough) + `npm i -g wrangler && wrangler login`.
3. **Telegram bot** — message @BotFather, `/newbot`, keep the token.
4. **OpenAI API key** — check the OpenAI booth for credits.
5. **Solana** — install the Solana CLI + Anchor, `solana config set --url devnet`, make a keypair, `solana airdrop 2`. The devnet faucet rate-limits, so airdrop early and often.

Secrets go in `backend/.dev.vars` (gitignored) and `wrangler secret put`. Never commit keys or keypair files.

## Build order

Each step ends with something you can see working. Don't start the next until it does.

1. **Worker + Durable Object skeleton.** `npm create cloudflare@latest backend` (TypeScript, Workers). One `UserAgent` Durable Object per user. Implement `POST /onboard`, `POST /workouts`, `GET /state`, `GET /trace` from `API.md` against Durable Object storage. Deploy and post the URL in our chat — this unblocks the iOS app.
2. **Channel interface + Telegram adapter.**
   ```ts
   interface Channel { send(chatId: string, texts: string[]): Promise<void> }
   // inbound: each adapter's webhook normalizes to { channel, chatId, text } and hands it to the user's Durable Object
   ```
   `yo <code>` links a chat to a user. `texts` is an array because Snap sends several short messages, ~1 s apart.
3. **The agent.** OpenAI function calling inside the Durable Object. Tools: `create_commitment`, `reschedule_commitment`, `send_messages`, `stay_quiet(reason)`, `release_stake`, `slash_stake`. The context given to the model on every turn: goal, this week's count, last 7 days of hits/skips, open commitments + stakes, recent conversation. Every step writes a trace event.
4. **Proactivity.** `create_commitment` sets a Durable Object alarm for `dueAt + graceMin`. When the alarm fires with no workout covering that window, run the agent with "you woke yourself up — decide whether to intervene." `POST /workouts` arriving with a matching workout marks the commitment `met` and runs the agent too (hype message, release stake).
5. **`POST /debug/timewarp`.** Needed for the demo and for testing step 4 without waiting.
6. **Solana escrow.** Anchor program `snap_escrow` on devnet — build this one with **Codex** and save the prompt + diff (OpenAI prize). Instructions: `stake(commitment_id, amount)` into a PDA vault seeded by `["stake", user, commitment_id]`; `release` (oracle-signed → back to user); `slash` (oracle-signed → treasury). Backend calls it with `@solana/web3.js`. **If it isn't working on devnet by Sat 6 PM, switch to a backend-held wallet doing plain transfers** and move on.
7. **Linq adapter.** Same `Channel` interface. Outbound `POST /v3/chats`, inbound via a `message.received` webhook subscription. Sandbox is capped at 100 messages/day — develop on Telegram, only test Linq end-to-end a few times.

## The voice

Your gym bro. Lowercase, short, several texts in a row, never a paragraph. "bro", "nah", "😭", "lock in". Funny, not mean. It negotiates ("30 mins then. push day. go.") rather than lecturing. It never sounds like an assistant and never explains itself.
