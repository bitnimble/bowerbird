import { describe, it, expect } from 'bun:test';
import path from 'node:path';
import type { Library } from '../../schemas/libraries';
import { fileRecipe, recipeOf } from '../../schemas/recipes';
import { originalPathOf } from '../paths';

const library = { root_path: path.resolve('photos') } as Library;

describe('originalPathOf', () => {
  it('joins a photograph onto its library root', () => {
    expect(originalPathOf(library, { recipe: fileRecipe('Trip/a.arw') })).toBe(path.join(library.root_path, 'Trip', 'a.arw'));
  });

  it('answers null for a row that is composed rather than imported', () => {
    const recipe = recipeOf(JSON.stringify({ kind: 'panorama', version: 1, sources: [], projection: 'cylindrical' }));
    expect(originalPathOf(library, { recipe })).toBeNull();
  });

  it('answers null for a recipe this build cannot read, rather than a path that resolves', () => {
    // What a peer on a later build composes with. Falling back to the file kind would send this
    // to `/photos/Panorama.pano`, which is a decode of nothing at best.
    expect(recipeOf('{"kind":"kaleidoscope"}').kind).toBe('unreadable');
    expect(originalPathOf(library, { recipe: recipeOf('{"kind":"kaleidoscope"}') })).toBeNull();
  });
});
