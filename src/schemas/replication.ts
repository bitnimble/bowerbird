import { z } from 'zod';
import { REPLICATED_ENTITIES, type ReplicatedKind } from '../services/replication/entities';
import { IdSchema } from './common';

export const PAGE_ROWS = 500;

// What replication says over the wire (docs/replication.md §6.2, §6.5), and the
// validation applied where a peer's payload becomes this catalogue's rows
// (§11.2). A buggy peer is in the threat model even where a malicious one is
// excluded: a recipe's path, `folder_path` and `bin_name` are later joined onto the
// library root and executed as file operations, so they are refused here, not
// where the damage would happen.
//
// Refinements only, never transforms: apply stores payloads byte-verbatim, so a
// normalising schema (a trim, a slash rewrite) would fork this peer's copy of a
// value from every other peer's and the catalogues could never converge.

/** Bumped on any breaking wire change, the stamp widths included (§2.2). */
export const REPLICATION_PROTOCOL = 1;

// The widths are the clock's (12 hex digits of milliseconds, 4 of counter, a
// 16-char peer id); a stamp of any other shape is from no build this protocol
// admits, and letting one in would poison every byte comparison after it.
export const StampSchema = z.string().regex(/^[0-9a-f]{16}[0-9a-z]{16}$/);
export const PeerIdSchema = z.string().regex(/^[0-9a-z]{16}$/);

export const VectorSchema = z.record(PeerIdSchema, StampSchema);

export const ReplicatedPathSchema = z
  .string()
  .min(1)
  .max(4096)
  .refine((p) => !p.includes('\\') && !p.includes('\0'), { message: 'path must use forward slashes' })
  .refine((p) => !p.startsWith('/') && !/^[A-Za-z]:/.test(p), {
    message: 'path must be relative to the library root',
  })
  .refine((p) => !p.split('/').some((segment) => segment === '' || segment === '.' || segment === '..'), {
    message: 'path must not contain empty, "." or ".." segments',
  });

const ReplicatedBinNameSchema = z
  .string()
  .min(1)
  .max(255)
  // A NUL is rejected as well as a separator, and deliberately: it terminates a C
  // string, so a name carrying one reaches the filesystem as its prefix and names
  // a folder other than the one that was checked. Tested rather than matched, so
  // the pattern holds no control character to object to.
  .refine((name) => !/[/\\]/.test(name) && !name.includes(String.fromCharCode(0)) && name !== '.' && name !== '..', {
    message: 'bin folder name must be a single folder name',
  });

const MAX_CELL_CHARS = 4_000_000;

const CellSchema = z.union([z.null(), z.boolean(), z.number(), z.string().max(MAX_CELL_CHARS)]);
/** A column value as it came out of SQLite, and as it goes back into one. */
export type Cell = z.infer<typeof CellSchema>;
const RowSchema = z.record(z.string().max(128), CellSchema);

// The columns that end up on disk or in a row id, per entity kind; everything else
// in a row is checked for shape and passed through, which is what lets an older
// build relay a newer one's columns (§8.5).
/**
 * A photograph's recipe as it arrives: JSON, and holding the path that will be joined onto the
 * library root and opened.
 *
 * **This is where `file_path`'s check went when the path moved into the recipe.** The value is a
 * string on the wire and is stored byte-verbatim, so this reads it to check it and hands back
 * what it was given: a refinement, never a transform, for the reason at the top of this file.
 * A kind this build does not know passes - a later peer may compose in ways this one cannot, and
 * relaying its rows is the point - but anything calling itself a file is held to the path rules.
 */
const RecipeCellSchema = z.string().max(MAX_CELL_CHARS).refine(
  (raw) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return false;
    }
    if (typeof parsed !== 'object' || parsed == null) return false;
    const recipe = parsed as { kind?: unknown; path?: unknown };
    if (typeof recipe.kind !== 'string') return false;
    // Held to the path rules whenever it carries a path at all, not only when it calls itself a
    // file. A kind this build does not know is relayed unread - that is the point - and one
    // carrying a `path` would otherwise reach a reader that asks for `$.path` without asking
    // what kind it is.
    if (recipe.path === undefined) return recipe.kind !== 'file';
    return ReplicatedPathSchema.safeParse(recipe.path).success;
  },
  {
    message: 'recipe must be JSON naming a kind, and any path it carries must be library-relative',
  },
);

const ROW_GUARDS: Partial<Record<string, z.ZodType>> = {
  photo: z.object({
    recipe: RecipeCellSchema,
    deleted_from_path: ReplicatedPathSchema.nullable().optional(),
  }),
  shoot: z.object({ folder_path: ReplicatedPathSchema }),
  folder_rule: z.object({ folder_path: ReplicatedPathSchema }),
  library: z.object({ bin_name: ReplicatedBinNameSchema.nullable().optional() }),
};

