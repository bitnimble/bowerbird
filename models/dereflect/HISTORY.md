# Dereflect training history

A journal of how the reflection remover's checkpoint was reached: the lineage, what each step
bought, what was tried and dropped, and what is still unsolved. Only the checkpoint of record
was kept; every other run's weights were deleted on 26 October 2026. Run logs (`train.log`,
`run.out`, watchdog logs) and the full day-by-day experiment log (`overnight.md`) are archived on
the NAS in `dereflect-runs-history/`, and the one-off research scripts in `dereflect-scripts/`.

## How runs were scored

- **Composites:** PSNR on held-out composites drawn by the training generator. Comparable only
  between runs on the same generator and validation draw; it moved several times.
- **Real pairs:** PSNR over 688 held-out real through-glass/clean pairs pooled from RRW,
  OpenRR-5k, PolaRGB and DRR. The number that ranked checkpoints from mid-October on.
- **Benchmarks:** the DSRNet protocol (Real20, SIR² Objects/Postcard/Wild, Nature), PSNR/SSIM.
  Eval only, never trained on.
- **No glass:** PSNR of the output against a photo with no glass in front of it. A control for
  over-removal, never a gate (the feature is opt-in).
- **Fine detail taken:** share of a reflection's high-pass detail removed, by blur bin. Added
  late, after finding most runs removed none.
- **Test photos:** the user's own zoo-glass and windscreen photos, judged by eye under the
  shipped HDR grade, and colour checks of a few veils (predicted against measured hue and
  saturation in user-calibrated boxes).

## The lineage of the record

Every step is a fine-tune of the one before.

1. **Base chain (Oct 10 to 15).** `dereflect` 200k from scratch, then `scratch`, `crop384`,
   `long-60k`, `long`, `clipped`, `soft`, `deep`, `decoded`, `physical`, `structure`, `real2`,
   `veil`, `control-24k`, `pairs`, `pairs-384`. Each added one idea (below). Over a million
   steps in total, on generators older than today's.
2. **`pairs-long` 110k (Oct 18).** Four real pair sets mixed in at half the steps. Real pairs
   25.61, benchmarks 25.42/0.899. Record until Oct 24.
3. **`tune` 80k (Oct 24).** Today's generator (broad colours and levels, near subjects with
   faces, scene casts, faint and green broads, vents at 1.0), `--detail-weight 10`, exclusion 0.
   Composites 32.22, best fins (real 0.42), but real pairs fell to 24.79. The user called it the
   biggest visible jump.
4. **`tune-real` 50k.** Real share back to 0.5. Real pairs 25.52, best colour on real pairs.
5. **`strength` 40k.** `--gain 0.5 --faint 0.2`: penalise taking out too little light overall
   and leaving faint reflection light behind. Real pairs 25.74, first time above `pairs-long`.
6. **`strength2` 50k, souped 30k to 50k (Oct 25).** `--gain 1.0 --faint 0.4`, vents rebuilt
   from measurements of real ones (black openings, roll, bow, side light), detail map taken from
   the composite's own reflection layer. Soup of 30k/40k/50k: real pairs 25.87, composites
   32.03; 50k alone benchmarks 25.64/0.898 (best of any run); real vent fins 73% taken.
7. **`hints3` 50k (Oct 25).** Two brush channels after the image (Remove strokes, Keep
   strokes) into a zero-initialised `hint_tokenizer`, half the samples given strokes drawn from
   their own true reflection. Remove strokes over a strong part of the reflection; Keep strokes
   over the scene's fine structure and smooth out-of-focus light, veil or not. Bare (no
   strokes) it lost 0.3 dB on real pairs.
8. **Record: `soup-with-strength2-whole` (Oct 26).** Mean of `hints3` 50k and `strength2`'s
   soup, with `hints3`'s `hint_tokenizer` taken whole (`soup.py --whole-hints`). Without
   strokes it scores as `strength2`'s soup (real 25.87, composites 32.00); with strokes from the
   true reflection it takes 93% of the reflection under them (real 25.90). This is the bundle
   the app downloads.

## What worked

- **Composites of the library's own frames as scenes and reflections**, decoded through the
  app's own develop (`decoded`), with the sensor round trip and real noise. Fixed a magenta cast
  and made the editor's input match training's.
- **Clipped-pixel weighting** (`clipped`): helped exactly where highlights clip.
- **Soft scenes** (`soft`): broke the "sharp layer is the scene" shortcut.
- **Deeper blocks** `[2, 3, 6, 10]` (`deep`) and a **frozen DINOv2 ViT-S/14 adapter**
  (`semantics`): semantic features help decide which layer is which.
- **Radiance-set reflection strength** (`physical`): reflections as bright as the exposure says.
- **Real pairs at half the steps** (`real2`, `pairs*`), once pairs whose exposures differed were
  gain-filtered out. The unfiltered RRW pairs taught a sign false positive.
- **Defocused veils** (`veil`, `control`) and an L2 term for broad reflections (`broad`).
- **Own-white normalisation of composites.** Composites had not been normalised like the
  inference input; fixing it removed a cue the network had been reading.
