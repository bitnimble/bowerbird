import { z } from 'zod';
import { CompositionSchema } from './composition';

export const MOST_TILES = 256;
export const MOST_VERTICES = 8192;
export const MOST_SOURCES = 12;

/** `assembly_weight::FEATHER`: a recipe's feather where it names none. */
export const DEFAULT_FEATHER = 0.0025;
/** The widest feather the page offers. */
export const MOST_FEATHER = 0.015;
/** The widest a stored recipe may name, past the page's own: the page clamps what it reads. */
const MOST_STORED_FEATHER = 0.1;

/**
 * What a tile asks the frame it picks for.
 *
 * `subject` reads that frame where the thing under the reader's click went, so a person who moved
 * is taken as they stand there. `ground` reads it in place, so what comes back is whatever stands
 * there instead - which is how a thing is removed rather than replaced.
 */
export const TakesSchema = z.enum(['subject', 'ground']);
export type Takes = z.infer<typeof TakesSchema>;

/** `[a, b, c, d, tx, ty]` of `[a b; c d] * p + t` over the canvas: where a source is read for `p`. */
const WarpSchema = z.tuple([z.number(), z.number(), z.number(), z.number(), z.number(), z.number()]);
export type Warp = z.infer<typeof WarpSchema>;

export const SeamsSchema = z.object({
  pick: z.array(z.number().int().nonnegative()).max(MOST_TILES),
  // What each tile asked for when these were solved, which a render holds against the recipe's own:
  // a tile flipped between its subject and the ground names the same frame and means another shape.
  takes: z.array(TakesSchema).max(MOST_TILES).optional(),
  base: z.number().int().nonnegative(),
  vertices: z.array(z.tuple([z.number(), z.number()])).max(MOST_VERTICES),
  tiles: z.array(z.array(z.number().int().nonnegative()).min(3)).max(MOST_TILES),
  source: z.array(z.number().int().nonnegative()).max(MOST_TILES),
  // The tile each piece grew from, which a click on it opens.
  zone: z.array(z.number().int().nonnegative()).max(MOST_TILES),
  // The room each piece's seam has, as a share of the long edge: what §5.2's feather is sized from.
  corridor: z.array(z.number()).max(MOST_TILES),
  // A piece's frame read where its content went (`patch_search::tracked`), or in place for a tile
  // asking for the ground.
  warp: z.array(WarpSchema).max(MOST_TILES),
  // A piece's gain to meet what lies across its seams.
  exposure: z.array(z.number().positive()).max(MOST_TILES),
});
export type Seams = z.infer<typeof SeamsSchema>;

// The panorama's geometry, plus the tiles across it. Bounded because `photos.recipe` is one
// replicated cell re-parsed by a SQL trigger on every write to the row.
export const AssemblyRecipeSchema = CompositionSchema.extend({
  vertices: z.array(z.tuple([z.number(), z.number()])).max(MOST_VERTICES),
  tiles: z.array(z.array(z.number().int().nonnegative()).min(3)).max(MOST_TILES),
  pick: z.array(z.number().int().nonnegative()),
  base: z.number().int().nonnegative(),
  // What each tile asks its pick for: the subject the reader pointed at, wherever that frame shows
  // it, or the ground that frame shows in its place. Absent, every tile asks for the subject, which
  // is what every recipe written before removal existed meant.
  takes: z.array(TakesSchema).max(MOST_TILES).optional(),
  // The widest §5.2's feather may be, as a share of the long edge: the reader's to set.
  feather: z.number().min(0).max(MOST_STORED_FEATHER).optional(),
  // Where the picked frames actually meet, solved for `pick` and `base` over the carve's volume
  // (`assembly_seams`). Absent, the tiles are the seams.
  seams: SeamsSchema.optional(),
  // The layer key the carve's seam volume was written under, which a re-solve reads.
  seamVolume: z.string().regex(/^[A-Za-z0-9_-]+$/).optional(),
}).superRefine((recipe, ctx) => {
  const bad = (message: string): void => void ctx.addIssue({ code: 'custom', message });
  const tiles = recipe.tiles.length;
  if (recipe.sources.length > MOST_SOURCES) bad(`an assembly is made of at most ${MOST_SOURCES} photographs`);
  if (recipe.pick.length !== tiles) bad('pick has to have one entry a tile');
  if (recipe.base >= recipe.sources.length) bad('the base names no source');
  if (recipe.pick.some((source) => source >= recipe.sources.length)) bad('a pick names no source');
  if (recipe.takes != null && recipe.takes.length !== tiles) bad('takes has to have one entry a tile');
  if (recipe.tiles.some((loop) => loop.some((at) => at >= recipe.vertices.length))) bad('a tile names no vertex');
  const seams = recipe.seams;
  if (seams != null) {
    const pieces = seams.tiles.length;
    for (const [name, field] of [['source', seams.source], ['zone', seams.zone], ['corridor', seams.corridor], ['warp', seams.warp], ['exposure', seams.exposure]] as const) {
      if (field.length !== pieces) bad(`the seams have to have one ${name} a piece`);
    }
    if (seams.source.some((source) => source >= recipe.sources.length)) bad('a piece names no source');
    if (seams.zone.some((zone) => zone >= tiles)) bad('a piece names no tile');
    if (seams.tiles.some((loop) => loop.some((at) => at >= seams.vertices.length))) bad('a piece names no vertex');
  }
});
export type AssemblyRecipe = z.infer<typeof AssemblyRecipeSchema>;

