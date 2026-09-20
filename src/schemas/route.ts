const segment =
  <const S extends string>(name: S) =>
  (): S =>
    name;

/**
 * Every segment of every URL path the app, the API and the tests use. A path is `route()` over
 * these, so renaming one is an edit here and nowhere else.
 */
export const PathSegment = {
  ack: segment('ack'),
  albums: segment('albums'),
  analysis: segment('analysis'),
  api: segment('api'),
  apply: segment('apply'),
  assemblies: segment('assemblies'),
  assembly: segment('assembly'),
  benchmark: segment('benchmark'),
  bin: segment('bin'),
  blobs: segment('blobs'),
  browse: segment('browse'),
  cancel: segment('cancel'),
  changes: segment('changes'),
  check: segment('check'),
  commit: segment('commit'),
  composites: segment('composites'),
  conflicts: segment('conflicts'),
  days: segment('days'),
  defaults: segment('defaults'),
  delete: segment('delete'),
  done: segment('done'),
  download: segment('download'),
  drafts: segment('drafts'),
  editConflicts: segment('edit-conflicts'),
  edits: segment('edits'),
  events: segment('events'),
  evict: segment('evict'),
  export: segment('export'),
  exports: segment('exports'),
  fetch: segment('fetch'),
  folderRules: segment('folder-rules'),
  folders: segment('folders'),
  frames: segment('frames'),
  handshake: segment('handshake'),
  hash: segment('hash'),
  hdr: segment('hdr'),
  hide: segment('hide'),
  ids: segment('ids'),
  image: segment('image'),
  img: segment('img'),
  job: segment('job'),
  jobs: segment('jobs'),
  keep: segment('keep'),
  landed: segment('landed'),
  libraries: segment('libraries'),
  mark: segment('mark'),
  merge: segment('merge'),
  missing: segment('missing'),
  models: segment('models'),
  neighbours: segment('neighbours'),
  noShoot: segment('no-shoot'),
  original: segment('original'),
  originals: segment('originals'),
  pair: segment('pair'),
  panorama: segment('panorama'),
  pause: segment('pause'),
  peers: segment('peers'),
  photos: segment('photos'),
  positions: segment('positions'),
  prepare: segment('prepare'),
  prepared: segment('prepared'),
  preview: segment('preview'),
  pull: segment('pull'),
  push: segment('push'),
  qualityCheck: segment('quality-check'),
  queued: segment('queued'),
  range: segment('range'),
  reachable: segment('reachable'),
  rebuildTiles: segment('rebuild-tiles'),
  redo: segment('redo'),
  refreshMetadata: segment('refresh-metadata'),
  remove: segment('remove'),
  removal: segment('removal'),
  rendition: segment('rendition'),
  renditions: segment('renditions'),
  replicas: segment('replicas'),
  replicate: segment('replicate'),
  replication: segment('replication'),
  restore: segment('restore'),
  resume: segment('resume'),
  runs: segment('runs'),
  seams: segment('seams'),
  settings: segment('settings'),
  share: segment('share'),
  shoots: segment('shoots'),
  soleHoldings: segment('sole-holdings'),
  stacks: segment('stacks'),
  stage: segment('stage'),
  status: segment('status'),
  sync: segment('sync'),
  tile: segment('tile'),
  tiles: segment('tiles'),
  transfers: segment('transfers'),
  triage: segment('triage'),
  undo: segment('undo'),
  unpair: segment('unpair'),
  unstack: segment('unstack'),
  updates: segment('updates'),
  verify: segment('verify'),

  param: <const N extends string>(name: N): `:${N}` => `:${name}`,
  optionalParam: <const N extends string>(name: N): `:${N}?` => `:${name}?`,
  any: segment('*'),
};

type Joined<S extends readonly string[]> =
  S extends readonly [] ? ''
  : S extends readonly [infer Only extends string] ? Only
  : S extends readonly [infer First extends string, ...infer Rest extends readonly string[]] ? `${First}/${Joined<Rest>}`
  : string;

/**
 * An absolute path: `route(PathSegment.api(), PathSegment.photos(), id)` is `/api/photos/<id>`,
 * and `route()` is `/`. A path under another is `${outer}${route(...)}`.
 *
 * Typed as the literal it builds, which is what lets Hono read a pattern's params off it.
 */
export function route<const S extends readonly string[]>(...segments: S): `/${Joined<S>}` {
  // The join is exactly what `Joined` spells; the compiler cannot follow it through `join`.
  return `/${segments.join('/')}` as `/${Joined<S>}`;
}
