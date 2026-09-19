"""Score the 2025 gallery with the same model and check it against who actually won."""
import re, html, json, glob, os, math, sys
sys.path.insert(0, '.')
import importlib.util
spec = importlib.util.spec_from_file_location('az', 'analyze.py')

# reuse analyze.py's extraction by running it against the 2025 corpus
src = open('analyze.py').read()
src = src.replace("glob.glob('all/*.html')", "glob.glob('bt2025/pages/*.html')")
src = src.replace("json.load(open('projects.json'))", "json.load(open('bt2025/labels.json'))")
src = src.replace("gal = {x['url'].split('/')[-1]: x for x in", "gal = {x['url'].split('/')[-1]: x for x in")
src = src.replace("if not p['tagline']: p['tagline'] = g['tag']", "pass")
src = src.replace("json.dump(projs, open('scored.json','w'))", "json.dump(projs, open('bt2025/scored25.json','w'))")
src = re.sub(r"for p in projs\[:30\]:\n.*", "", src, flags=re.S)
exec(compile(src, 'analyze_bt', 'exec'), {'__name__': '__main__'})