// A session id is deliberately *not* guarded here, though it becomes half of an
// `edit_conflict`'s row id and a `/` in one mints a row nothing can parse. A guard
// that fails rejects the whole page rather than the row - `PageSchema.parse` and
// `PushPageRequestSchema.parse` both do - and a page is regenerated identically
// from a fixed log position every session, so refusing one here stops that library
// replicating in either direction for good. That is the outcome being prevented,
// not a way of preventing it, and it would fall on precisely the catalogues that
// took a bad id before anything checked. The check lives where a divergence is
// parked (`parkDivergentEdits`), which is the only place such an id can do harm and
// where declining costs a conflict card rather than the library.

const KINDS = new Set<string>(REPLICATED_ENTITIES.map((entity) => entity.kind));

// Narrowed, not merely checked: this is the boundary the wire crosses, so past it a
// kind is one of the ten and every per-kind decision can be made exhaustively
// rather than defensively.
const KindSchema = z.custom<ReplicatedKind>((kind) => typeof kind === 'string' && KINDS.has(kind), {
  message: 'unknown replicated entity',
});

/**
 * The two shapes a change arrives in, told apart by the flag that decides which.
 *
 * A union rather than one object with optional halves: a grave has a stamp and no
 * units, a live row has units and no single stamp. Spelled as optionals, both
 * halves are readable on both shapes, and reading a live row's `stamp` - the newest
 * of its units - is how a deferral came to cap the wrong peer.
 */
export const ChangeSchema = z.discriminatedUnion('deleted', [
  z.object({
    kind: KindSchema,
    rowId: z.string().min(1).max(4096),
    deleted: z.literal(true),
    stamp: StampSchema,
  }),
  z
    .object({
      kind: KindSchema,
      rowId: z.string().min(1).max(4096),
      deleted: z.literal(false),
      row: RowSchema,
      stamps: z.record(z.string().max(64), StampSchema),
      // Not optional: absent would be a third meaning - "said nothing, leave what is
      // stored" - and null already says there is none to store.
      sidecar: RowSchema.nullable(),
    })
    .superRefine((change, ctx) => {
      const guard = ROW_GUARDS[change.kind];
      if (guard == null) return;
      const checked = guard.safeParse(change.row);
      if (checked.success) return;
      for (const issue of checked.error.issues) {
        ctx.addIssue({ code: 'custom', message: issue.message, path: ['row', ...issue.path] });
      }
    }),
]);
export type Change = z.infer<typeof ChangeSchema>;
export type Tombstone = Extract<Change, { deleted: true }>;
export type LiveChange = Extract<Change, { deleted: false }>;

// Opaque to everyone but the sender's `page()`: the resume key into its log.
const CursorSchema = z.string().max(4400);

export const PageSchema = z.object({
  changes: z.array(ChangeSchema).max(PAGE_ROWS),
  cursor: CursorSchema,
  done: z.boolean(),
});
export type Page = z.infer<typeof PageSchema>;

/**
 * A library a peer is offering, as the dialog that picks one needs it (§9.1).
 *
 * Read-only libraries are listed rather than hidden: they cannot be replicated
 * (§1), and a library missing from the list with no reason given is the sort of
 * thing that has somebody checking their network for an hour.
 */
export const RemoteLibrarySchema = z.object({
  id: IdSchema,
  name: z.string(),
  photo_count: z.number().int(),
  read_only: z.boolean(),
  /** Whether that peer already replicates it, which most of them will. */
  replicating: z.boolean(),
});
export type RemoteLibrary = z.infer<typeof RemoteLibrarySchema>;

export const RemoteLibrariesSchema = z.object({
  peer_id: PeerIdSchema,
  name: z.string(),
  clock_ms: z.number().int(),
  libraries: z.array(RemoteLibrarySchema),
});
export type RemoteLibraries = z.infer<typeof RemoteLibrariesSchema>;

export const BrowsedRemoteSchema = RemoteLibrariesSchema.extend({ clock_skew_ms: z.number() });
export type BrowsedRemote = z.infer<typeof BrowsedRemoteSchema>;

export const PairRequestSchema = z.object({
  library_id: IdSchema,
  peer_id: PeerIdSchema,
  name: z.string().trim().min(1).max(120),
});
export type PairRequest = z.infer<typeof PairRequestSchema>;

export const PairResponseSchema = z.object({
  library_id: IdSchema,
  library_name: z.string(),
  peer_id: PeerIdSchema,
  name: z.string(),
  clock_ms: z.number().int(),
});
export type PairResponse = z.infer<typeof PairResponseSchema>;

// Each side says whether it keeps RAW files for this library (§7.10), so neither
// offers to send bytes the other would refuse. Optional and defaulting to true:
// a peer on a build that predates the setting has always taken originals.
const WantsOriginalsSchema = z.boolean().default(true);

export const HandshakeRequestSchema = z.object({
  protocol: z.number().int().nonnegative(),
  schema: z.number().int().nonnegative(),
  library_id: IdSchema,
  peer_id: PeerIdSchema,
  clock_ms: z.number().int().nonnegative(),
  coverage: VectorSchema,
  wants_originals: WantsOriginalsSchema,
});
export type HandshakeRequest = z.infer<typeof HandshakeRequestSchema>;

