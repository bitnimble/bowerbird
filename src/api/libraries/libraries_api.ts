import { Hono } from 'hono';
import {
  CreateLibraryRequestSchema,
  DEFAULT_LIBRARY_SETTINGS,
  DetectStacksResponseSchema,
  FolderPathSchema,
  FolderRulesSchema,
  LibrariesSchema,
  LibraryFoldersSchema,
  LibraryScanStatusSchema,
  LibrarySchema,
  LibrarySettingsSchema,
  SetFolderRuleRequestSchema,
  UpdateLibraryRequestSchema,
} from '../../schemas/libraries';
import { PathSegment, route } from '../../schemas/route';
import { HiddenShootsQuerySchema } from '../../schemas/shoots';
import { foldersUnder } from '../../utils/browse';
import { foldersOutside } from '../../utils/shoots';
import { takeAsLongAsItTakes } from '../long_requests';
import { respond } from '../respond';
import type { LibrariesService } from '../../services/libraries/libraries_service';
import type { FolderRulesRepository } from '../../services/shoots/folder_rules_repository';
import type { ShootsService } from '../../services/shoots/shoots_service';
import type { ScanService } from '../../services/sync/scan/scan_service';

export class LibrariesApi {
  readonly routes: Hono;

  constructor(
    private readonly service: LibrariesService,
    private readonly scan: ScanService,
    private readonly folderRules: FolderRulesRepository,
    // The folder tree has to lose a hidden shoot's folders along with the shoot (§12.4), which is
    // the one thing here that is a question about shoots rather than about the library.
    private readonly shoots: ShootsService,
    private readonly detectStacks: (libraryId: string) => number,
  ) {
    const app = new Hono();

    app.post(route(), async (c) => {
      const body = CreateLibraryRequestSchema.parse(await c.req.json());
      return c.json(respond(LibrarySchema, await this.service.create(body)), 201);
    });

    app.get(route(), (c) => c.json(respond(LibrariesSchema, this.service.list())));

    // What a new library is created with, so a client can offer "put this back"
    // without carrying a copy of the schema's defaults. Above `/:id`, which would
    // otherwise take `defaults` for a library id.
    app.get(route(PathSegment.defaults()), (c) => c.json(respond(LibrarySettingsSchema, DEFAULT_LIBRARY_SETTINGS)));

    // Every folder inside this library, in the root-relative paths a shoot's
    // folder is stored as. Whole tree in one answer rather than a level per
    // request: the shoots page has to know which folders hold nothing before it
    // draws them, and a chevron that has to be clicked to find out is one that
    // disappears under the click half the time.
    // Only folders the library actually contains: offering a Bin, a dotfolder or
    // an excluded folder here would offer "Add as shoot" on a folder the scan is
    // never going to look at, whose photos would be moved in and then vanish.
    // A hidden shoot's folders go with it (§12.4). The tree is read off the disk, where nothing says
    // a folder has been put away, so left in they come back as unclaimed rows - dimmed, under the
    // folder's own name, offering to adopt the shoot that is already on them.
    app.get(route(PathSegment.param('id'), PathSegment.folders()), async (c) => {
      const library = this.service.get(c.req.param('id'));
      const { include_hidden } = HiddenShootsQuerySchema.parse(c.req.query());
      const folders = await foldersUnder(this.scan.scopeFor(library));
      const shown = include_hidden ? folders : foldersOutside(folders, this.shoots.hiddenFolders(library.id));
      return c.json(respond(LibraryFoldersSchema, shown));
    });

    // Where a folder differs from what the library's settings say (§4.7). Reads
    // and writes go through the library so an id that does not exist is a 404
    // here rather than a rule nothing will ever consult.
    app.get(route(PathSegment.param('id'), PathSegment.folderRules()), (c) =>
      c.json(respond(FolderRulesSchema, this.folderRules.listByLibrary(this.service.get(c.req.param('id')).id))),
    );

    app.put(route(PathSegment.param('id'), PathSegment.folderRules()), async (c) => {
      const library = this.service.get(c.req.param('id'));
      const body = SetFolderRuleRequestSchema.parse(await c.req.json());
      this.folderRules.set(library.id, body.folder_path, body.rule);
      return c.json(respond(FolderRulesSchema, this.folderRules.listByLibrary(library.id)));
    });

    app.delete(route(PathSegment.param('id'), PathSegment.folderRules()), (c) => {
      const library = this.service.get(c.req.param('id'));
      const folderPath = FolderPathSchema.parse(c.req.query('folder_path'));
      this.folderRules.clear(library.id, folderPath);
      return c.body(null, 204);
    });

    // Answers only when the scan has finished, which on a first import is minutes
    // of opening and hashing every file - well past Bun's idle ceiling. Closed
    // underneath, the browser sees a failed request for a scan that is still
    // running and will succeed, and reports it as an error.
    app.post(route(PathSegment.param('id'), PathSegment.sync()), async (c) => {
      takeAsLongAsItTakes(c);
      return c.json(respond(LibraryScanStatusSchema, await this.scan.scanLibrary(c.req.param('id'))));
    });

    // Returns as soon as the run has been told to stop; it settles back to idle
    // on its own, which the status endpoint reports like any other transition.
    app.delete(route(PathSegment.param('id'), PathSegment.sync()), (c) => {
      this.scan.cancelScan(c.req.param('id'));
      return c.body(null, 204);
    });

    app.get(route(PathSegment.param('id'), PathSegment.sync(), PathSegment.status()), (c) =>
      c.json(respond(LibraryScanStatusSchema, this.scan.getScanStatus(c.req.param('id')))),
    );

    // One stage of what a scan does, on its own: rebuild every grid tile, or
    // every viewer render. Same status endpoint and Stop button as a scan.
    app.post(route(PathSegment.param('id'), PathSegment.jobs(), PathSegment.tiles()), (c) =>
      c.json(respond(LibraryScanStatusSchema, this.scan.rebuildTiles(c.req.param('id')))),
    );
    app.post(route(PathSegment.param('id'), PathSegment.jobs(), PathSegment.renditions()), (c) =>
      c.json(respond(LibraryScanStatusSchema, this.scan.rebuildRenditions(c.req.param('id')))),
    );

    // The pass a scan runs when it has brought something in, asked for on its own:
    // the stacking settings are not retroactive, so changing one otherwise waits
    // for the next import to mean anything (§19.4).
    app.post(route(PathSegment.param('id'), PathSegment.jobs(), PathSegment.stacks()), (c) =>
      c.json(respond(DetectStacksResponseSchema, { stacks: this.detectStacks(this.service.get(c.req.param('id')).id) })),
    );

    app.get(route(PathSegment.param('id')), (c) => c.json(respond(LibrarySchema, this.service.get(c.req.param('id')))));

    app.patch(route(PathSegment.param('id')), async (c) => {
      const body = UpdateLibraryRequestSchema.parse(await c.req.json());
      return c.json(respond(LibrarySchema, await this.service.update(c.req.param('id'), body)));
    });

    app.delete(route(PathSegment.param('id')), async (c) => {
      await this.service.delete(c.req.param('id'));
      return c.body(null, 204);
    });

    this.routes = app;
  }
}
