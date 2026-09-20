import {
  type AssemblyJob,
  AssemblyJobSchema,
  type AssemblyJobStarted,
  AssemblyJobStartedSchema,
  type AssemblyPreview,
  AssemblyPreviewSchema,
  type AssemblyRecipe,
  CommitAssemblyRequestSchema,
  PreviewRequestSchema,
  type ReopenedAssembly,
  ReopenedAssemblySchema,
  SeamsRequestSchema,
  type SolvedSeamsResponse,
  SolvedSeamsResponseSchema,
} from '../../../src/schemas/assembly';
import { type CompositePhoto, CompositePhotoSchema } from '../../../src/schemas/composition';
import { type PhotoSummary, PhotoSummaryListSchema, type PhotoTarget, PhotoTargetSchema } from '../../../src/schemas/photos';
import { PathSegment, route } from '../../../src/schemas/route';
import { NothingSchema, request } from './request';
import { assetUrl } from './transport';

const assemblyOf = (photoId: string): string =>
  route(PathSegment.api(), PathSegment.composites(), PathSegment.assembly(), photoId);

const assemblyJob = (jobId: string): string =>
  route(
    PathSegment.api(),
    PathSegment.composites(),
    PathSegment.assembly(),
    PathSegment.jobs(),
    encodeURIComponent(jobId),
  );

export const compositesApi = {
  // The same target every bulk route takes, answering with the photograph the merge made. It
  // takes as long as the alignment and the first renditions do, which is where the caller's
  // progress indicator earns its keep.
  createPanorama: (target: PhotoTarget): Promise<CompositePhoto> =>
    request(
      CompositePhotoSchema,
      'POST',
      route(PathSegment.api(), PathSegment.composites(), PathSegment.panorama()),
      PhotoTargetSchema.parse(target),
    ),
  /** The frames a panorama is composed from, in the order its recipe names them. */
  listFrames: (id: string, signal?: AbortSignal): Promise<PhotoSummary[]> =>
    request(PhotoSummaryListSchema, 'GET', route(PathSegment.api(), PathSegment.photos(), id, PathSegment.frames()), undefined, signal),
  /** Starts analysing a set of frames into an assembly, answering the job at once. */
  startAssembly: (photoIds: string[]): Promise<AssemblyJobStarted> =>
    request(
      AssemblyJobStartedSchema,
      'POST',
      route(PathSegment.api(), PathSegment.composites(), PathSegment.assembly()),
      PhotoTargetSchema.parse({ photo_ids: photoIds }),
    ),
  getAssemblyJob: (jobId: string, signal?: AbortSignal): Promise<AssemblyJob> =>
    request(AssemblyJobSchema, 'GET', assemblyJob(jobId), undefined, signal),
  /** Stops a job's carve at its next boundary, letting go of the device (§3.9). */
  cancelAssembly: (jobId: string): Promise<void> =>
    request(NothingSchema, 'POST', `${assemblyJob(jobId)}${route(PathSegment.cancel())}`),
  /**
   * A finished assembly's recipe and layers, rebuilt from the recipe alone - no analysis re-run.
   * `missingSources` names a source since binned or deleted, which is what puts the page into its
   * read-only state.
   */
  getAssembly: (photoId: string, signal?: AbortSignal): Promise<ReopenedAssembly> =>
    request(ReopenedAssemblySchema, 'GET', assemblyOf(photoId), undefined, signal),
  /** Done: the recipe is the whole request, and it names its own frames by id. */
  commitAssembly: (recipe: AssemblyRecipe): Promise<CompositePhoto> =>
    request(
      CompositePhotoSchema,
      'POST',
      route(PathSegment.api(), PathSegment.composites(), PathSegment.assembly(), PathSegment.commit()),
      CommitAssemblyRequestSchema.parse({ recipe }),
    ),
  /**
   * Where the frames meet for each of `picks` in place of the recipe's own: `null` for a set whose
   * solve was refused, and for all of them once the carve's volume has been reaped.
   */
  solveSeams: (recipe: AssemblyRecipe, picks: number[][], signal?: AbortSignal): Promise<SolvedSeamsResponse> =>
    request(
      SolvedSeamsResponseSchema,
      'POST',
      route(PathSegment.api(), PathSegment.assemblies(), PathSegment.seams()),
      SeamsRequestSchema.parse({ recipe, picks }),
      signal,
    ),
  /** §4.2's settled preview: this recipe through the render, at the layers' size. */
  previewAssembly: (recipe: AssemblyRecipe, signal?: AbortSignal): Promise<AssemblyPreview> =>
    request(
      AssemblyPreviewSchema,
      'POST',
      route(PathSegment.api(), PathSegment.assemblies(), PathSegment.preview()),
      PreviewRequestSchema.parse({ recipe }),
      signal,
    ),
  /** Done on a reopened assembly: updates the row's recipe in place rather than inserting a
   * second photograph. */
  updateAssembly: (photoId: string, recipe: AssemblyRecipe): Promise<CompositePhoto> =>
    request(CompositePhotoSchema, 'PUT', assemblyOf(photoId), CommitAssemblyRequestSchema.parse({ recipe })),

  /**
   * A draft's layer, which the server names as the path it serves it at (§4.3).
   *
   * Through `assetUrl` like every other picture the browser fetches for itself: the path is the
   * API's, and under the desktop shell the scheme in front of it is not.
   */
  layerUrl: (path: string): string => assetUrl(path),
};
