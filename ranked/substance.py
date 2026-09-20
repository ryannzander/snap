"""Score what a project DOES, not how well the page is written.

The rating in Ranked measures the Devpost page: length, sections filled, how
many technical words appear. A thin page on a strong build scores badly; a long
page on a thin build scores well. This scorer is the other half — it asks what
the project can actually do, and deliberately refuses to reward volume.

Three rules keep prose out of it:

  * Every text signal is PRESENCE, not count. Saying "latency" nine times is
    worth exactly what saying it once is worth. This is what kills the
    length advantage, because a longer page can only ever find the same
    capabilities a shorter one names.
  * Capabilities are grouped into families and each family caps at one point,
    so listing six vector databases does not beat shipping one and a robot.
  * Artifacts (a repo, a live link, a demo video, a device) are worth more
    than any adjective, because they are the parts a judge can open.

Output is 0-100 within the rated field, like the rating, so the two are
directly comparable.
"""
import re, json, os, glob, math
import feats as F

# --- capability families -----------------------------------------------------
# One point per family, however many members it matches. Membership is checked
# on word boundaries, so 'ros' does not fire inside 'across'.
FAMILIES = {
 'moving parts':   ['servo','motor','actuator','gantry','gimbal','stepper','solenoid'],
 'sensing':        ['lidar','depth camera','imu','accelerometer','gyro','apriltag','time-of-flight','emg','eeg','radar','ultrasonic'],
 'vision':         ['opencv','yolo','segmentation','pose estimation','object detection','optical flow','slam','structure from motion'],
 'custom silicon': ['fpga','pcb','soldered','oscilloscope','microcontroller','esp32','stm32','raspberry pi','arduino','jetson'],
 'fabrication':    ['3d print','laser cut','cnc','machined','resin','filament'],
 'model training': ['fine-tun','lora','trained on','training loop','dataset of','epochs','gradient','backprop','distill','quantiz'],
 'retrieval':      ['embedding','vector database','vector store','rag','semantic search','pgvector','faiss','pinecone','chroma'],
 'agents':         ['function calling','tool call','agentic','multi-agent','mcp','tool use','planner'],
 'distributed':    ['durable object','queue','worker','sharding','consensus','raft','pub/sub','kafka','websocket','grpc'],
 'on-chain':       ['on-chain','smart contract','escrow','anchor','solidity','devnet','mainnet','wallet','transaction hash'],
 'compilers':      ['compiler','parser','ast','bytecode','interpreter','type checker','codegen','lexer'],
 'low-level':      ['kernel','cuda','simd','assembly','memory-mapped','firmware','bare metal','rtos','driver'],
 'realtime':       ['real-time','low latency','streaming','frame budget','60 fps','sub-second','p99'],
 'reliability':    ['idempot','retry','backoff','rollback','circuit breaker','graceful degradation','failover'],
}

# Artifacts a judge can open. Weighted above any wording.
def artifacts(raw, body):
    low = body.lower()
    repos = set(re.findall(r'https://github\.com/[\w.-]+/[\w.-]+', raw)) - {
        'https://github.com/newrelic/newrelic-browser-agent'}
    return dict(
        repo   = int(bool(repos)),
        video  = int(bool(re.search(r'youtube\.com/embed|player\.vimeo|video-embed', raw, re.I))),
        live   = int(bool(re.search(r'class="[^"]*app-links', raw)) or '>Try it out' in raw),
        device = int(bool(re.search(r'(?<![a-z])(robot|drone|headset|wearable|glove|badge|vehicle|rig)(?![a-z])', low))),
    )

def measured(body):
    """Distinct measured quantities. Deduped, so repeating '60%' adds nothing."""
    return len({m.group(0).lower().replace(' ','') for m in F.NUM.finditer(body)})

def families_hit(body):
    low = body.lower()
    hit = []
    for name, members in FAMILIES.items():
        if any(re.search(r'(?<![a-z])' + re.escape(m), low) for m in members):
            hit.append(name)
    return hit

def raw_signals(raw):
    t = F.strip(raw)
    i, j = t.find('Submission history'), t.find('Built With')
    body = (t[i+19 : j if j > i else i+20000] if i > 0 else '').strip()
    a = artifacts(raw, body)
    fam = families_hit(body)
    tags = re.findall(r'<span class="cp-tag"[^>]*>(.*?)</span>', raw, re.S)
    generic = {'app','apple','b2c','consumer','web','mobile','ai','hack','fun','other','beginner'}
    return dict(
        words     = len(body.split()),
        families  = len(fam),
        fam_list  = fam,
        measured  = min(measured(body), 8),
        artifacts = a['repo'] + a['video'] + a['live'] + 2 * a['device'],
        art       = a,
        stack     = len({x.strip().lower() for x in tags} - generic),
    )

def score_from(s):
    """0-100. Weights chosen so no single family or artifact can dominate, and
    so the whole thing is reachable by a 300-word page on a real build."""
    cap  = min(s['families'], 7) / 7 * 100          # what it can do
    art  = min(s['artifacts'], 5) / 5 * 100         # what a judge can open
    meas = min(s['measured'], 6)  / 6 * 100         # what was quantified
    stak = min(s['stack'], 8)     / 8 * 100         # how much was integrated
    return round(0.42 * cap + 0.28 * art + 0.16 * meas + 0.14 * stak, 1)
