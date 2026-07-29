import { Hono } from 'hono';
import { CreateLibraryRequestSchema, SetFolderRuleRequestSchema, UpdateLibraryRequestSchema } from '../../schemas/libraries';
import { AppError } from '../../errors';
import { browseUnder } from '../../utils/browse';
import type { LibrariesService } from '../../services/libraries/libraries_service';
import type { FolderRulesRepository } from '../../services/shoots/folder_rules_repository';
import type { SyncService } from '../../services/sync/sync_service';

export class LibrariesApi {
  readonly routes: Hono;

  constructor(
    private readonly service: LibrariesService,
    private readonly sync: SyncService,
    private readonly folderRules: FolderRulesRepository,
  ) {
    const app = new Hono();

    app.post('/', async (c) => {
      const body = CreateLibraryRequestSchema.parse(await c.req.json());
      return c.json(await this.service.create(body), 201);
    });

    app.get('/', (c) => c.json(this.service.list()));

    // Folders inside this library, in the root-relative paths a shoot's folder
    // is stored as. Fenced at the root: a shoot's folder cannot be outside the
    // library it belongs to, so neither can the picker that chooses one.
    app.get('/:id/browse', async (c) =>
      c.json(await browseUnder(this.service.get(c.req.param('id')).root_path, c.req.query('path') ?? '')),
    );

    // Where a folder differs from what the library's settings say (§4.7). Reads
    // and writes go through the library so an id that does not exist is a 404
    // here rather than a rule nothing will ever consult.
    app.get('/:id/folder-rules', (c) => c.json(this.folderRules.listByLibrary(this.service.get(c.req.param('id')).id)));

    app.put('/:id/folder-rules', async (c) => {
      const library = this.service.get(c.req.param('id'));
      const body = SetFolderRuleRequestSchema.parse(await c.req.json());
      this.folderRules.set(library.id, body.folder_path, body.rule);
      return c.json(this.folderRules.listByLibrary(library.id));
    });

    app.delete('/:id/folder-rules', (c) => {
      const library = this.service.get(c.req.param('id'));
      const folderPath = c.req.query('folder_path');
      if (folderPath == null || folderPath === '') {
        throw new AppError('VALIDATION_ERROR', 'folder_path is required');
      }
      this.folderRules.clear(library.id, folderPath);
      return c.body(null, 204);
    });

    app.post('/:id/sync', async (c) => c.json(await this.sync.syncLibrary(c.req.param('id'))));

    // Returns as soon as the run has been told to stop; it settles back to idle
    // on its own, which the status endpoint reports like any other transition.
    app.delete('/:id/sync', (c) => {
      this.sync.cancelSync(c.req.param('id'));
      return c.body(null, 204);
    });

    app.get('/:id/sync/status', (c) => c.json(this.sync.getSyncStatus(c.req.param('id'))));

    app.get('/:id', (c) => c.json(this.service.get(c.req.param('id'))));

    app.patch('/:id', async (c) => {
      const body = UpdateLibraryRequestSchema.parse(await c.req.json());
      return c.json(this.service.update(c.req.param('id'), body));
    });

    app.delete('/:id', async (c) => {
      await this.service.delete(c.req.param('id'));
      return c.body(null, 204);
    });

    this.routes = app;
  }
}
