#!/usr/bin/env bash
# Snap backend verification suite. Run from a shell with unrestricted egress.
# Creates EXACTLY ONE test user. Never calls /debug/*.
set -u
B=https://snap.snap-backend.workers.dev
TS=$(date +%s)
NAME="review-probe-$TS"
C() { echo; echo "### $*"; }
c() { curl -sS -i --max-time 20 -w '\n--- status=%{http_code} time=%{time_total}s\n' "$@"; }

C "1. GET /";                 c "$B/"
C "1. GET /state no auth";    c "$B/state"
C "1. GET /trace no auth";    c "$B/trace"
C "1. GET /nope-$TS";         c "$B/nope-$TS"
C "1. OPTIONS /state";        c -X OPTIONS -H 'Origin: https://example.com' \
                                 -H 'Access-Control-Request-Method: GET' "$B/state"
C "6. GET /state bogus token"; c -H 'Authorization: Bearer not-a-real-token' "$B/state"

C "2. POST /onboard (ONCE)"
OUT=$(curl -sS --max-time 20 -X POST "$B/onboard" -H 'content-type: application/json' \
  -d "{\"name\":\"$NAME\",\"weeklyGoal\":4,\"timezone\":\"America/Toronto\"}")
echo "$OUT"
TOK=$(printf '%s' "$OUT" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("token",""))')
echo "token=$TOK"
A=(-H "Authorization: Bearer $TOK")

C "3. GET /state";            c "${A[@]}" "$B/state"
C "3. GET /trace";            c "${A[@]}" "$B/trace"
C "3. GET /trace?since=0";    c "${A[@]}" "$B/trace?since=0"
C "3. GET /trace?since=999999"; c "${A[@]}" "$B/trace?since=999999"

U="probe-$TS-A"
W='{"workouts":[{"hkUuid":"'$U'","type":"traditionalStrengthTraining","start":"2026-09-19T14:00:00Z","end":"2026-09-19T14:45:00Z","durationSec":2700,"activeKcal":310,"source":"com.apple.health.probe","wasUserEntered":false}]}'
C "3. POST /workouts (new)";       c "${A[@]}" -H 'content-type: application/json' -d "$W" "$B/workouts"
C "3. POST /workouts (same uuid)"; c "${A[@]}" -H 'content-type: application/json' -d "$W" "$B/workouts"
C "3. POST /workouts wasUserEntered=true"
c "${A[@]}" -H 'content-type: application/json' "$B/workouts" -d '{"workouts":[{"hkUuid":"probe-'$TS'-B","type":"traditionalStrengthTraining","start":"2026-09-19T15:00:00Z","end":"2026-09-19T15:45:00Z","durationSec":2700,"activeKcal":300,"source":"com.apple.Health","wasUserEntered":true}]}'
C "3. POST /workouts fractional secs + end omitted (exact iOS encoder shape has NO fraction and omits end/activeKcal)"
c "${A[@]}" -H 'content-type: application/json' "$B/workouts" -d '{"workouts":[{"hkUuid":"probe-'$TS'-C","type":"running","start":"2026-09-19T16:00:00.000Z","durationSec":1800,"source":"com.apple.health.probe","wasUserEntered":false}]}'
C "3. POST /workouts end:null"
c "${A[@]}" -H 'content-type: application/json' "$B/workouts" -d '{"workouts":[{"hkUuid":"probe-'$TS'-D","type":"running","start":"2026-09-19T17:00:00Z","end":null,"durationSec":1800,"activeKcal":null,"source":"com.apple.health.probe","wasUserEntered":false}]}'
C "3. POST /workouts malformed";   c "${A[@]}" -H 'content-type: application/json' -d '{"workouts":"nope"}' "$B/workouts"
C "3. POST /workouts bad date";    c "${A[@]}" -H 'content-type: application/json' "$B/workouts" -d '{"workouts":[{"hkUuid":"probe-'$TS'-E","type":"running","start":"yesterday","durationSec":1800,"source":"x","wasUserEntered":false}]}'

C "3. GET /state after";  c "${A[@]}" "$B/state"
C "3. GET /trace after";  c "${A[@]}" "$B/trace"

# 4. Solana: paste any txSig / pubkey seen above.
# curl -sS https://api.devnet.solana.com -X POST -H 'content-type: application/json' \
#   -d '{"jsonrpc":"2.0","id":1,"method":"getTransaction","params":["<SIG>",{"encoding":"json","maxSupportedTransactionVersion":0}]}'
# curl -sS https://api.devnet.solana.com -X POST -H 'content-type: application/json' \
#   -d '{"jsonrpc":"2.0","id":1,"method":"getBalance","params":["<PUBKEY>"]}'
# curl -sS https://api.devnet.solana.com -X POST -H 'content-type: application/json' \
#   -d '{"jsonrpc":"2.0","id":1,"method":"getAccountInfo","params":["<PROGRAM_ID>",{"encoding":"base64"}]}'
