"""Extract a wide feature set from a backtest corpus, with outcome labels."""
import re, html, json, glob, os, math

def strip(s):
    s = re.sub(r'<script.*?</script>', '', s, flags=re.S)
    s = re.sub(r'<style.*?</style>', '', s, flags=re.S)
    return re.sub(r'\n\s*\n+', '\n', html.unescape(re.sub(r'<[^>]+>', '\n', s)))

DEEP = ["latency","benchmark","throughput","quantiz","fine-tun","lora","distill","kernel","tensor","inference","durable object","state machine","webhook","escrow","on-chain","anchor","consensus","pipeline","embedding","vector","slam","lidar","apriltag","urdf","fpga","real-time","regression","deterministic","idempot","retry","queue","sharding","parallel","transformer","diffusion","rag","protocol","firmware","pcb","servo","mavlink","ros","cuda","triton","wasm","compiler","ast"]
PHYS = ["robot","drone","headset","wearable","glove","keyboard","display","hardware","3d print","camera","projector","badge","physical","arm","vehicle","haptic","sensor","prototype","rig","motor","raspberry"]
PROOF= ["we measured","accuracy","held-out","baseline","ablation","ground truth","evaluated","precision","we tested","test suite","validated","reproduc","hidden set","correctness"]
SOCIAL=["accessib","disab","blind","deaf","health","medical","patient","climate","carbon","safety","rescue","emergency","education","student"]
AI   = ["llm","gpt","agent","model","neural","machine learning","fine-tune","prompt","openai","anthropic","claude","gemini","cohere"]
NUM  = re.compile(r'\b\d+(?:\.\d+)?\s*(?:%|ms|s\b|x\b|k\b|gb|mb|cm|fps|hz|dof|tokens?|trials?|params?|b\b)', re.I)

def extract(year):
    lab = {x['url'].split('/')[-1]: x for x in json.load(open(f'bt{year}/labels.json'))}
    pz  = json.load(open(f'bt{year}/prizes.json'))
    rows = []
    for f in glob.glob(f'bt{year}/pages/*.html'):
        slug = os.path.basename(f)[:-5]
        if slug not in lab: continue
        raw = open(f, encoding='utf-8', errors='ignore').read()
        if len(raw) < 5000: continue
        t = strip(raw)
        i, j = t.find('Submission history'), t.find('Built With')
        body = (t[i+19 : j if j > i else i+20000] if i > 0 else '').strip()
        low = body.lower()
        words = len(body.split())
        tags = re.findall(r'<span class="cp-tag"[^>]*>(.*?)</span>', raw, re.S)
        prizes = pz.get(slug, [])
        rows.append(dict(
            slug=slug, year=int(year), words=words,
            finalist=int(any('finalist' in q.lower() for q in prizes)),
            anywin=int(bool(lab[slug].get('winner'))),
            video=int(bool(re.search(r'youtube\.com/embed|player\.vimeo|video-embed', raw, re.I))),
            team=len(re.findall(r'software-team-member', raw)) or 1,
            tags=len(tags),
            images=len(re.findall(r'software_photos|gallery-item', raw)),
            links=len(re.findall(r'class="[^"]*app-links', raw)) + len(re.findall(r'>Try it out', raw)),
            updates=len(re.findall(r'software-update', raw)),
            likes=int((re.search(r'(\d+)\s+(?:person likes|people like)', t) or [0,0])[1] or 0),
            comments=len(re.findall(r'class="comment', raw)),
            sections=sum(1 for h in ('inspiration','what it does','how we built','challenges',
                                     'accomplishments','what we learned',"what's next") if h in low),
            deep=sum(1 for w in DEEP if w in low), phys=sum(1 for w in PHYS if w in low),
            proof=sum(1 for w in PROOF if w in low), social=sum(1 for w in SOCIAL if w in low),
            ai=sum(1 for w in AI if w in low), nums=len(NUM.findall(body)),
            repos=len(set(re.findall(r'https://github\.com/[\w.-]+/[\w.-]+', raw)) - {'https://github.com/newrelic/newrelic-browser-agent'}),
            taglen=len((lab[slug].get('name') or '')),
            vocab=len(set(re.findall(r'[a-z]{5,}', low))),
        ))
    return rows

if __name__ == '__main__':
    allrows = []
    for y in ('2023','2024','2025'):
        r = extract(y); allrows += r
        print(f'  {y}: {len(r)} rows, {sum(x["finalist"] for x in r)} finalists, {sum(x["anywin"] for x in r)} winners')
    json.dump(allrows, open('feats.json','w'))
    print('total', len(allrows))
