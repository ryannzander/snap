"""Post-processing applied after analyze -> tracks -> novelty -> funnel.
Idempotent: safe to re-run on every scrape."""
import json, re, os

d  = json.load(open('site_data.json'))
sc = {p['slug']: p for p in json.load(open('scored.json'))}
nov = json.load(open('novelty.json'))

HEADS = ['inspiration','what it does','what we built','how we built','how i built','the problem','tl;dr','tldr','overview']
def tidy(b):
    i = b.find('Submission history')
    if i > 0: b = b[i + 19:]
    b = re.sub(r'\n{2,}', '\n', b).strip()
    low = b.lower()
    hits = [low.find(h) for h in HEADS if 0 <= low.find(h) < 700]
    if hits: b = b[min(hits):].strip()
    return b[:2000]

bodies = 0
for p in d['projects']:
    s = sc[p['slug']]
    n = nov.get(p['slug'], {})
    p['novelty']  = n.get('novelty')
    p['near']     = n.get('near', [])
    p['novProv']  = s['words'] < 250
    p['repoList'] = s['repos'][:3]
    p['raw'] = {'w': s['words'], 'd': s['depth_hits'], 'n': s['nums'],
                'm': s['demo_hits'], 'r': s['rigor_hits'], 'tags': len(s['tags'])}
    if s['words'] >= 80:
        p['body'] = tidy(s['body']); bodies += 1

live = [p for p in d['projects'] if p['novelty'] is not None]
live.sort(key=lambda p: -p['novelty'])
for i, p in enumerate(live): p['novRank'] = i + 1
d['novCount'] = len(live)

d['dist'] = {'w': sorted(s['words'] for s in sc.values()),
             'd': sorted(s['depth_hits'] for s in sc.values()),
             'n': sorted(s['nums'] for s in sc.values()),
             'm': sorted(s['demo_hits'] for s in sc.values())}
d['scores'] = sorted((p['score'] for p in d['projects']), reverse=True)

# --- movement since the previous scrape -------------------------------------
if os.path.exists('site_data_prev.json'):
    prev = {p['slug']: p for p in json.load(open('site_data_prev.json'))['projects']}
    moved = 0
    for p in d['projects']:
        q = prev.get(p['slug'])
        if not q:
            p['move'] = {'new': True}
            moved += 1
            continue
        dr = q['rank'] - p['rank']          # positive = climbed
        ds = round(p['score'] - q['score'], 1)
        dw = p['raw']['w'] - q.get('raw', {}).get('w', p['raw']['w'])
        if dr or abs(ds) >= 0.1 or dw:
            p['move'] = {'rank': dr, 'score': ds, 'words': dw,
                         'filled': p['filled'] - q['filled']}
            moved += 1
    d['movedCount'] = moved
    d['prevAt'] = json.load(open('site_data_prev.json')).get('generated', '')


# --- track gate keywords + criteria weights (mirrors tracks.py) --------------
import re as _re
KEYS = {
 "openai":["openai","gpt-","chatgpt"], "cloudflare":["cloudflare","workers","durable object"],
 "solana":["solana"], "badge":["badge","badges"], "linq":["linq","imessage"],
 "rox":["agent","agents","agentic"], "baseten":["baseten"],
 "warp":["developer experience","devtools","code review","pull request","codebase","compiler","kernel","observability","debugging","ide","linter","test suite","ci/cd","migration","sdk"],
 "elastic":["elastic","elasticsearch","es|ql","bm25"], "browserbase":["browserbase","stagehand"],
 "shopify":["shopify","commerce","merchant","checkout","shopper"], "qnx":["qnx"],
 "bracketbot":["bracket bot","bracketbot"], "federato":["federato","underwrit","insurance","appetite"],
 "sentry":["sentry"], "dryft":["triton","cuda","h100","memory bandwidth","kernel fusion"],
 "dominion":["whiteout","mavlink","ardupilot"], "huawei_agent":["multi-agent","jiuwen","jiuwenswarm","orchestrator"],
 "tether":["qvac","pear","local-first","on-device","offline"],
 "zip":["zip api","procurement","purchase order","approval","invoice","vendor"],
 "expo":["expo","react native"], "elevenlabs":["elevenlabs"], "gemini":["gemini"],
 "composio":["composio"], "backboard":["backboard"], "gptzero":["gptzero","ai detection","hallucination detection"],
 "thru":["thru sdk","unto labs"], "devin":["devin"], "intact":["insurance"],
 "rbc":["financial report","earnings","filings","rbc","financial research","10-k"],
 "cse":["traffic log","intrusion","threat detection","anomaly","security log","siem","waf"],
 "lelamp":["lelamp","le lamp"], "beginner":[], "finalist":[],
}
src = open('tracks.py').read()
W = {}
for m in _re.finditer(r'dict\(id="([a-z_]+)".*?w=dict\(([^)]*)\)', src, _re.S):
    W[m.group(1)] = {k: float(v) for k, v in _re.findall(r'(\w+)=([0-9.]+)', m.group(2))}
for t in d['tracks']:
    t['keys'] = KEYS.get(t['id'], [])
    t['w'] = W.get(t['id'], {})
missing = [t['id'] for t in d['tracks'] if not t['w']]
assert not missing, 'no weights for: %s' % missing

d['generated'] = os.environ.get('SCRAPE_AT', d.get('generated', ''))
json.dump(d, open('site_data.json', 'w'), separators=(',', ':'))
print('bodies', bodies, '| novelty rated', len(live), '| moved', d.get('movedCount', 0),
      '| KB', os.path.getsize('site_data.json') // 1024)
