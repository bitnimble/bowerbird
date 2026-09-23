import { z } from 'zod';
import { AssemblyRecipeSchema, type AssemblyRecipe } from './assembly';
import { CompositionSchema, type Composition } from './composition';
import { EditDocSchema, type EditDoc } from './photo_edits';

/**
 * What an alignment answers: the recipe, and what it has to say about the set it was given.
 *
 * `lensless` is the one the caller has to act on. The recipe is stated in the camera's corrected
 * geometry, so a composite of the *photographs* reaches each RAW through its lens's own ratio
 * table - and that table is the stored camera match, which is fitted inside a render. A library
 * that serves the cameras' pictures never renders a frame, so nothing has fitted the lens, and a
 * canvas stitched without one doubles every edge at every seam. One photograph per lens, which is
 * all it takes to fit one (`shared_lenses` shares it across the group).
 */
export const AlignedSchema = z.object({
  recipe: CompositionSchema,
  /** What the kept correspondences reproject to, in the preview pixels they were found in. */
  rmsPx: z.number(),
  /** Photographs the recipe left out, which do not overlap the rest. */
  dropped: z.array(z.string()).default([]),
  lensless: z.array(z.string()).default([]),
  warnings: z.array(z.string()).default([]),
});
export type Aligned = z.infer<typeof AlignedSchema>;

// How a photograph's pixels are arrived at, and what they are arrived at *from*.
//
// The inputs are in here rather than in a column beside it, and that is the whole point of the
// shape: a row is not one file, it is a recipe over one or more of them, so every caller that
// wants a path has to say what it does with a list. The base case is a list of one.
export const RecipeSchema = z.discriminatedUnion('kind', [
  // A photograph as its camera wrote it. `path` is root-relative, forward slashes, exactly what
  // the scan found it at, and it moves when the file moves.
  z.object({ kind: z.literal('file'), path: z.string().min(1) }),
  CompositionSchema.extend({ kind: z.literal('panorama') }),
  AssemblyRecipeSchema.extend({ kind: z.literal('assembly') }),
  CompositionSchema.extend({ kind: z.literal('exposureBracket') }),
  CompositionSchema.extend({ kind: z.literal('pixelShift') }),
]);
export type Recipe = z.infer<typeof RecipeSchema>;

/**
 * A row whose recipe this build cannot read, which is a peer on a later build having composed it
 * out of something this one has never heard of.
 *
 * A kind of its own rather than a fall back to `file`, which would send every caller to a path
 * that resolves and holds nothing: what is true of such a row is that its picture cannot be built
 * here, and every switch below says so because it has to name this arm.
 */
export const StoredRecipeSchema = z.discriminatedUnion('kind', [
  ...RecipeSchema.options,
  z.object({ kind: z.literal('unreadable') }),
]);
export type StoredRecipe = z.infer<typeof StoredRecipeSchema>;

export function fileRecipe(path: string): Recipe {
  return { kind: 'file', path };
}

/**
 * How a panorama is framed, as the document every renderer and the editor already take.
 *
 * **The align's answer, but the reader's own field.** A hand-held pan leaves wedges of nothing at
 * its corners, which is exactly what a crop is for - so the merge writes one on the composite's
 * row and the picture goes down the path the editor's crop goes down, rather than growing a
 * second way to trim a picture that only some of the renderers know about.
 *
 * No straighten beside it: the solve levels the rotations themselves, so what is framed is
 * already upright (`composite_solve::straighten`).
 */
export function framingEdits(recipe: Composition | AssemblyRecipe): EditDoc {
  const [cropLeft, cropTop, cropRight, cropBottom] = recipe.crop;
  return EditDocSchema.parse({ cropLeft, cropTop, cropRight, cropBottom });
}

export function recipeOf(stored: string): StoredRecipe {
  try {
    const parsed = RecipeSchema.safeParse(JSON.parse(stored));
    return parsed.success ? parsed.data : { kind: 'unreadable' };
  } catch {
    return { kind: 'unreadable' };
  }
}

/**
 * The files this row is composed from, root-relative: one for a photograph, none for a recipe
 * that composes other rows rather than files, and none for one this build cannot read.
 *
 * **The unit the scan reconciles against.** A file changing on disk makes every row that names it
 * an input stale, which for almost all of them is the one photograph it is - and for the rest is
 * the reason this answers with a list rather than a path.
 */
export function inputsOf(recipe: StoredRecipe): readonly string[] {
  // A panorama names other photographs rather than files; what those resolve to is theirs to
  // answer, so the edge from one to its sources is a `photo_sources` question, not this one.
  return recipe.kind === 'file' ? [recipe.path] : [];
}

/**
 * The one file this row *is*, or null where it is not exactly one.
 *
 * Every caller of this is one that can only mean a single file - a decode, a bin move, an
 * embedded JPEG - so a row composed from several is refused here rather than silently reduced to
 * its first.
 */
export function soleInputOf(recipe: StoredRecipe): string | null {
  const inputs = inputsOf(recipe);
  return inputs.length === 1 ? (inputs[0] ?? null) : null;
}

/**
 * The photographs this row is composed *from*, in the order the recipe names them.
 *
 * The other half of a recipe's dependencies: `inputsOf` is the files it reads directly, this is
 * the rows it reads through. A `file` recipe has none - it depends on its own bytes and nothing
 * else - which is what makes the ordinary photograph a leaf of the graph. `unreadable` has none
 * either: it names no `sources` to map.
 */
export function sourcesOf(recipe: StoredRecipe): readonly string[] {
  if (recipe.kind === 'file' || recipe.kind === 'unreadable') return [];
  return recipe.sources.map((source) => source.photoId);
}

/**
 * A recipe composed of other photographs, kind and all - what a render's job carries once `file`
 * and `unreadable` are ruled out, and what stops being stripped before it reaches native.
 */
export type Composed = Exclude<Recipe, { kind: 'file' }>;

/**
 * Whether this row is composed out of other photographs rather than imported from a file.
 *
 * Narrowing rather than a bare boolean, so a caller that has to reach `.sources` afterwards does
 * it without a cast: the same check `sourcesOf` answers through.
 */
export function isComposite(recipe: StoredRecipe): recipe is Composed {
  return sourcesOf(recipe).length > 0;
}

/** The canvas a composite recipe is composited onto, or null for a recipe with none of its own. */
export function canvasOf(recipe: StoredRecipe): Composition['canvas'] | null {
  return recipe.kind === 'file' || recipe.kind === 'unreadable' ? null : recipe.canvas;
}
