import { describe, it, expect, jest } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { libraryScope } from '../../../utils/scope';
import { PathSegment, route } from '../../../schemas/route';
import { LIBRARY_ID, buildApp, library, type LibrariesApp } from './libraries_api_test_helpers';

describe('LibrariesApi', () => {
  // A hidden shoot's folders leave the tree with the shoot (§12.4), which is what stops Tree (full)
  // drawing them back as unclaimed rows offering to adopt the shoot already on them. Over a real
  // temp tree, so the walk and the filter are held against each other rather than mocked apart.
  describe('the folder tree and the shoots put away', () => {
    function withTree(): { root: string; drop: () => void } {
      const root = mkdtempSync(path.join(tmpdir(), 'bowerbird-folders-'));
      for (const folder of ['Trip', 'Trip/Day one', 'Other']) mkdirSync(path.join(root, folder), { recursive: true });
      return { root, drop: () => rmSync(root, { recursive: true, force: true }) };
    }

    function appOver(root: string, hiddenFolders: string[]): LibrariesApp {
      const rooted = { ...library, root_path: root };
      return buildApp(
        { get: jest.fn(() => rooted) },
        { scopeFor: jest.fn(() => libraryScope(rooted, new Set<string>())) },
        {},
        jest.fn(() => 0),
        { hiddenFolders: jest.fn(() => hiddenFolders) },
      );
    }

    it('drops a hidden shoot and everything under it by default', async () => {
      const { root, drop } = withTree();
      try {
        const { app, shoots } = appOver(root, ['Trip']);
        const res = await app.request(route(PathSegment.api(), PathSegment.libraries(), LIBRARY_ID, PathSegment.folders()));
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual(['Other']);
        expect(shoots.hiddenFolders).toHaveBeenCalledWith(LIBRARY_ID);
      } finally {
        drop();
      }
    });

    it('answers with the whole tree when the hidden are asked for', async () => {
      const { root, drop } = withTree();
      try {
        const { app, shoots } = appOver(root, ['Trip']);
        const res = await app.request(
          `${route(PathSegment.api(), PathSegment.libraries(), LIBRARY_ID, PathSegment.folders())}?include_hidden=true`,
        );
        expect(((await res.json()) as string[]).sort()).toEqual(['Other', 'Trip', 'Trip/Day one']);
        // Nothing to filter by, so nothing is asked for.
        expect(shoots.hiddenFolders).not.toHaveBeenCalled();
      } finally {
        drop();
      }
    });
  });
});
