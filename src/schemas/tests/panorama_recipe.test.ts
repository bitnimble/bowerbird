// What a panorama's recipe carries, held against the host that writes it.
//
// **This schema is what the merge parses the align's answer with**, and zod strips what it does
// not declare - so a field the native side adds and this does not know is gone by the time the
// recipe is stored, with nothing raised anywhere. Every unit test on both sides passes; what
// happens instead is a wrong picture.
//
// That is not hypothetical. The crop the align works out to trim a hand-held pan's empty corners
// was dropped exactly this way: the recipe stored named no crop, so both renditions rendered the
// whole canvas with the wedges of nothing still in them, and the grid laid the tile out at the
// shape of a picture nobody was going to see.
//
// `native/rawshim/tests/panorama_recipe.rs` writes the sample and asserts its own half.
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CompositionSchema } from '../composition';

const SAMPLE = join(import.meta.dir, '..', '..', '..', 'test', 'fixtures', 'panorama-recipe.json');

test('a recipe survives this schema with every field the other host wrote', () => {
  const written: unknown = JSON.parse(readFileSync(SAMPLE, 'utf8'));

  const parsed = CompositionSchema.parse(written);

  // Whole-value equality, not a field list: what this is for is the field nobody thought to add
  // here, and a list of the ones somebody did think of cannot catch that.
  expect(parsed).toEqual(written as typeof parsed);
});

// The one field with a default, so a recipe written before the align found a crop still parses -
// and reads as the whole canvas, which is what such a recipe rendered as.
test('a recipe from before the crop reads as the whole canvas', () => {
  const written = JSON.parse(readFileSync(SAMPLE, 'utf8')) as Record<string, unknown>;
  delete written.crop;

  expect(CompositionSchema.parse(written).crop).toEqual([0, 0, 1, 1]);
});