export const HandshakeResponseSchema = z.object({
  protocol: z.number().int(),
  schema: z.number().int(),
  peer_id: PeerIdSchema,
  clock_ms: z.number().int(),
  coverage: VectorSchema,
  wants_originals: WantsOriginalsSchema,
});
export type HandshakeResponse = z.infer<typeof HandshakeResponseSchema>;

export const ChangesRequestSchema = z.object({
  library_id: IdSchema,
  peer_id: PeerIdSchema,
  held: VectorSchema,
  cursor: CursorSchema,
  limit: z.number().int().min(1).max(PAGE_ROWS).default(PAGE_ROWS),
});
export type ChangesRequest = z.infer<typeof ChangesRequestSchema>;

export const AckRequestSchema = z.object({
  library_id: IdSchema,
  peer_id: PeerIdSchema,
  coverage: VectorSchema,
});
export type AckRequest = z.infer<typeof AckRequestSchema>;

/**
 * One page of the *caller's* changes, for the callee to apply (§6.4).
 *
 * The direction a pull cannot cover: only one of two peers can usually dial the
 * other, so the one that dials has to be able to offer as well as ask.
 */
export const PushPageRequestSchema = z.object({
  library_id: IdSchema,
  peer_id: PeerIdSchema,
  page: PageSchema,
});
export type PushPageRequest = z.infer<typeof PushPageRequestSchema>;

export const PushDoneRequestSchema = z.object({
  library_id: IdSchema,
  peer_id: PeerIdSchema,
  /** What the sender held when the session opened, less any origin the callee deferred. */
  delivered: VectorSchema,
});
export type PushDoneRequest = z.infer<typeof PushDoneRequestSchema>;

export const PushPageResponseSchema = z.object({ deferred: z.array(StampSchema) });
export type PushPageResponse = z.infer<typeof PushPageResponseSchema>;

export const RenamePeerRequestSchema = z.object({ name: z.string().trim().min(1).max(120) });

export const SyncOriginalsRequestSchema = z.object({ sync_originals: z.boolean() });

export const SyncOriginalsResponseSchema = z.object({ cancelled: z.number().int() });
export type SyncOriginalsResponse = z.infer<typeof SyncOriginalsResponseSchema>;

export const PairedPeerSchema = z.object({
  peer_id: PeerIdSchema,
  name: z.string(),
  paired_at: z.string(),
  last_replicated_at: z.string().nullable(),
  // Why the last attempt did not land, or null (§8.6).
  last_error: z.string().nullable(),
  // Whether that peer keeps RAW files for this library (§7.10), as of the last
  // handshake with it.
  wants_originals: z.boolean(),
});
export type PairedPeer = z.infer<typeof PairedPeerSchema>;

export const PeersResponseSchema = z.object({
  peers: z.array(PairedPeerSchema),
  /** Whether this device keeps the RAW files of this library (§7.10). */
  sync_originals: z.boolean(),
});
export type PeersResponse = z.infer<typeof PeersResponseSchema>;

/** Every library that replicates. One absent from `libraries` has no peers (§10). */
export const AllPeersResponseSchema = z.object({
  libraries: z.array(PeersResponseSchema.extend({ library_id: z.string() })),
});
export type AllPeersResponse = z.infer<typeof AllPeersResponseSchema>;

export const ReplicaSummarySchema = z.object({
  library_id: z.string(),
  peer_id: z.string(),
  /** Rows the first session brought over, which is the whole catalogue. */
  applied: z.number().int(),
});
export type ReplicaSummary = z.infer<typeof ReplicaSummarySchema>;

export const ReplicateResultSchema = z.object({ applied: z.number().int(), peers: z.number().int() });
export type ReplicateResult = z.infer<typeof ReplicateResultSchema>;

export const SoleHoldingsResponseSchema = z.object({ photos: z.array(z.string()) });
export type SoleHoldingsResponse = z.infer<typeof SoleHoldingsResponseSchema>;

/** An address to offer, and how much this server actually knows about it. */
export const ReachableAddressSchema = z.object({
  url: z.string(),
  /**
   * `browser` is the origin the reader is on: known to work, because they are
   * using it. `interface` is a guess assembled from a local NIC.
   */
  kind: z.enum(['browser', 'interface']),
});
export type ReachableAddress = z.infer<typeof ReachableAddressSchema>;

export const ReachableAddressesSchema = z.object({ addresses: z.array(ReachableAddressSchema) });
export type ReachableAddresses = z.infer<typeof ReachableAddressesSchema>;

/** Asking a peer what it has, which changes nothing on either side (§9.1). */
export const BrowseRemoteRequestSchema = z.object({
  address: z.string().trim().min(1).max(2048),
});
export type BrowseRemoteRequest = z.infer<typeof BrowseRemoteRequestSchema>;

export const AddReplicaRequestSchema = z.object({
  address: z.string().trim().min(1).max(2048),
  library_id: IdSchema,
  root_path: z.string().trim().min(1),
  sync_originals: WantsOriginalsSchema,
});
export type AddReplicaRequest = z.infer<typeof AddReplicaRequestSchema>;

export const UnpairRequestSchema = z.object({
  library_id: IdSchema,
  peer_id: PeerIdSchema,
});
export type UnpairRequest = z.infer<typeof UnpairRequestSchema>;
