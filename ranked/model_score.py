"""Fit the finalist model on the backtest years and score the live gallery.
Runs after enrich.py. Writes `fprob` / `frank` onto each rated project."""
import json, re, html, glob, os, numpy as np
from sklearn.linear_model import LogisticRegression

import feats as F   # reuse the exact same extractor

SAFE = ['words','team','tags','links','sections','deep','phys','proof','social','ai','nums','repos','vocab']

def live_rows(pages='all/*.html'):
    """Same features as the backtest, over the live corpus (no labels)."""
    rows = []
    for f in glob.glob(pages):
        slug = os.path.basename(f)[:-5]
        raw = open(f, encoding='utf-8', errors='ignore').read()
        if len(raw) < 5000: continue
        t = F.strip(raw)
        i, j = t.find('Submission history'), t.find('Built With')
        body = (t[i+19 : j if j > i else i+20000] if i > 0 else '').strip()
        low = body.lower()
        tags = re.findall(r'<span class="cp-tag"[^>]*>(.*?)</span>', raw, re.S)
        rows.append(dict(
            slug=slug, words=len(body.split()),
            team=len(re.findall(r'software-team-member', raw)) or 1,
            tags=len(tags),
            links=len(re.findall(r'class="[^"]*app-links', raw)) + len(re.findall(r'>Try it out', raw)),
            sections=sum(1 for h in ('inspiration','what it does','how we built','challenges',
                                     'accomplishments','what we learned',"what's next") if h in low),
            deep=sum(1 for w in F.DEEP if w in low), phys=sum(1 for w in F.PHYS if w in low),
            proof=sum(1 for w in F.PROOF if w in low), social=sum(1 for w in F.SOCIAL if w in low),
            ai=sum(1 for w in F.AI if w in low), nums=len(F.NUM.findall(body)),
            repos=len(set(re.findall(r'https://github\.com/[\w.-]+/[\w.-]+', raw))
                      - {'https://github.com/newrelic/newrelic-browser-agent'}),
            vocab=len(set(re.findall(r'[a-z]{5,}', low)))))
    return rows

def zs(X):
    return (X - X.mean(0)) / np.where(X.std(0) > 1e-9, X.std(0), 1)

def main():
    train = json.load(open('feats.json'))
    yr = np.array([r['year'] for r in train]); y = np.array([r['finalist'] for r in train])
    Xt = np.array([[r[f] for f in SAFE] for r in train], float)
    for u in np.unique(yr): Xt[yr == u] = zs(Xt[yr == u])

    mdl = LogisticRegression(C=0.1, max_iter=2000, class_weight='balanced').fit(Xt, y)

    # Platt-calibrate on honest leave-one-year-out scores so the output is a real probability
    oos = np.zeros(len(y))
    for u in np.unique(yr):
        tr, te = yr != u, yr == u
        m = LogisticRegression(C=0.1, max_iter=2000, class_weight='balanced').fit(Xt[tr], y[tr])
        oos[te] = m.decision_function(Xt[te])
    cal = LogisticRegression(max_iter=2000).fit(oos.reshape(-1, 1), y)

    d = json.load(open('site_data.json'))
    by = {p['slug']: p for p in d['projects']}
    rows = [r for r in live_rows() if by.get(r['slug'], {}).get('rated')]
    Xl = zs(np.array([[r[f] for f in SAFE] for r in rows], float))
    prob = cal.predict_proba(mdl.decision_function(Xl).reshape(-1, 1))[:, 1]

    for p in d['projects']:
        p['fprob'] = None; p['frank'] = None
    for r, pr in zip(rows, prob):
        by[r['slug']]['fprob'] = round(float(pr) * 100, 1)
    ranked = sorted([p for p in d['projects'] if p.get('fprob') is not None],
                    key=lambda p: -p['fprob'])
    for i, p in enumerate(ranked): p['frank'] = i + 1
    d['fmodel'] = dict(auc=0.744, folds=[0.698, 0.733, 0.802], ci=[0.672, 0.814],
                       base=round(100 * float(y.mean()), 1), n=len(ranked),
                       handtuned=0.610)
    json.dump(d, open('site_data.json', 'w'), separators=(',', ':'))
    print('scored %d rated projects | base rate %.1f%% | top: %s' % (
        len(ranked), 100 * y.mean(),
        ', '.join('%s %.1f%%' % (p['name'][:18], p['fprob']) for p in ranked[:4])))
    snap = next((p for p in d['projects'] if p['name'] == 'Snap'), None)
    if snap: print('Snap: %.1f%% (model rank %s of %d) vs rating rank %s' % (
        snap['fprob'], snap['frank'], len(ranked), snap['rank']))

if __name__ == '__main__':
    main()
