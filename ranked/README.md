# Ranked

A scoreboard for the Hack the North 2026 Devpost gallery. It rates all 341 submissions
out of 100, plots your win chance against the rest of the field on every sponsor prize,
and tells you what to change tonight to move it.

Built during the hackathon, from the public gallery only.

## Where it is hosted

`index.html` is a single self-contained static page — the whole dataset is inlined, there
is no build step and no server. Any static host works; three are set up.

**githack** (live, nothing to configure). Serves the file straight off this public
repository with the right content type, following the branch, so every re-scrape push
updates it:

<https://raw.githack.com/ryannzander/snap/claude/amazing-babbage-hveamd/ranked/index.html>

Its CDN is rate limited and asks not to be used for heavy production traffic. For a link
that will get real traffic, pin a commit on the caching host instead — permanent, but it
will not pick up later refreshes:

```
https://rawcdn.githack.com/ryannzander/snap/<commit-sha>/ranked/index.html
```

**GitHub Pages** (one switch away, best long-term). Set **Settings > Pages > Source** to
**GitHub Actions**; `.github/workflows/pages.yml` publishes this directory on every push
that touches it, to <https://ryannzander.github.io/snap/>. Until that setting is on the
workflow skips its deploy steps and says so, so CI stays green. Enabling Pages is
admin-only — the Actions token can neither create the site nor read the setting back.

**Vercel:** import this repository, set **Root Directory** to `ranked`, framework preset
**Other**, and leave the build and output settings empty. Or from this directory:

```
npx vercel --prod
```

Anonymous (`--temporary`) Vercel deployments expire after an hour and cannot be renewed in
place, so they are only useful while something keeps redeploying them.

Any static host works the same way (GitHub Pages, Netlify, Cloudflare Pages, `python3 -m http.server`).

## What is in here

| File | |
| --- | --- |
| `index.html` | The whole app, data included. Open it directly from disk and it works. |
| `data.json` | The same dataset on its own: every project's scores, each prize track's field, and the win probabilities. |
| `vercel.json` | Static hosting config. |

## How the numbers are made

Every project page in the gallery was fetched and parsed on 19 Sept 2026 at 8:55 PM EDT —
write-up sections, Built With tags, repository links, demo video, team size.

**Rating (out of 100)** is a weighted blend of five measures, each ranked against the
whole gallery rather than an absolute scale:

| Dimension | Weight | Measured from |
| --- | --- | --- |
| Technical depth | 30% | Architecture terms, measured quantities, length |
| Originality | 24% | How rare the write-up's vocabulary is across all 341 |
| Demo strength | 20% | Signals that there is something to watch happen |
| Completeness | 16% | Seven sections, repo link, video, real tags |
| Evidence | 10% | Baselines, tests, accuracy, latency — claims you can check |

About 75 projects were also read in full and carry a written analyst note and a scoring
adjustment; they are marked `read`.

**Novelty** is scored separately: TF-IDF cosine similarity of each write-up against every
other, taking the mean of the five nearest, then residualised against write-up length so a
short page cannot pass as original. Only the 110 projects with enough text get one.

**Win probability** applies each sponsor's stated judging criteria as a weighting over the
five dimensions, plus bonuses for depth of use of that sponsor's product, then softmaxes
across the eligible field and normalises so the expected number of winners equals the
prize's actual winner count.

`MOGGED` means outside the top 15 of that field.

## Honesty

These are a model's opinion, not the judges'. Nothing here is calibrated against real
outcomes, because there are none yet. Judging at Hack the North is a live demo, which a
Devpost page cannot show — a great demo breaks every number in here.

Projected odds in the game plan hold every rival frozen at tonight's write-up, so read
them as the optimistic end.

## Runtime

Two features come from the claude.ai artifact runtime and are simply absent when the page
is hosted anywhere else — the page degrades without them:

- **Second opinion** — asks Claude for a written review. Hidden when unavailable.
- **Export brief** — saves a markdown file; falls back to copying to the clipboard.
