#!/usr/bin/env bash
# One full refresh: gallery -> pages -> score -> enrich -> build -> repo -> vercel.
# Safe to re-run; idempotent apart from the snapshot rotation.
set -uo pipefail
cd "$(dirname "$0")"
SCRATCH="$PWD"
REPO=/home/user/snap
STAMP_UTC="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
export SCRAPE_AT="$(date '+%Y-%m-%dT%H:%M:%S%z')"
echo "=== rescrape $STAMP_UTC ==="

# 1. gallery index ------------------------------------------------------------
for i in $(seq 1 20); do
  curl -sS --max-time 30 "https://hackthenorth2026.devpost.com/project-gallery?page=$i" -o "p$i.html" &
done; wait

python3 - <<'PY' || exit 1
import re, html, json, glob, os
out, seen = [], set()
for f in sorted(glob.glob('p*.html'), key=lambda x: int(re.findall(r'\d+', x)[0])):
    s = open(f, encoding='utf-8', errors='ignore').read()
    for m in re.finditer(r'<a class="block-wrapper-link fade link-to-software" href="([^"]+)"(.*?)</a>', s, re.S):
        url, body = m.group(1), m.group(2)
        if url in seen: continue
        seen.add(url)
        t = re.search(r'<h5[^>]*>(.*?)</h5>', body, re.S)
        d = re.search(r'<p[^>]*class="[^"]*small[^"]*"[^>]*>(.*?)</p>', body, re.S)
        cl = lambda x: html.unescape(re.sub(r'<[^>]+>', '', x)).strip() if x else ''
        out.append({"name": cl(t.group(1) if t else ''), "tag": cl(d.group(1) if d else ''), "url": url})
assert len(out) > 200, 'gallery looks truncated: %d' % len(out)
json.dump(out, open('projects.json', 'w'), indent=1)
open('allurls.txt', 'w').write('\n'.join(x['url'] for x in out))
print('gallery:', len(out), 'projects')
PY

# 2. project pages ------------------------------------------------------------
rm -rf all_new && mkdir -p all_new
i=0
while read -r u; do
  n="${u##*/}"
  curl -sS --max-time 25 "$u" -o "all_new/$n.html" &
  i=$((i+1)); [ $((i % 20)) -eq 0 ] && wait
done < allurls.txt
wait
GOT=$(find all_new -name '*.html' -size +4k | wc -l)
echo "pages fetched: $GOT"
if [ "$GOT" -lt 200 ]; then echo "ABORT: only $GOT usable pages, keeping previous snapshot"; exit 1; fi
rm -rf all && mv all_new all

# 3. score --------------------------------------------------------------------
cp -f site_data.json site_data_prev.json 2>/dev/null || true
python3 analyze.py > /dev/null || exit 1
python3 tracks.py  > /dev/null || exit 1
python3 novelty.py > /dev/null || exit 1
python3 funnel.py  > /dev/null || exit 1
python3 enrich.py            || exit 1
python3 model_score.py       || exit 1

# 4. build --------------------------------------------------------------------
python3 - <<'PY' || exit 1
s = open('contender.html').read()
d = open('site_data.json').read()
assert '__DATA__' in s
open('contender_final.html', 'w').write(s.replace('__DATA__', d))
import json, os
j = json.loads(d)
print('built: %d projects, %d moved, %d KB' % (len(j['projects']), j.get('movedCount', 0),
      os.path.getsize('contender_final.html') // 1024))
PY

# 5. repo ---------------------------------------------------------------------
cp -f contender_final.html "$REPO/ranked/index.html"
cp -f site_data.json       "$REPO/ranked/data.json"
cd "$REPO"
if [ -n "$(git status --porcelain ranked)" ]; then
  git add ranked
  git -c user.email=baconbui@gmail.com -c user.name="Ryan Zander" commit -q -F - <<MSG
Refresh the Ranked snapshot ($STAMP_UTC)

Automated hourly re-scrape of the Devpost gallery ahead of the 8am
submission deadline.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01DYVbTfsu9hma6xAmgCLcFs
MSG
  for a in 2 4 8 16; do git push origin claude/amazing-babbage-hveamd -q && break || sleep $a; done
  echo "pushed $(git rev-parse --short HEAD)"
else
  echo "no repo change"
fi

# 6. deploy -------------------------------------------------------------------
cd "$REPO/ranked"
for a in 1 5 15 30; do
  OUT=$(timeout 300 npx --yes vercel@latest deploy --temporary --yes 2>&1)
  if echo "$OUT" | grep -q '^▲'; then echo "$OUT" | grep -E '^▲' | head -1; break; fi
  echo "deploy attempt failed: $(echo "$OUT" | grep -iE 'error' | head -1)"
  sleep $a
done
# githack serves the pushed file directly, so the branch URL is already current.
GH="https://raw.githack.com/ryannzander/snap/claude/amazing-babbage-hveamd/ranked/index.html"
code=$(curl -sS -o /dev/null -m 60 -w '%{http_code}' "$GH" || echo 000)
echo "githack $code   $GH"
echo "short        https://tinyurl.com/htnranked"

echo "=== done $(date -u '+%H:%M:%SZ') ==="
