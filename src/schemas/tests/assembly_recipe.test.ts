// What an assembly's recipe carries, held against the host that writes it.
//
// The same boundary `panorama_recipe.test.ts` guards, for the recipe that adds the tiles: this
// schema is what the merge parses the align's answer with, and zod strips what it does not declare,
// so a field the native side adds and this does not know is gone by the time the recipe is stored
// with nothing raised anywhere. Every unit test on both sides passes; what happens instead is a
// wrong picture.
//
// `native/rawshim/tests/assembly_recipe.rs` asserts its own half of the same file.
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AssemblyRecipeSchema } from '../assembly';

const SAMPLE = join(import.meta.dir, '..', '..', '..', 'test', 'fixtures', 'assembly-recipe.json');

test('an assembly survives this schema with every field the other host wrote', () => {
  const written: unknown = JSON.parse(readFileSync(SAMPLE, 'utf8'));

  const parsed = AssemblyRecipeSchema.parse(written);

  // Whole-value equality, not a field list: what this is for is the field nobody thought to add
  // here, and a list of the ones somebody did think of cannot catch that.
  expect(parsed).toEqual(written as typeof parsed);
});
