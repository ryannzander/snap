import re, json, sys, bisect
YEAR = sys.argv[1]
src = open('analyze.py').read()
src = src.replace("glob.glob('all/*.html')", f"glob.glob('bt{YEAR}/pages/*.html')")
src = src.replace("json.load(open('projects.json'))", f"json.load(open('bt{YEAR}/labels.json'))")
src = src.replace("if not p['tagline']: p['tagline'] = g['tag']", "pass")
src = src.replace("json.dump(projs, open('scored.json','w'))", f"json.dump(projs, open('bt{YEAR}/scored.json','w'))")
src = re.sub(r"for p in projs\[:30\]:\n.*", "", src, flags=re.S)
src = re.sub(r"^\s*print\(.*$", "", src, flags=re.M)
exec(compile(src, 'bt', 'exec'), {'__name__': '__main__'})
