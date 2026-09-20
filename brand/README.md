# brand

The mark, and the four pieces of art that carry the pitch. Every file is an SVG
with a PNG rendered from it — edit the SVG, re-render, commit both.

| file | what it is | where it goes |
|---|---|---|
| `snap-mark` | the bubble on its own | anywhere the name is already on screen |
| `snap-icon` | the mark on paper, 1024² | the app icon — `ios/Snap/Assets.xcassets/AppIcon.appiconset/icon-1024.png` is a copy of this |
| `snap-icon-dark` | the mark inverted, 1024² | dark-background avatars, the Linq profile |
| `snap-wordmark` | mark + "snap." | headers, slides, the top of a README |
| `snap-banner` | the cover: what Snap is | Devpost header, repo social preview |
| `snap-thread` | the pitch as a conversation | Devpost body, the slide that explains the product |
| `snap-how` | the loop in three cards | Devpost "how it works", anywhere the mechanic needs explaining |

## The rules the art follows

Same as the app (`ios/Snap/Views/Theme.swift`): paper `#F2F2F2`, ink `#141414`,
secondary `#6B6B6B`, white cards. The lavender→rose gradient
(`#8C8BD8` → `#D990B4`) is the one colour, and it only ever appears where money
does — the stake pill, the step numbers. Everything is lowercase except SOL.

The mark is a speech bubble with its eyes closed, happy. It has not changed and
should not: it ships in the asset catalog, and a late redesign means
regenerating the icon set for no gain.

## Re-rendering

Text is real `<text>`, not outlines, so it needs a sans-serif installed. The
committed PNGs were rendered through cairosvg with Liberation Sans standing in
for SF Pro — close enough that the two are indistinguishable at these sizes, and
consistent, which matters more than matching Apple's face exactly.

```sh
pip install cairosvg
python3 -c "
import cairosvg, glob, os
for svg in glob.glob('brand/*.svg'):
    png = svg[:-4] + '.png'
    width = 1024 if 'icon' in svg else None
    cairosvg.svg2png(url=svg, write_to=png, output_width=width or 1600)
"
```

**No emoji in the art.** They render as a tofu box through this path — the skull
in an earlier draft of `snap-thread` came out empty. The copy carries the voice
without them; save the emoji for the thread, where a real phone draws them.

## Keeping the copy true

`snap-thread` and `snap-banner` say what the product does, so they go stale when
it changes. They already did once: both described HealthKit as the referee, and
the thread showed Snap granting a reschedule after the deadline — a move the
backend now refuses. If the verification story or the stake rules change, these
two change with them.
