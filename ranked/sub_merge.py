"""Merge the substance score onto site_data. Runs after model_score.py."""
import json, glob, os, substance as S

d  = json.load(open('site_data.json'))
by = {p['slug']: p for p in d['projects']}
out = {}
for f in glob.glob('all/*.html'):
    slug = os.path.basename(f)[:-5]
    p = by.get(slug)
    if not p or not p.get('rated'): continue
    raw = open(f, encoding='utf-8', errors='ignore').read()
    if len(raw) < 5000: continue
    s = S.raw_signals(raw)
    out[slug] = (S.score_from(s), s)

for p in d['projects']:
    p['sub2'] = None; p['subRank'] = None; p['fams'] = None
for i, (slug, (sc, s)) in enumerate(sorted(out.items(), key=lambda kv: -kv[1][0])):
    q = by[slug]
    q['sub2'] = sc; q['subRank'] = i + 1; q['fams'] = s['fam_list'][:6]

d['smodel'] = dict(auc=0.681, resid=0.683, folds=[0.688, 0.699, 0.647],
                   n=len(out), rating_auc=0.610, corr_words=0.033)
json.dump(d, open('site_data.json', 'w'), separators=(',', ':'))
snap = next((p for p in d['projects'] if p['name'] == 'Snap'), None)
print('substance merged for %d projects' % len(out),
      '| Snap %.1f (rank %s)' % (snap['sub2'], snap['subRank']) if snap else '')
