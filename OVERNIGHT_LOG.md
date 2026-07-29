# Overnight: photo stacks

Task: finish the photo stacks feature per
`docs/superpowers/specs/2026-07-29-photo-stacks-design.md`.

**All of it landed in one squashed commit on `photo-stacks`:**
`feat(stacks): group photographs of one shot into a stack`, 52 files, +3528/-172.
Read it with `git show`, not `git diff`: the working tree is clean apart from
this file, which is a scratch report and stays uncommitted.

## Done

| plan step | where | validation |
|---|---|---|
| 1. Rust pixel boundary | `rawshim_pixels.ts` + oxlint rule | rule verified to fire, probe then removed |
| 2. Descriptor + grouping | `native/rawshim/src/stacks.rs` | 11 new unit tests; 87 Rust tests green |
| 3. FFI bindings | `rawshim.ts`, `rawshim_ops.ts` | typecheck; exercised by the integration suite |
| 4. Migration | `src/db/migrations.ts` | migration tests green |
| 5. Zod schemas | `schemas/stacks.ts`, photos, libraries | typecheck |
| 6. Collapse, positions, selection expansion | `photos_repository.ts` | 13 new integration tests |
| 7. Services | `src/services/stacks/*` | as above |
| 8. API | `api/stacks/stacks_api.ts`, `/api/photos/positions` | driven end to end (below) |
| 9. Sync hook | `sync_service.ts` `onSettled` | e2e + the real-import run |
| 10. Web: bands, actions, settings | `bands.ts`, grid, bulk bar, settings page | 10 band unit tests, 4 e2e |
| 11. DESIGN.md §19 | `DESIGN.md` |, |

**Checks on the final tree:** typecheck clean; lint clean bar a pre-existing
`app.tsx` warning; 277 unit, 174 integration, 87 Rust and 47 e2e tests passing;
web build succeeds.

**Real-photo run.** Fourteen frames imported through the actual server produced
eight entries, both labelled groups formed exactly, the six surrounding frames
left loose. The temporary library and catalogue were deleted afterwards.

## Found and fixed on the way

- **Ties in the rank sort broke arbitrarily**, so a flat sky or a blown
  highlight described differently from one run to the next.
- **Rank-normalizing near-equal chromaticity amplified float noise to full
  scale**, so two frames of one grey scene described it completely differently.
  Both were invisible to the real photographs and caught by synthetic fixtures.
- **The stack badge rendered underneath the select checkbox** in the same corner,
  so it could never have been clicked. Moved to the top left.
- **Detection ran after the sync status flipped to idle**, and the client
  re-reads on idle, so a fresh import showed an ungrouped grid until you
  navigated away and back.
- **Automatic stacking would have broken the existing e2e specs**: the fixture is
  one ARW copied under several names, so detection correctly collapsed the whole
  library to one tile. Stacking is now off for fixture libraries unless a spec
  asks for it.

## Assumptions

- Detection fires only when a sync added or changed photos (confirmed before the
  autonomous run).
- No backfill for photos imported before the feature (confirmed); rebuilding
  tiles gives a library descriptors as a side effect.
- The e2e stacks spec reuses `test/fixtures/DSC02981.ARW` rather than adding any
  photo data to the repo.

## Left for you

- **`photo-stacks-prescrub`** still holds the pre-scrub history, including the
  NAS path and frame filenames. Deleting a branch is irreversible, so it is left
  for you: `git branch -D photo-stacks-prescrub`.
- **Nothing pushed.** One commit on `photo-stacks`, ready to review and push.
- **The thresholds rest on one afternoon's shooting from one camera**, and the
  negative floor on five hand-verified pairs. Worth re-checking against a
  different kind of folder before trusting the defaults everywhere.