/** A seam solve for each of `picks` in place of the recipe's own: one a frame of an open tile. */
export const SeamsRequestSchema = z
  .object({
    recipe: AssemblyRecipeSchema,
    picks: z.array(z.array(z.number().int().nonnegative()).max(MOST_TILES)).min(1).max(MOST_SOURCES + 2),
  })
  .superRefine(({ recipe, picks }, ctx) => {
    if (picks.some((pick) => pick.length !== recipe.tiles.length)) {
      ctx.addIssue({ code: 'custom', message: 'a pick set has to have one entry a tile' });
    }
    if (picks.some((pick) => pick.some((source) => source >= recipe.sources.length))) {
      ctx.addIssue({ code: 'custom', message: 'a pick names no source' });
    }
  });

export const SolvedSeamsSchema = z.array(SeamsSchema.nullable());

/** §4.2's settled preview: one recipe, rendered as its picks stand. */
export const PreviewRequestSchema = z.object({ recipe: AssemblyRecipeSchema });

export const CommitAssemblyRequestSchema = z.object({ recipe: AssemblyRecipeSchema });

/**
 * What the analysis answers: an untiled recipe the reader seeds tiles on, and whether §3.1's corner
 * check held.
 *
 * Parsed rather than passed through, for `AlignedSchema`'s reason: a reply this build cannot read
 * is a refusal here rather than a page drawing tiles out of undefined.
 */
export const AnalysedSchema = z.object({
  recipe: AssemblyRecipeSchema,
  // §3.1's corner check failed: the frames were not taken from one place.
  unaligned: z.boolean(),
  warnings: z.array(z.string()),
});
export type Analysed = z.infer<typeof AnalysedSchema>;

export const SolvedSeamsResponseSchema = z.object({ seams: SolvedSeamsSchema.nullable() });
export type SolvedSeamsResponse = z.infer<typeof SolvedSeamsResponseSchema>;

export const AssemblyPreviewSchema = z.object({ url: z.string() });
export type AssemblyPreview = z.infer<typeof AssemblyPreviewSchema>;

export const AssemblyJobStartedSchema = z.object({ jobId: z.string() });
export type AssemblyJobStarted = z.infer<typeof AssemblyJobStartedSchema>;

/**
 * What a carve answers: what the analysis measured, and §4.3's layers.
 *
 * The layers are URLs rather than bytes, one per `analysed.recipe.sources` in that order - they are
 * pictures, and the page decodes each through `ImageDecoder` as it does every other rendition.
 */
export const CarvedSchema = z.object({
  analysed: AnalysedSchema,
  layers: z.array(z.string()),
});
export type Carved = z.infer<typeof CarvedSchema>;

/** An analysis `startAssembly` began, as it stands now. */
export const AssemblyJobSchema = z.object({
  id: z.string(),
  // The frames being analysed, which the page names its swatches from before the analysis answers.
  photoIds: z.array(z.string()),
  status: z.enum(['analysing', 'ready', 'failed', 'cancelled']),
  // How much of the analysis is behind it, 0 to 1.
  fraction: z.number(),
  // Once `ready`.
  carved: CarvedSchema.optional(),
  // Once `failed`.
  error: z.string().optional(),
});
export type AssemblyJob = z.infer<typeof AssemblyJobSchema>;

/** What §2.7's reopen answers: the recipe as it was committed, and the same layers over it. */
export const ReopenedAssemblySchema = z.object({
  recipe: AssemblyRecipeSchema,
  // One per `recipe.sources`, or empty where a source is missing: a canvas is drawn from every frame
  // it names or from none.
  layers: z.array(z.string()),
  // Sources since deleted or binned, which is what opens the page read-only.
  missingSources: z.array(z.string()),
});
export type ReopenedAssembly = z.infer<typeof ReopenedAssemblySchema>;
