# Art directions

The founder's brief was that the original art was boring and needed to be
memeable. That means reaction-face energy, exaggerated expressions and bold
silhouettes. It should be something people screenshot, crop into a reaction
image or wear as a pfp. Each agent's personality should be a joke you get in
one second:

| Agent | Role | The joke |
| --- | --- | --- |
| Aloof | Observer | judges you silently: half-lidded stare, monocle, sips tea |
| Chaotic | Trickster | unhinged: mismatched eyes, too many teeth, jester cap |
| Social | Connector | the overly eager reply-guy: sparkle eyes, notification badge, typing dots |
| Skeptic | Auditor | the "well actually" guy: raised index finger, glare glasses, smug smirk |

## Moods (reaction variants)

Every new style draws each agent in four moods, so a swarm post can carry the
reaction image that matches its tone:

| Mood | Use for | Example |
| --- | --- | --- |
| `neutral` | the signature pfp | Aloof's deadpan stare |
| `hype` | agreeing, excited | Chaotic's laser eyes |
| `shade` | disagreeing, unimpressed | Aloof's side-eye over a teacup |
| `shook` | caught off guard | Aloof's monocle popping off |

`moodForText(text)` in `src/art/moods.mjs` is a deterministic tone classifier
for swarm posts. "who checked it?" maps to `shade`, "wait, what" to `shook`
and "count me in" to `hype`. `style.render(traits, { mood })` draws the
matching face.

## How to see them

```
node scripts/render-agents.mjs --style sticker    # or pixel, deepfried, default, all
```

This writes `out/styles/<style>/<agent>-<mood>.svg` (16 files) and a
`sheet.svg` contact sheet, with agents as rows and moods as columns. The
committed sheets are in `docs/art/`:
[sticker](art/sticker-sheet.svg), [pixel](art/pixel-sheet.svg) and
[deepfried](art/deepfried-sheet.svg). Running the script with no `--style`
keeps the old behaviour: the default style goes to `out/<agent>.svg`.

All styles are pure SVG and deterministic from the traits plus the mood.
They have no dependencies, no text or fonts, and no external references.
Every trait slot changes the image:

| Trait | Draws |
| --- | --- |
| temperament | palette |
| role | the character and its props |
| risk | background pattern |
| voice | mouth |
| memory_depth | the `data-ring` count: stars, XP pips or stickers |

`data-tier` and `data-mood` on the root carry the rarity tier and the mood.
The shared contract in `src/art/styles/contract.mjs` covers each style with:

- 16 goldens
- determinism
- slot coverage
- distinct faces per mood
- id hygiene
- a 32 KB size cap

## The three directions

### `sticker`: Bighead Sticker Pack

A Telegram or Discord sticker pack. Each character is a huge round head
cropped at the shoulders like a reaction screenshot. It has 7-9px ink
outlines, flat fills, a hard cel-shadow and a fat white die-cut border with a
drop shadow.

Expressions are pushed to the limit:

- Aloof's lidded stare, side-eye over a steaming teacup and flying monocle.
- Chaotic's one-giant-eye grin with tongue, starburst-eyed scream and evil
  steepled fingers.
- Social's sparkle eyes under a red "1" badge and typing bubble, and the
  strained "haha... ok" grimace with a sweat drop.
- Skeptic's raised "um, actually" finger with ding lines, and the
  push-up-glasses `^^` smugness.

It is the cleanest read at 48px and the most legible joke per tile. It needs
no filters, so wallets and marketplaces that rasterize SVG without a browser
engine show it exactly as designed. The largest file is about 9 KB.

Weaknesses: Skeptic's wilted shook finger is the weakest tile, and the
cel-shadow is faint on the pale cool and muted skins.

### `pixel`: 8-bit Reaction PFP

A 32x32 pixel-art pfp at 8px per pixel, built from a character-map DSL and
emitted as run-length-merged `<rect>`s. It has Bayer-dithered backgrounds, a
1px outline and 3-tone shading. `memory_depth` shows as gold pips in a game
HUD XP bar along the bottom, a ring mechanic holders will understand without
explanation.

It speaks pfp-collector culture. Some tiles stand out:

- Chaotic's laser eyes cross the whole frame.
- Chaotic's shade is a properly sinister slit-eyed mask.
- Social's heart eyes come with "!!" and heart bubbles.

Expressions have fewer degrees of freedom than vector, so it relies on brows
and big eyes. The largest file is about 18 KB.

Weaknesses: the jester cap reads more like a crown, and the Skeptic hype
hand is blobby.

### `deepfried`: Deep-Fried Reaction

The been-reposted-400-times meme look, done on purpose. Crude MS-Paint-bold
heads in role-specific silhouettes sit over zoom-ray backgrounds. A
filter chain is applied on top:

- displacement crunch
- sharpen ringing
- saturate
- red-orange cast with crushed shadows
- posterize
- bloom
- grain seeded from `traitSeed`
- burned vignette

The frying scales with mood, mildest on `shade` and hottest on `shook`. Its
signature is that every agent's `hype` has glowing lens-flare eyes. Chaotic
fires lasers out of frame, Aloof fires one beam through the monocle, Skeptic's
glasses blaze and Social's heart eyes glow. That makes the hype set a
collectible series, and it is the funniest single image in the project.

Weaknesses:

- The fry pulls every head toward yellow, so identity rests on silhouette and
  props.
- The effect depends on `feConvolveMatrix` and `feDisplacementMap`. Non-browser
  rasterizers show a cleaner, less fried image.
- The largest file is about 14 KB.

## Pick: `sticker`

`sticker` should be the token art. It is the only direction where all 16
tiles land the joke in one glance and survive a 48px crop. It renders
identically everywhere because it uses no filters. It is also the smallest,
which matters because the SVG is generated from on-chain traits and must be
byte-identical for verification. Its shoulders-up crop is the reaction-image
format, so a swarm post can attach `sticker` + `moodForText(post)` and look
like a native meme reply.

Keep `deepfried` as the "hype mode" variant for the demo video and social
posts. Its laser-eye series is the most repostable content we have, but it is
too dependent on the renderer to be the canonical token image. `pixel` is a
solid fallback if the community skews toward pfp-collector aesthetics.

`default`, the original layered renderer, stays byte-identical and remains
the renderer behind the existing goldens until the mint path switches styles.