- **Excluding through-glass frames from the scene pool.** The library holds zoo, aquarium,
  shop-window and windscreen photos, and all of the user's test photos had been training scenes,
  so their real veils were taught as content. `filelist-noglass.csv` comes from Sonnet over the
  whole library, Opus over Sonnet's yes frames, plus frames shot within 20 minutes of a test
  photo. Haiku caught 1 of 10 test photos.
- **Broad colours and levels** (`zoo`): uniform hues and 0.03 to 0.2 of white for veils and
  glares. First run to read the test veils' hues right.
- **Faint broads** (`faint`): broad layers at low saturation, so neutrality is supervised too.
  Halved composite hue error.
- **Faces as near reflections** (`faces`): frames with a detected face, cropped around it and
  warped, standing at the glass in about a fifth of steps. A YOLOv8 face model labelled frames
  offline only.
- **Scene casts** (`casts`): whole-scene tints with and without a reflection, which stopped the
  network taking every cool colour out of teal-lit scenes.
- **Warm-starting from the old chain** (`tune`). Every from-scratch run on today's generator
  learned no fine reflection detail (0.00 to 0.02 taken); the skill lives in the old chain and
  survives fine-tuning on any newer generator.
- **Vents measured, not guessed** (`strength2`): spacing, width, lean, height and the light of
  openings and fins read off real windscreen photos' predicted reflections and inverted into
  generator settings. Real fins 27% to 73% taken.
- **Weight soups** of a run's late steps: small, consistent gains on real pairs.
- **Brush hints** (`hints3`), especially with the hint layer souped whole.

## What didn't

- **Overshoot, colour and exclusion losses as first built**: little effect; exclusion turned
  out not to be the general detail suppressor either (`noexcl`).
- **ViT-L adapter only** (`vitl`) and **ViT-B** (`vitb`): worse or no better than ViT-S.
- **Distilled student** (4.6x faster): worse; the user accepted the teacher's speed.
- **More glare data** (`glare`, `white`): a flat additive lift is not identifiable from one
  image, so more of it only dehazed clean photos.
- **Late steps on composites** (`structure` past 40k): overfit composites. **TTA** and soups of
  that run: no gain. **Two passes** (`real2`'s second pass, and `second`, a trained second look):
  the second pass costs the first more than it adds.
- **From scratch on clean frames** (`fresh`, `v2`, `zoo`, `casts`, `crop512`, ...): better no-glass
  and colour, worse real pairs and benchmarks, no fine detail.
- **Hue-only fixes for the slate-blue prior** (`hues`, `chroma`, `chroma2`, `colour5`,
  `veilhues`, `broadhues`, `glareprobe`): a heavier colour weight trades removal for hue; the
  network could not read the green-magenta axis. The real fix was faint and coloured broad
  draws.
- **Bright broad shares** (`broadshares`): scenes buried under more than white; rejected by eye.
- **512 px crops** (`crop512`): removed the inference-size dependence of the colour error but
  not the error.
- **People without faces** (`people`): reflections of backs and torsos, which nobody
  photographs. Replaced by face crops.
- **`--fin-weight`** (fin map): lifted synthetic fins, not real ones. Replaced by the detail
  weight and measured vents.
- **Dashboard objects** (`dash`): paper, panels and stickers on the dashboard. Didn't carry to
  real dashcam frames, and erased white objects in the scene. Dashcam work dropped from the still
  model; video would get its own temporal stage.
- **A deterministic tint correction** from mean scene and reflection colour: explained nothing.
- **Uncontaminated restart** (`clean`): stopped once the frame leak was found, lineage
  contaminated.

## Unsolved

- Milky veils on zoo glass: taken only partly at strength 1, blotchy past 1.5.
- A faint reflected face in one zoo-glass photo: Remove strokes darken the area broadly
  (about 4 to 6 of 255) and leave the face.
- Strong blurred foreground objects read as veil: Keep strokes over them move the result only
  about 3 levels.
- Sharp dashboard reflections in dashcam video (out of scope for the still model).
- A small blue lean on grey veils, which frame is affected being learned per lineage.

## Precision (26 October 2026)

Every run trained under bf16 autocast, and every preview judged by eye ran under it too. The
first device port computed in full precision and removed far more on the zoo-glass photos,
blurred foreground people included: 19.6 dB from the bf16 output on the worst photo. Running bf16
inside one component at a time found it all in the tokenizers' input. Autocast rounds the picture
to bf16 before the first convolution, so the network only ever saw 8 significant bits; given a
continuous picture it behaves differently. `LightRR.forward` now rounds its input to bf16 in every
precision, and the device does the same in `admit`. The next model should either keep that
rounding or train its input path in full precision.

The fp16 port found another limit. The scan's output reaches millions before
`out_norm` brings it back to unit scale, past fp16's 65504, so the scan, `sum4`, `idwt` and the
`out_norm` input stay fp32 on the device whatever the cells. Plain fp16 autocast in torch gives NaN
on every photo for the same reason.

## Ideas not yet tried

- EXIF conditioning: scene radiance and aperture as network inputs.
- Training from the record with stronger Keep-stroke supervision over foreground blur.
