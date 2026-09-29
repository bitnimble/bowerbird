# Library replication

Several Bowerbird installs (hosted server, macbook, later desktop or phone) hold **replicas**
of one library, work fully offline and converge deterministically through pairwise exchanges.

§14's **passive peer** is a one-way originals backup folder on a drive or share, with no remote
Bowerbird. It shares active peers' transfer queue, hashes and staging, letting laptops cap local
storage while retaining access to the rest. This is likely the common case.

Replication names the protocol (`replication_*`); `ScanService` reads disk into the catalogue
(§9 of DESIGN.md). Product copy says libraries sync between devices and back up to folders.
Settings jobs: "Scan library", "Sync library to other devices", "Back up originals"; show the
last two only with a paired device or folder.

## 1. Goals and non-goals

Goals:

- A replica is a **true library**: offline import, triage, edit, stack, bin, tiles and renditions.
- Replication is **pairwise and symmetric**, with no master. Devices usually contact the
  reachable server; that is topology, not protocol.
- **Deterministic convergence**: after any sequence of replication sessions that connects the
  peers, all peers replicating a library hold identical replicated state for it (values _and_
  stamps), regardless of pair order, crashes, and interleavings.
- Catalogue state replicates **automatically** whenever a peer is reachable. Originals (RAWs)
  move when asked for: pressed for, opened (§7.5), fetched once by a replica that keeps them as it
  is added (§9.1), or on every session for a library set to send and fetch them (§10).
- Per-peer storage policy for originals: the server keeps everything, a laptop keeps what it
  imported plus what it fetched, and a laptop with a backup folder keeps what fits the ceiling it
  was given (§14.5). The catalogue always replicates in full on every peer.
- **A peer that is only a folder** (§14): a drive or a share holding every original, one way, with
  nothing running on the other side. What makes the ceiling above safe, and what a person who
  never pairs a second device gets out of this design.

Non-goals (v1):

- **Albums.** Cross-library `albums`, `album_photos` and `album_banners` stay per-install;
  syncing them is a separate project. Replicated photo hard-deletes (remote folder removal)
  cascade local album memberships through the existing FK, as local library deletion does.
- Linking independent libraries. Replicas are **born from** an existing library (§9), never
  merged with one. Do not preclude a future dedup-based merge; do not build it now.
- Readonly libraries. Replication requires rw and refuses otherwise.
- Deleting files on other peers. Replication propagates catalogue-row tombstones and never a
  file deletion: bin is a move and library removal is DB-rows-only, and the two places a RAW is
  unlinked (§7.6, §14.5) are each one device giving up its own copy on evidence it holds
  another. If purge ships later it rides the same tombstone machinery.
- Deduplicating the same RAW imported independently on two peers. Two imports are two photos; a
  future dedup tool is the answer, not the merge engine.
- **Phone build and UI.** Rendition fetch-through (§7.9) and catalogue-only mode (§7.10)
  solve full-catalogue browsing without local RAWs. The phone client remains a separate project.
- Evicting against another _device_ on a policy. Between peers the only eviction is the manual
  "remove local copy" action (§7.6), which requires live verification at the moment it deletes.
  A ceiling that gives copies back on its own exists only against a backup folder (§14.5), where
  this device can read both copies itself rather than take a peer's word for one.
- **Authentication.** Deployment requirement instead (§11.1): the server is reachable only over
  a trusted network (tailscale/VPN/LAN). An auth layer is a future project.
- Multi-user. Every peer is the same person; per-peer identity exists for clocks, blob
  locations, and lifecycle, not authorship.

Accepted risk: anything on the trusted network, including a buggy peer, can rewrite catalogue
state through valid operations. Peer messages never delete files. Local unlink requires live
peer possession (§7.6) or locally hashing both copies (§14.5). Payload validation (§11.2), stamp
bounds (§2.2) and rolling DB backups (§8.2, DESIGN.md §4.9) cover the remaining risks.

## 2. Peers, identity, clocks

### 2.1 Peer identity

Each install mints one app-level `peer_id` (16 chars, §2.3) across all libraries. Its visible
name defaults to hostname ("Macbook", "Home server"); devices name only themselves and exchange
names each handshake, propagating renames next sync. Reinstall pairing mints a **fresh** peer_id
and forgets the old one (§6.5), never resumes it.

### 2.2 Hybrid logical clock

Every replicated write is stamped with an HLC value `(physical_ms, counter, peer_id)` encoded
as one byte-comparable TEXT, so **string comparison is the total order** and last-write-wins is
one comparison identical on every peer.

Encoding, pinned because byte order is load-bearing: 12 lowercase hex digits of milliseconds
(enough until year ~5000), then 4 lowercase hex digits of counter, then the 16-char peer_id
(already a single-case alphabet). Counter overflow carries into the millisecond field
(standard HLC), never widens or wraps. Any two peers disagreeing on widths would disagree on
every comparison; the widths are part of the protocol version.

- Strictly monotonic per peer: `now = max(wall_ms, last_ms)`, counter increments when wall time
  does not advance.
- Merges forward on receive: `last_ms = max(last_ms, remote_ms)`, so a peer never mints below a
  stamp it has seen.
- **Mint-time guard**: minting refuses (and surfaces an error in the UI) when `last_ms` leads
  the local wall clock by more than the skew threshold (an hour, configurable: refusing to mint
  is refusing to write, and a few minutes ahead is what a suspended laptop leaves behind and
  what the clock is built to absorb, so the bar is set where waiting stops being a remedy).
  This catches
  the laptop that booted in 2035 at its **first write**, before poisoned stamps exist. Without
  it, monotonicity makes poisoning permanent: fixing the wall clock cannot bring `last_ms` back
  down.
- **Receive-time guard**: any received stamp whose `physical_ms` exceeds local wall time plus
  the threshold rejects the page, and the clock never merges forward past that bound. The
  handshake comparison (§6.2) is defense in depth, not the only gate: a peer can pass an honest
  handshake and ship future-dated stamps in payloads.
- **Recovery** for a replica that was poisoned anyway (guard threshold misjudged, old build):
  "Reset replica", re-clone under a fresh peer_id. The mint-time guard's job is to make that
  loss empty: stamps it refused to mint never carried work.

Wall-clock timestamps (`date_added`, `updated_at`, …) keep their current meaning and are never
used for conflict resolution.

### 2.3 ID width

`newId()` today mints 8 chars from a 36-char alphabet ≈ 41 bits. One writer never collides;
several peers minting offline into one id-space collide at birthday rates (~18% chance of a
collision by ~1M rows), and a collision is two unrelated rows claiming one primary key at
merge. `newId()` moves to **16 chars** (~82 bits, negligible forever). Existing 8-char ids are
safe: all minted on one machine before replication existed, and a clone copies them verbatim
(same id = same entity).

## 3. What replicates, and in what units

LWW units follow controls: fields changed together share a stamp; independent fields must not
clobber one another. **Assign every column** to a replicated unit or per-peer list. Missing
assignments are design bugs; the first draft missed seven.

### 3.1 Photos

| Unit        | Columns                                                                                                                                                                             | Notes                                                                                                                                                                                                                                                |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `imported`  | `content_hash` (§7.1), `file_size`, `width`, `height`, `orientation`, `date_taken`, `date_taken_offset`, `date_added`, `latitude`, `longitude`, exif columns (`iso` … `lens_model`) | Import facts. `date_added` replicates: it drives the `added_*` orderings, which must agree everywhere                                                                                                                                                |
| `triage`    | `rating`, `triage`, `notes`                                                                                                                                                         | The cull verdict                                                                                                                                                                                                                                     |
| `placement` | `recipe`, `shoot_id`                                                                                                                                                                | Tree position. The recipe is where a photograph's path lives (DESIGN §4.2.1), and for a file photograph it _is_ the placement: a rename rewrites it. Split from bin state so a bulk path rewrite (folder rename) cannot clobber a concurrent binning |
| `bin`       | `is_deleted`, `deleted_from_path`, `deleted_batch`                                                                                                                                  | Binned or not, and where it restores to                                                                                                                                                                                                              |
| `stack`     | `stack_state`                                                                                                                                                                       | The human verdict 'unstacked' must replicate or another peer's auto-detection re-stacks the photo. Membership itself is `stack_members` rows (§3.3)                                                                                                  |
| `hidden`    | `is_hidden`                                                                                                                                                                         | Put away (DESIGN §12.4). Apart from `triage` because the two are decided at separate moments: sharing that stamp, a rating arriving from a peer would bring back what somebody had hidden                                                            |

Per-peer, never replicated: `file_hash` (a stat-hash including mtime, meaningful only for this
disk's scan, §7.1), `is_missing`, `date_updated`, `needs_tile`, `needs_renditions`,
`tile_built_at`, `renditions_built_at`, `built_from`,
`processing_error`, `descriptor`, `viewer_rendition`, photo-level `rendition_source`. `stack_id` and `is_representative` are locally-maintained
derivations (§3.3), not replicated.

A folder rename rewrites member `placement` units (as the scan does today) and only them; it
never touches `bin` units. The repair pass (§5.5) keeps `shoot_id` coherent with paths.

**Correct `deleted_from_path` locally without replicating that correction.** Otherwise restore
recreates the renamed folder. Both attempted ways to replicate it are worse:

- _Stamp the `bin` unit._ The correction then asserts that the binning was decided now, so a peer
  that restored the photograph while apart loses that restore to a rename which knew nothing
  about it. What somebody did is silently undone, everywhere.
- _Move the column to `placement`._ Worse. A peer that still believes the row is live holds NULL
  for it, so its ordinary path writes null the origin of a binning it never heard of - and the
  restore then puts the RAW in the library root.

The remaining cost is a stale peer recreating the old folder on restore, preferable to undoing
an action or losing the restore destination. `converge.test.ts` pins both failures; `peers.ts`
requires every seed to leave every binned photo a destination.

### 3.2 Shoots, rules, banners, libraries, settings

| Table           | Unit                                                                                                                                                                                | Per-peer (not replicated)                                                                                                                                                                           |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `shoots`        | `shoot`: `name`, `description`, `ordering`, `parent_id`. `shoot.folder`: `folder_path`. `shoot.hidden`: `is_hidden`. Each on its own stamp                                          | `folder_dev`, `folder_ino`, `folder_birthtime` (disk identity is per-disk)                                                                                                                          |
| `folder_rules`  | one stamp per row                                                                                                                                                                   | none                                                                                                                                                                                                |
| `shoot_banners` | one stamp per row                                                                                                                                                                   | none                                                                                                                                                                                                |
| `libraries`     | one stamp over `name`, `ordering`, `include_subfolders`, `bin_name`, `auto_stack`, `auto_stack_similarity`, `auto_stack_window_seconds`                                             | `root_path`, `read_only`, `bin_dev/ino/birthtime`, `last_synced_at`, `rendition_source`, `rendition_hdr` (what to build is a per-device choice; a laptop may build SDR where the server builds HDR) |
| `labels`        | `label`: `name`, `colour`. `label.position`: `position`. Each on its own stamp, so a reorder, which rewrites every label's position at once, cannot clobber a rename made elsewhere | none                                                                                                                                                                                                |
| `photo_labels`  | one stamp per row, like `stack_members`: the row _is_ the labelling, and a removal is a tombstone                                                                                   | none                                                                                                                                                                                                |
| `settings`      | not replicated: per-install (HDR viewing on a device that can't, backup schedule)                                                                                                   | everything                                                                                                                                                                                          |

Albums (`albums`, `album_photos`, `album_banners`) are not replicated at all (§1).

`bin_name` replicates; each peer replays the folder rename locally on merge (§7.7 for what
happens when the replay cannot run).

**Give `folder_path` its own unit (§3).** The scan follows disk renames (§9.4.1); people change labels
and ordering. Collision resolution (§5.6) must not re-stamp those controls too: a third peer's
in-flight label rename would look stale, be claimed and silently overwritten everywhere. This is
the same hazard requiring separate `bin` and `placement` units.

`is_hidden` is split off for the same reason: on one stamp, a folder rename would assert a hidden
flag decided now and clobber a hide - or an unhide - made on another peer while they were apart.

**Store one row's flag; derive subtree visibility** (DESIGN §12.4). Copying it to descendants
leaves wrong bits when shoots move into or out of hidden subtrees, even with separate stamps.
Derived visibility makes rename and hide independent: arrival order cannot change the answer.

### 3.3 Stacks

Membership must replicate as **rows**, not as a per-photo pointer. With `stack_id` LWW alone,
the losing side's memberships vanish during merge before the collapse rule can see the overlap,
so the union rule ("largest set survives under the latest stack") would be unimplementable:
converged per-photo LWW can only yield "newest stacking wins, stragglers unstack".

```sql
CREATE TABLE stack_members (
  library_id TEXT NOT NULL,
  stack_id   TEXT NOT NULL,
  photo_id   TEXT NOT NULL,
  -- Nullable like every stamp column: NULL is a unit no peer has had an opinion
  -- about yet, which is every row until pairing walks the library (§4).
  stamp      TEXT,
  PRIMARY KEY (library_id, stack_id, photo_id)
);
```

Per-row LWW plus tombstones. The `stacks` row carries a replicated, immutable `created_stamp`
(its LWW stamp moves on other writes; "latest-created" must not). After merge, converged state
may show a photo in two live stacks; the collapse is a **pure function of converged state**,
run identically by every peer's repair pass: stacks with intersecting membership merge (members
move under the stack with the highest `created_stamp`, via deterministic derived writes, §5.4),
stacks left with fewer than two members dissolve.

**Keep `photos.stack_id` as a materialised derivation of `stack_members`.** The hot listing
filter (`photo_query.ts`) short-circuits the unstacked majority on `stack_id IS NULL` in the
row already read. A join adds a b-tree probe per visited row, including deep OFFSET skips:
hundreds of thousands per block, the regression in DESIGN.md §4.2. SQLite views merely expand
the join and cannot replace a column in the covering index.

**One membership writer owns both.** Every `stack_members` write updates `photos.stack_id`
transactionally, falling back to remaining membership on removal. Repositories, merge and repair
must call that writer; none may mutate table or column directly. The derived column is never
replicated or diffed. Repair recomputes `is_representative` through its existing choice logic.

### 3.4 Edits

`photo_edits` replicates whole (doc, history, cursor, session lineage) under session semantics
(§5.3). `rev` stays local (per-replica optimistic-lock token for tab-vs-tab; bumped on merge so
an open editor 409s instead of overwriting merged state). `photo_edit_history` travels with its
row, always whole, never delta-spliced.

### 3.5 Tombstones

Hard-deleted rows leave `(entity, id, stamp)`. Sources: shoot deleted, stack dissolved, stack
membership removed, folder rule removed, shoot banner cleared, photo rows removed by taking a
folder out of the library (catalogue rows only, no file touched), blob location retracted
(§7.2), label deleted, label taken off a photo. Merge in §5.1, GC in §8.3.

A label's tombstone is final, like a photograph's and a shoot's: its deletion took every
photograph's copy of it, so a rename arriving afterwards would bring back a label on nothing.

Removing a **replica** is not a deletion of the library: unlinking drops local rows and writes
no entity tombstones. It does have replicated final acts and safety checks, §8.4. Deleting the
library everywhere is a separate, explicit, loudly-confirmed action that replicates a library
tombstone.

## 4. Change tracking

A write to a replicated unit sets that unit's stamp column, and the database turns that into
one row of the log:

```sql
CREATE TABLE replication_log (
  library_id  TEXT NOT NULL,
  entity      TEXT NOT NULL,   -- 'photo.triage', 'stack_member', 'shoot', ...
  row_id      TEXT NOT NULL,   -- unit primary key (composite keys joined)
  stamp       TEXT NOT NULL,
  deleted     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (library_id, entity, row_id)
);
CREATE INDEX idx_replication_log_stamp ON replication_log(library_id, stamp);
```

One row per live unit, overwritten on every write: state-based, never larger than the
catalogue, never compacted. "Everything since vector V" is one index range scan. Tombstones are
rows in the same log. The log is derivable from the stamped tables (rebuildable by full scan);
it is an index, not a second truth.

**Triggers maintain the log.** Around forty repository write sites know only photo id;
manual logging would thread library identity through every signature. Stamp-column triggers
already have `NEW.library_id` and cannot miss a stamp change. Write sites owe one rule:
stamp the unit whenever writing its columns.

**Triggers skip logging nonreplicated libraries.** Write sites still set stamps because they
cannot cheaply determine participation; omitting log rows avoids replication write amplification
for catalogues nobody syncs.

Pre-replication rows have stamps only on recently written units and no log. Pairing (§9) assigns
one genesis stamp to unstamped units and builds the log from all stamps. Defer this rebuild
until pairing; migration would rewrite every catalogue for a feature most never enable.

Two stragglers sit inside the boundary: choosing a stack's representative, which is part of
`StackMembership` rather than a bare function over `db` shared by two repositories, and any
future migration that writes replicated columns, which stamps what it writes.

## 5. Merge rules

All merges are per unit, newest stamp wins, byte-compared; the peer_id inside the stamp breaks
exact ties deterministically. The exceptions and mechanics:

### 5.1 Tombstone vs write

Newer stamp wins: a delete after a write removes the row. Whether a write after a delete brings
it back depends on what the delete meant.

**Photo and shoot tombstones are final.** Their only hard-delete path is folder removal (§4.7),
which writes the folder rule transactionally. A late rating is work in a departed folder, not a
request to restore it; repair would remove a resurrected row again. Readmitted folders import
**new photographs with new ids**, no ratings, verdicts or edits; merge need not resurrect them.

Finality also closes a convergence hole: resurrection supplies the sender's possibly older
copies of units the receiver destroyed. Erasing the grave then removes any way to settle those
differences. A final tombstone persists, travels and wins everywhere.

**A stack's tombstone is not final**, and stacks are the only rows this applies to: dissolving
one is a statement about the stack alone, with no folder rule behind it, so a later write to it
is somebody saying the more recent thing. Exact tie: tombstone wins.

**Tombstone FK-cascaded rows with locally minted stamps.** SQLite otherwise removes banners
and memberships without a deletion record; peers interpret absence as unseen state and resend.

The parent's stamp would yield identical tombstones but can be **undeliverable**. Each peer
buries only children it holds; another origin's stamp cannot reach peers already covering that
origin. Concurrent membership creation and photo deletion can therefore leave the membership
alive on its creator and buried elsewhere forever. Three peers and a resurrection expose it.

Minting locally makes it an ordinary write and it travels like one. Peers do then disagree about
_when_ a child died, each having stamped its own, but those tombstones replicate like any other
row and the log keeps the newest - so the threshold a later write must beat to bring the child
back converges too. The cost, accepted deliberately and unchanged: a photograph brought back by
a later write elsewhere comes back without its memberships, its banner or its edits.

**Resurrection removes the entity tombstone.** Otherwise live-unit entries coexist with a grave,
the log streams the grave, and the receiver deletes the row being restored.

**Never claim discarded changes.** SQLite refuses references to deleted parents. Cap that
origin's vector below the unapplied stamp so it retries; usually the deletion reaches the sender
before then. Advancing past it silently loses rows between peers claiming agreement.

**The one exception is a change no peer could ever take.** A composite row id is joined with a
slash, so an id carrying one of its own splits into more parts than the key has - and both the
side building a page and the side applying one take it apart in the same place. Left unclaimed it
returns every session and refuses the page it arrives in, which is that library not replicating in
either direction, permanently, over a row that names nothing on any device. So the holder does not
send it and a receiver drops it, claimed at both ends. The row itself stays where it is: a parked
conflict with such an id is one each device's reader has to resolve on that device, because the
resolution cannot travel either.

**A photograph's removal takes edits made after it, and cannot do otherwise.** Folder removed on
one peer, photo edited meanwhile on another: the edit is newer than the tombstone and it still
goes. There is nowhere to keep it. `photo_edits` and `edit_conflicts` both hang off the
photograph by a foreign key, so any parking the cascade would reach anyway; the photo row cannot
stay either, its folder being out of the library and its tombstone final; and if the folder is
ever let back in, the scan imports its files as new photographs with new ids, which an old
edit could not attach to. What the merge refuses to do is lose it _quietly_: an edit newer than
the deletion that removes it is logged, naming the photograph, so a backup can still be gone
through.

### 5.2 Stacks

All via `stack_members` rows plus the collapse in the repair pass (§3.3, §5.5). No merge-time
special case: LWW on rows, then a function of the converged state.

The collapse is the rule a photographer asked for. Two peers stacking overlapping sets leave a
photograph in two stacks at once, which the app has no meaning for, so the stacks that share a
photograph become one: the survivor is the one **created last**, and the members of the others
**move to it** rather than being orphaned - `[a,b,c]` on one peer and `[a,b]` on another end as
`[a,b,c]` on both. Stacks chained by different photographs collapse together, three at a time if
that is how they overlap.

**Dissolve stacks left below two members by any removal**, local or merged. Two peers removing
different members from a three-member stack each retain two until sync combines removals;
both then dissolve it.

**Evaluate removals only at session close.** Three earlier attempts evaluated partial state:
stamp-ordered pages can deliver removals before additions, dissolving a stack and refusing its
later members while the sender keeps it. Close sees the complete stream. Consider only stacks
with membership graves; a small stack still awaiting members has none.

What it writes is an ordinary tombstone under the dissolving peer's own origin - not derived
from anything - which is what lets it reach the peer whose removal was the other half of the
story. A derived stamp would carry that peer's origin and be undeliverable to it, which is the
trap §5.1 describes and which two of those earlier attempts fell into.

Collapse writes are stamped **where they run**, never from the survivor. Another origin's
stamp cannot reach that origin, whose self-coverage is total (§5.1). Local writes travel;
exchanging tombstones reconciles differing collapse times.

#### 5.2.1 Labels named alike

Two devices creating a label of one name while apart cannot refuse each other, so each keeps its
own until they meet. At the close of a session (`mergeLabelsNamedAlike`), labels of a library
sharing a name, ignoring case, become one: the survivor is the one whose `label` unit (name and
colour) was **set last**, so it keeps its name, colour and place, and the others' photos **move to
it**. The losers are deleted with final tombstones, stamped where the merge ran, as the stack
collapse's are.

At the close and not per page for the reason the stack rule is: mid-session a loser's photos may
still be on their way, and they would land on a label already buried here. A loser's tombstone
arriving at a peer that holds its twin moves that peer's photos across before the cascade, so a
label put on a photo in the window between one device merging and another hearing of it is kept.
A photo somebody took the survivor off after the loser was put on it is not moved.

A tombstone does not say whether it was a merge or somebody deleting the label, and the move
treats both alike: a label deleted on one device while another held a twin it had never seen
leaves its photos on the twin. Had the two devices met first, the merge would have put them there
anyway.

Names are compared with a locale-independent lower-casing (`toLowerCase`), never SQL's `lower`,
which folds ASCII only, nor a locale-aware one, whose answer would differ between devices.

### 5.3 Edits: sessions, and the one user-facing conflict

An editor open starts a **session** with random 16-char `session_id`, reused until close.
`photo_edits` stores current `session_id`, stamp and **full lineage chain** of
`(session_id, stamp)` hops to the root, appended per open. One parent hop would misclassify
linear multi-session edits as conflicts: the latest-state log routinely skips intermediate sessions.

Merge, given local row L and incoming row I:

- I applies silently iff L's `(session_id, stamp)` appears in I's chain with stamp ≥ L's stamp
  (I descends from L's exact state or a later save of L's session).
- L wins silently iff I's `(session_id, stamp)` appears in L's chain the same way.
- Neither: a real conflict, and the user decides. Both candidates land in `edit_conflicts`
  (photo_id, session_id, doc, history, cursor, chain, stamp, device name). The newest session
  becomes the provisional `photo_edits` row (replication never blocks on a human) and the photo
  is badged until resolved.

The stamp comparison inside the chain test is load-bearing: incoming session s2 parented on
`(s1, t3)` against local s1 last saved at t5 > t3 must conflict, or the t3→t5 saves are
silently clobbered.

A chain is capped at the newest `MAX_CHAIN_HOPS` hops, applied where one is read rather than
where one is built, so an overlong chain from a buggy peer is cut before it is stored or relayed
(§11.2). Pruning at the tombstone GC watermark (§8.3) would be the sharper rule and is not
implemented; what the fixed cap costs is a surfaced conflict for a peer stale past that many
session opens, never a silent clobber.

Resolution: the UI shows each candidate's last-edit time, edit count and device, over the
picture as currently stored - the same on both cards. A thumbnail rendered from each candidate's
own doc is the better answer and is not built: it needs the original, which a replica holding no
RAWs does not have (§7.9), so the two would differ on one device and not the other. Because
edits may have continued on the provisional
winner since the conflict formed, resolution branches from the **current** doc: picking a
candidate applies it as a new session parented on the current row, so nothing visible is
clobbered without appearing in the history. A resolution replicates as that new-session write
plus conflict-row tombstones; two concurrent resolutions re-conflict, correctly.

**Candidate holdings cannot converge.** A candidate's original edit stamp cannot stream back
to its origin, which already claims full self-coverage. Peers seeing both sides reconstruct them;
peers seeing only the winner have no conflict. Rendered documents and resolutions converge.
Candidate rows still replicate where deliverable, including to peers knowing neither side.

Accepted asymmetry, by design: a two-hour session loses _provisional rendering_ to a one-slider
tweak made later on another device; nothing is lost, both candidates sit in the conflict entry.

### 5.4 Derived writes happen only when the value differs

Repairs and collapses are machine writes. **A derived write happens only when the value actually
differs**, or repair churns forever: that half is absolute and every derived write obeys it.

The other half of the original design - that a derived write's stamp is a pure function of its
inputs, "the maximum input stamp with counter+1, peer_id taken from that maximum input stamp",
byte-identical on every peer - **cannot be built, and both ways of trying it fail.**

Taking the _origin_ from the input makes the write undeliverable. A peer's coverage of its own
origin is total by construction, so a row carrying peer A's id is never selected to send to A -
the trap behind several of this engine's worst divergences (§5.1). Derived writes therefore mint
under the origin of whoever ran them, and two peers computing the same repair produce stamps
differing in the tail. They still converge, because LWW settles it and both are deliverable.

Taking only the _time_ from the inputs, under a local origin, looks like the way out and is
worse, because it fails silently. A version vector's promise is "everything this origin wrote
below this stamp is applied here", and that holds only because nothing a peer mints ever sorts
below something it has already minted. A stamp placed in the past under this peer's own origin is
one a receiver advances its vector straight past, having never been sent it, and never is again.
Measured rather than argued: the collapse stamped this way diverged 2 seeds in 1500 - a stack
alive on one peer and buried on another, the grave sitting below the receiver's coverage.

So **a derived write is stamped where it ran**, and the consequence is faced rather than
engineered away: it outranks a deliberate action made before it that has not arrived yet. Where
that matters, the repair _asks_ instead of relying on the ordering - `collapseOverlappingStacks`
checks for a grave on the winning stack before moving a membership into it, because a photograph
somebody took out of a stack must not be put back by machine work (§3.3).

`clock.test.ts` pins monotonicity; `converge.test.ts` pins the grave check. Both guard against
the already-attempted regression toward the original design.

### 5.5 Repair pass

After every apply batch, deterministic, same code and order on every peer, all writes per §5.4:

- `shoot_id` pointing at a shoot this peer has _buried_ → unassign (photo keeps its path). Absent
  is not buried: a page is stamp-ordered and only the page is sorted parents-first, so a shoot
  written after its photographs were placed arrives after them, and reading "not here yet" as a
  deletion strips the membership of every photograph in it for good - the write succeeds, so the
  stamp is claimed and the shoot lands with nothing left to attach. Handed on untouched, the
  foreign key refuses it and the change defers, which is what deferral is for.
- Stack collapse and dissolve (§3.3); `photos.stack_id` and `is_representative` recomputed as
  local derivations.
- `stack_members` rows of a tombstoned stack older than the tombstone → removed (normally
  already handled by the cascade, §5.1; the repair is the idempotent backstop).
- `folder_rules` row contradicting a live shoot at the same path → newer stamp wins.
- Shoot banner pointing at a tombstoned photo → cleared (falls back to first-photo default).
- `shoot_id` re-derived from the path-prefix rule where `placement` and shoot rows converged
  from different peers.

### 5.6 Duplicate imports and path collisions

Same RAW imported on two peers = two photos, kept (dedup tool later). Two _different_ photos
converging onto one path: the newer `placement` stamp keeps the path; the older is
flagged for the user to resolve (rename/move). This flag is a **new user-facing surface**
(nothing like it exists today; the current importer silently suffixes filenames), it is
per-peer derived state, not replicated, and materialisation's matching rule is in §7.7.

**Two shoots claiming one folder: the earlier rename keeps it.** `shoots` is unique on
`(library_id, folder_path)`, and the reachable way to reach that constraint is two peers each
renaming a _different_ folder to the same name while apart - which needs only a folder rename on
each disk, not a tree both scanned independently. The rename that came first is the one that
already stood when the second was made, so it keeps the folder and the second goes back where it
was.

Both peers reach the same verdict because both compare the same pair of stamps - the arriving
shoot's `shoot` unit against the one already sitting on the folder - and a stamp carries the peer
that minted it, so there are no ties. Which side of the comparison each peer is on differs; the
answer does not.

A stamp of exactly equal value is not hypothetical - `relocate` stamps a shoot and its whole subtree
with one value, so two rows can carry the same one - and there the **id** breaks it, being the only
thing left both peers read the same way. A tie broken differently on each side is two peers each
keeping their own rename for ever.

**The loser yields, and every peer can always make it.** Whichever rename came later gives the folder
up: the arriving one by not being written, or the one already sitting there by being moved off. The
first keeps what this peer holds, re-asserted under a fresh stamp, and everything else the unit
carried still lands - a name changed in the same breath as the folder was not what was contested.

The second cannot go back where it came from, because the peer applying the winning rename is the one
peer that _cannot_ say where the loser was: that is the other peer's row. So it takes the contested
name suffixed - `Contested_2`, counting past whatever suffixes are already spent - under a stamp of
its own, which is what carries it to the peer that made the losing rename. The same fallback covers a
re-assertion whose own folder has since been taken, and a shoot holding the folder with **no stamp at
all** (what a payload carrying no `shoot` unit inserts, the folder coming off the identity columns):
no peer has been told where that one sits, so it has the weaker claim and it is the row that moves.

So in practice the loser usually ends at the suffix rather than at its original name, because the
suffix is written by the peer that resolves first. Both peers agree on it either way, which is the
property that matters; which of the two names it settles on is whichever assertion carries the later
stamp. Nothing invents a path a peer does not have: a suffix of a name it does hold is a folder it can
make, and the scan relocates a shoot by inode regardless (§9.4.1), so the name only has to be free and
stable rather than a description of any particular disk.

A shoot this peer does not have by key collides on the **insert** instead, and that one is still only
a deferral: `ON CONFLICT DO NOTHING` plus a zero-row check. The update path reads its failure through
`isUniqueCollision`, deliberately consulted at that one write rather than folded into
`isMissingReference` - a unique index is also how this catalogue states invariants it wants to hear
about loudly (`idx_photos_one_representative`), and a blanket "unique failures are deferrals" would
turn the next of those into a page quietly arriving again for ever. A collision it cannot name at all

- some other constraint, or a folder that turns out to be free - is deferred rather than guessed at.

What neither path may do is throw. The page would be refused, and because it is refused nothing in
it is claimed - so it arrives again next session and throws again, in both directions, for good. One
contested folder name would stop that library replicating anything at all, and what is in those
pages is photographs. `collisions.test.ts` pins the resolution both ways round, the suffix counting
past what is already spent, and that the rest of the page lands regardless; the convergence walk
renames folders too, drawing targets from a set both shoots share so seeds meet the collision on
their own.

## 6. Protocol

### 6.1 Version vectors

Each replica keeps **one coverage vector per library**, not per pair: each origin peer_id maps
to the highest stamp through which _all_ its writes have applied. Cached remote vectors serve
UI only. Stamps encode origin without extra bookkeeping. Vectors, log, HLC state and pairing
records live **inside the catalogue**, rewinding atomically with restored data (§8.2).

### 6.2 Session

Either side initiates; the flow is symmetric. One session between two peers covers every
library both replicate.

1. **Handshake**: protocol version (stamp widths included), app schema version, which way the
   rows go, the shared library ids, rw check, both clocks (skew guard), both coverage vectors.
   Rows only ever go from a schema to the same or a newer one (§8.5); a direction that cannot is
   refused with "update the app", never half-understood.
2. **Stream**: each sender opens a **stable read snapshot** and streams, per library, every
   unit the receiver's vector lacks, in stamp order, in pages. The sender's claimed coverage is
   its own vector joined with its own clock, **as of that snapshot**.
3. **Apply**: each page applies in one transaction: receive-time stamp guard (§2.2), payload
   validation (§11.2), merge rules, repair, and the materialisation queue append (§7.4). Pages
   are idempotent; re-applying is a no-op.
4. **Close**: the receiver's durable vector for each library advances **only at session
   close**, atomically with the final page, to the elementwise max of itself and the sender's
   claimed coverage, and never past the sender's own coverage for any origin.

Close-only capped advancement prevents permanent loss from overclaiming origins the sender
lacks or skipping units overwritten behind a page watermark. Resume through a **session cursor**
keyed to the sender's snapshot. If that snapshot expired, restart from the unchanged durable
vector; idempotent apply makes repeated pages harmless.

Catalogue replication runs automatically whenever a peer is reachable, and on demand. Asset
transfer never rides along (§7).

### 6.3 Locks

Replication apply and materialisation take the library's scan lease (`sync_locks`, refreshed
per page) **and** `libraryMutex`, in that order, the same discipline the scan itself uses: the
lease serialises against the scan, the mutex against user mutations that move files. §7.4 for
the drain rule that spans the two subsystems.

### 6.4 Transport

The server peer listens over HTTP(S): replication endpoints under the existing API. The macbook
initiates outbound from its sidecar (page → Tauri bridge → sidecar → outbound HTTP), so a
laptop behind NAT needs nothing open. Consequence, stated because the UI must reflect it:
**fetch works only from peers that listen**. The server cannot pull from the laptop; originals
reach the server because the laptop pushes.

### 6.5 Pairing and peer lifecycle

Pairing **records which devices sync each library**; it is not authentication (§11.1).
The joiner lists libraries (§9.1), selects one, registers peer_id/name and links it. No secrets
are exchanged or stored. Request peer_id identifies ownership of opinions and coverage,
never caller authority.

- **Peer list**: the server's settings show every paired peer: name, last replicated, holdings
  summary. Rename; **forget** (§8.4: unregister, retract the peer's blob claims, drop it from
  the GC floor). A forgotten peer that returns is refused and re-pairs fresh (§2.1), arriving
  as a clone.
- Re-pairing is a fresh pairing: new peer_id.

## 7. Originals (blobs)

### 7.1 Integrity: a content hash, which does not exist yet

The existing `file_hash` is a SHA-1 over stat metadata (`ext|width|height|mtime|colorspace|
filesize|orientation`), mtime included: it identifies "this file on this disk hasn't changed",
which is the scan's question, and it **cannot** verify a transfer or match bytes across
machines. It moves to the per-peer list (§3.1) beside `date_updated`, exactly as local as
they are. Replicating it would ping-pong: each peer's scan would see its local mtime disagree,
re-stamp, and fight forever.

Transfers are verified by a new `content_hash`: BLAKE3 (or SHA-256) over the file's bytes.
Nothing else needs it, and nothing waits for it: photos are addressed by id everywhere,
`blob_locations` included, so catalogue rows replicate hash-less the moment they exist, and a
library that never replicates never hashes anything. The hash exists exactly from the moment
bytes first move: **the sending peer of a photo's first transfer computes it while streaming**
(no extra read), stores it, and stamps it into the `imported` unit as an ordinary replicated
write; the receiver verifies the download against it and discards on mismatch. Every later
transfer of that photo verifies against the recorded value, which also catches a holder whose
copy has rotted since.

Trade: first-share bytes establish integrity, so earlier corruption becomes canonical.
Import-time integrity is not claimed; adding it would populate this same column earlier.

The eviction spot-check (§7.6) stays consistent for free: a photo never transferred has no
second holder, so eviction already refuses it as the sole copy; once transferred, the hash
exists.

### 7.2 Locations

```sql
CREATE TABLE blob_locations (
  library_id TEXT NOT NULL,
  photo_id   TEXT NOT NULL,
  peer_id    TEXT NOT NULL,
  stamp      TEXT NOT NULL,
  PRIMARY KEY (library_id, photo_id, peer_id)
);
```

Replicate locations with per-row LWW and retraction tombstones. They identify **fetch sources**
and awaiting-originals counts, never **eviction safety**: stale mutual claims could let two peers
delete the last copies concurrently. Every eviction, including v1 manual eviction, needs live
verified possession from another peer (§7.6).

Ordering: a peer records its own location row only **after** the blob is verified and renamed
into the tree, never before. The scan reconciles the self-row: asserts it where a verified blob
exists, retracts it (tombstone) where the file has verifiably gone (deleted out-of-band), so
the table self-heals.

### 7.3 Transfer

Explicit, both directions where topology allows (§6.4): pressed for, or queued by a session in a
library set to send and fetch originals (§10), which asks for the same library-wide diff in each
direction the two sides' §7.10 answers allow. **Push is defined as a diff, not a selection of
files**: "send originals <peer> lacks", scoped to a selection, a shoot, or the library, computed
from `blob_locations`. That makes it idempotent (restart recovery is
pressing it again), makes partial completion a number rather than a mystery, and gives the
replication strip its headline ("Macbook holds 2,000 originals Home server lacks"). The queue
survives app restart and laptop sleep; per-item progress, pause, resume; ranged GET,
`content_hash`-verified, staged to a temp file **on the same filesystem as the library root**
(or the rename is a copy and §8.1's atomicity claim is false) and renamed into the tree.

### 7.4 Materialisation

The catalogue specifies the tree. Materialise held blobs **and every shoot folder**, even
without blobs. Otherwise scans interpret missing folders as user-deleted shoots and propagate
tombstones. Cheap folders also keep offline trees browsable.

**Write the durable materialisation queue transactionally with page apply.** Each merged unit
adds its pending move, bin transition or folder create/rename. Without this queue, unfinished
disk work resembles a user reversal: scans would re-stamp and replicate it, undoing renames or
un-binning partial batches after a crash. Therefore:

- The scan lease spans apply **and** drain (§6.3); a scan acquiring the lease **drains the
  pending queue first** (idempotent: entries already satisfied on disk are skipped) before it
  may conclude any removal, move, or bin crossing.
- Backstop: the scan refuses to re-stamp a `placement`/`bin` unit whose current stamp is
  remote-origin and newer than the local materialisation watermark; such rows surface as
  "pending materialisation" instead of being adopted as disk truth.
- Queue entries execute against the row's **current** merged state at drain time (a rename
  merged mid-queue retargets the entry), with `mkdir -p` as needed.
- A file the editor holds open (EBUSY on Windows) retries; the entry stays queued.

Materialisation uses extracted disk primitives from bin/restore/shoot-move, **without
re-stamping merged rows**. Local actions retain move-plus-write services; remote state drives
only their disk half.

### 7.5 On-demand fetch on open

Opening a photo whose original is not local streams it from a peer that has it, with visible
progress, a size hint, and a cancel (an accidental open on hotel wifi must not cost 50MB), and
**keeps it**: staged, verified, materialised at the row's current path (bin path if it
is binned by then), location row recorded after the rename. The next open is a plain local
open. This is the one transfer needing no explicit transfer action: opening the photo is the
user asking for it.

### 7.6 Manual eviction ("Remove local copy")

V1 ships one eviction: a bulk "remove local copy (kept on <peer>)" action. It requires a live
confirmation from a listening peer that verifies possession at that moment (existence plus
spot-check of `content_hash`), deletes the local file, tombstones the local location row. If no
peer confirms, it refuses. Policy eviction later reuses exactly this rule.

Refuse per photograph; report both successes and failures. Like other bulk routes (§12.3), use
`PhotoTarget` positions in a filtered collection, keeping hundred-thousand-photo selections one
small request rather than round-tripping every id.

### 7.7 Disk collision and portability rules

Materialisation and fetch never overwrite and never suffix; `moveIntoDir`'s suffix loop is for
imports, and a suffixed materialisation would diverge from the replicated path and then
replicate the accident. On any occupied target (tracked or not: an unscanned file is still the
user's file), the entry is skipped and flagged with the §5.6 surface.

- Collision detection compares paths **case-folded and Unicode-normalised** (macOS folds case
  and returns NFD where the server minted NFC; without this, every materialised path scans back
  as "moved" and churns re-stamps forever). Case-only renames use a two-step rename on
  case-insensitive filesystems.
- A path illegal on the local filesystem (Windows reserved names, trailing dots) skips and
  flags that row; the batch continues.
- A replicated `bin_name` whose local replay cannot run (folder moved by hand, name illegal
  locally) **parks as pending**: the bin channel skips both walks and the §9.4.1 rename-follow
  is suppressed until resolved, because the alternative is the scan re-importing the entire old
  bin as live photos or a fresh stamp reverting the user's rename globally.

### 7.8 Pipeline hand-off

An arriving original (push or fetch) sets `needs_tile`/`needs_renditions`, so placeholders heal
into thumbnails without a manual rescan. This is the server's post-trip behaviour: catalogue
arrives, grid shows badged placeholders naming the holding peer, originals arrive, renditions
build.

### 7.9 Fetch-through: a device with no originals still shows pictures

A peer holding the catalogue and none of the RAWs has nothing to draw from - every tile and
every rendition is built out of an original - and fetching whole originals to fill a grid is the
one thing the manual-assets rule (§7.3) exists to prevent. So a _rendition_ is itself something a
peer can serve: the holder renders `full` or `max` on request if it has no current copy, at the
dynamic range the asking device shows, and lifts the camera JPEG out of the original for
`embedded`. The asking side verifies the bytes against a hash the sender computed over them, and
caches the result at exactly the path its own pipeline would have written. Everything downstream -
the staleness rule, the URL versioning, the startup sweep - then reads a fetched copy as a built
one. The grid tile is the exception: the holder builds it at import and rebuilds it from its
queue, and serves only what that has made.

Devices unable to build or serve a copy forward and cache it, allowing multi-hop originals.
`X-Bowerbird-Via` records visited devices; never revisit them. Forwarded requests must not join
in-flight fetches, which may themselves await the requesting device.

Both sides use one freshness predicate. Holders reject copies behind their edits; callers check
`X-Rendition-Built-From` against their own potentially newer edit stamp. If no peer can supply
current pixels, retain a cached stale picture and retry next request. With no cache, accept an
older holder copy but record its actual build stamp so it remains owed.

A reader's rebuild on a device that cannot build asks with `force=1`, which the holder renders
again past its own copy, and which a device passing the request on passes on past its cached one.
A fetched copy that replaces one already on disk is announced to clients as a build is, so their
URLs for it move; a first fetch is not, being on its way to whoever asked.

**Freshness uses edit stamps, never wall-clock build times.** Edits and renders may occur on
different peers. A minute-slow clock can permanently hide an edit; a minute-fast one rejects
correct renders. Both fit within §2.2's tolerated hour. `built_from` stores each variant's
rendered `photo_edits` stamp under `renditionVariant` - `grid`, `full`, `full-hdr`, `max`,
`max-hdr`. `renditions_built_at` and `tile_built_at` version image URLs only, never freshness.

`linkLibrary` backfills only the two variants a build time is evidence for: `grid` from
`tile_built_at`, and the range the library builds from `renditions_built_at`. A `max`, or the
range the library does not build, is written at a moment neither column records, so pairing
leaves it unstamped - which reads as owed, and is the safe direction.

**Fetching the whole original to build locally is never done here.** That is the explicit §7.5
action, and walking a device into a 50MB transfer over a missing thumbnail is exactly the
accident the fall-back order exists to rule out.

These renditions are the only files in the catalogue's data directory that are neither
rebuildable nor bounded: the pipeline's own can be made again from the RAW beside them, and the
orphan sweep takes them when the photograph goes, but a fetched one has neither property and
nothing except browsing decides how many there are. So they are a cache with a cache's rules - a
per-library byte cap, least-recently-used evicted first, "used" meaning served. A device that
scrolls a decade of photographs gives back the ones it scrolled past first.

### 7.10 "Keep originals on this device"

Per replica, chosen when it is created and changeable afterwards. Off, the device holds the
catalogue and lives on §7.9's renditions: everything is browsable, sortable, cullable and
rateable, and none of it costs a 50MB transfer. This is what makes a phone a peer, and it is the
same setting on a laptop that wants the library without the terabyte. Every picture such a device
shows comes from a peer, the camera JPEG and a panorama's included, until an original is fetched
here by hand: from then on that photo is built here, as on a device that keeps its originals.

**Keep this setting local.** One device's storage policy must not overwrite another's.

**The refusal that counts is the receiving peer's**, taken before a byte is staged: an incoming
push and a bulk fetch are both refused where the setting is off. The handshake carries each
side's answer so neither offers what the other would refuse - and that is advisory only, because
it is minutes old by the time a transfer starts. A peer on a build that does not send it reads
as wanting originals, which is what every peer did before the setting existed.

Turning it off also cancels what is still queued to arrive, or the queue goes on delivering
exactly what was just turned off.

Turning it off retains existing originals (§7.6 frees them), allows outgoing transfers and
still permits §7.5 manual single fetches for occasional editing.

## 8. Failure modes and hygiene

### 8.1 Crash safety

Apply is transactional per page; the durable vector moves only at session close, atomically
with the final page; the materialisation queue is written with the pages it derives from and
drains idempotently; blob staging is temp-plus-rename on one filesystem. Every crash window
lands in a state the next session, drain, or scan resolves without minting wrong stamps (§7.4).

### 8.2 Backup restore on a replicated peer

Replication changes DESIGN.md §4.9 restore semantics: automatic catch-up would silently reapply
the writes being undone. External vectors would instead overclaim restored state, preventing
refetch forever and causing silent divergence.

So: vectors, log, HLC state, and pairing live inside the catalogue (§6.1), rewound atomically by
restore. That is the half that keeps convergence - a vector living outside the catalogue would
over-claim after a rewind and the gap would never be re-fetched.

**Restore preserves restored values.** Re-stamp every replicated row with one fresh stamp so
the restore becomes the newest write, rather than being undone by sync ten minutes later.

Mint **above the pre-restore clock** from the replaced catalogue, not the snapshot log.
Otherwise peers' intervening stamps win, and a rewound clock might reuse a stamp for another
write, violating idempotence.

**Re-stamping is not deleting.** Rows the peers hold and the backup does not - photographs
imported since - arrive on the next session and are kept. The restore is a statement about the
values it holds, not a claim that nothing has happened since; rolling a catalogue back a week
should not discard a card imported on Tuesday.

**Prepare everything before swap.** Vacuum the snapshot into a sibling staged file, migrate
and re-stamp there, then rename. Old-backup migration, mint-guard refusal (§2.2) or disk-full
failure leaves the live catalogue unchanged; report and retry normally.

Done the other way round, each of those is instead a failure reported over a catalogue that is in
fact restored, and leaves a window in which the restored rows sit at stamps the peers have already
passed. That window is what needed a marker file beside the catalogue, a walk deferred to the next
start, a rule about which spelling of a symlinked path the marker is named by, and a refusal on
every session in both directions while one was pending. None of it exists, because the state it
described cannot occur.

### 8.3 Tombstone GC

**By acknowledgement, not by age.** A tombstone may be dropped only once every known peer's
vector has passed it (the GC floor = elementwise min over peers' vectors). Age-based GC on a
long-offline peer reaps that peer's own never-replicated deletions, which then resurrect
everywhere on reconnect; age-based GC anywhere risks resurrecting edited-then-deleted rows
through any heuristic patch.

The wall-clock horizon applies to **peers**: a peer silent past the horizon is surfaced in the
UI ("Macbook has not replicated in 97 days and is holding up cleanup"), and the user may
**forget** it (§6.5), removing it from the GC floor. A forgotten peer that returns is refused
and re-pairs fresh, arriving as a clone, which is the full-reconcile path and cannot resurrect
anything.

### 8.4 Unlink, and the truthfulness of blob claims

Unlinking a replica (and the server-side **forget** for a peer that cannot run its own unlink)
must not leave permanent lies behind:

- Final replicated act: tombstone the departing peer's own `blob_locations` rows. These are
  facts about the departing peer, exempt from "unlink writes no tombstones" (§3.5), or every
  remaining peer forever believes a dead laptop still holds the trip.
- **Sole-holder check**: blobs whose only recorded holder is the departing peer are enumerated
  first: "these N originals exist nowhere else", with push-first as the offered exit. Same bar
  for unreplicated catalogue work (local log tail beyond every known remote vector): warn
  before it is discarded.
- Forget additionally unregisters the peer and drops it from the GC floor (§8.3).

### 8.5 Version skew

Two devices a migration apart still sync, one way. An older build's rows merge into a newer
catalogue: a column or a unit the sender has never heard of is absent from its payload, and apply
keeps this peer's own value for anything absent, on insert and update alike. The reverse cannot
work - a unit kind the older build has no table for fails its whole page - so a newer peer never
sends to an older one. A laptop updated before the server it syncs with therefore still receives
the server's work and keeps its own until the server is updated; a server updated first still
takes the laptop's. Nothing is skipped in either direction, so no vector ever claims a row it
lacks, and the first session after the update carries the rest.

Pictures are not catalogue and ignore all of this: renditions and originals move over the blob
routes (§7), which carry no version at all. A photograph edited on the side that cannot send is
shown from a peer's copy built before the edit, marked stale, until the edit reaches a device that
can rebuild it (§7.9).

Each peer records the build the other last named in a handshake, refused ones included, so both
ends say which device to update. A change an older build's rows cannot be merged under - a
column renamed, removed, or given a new meaning - is a breaking protocol change, as is any change
to stamp widths: it bumps the protocol version, and the handshake refuses both directions.

### 8.6 Visibility of failure

Replication that stops working must not be a timestamp buried in Settings. The library sidebar
badges: refused handshakes (skew, version, with the reason), last-replicated age beyond a
threshold, pending edit conflicts, peers holding up GC (§8.3), sole-holder warnings (§8.4).
Minimal status (last replicated per peer, last error) ships with the first replicating build
(milestone 3), not with the polish milestone; the offline laptop must not ship into a blind
window.

## 9. Replica creation

"Connect to another Bowerbird", alongside "Add library", takes the other device's address, lists what it
offers, and takes a local root for the one picked. It refuses a readonly library, creates the bin
folder with identity columns recorded (the same helper library creation uses, not the scan's
healing path), then clones: the ordinary stream from an empty vector, ids preserved verbatim. The
replica starts with zero blobs, everything remote-badged, and the user pulls what they want or
starts importing.

### 9.1 The flow

**Exchange web addresses.** Deployment exposes one web port; dev compose's loopback API is
reachable only through its proxy. Peer calls use the browser address, not the hidden API port.
Production similarly serves the client from bun so one published address answers both.

On the joining device: **"Connect to another Bowerbird"** is three steps. The address; the list of what
that device offers; then the folder, which the picker can create, and whether to keep originals
(§7.10) and automatically send and fetch originals. Both options start enabled and are independent.
Keeping originals controls whether this device receives them, automatic transfer controls whether
each session exchanges missing originals. The choices are saved when the replica is created,
before its first session. A replica that keeps originals queues a fetch of every original the
device it joined holds as soon as the catalogue has landed, including when automatic transfer is disabled.

**Pairing exchanges no credentials** (§11.1); trust comes from the network. Listing libraries
registers nothing on either side. Pair only on final add, together with cloning.

Validate local library absence, empty folder and writable root _before_ remote pairing.
If local work later fails, unpair (§8.4) so a nonexistent replica cannot block tombstone GC
(§8.3). Retract broadly, including uncertain pairings: a lost reply may hide a successful add.

**Serialise add per library across the network call.** Concurrent adds share the device peer id;
the loser could otherwise roll back the winner's upserted pairing. No existing local library
can await this lock before commit.

**The local folder must be new or empty**, checked on the server rather than in the dialog.
Anything already there is imported as this library's own, which then replicates to every other
peer as photographs that appeared on their disks.

Browsing warns, without blocking, when wall clocks differ by minutes. This gives users time
to fix NTP before skew reaches the session refusal (§2.2).

**Pairing requires the server reachable, so the replica must exist before the trip.** A
standalone library created on the road can never become a replica (§1). Settings puts "Add
library" and "Connect to another Bowerbird" side by side so the fork is visible at the moment it matters,
and this sentence is the one that belongs in the user docs in bold.

## 10. UI

- **Device sync strip** per synced library: per-device last sync, in-flight state,
  awaiting-originals counts in both directions, and errors. What is moving - a session, fetches,
  sends, a backup pass - is also said on the library's own status line beside its scan, and
  "Sync library to other devices" is a library job.
- **"Automatically send and fetch originals"** per library, enabled by default when connecting
  to another device. Every session that reaches a device also queues the originals either side
  lacks, in each direction the two sides' §7.10 answers allow.
- **Transfer manager**: the persistent queue: per-item progress, pause/resume/cancel, errors.
- **Conflict page**: candidate cards (§5.3), fetch-to-preview when the original is remote.
- **Remote badge** names the holding peer ("Original on: Macbook"); opening fetches with
  progress, size, cancel (§7.5).
- **Availability filter** ("original on this device") in the existing filter menu. No
  availability _sort_: sorts are collection-owned and replicated; availability is per-peer.
- **Peer list** (§6.5): forget, holdings, last seen, each under the name the peer gave itself
  (§2.1).
- **Adding one** (§9.1): "Connect to another Bowerbird" takes an address, lists what that device
  offers, and takes a local folder.
- A library with no peers renders none of this: no strip, no badges, no conflict page, zero new
  states for the single-server user.

## 11. Trust and validation

### 11.1 Deployment requirement: trusted network only

The server has no authentication, replication adds none, and building an auth layer is a
separate future project. **The hard deployment requirement, stated in the user docs: the server
is reachable only over a trusted network** (tailscale/VPN/LAN); exposing it publicly, including
behind a plain reverse proxy, is unsupported. Everything on that network can read and mutate
everything, which is the pre-replication status quo extended to replication.

Nothing in replication is a security boundary, and the pairing check on the session endpoints is
not one either: it says which peer a page belongs to, not whether the caller may ask. Anything on
the network can list a device's libraries, pair with one, and read every original it holds -
`/api/blobs` takes no peer_id at all. The one place to start, if auth is ever built, is that
surface rather than the handshake.

### 11.2 Apply is a trust boundary anyway

Replicated payloads are remote input to disk operations, and a _buggy_ peer is in the threat
model even where a malicious one is excluded. A photograph's recipe path, `folder_path` and
`bin_name` arrive from a peer and are later joined onto the library root and executed as moves,
renames, and blob reads/writes; a malformed `../../…` row would be an arbitrary file write. Apply
therefore validates every payload with the same zod schemas the local API uses, including the
folder-path refinement (no absolute paths, no `..`) applied to every path-like value - reaching
_into_ the recipe for the path it carries (`RecipeCellSchema`) - and the blob
read/write handlers additionally check the resolved path is inside the root (`containsPath`).
Every request's library id is checked against the pairing. Known fields are validated even
while unknown fields round-trip (§8.5): check what you know, pass through what you don't.
Payload and page sizes are capped in the protocol.

Stamps are bounded at receive time (§2.2), which is what stops one peer's broken clock from
winning every future conflict with year-2200 stamps.

### 11.3 Sidecar

The sidecar binds loopback only (`HOST=127.0.0.1`, random port), or the laptop serves the full
unauthenticated API to whatever network it is on, which on a trip is the hotel's.

## 12. Testing

The merge engine is pure logic over catalogues, so nearly everything tests in `bun test` with
in-memory SQLite catalogues and a function-call transport:

- **Convergence property, the centrepiece**: N peers, random interleaved ops (triage, edit
  sessions, stacking, moves, bins, folder removals, **hash-at-first-transfer, crash between pages,
  crash mid-materialisation-drain, backup-restore with both choices, peer death,
  forget-peer**), replicate in random pair orders until quiescent → **byte-identical**
  replicated state on all peers, stamps included, not values only: a value-only comparison
  passes on a pair that has settled on different stamps for the same row, and the next write
  to either then diverges. Many seeds - the failures that matter here have shown up at 2 in
  1500, so a green run of 40 says very little (§5.4).
- Vector soundness: interrupted sessions resume or restart without loss; the close-only capped
  advance never over-claims (adversarial schedules from the §6.2 counterexamples).
- Merge units: tombstone races, cascade stamps, child-newer-than-tombstone (stack resurrect,
  edit parked), stack collapse determinism and the union rule, session-chain ancestry (linear
  multi-session histories produce zero conflicts; true branches always conflict; the in-chain
  stamp comparison), repair idempotence and stamp determinism, `stack_id` cache always agreeing
  with `stack_members` after any merge.
- HLC: monotonicity, merge-forward, mint-time and receive-time guards, encoding order =
  numeric order, counter carry.
- GC: acknowledgement floor (nothing reaps an unacked tombstone), forget-peer unblocks,
  returning forgotten peer cannot resurrect.
- Materialisation: queue drain idempotence, scan-with-pending-queue takes no wrong action
  (the §7.4 scenarios: folder rename crash, bin-replay crash, bin_name pending), collision
  skip+flag, case-fold/NFD, current-state retargeting.
- Blobs: content-hash computed at first transfer and verified (including a photo the decoder
  chokes on transferring anyway), resume
  from offset, mismatch discard, location-row ordering, self-row reconcile, manual evict
  refuses without live confirmation.
- Restore: catch-up replays forward; keep-restored wins everywhere; HLC jump prevents stamp
  reuse.
- Validation: traversal rejected in every path-like column; future-dated pages rejected;
  cross-library requests refused.
- One Playwright happy path at the end: two servers, pair, import on A, triage on A, replicate,
  assert on B, fetch original on B, edit both sides while apart, resolve the conflict.

## 13. Milestones

1. **Plumbing** (invisible): HLC + stamp columns + replication log + `newId()` 16 chars +
   `content_hash` column (written at first transfer, §7.1) + `stack_members` behind its
   single-writer membership module (§3.3); stamping threaded through every repository write
   site (§4),
   representative selection inside the boundary. All suites green, behaviour unchanged.
2. **Merge engine**: vectors, snapshot streams, pages, merge rules, cascades, repair pass,
   tombstones, acknowledgement GC, edit sessions and the conflict they park. In-memory
   convergence property green over deletions, cascades and resurrections.
3. **Transport + pairing + bootstrap**: endpoints, validation boundary, browse and pair (§9.1),
   peer list with forget, clone, **minimal status surface** (§8.6). Server↔server replication end
   to end.
4. **Offline desktop**: bun server as Tauri sidecar, serving the page the shell's webview loads,
   so requests, images and the event stream are plain same-origin HTTP as in a browser tab; the
   work is sidecar lifecycle (spawn, health, shutdown; `externalBin` packaging) and the token the
   shell signs its page in with. Loopback bind (§11.3).
5. **Blobs**: locations, transfer queue + push-the-diff, fetch-on-open, materialisation queue +
   drain discipline, collision rules, remote badges, pipeline hand-off.
6. **Conflict + lifecycle UI**: edit-conflict page, availability filter, manual evict,
   forget-peer flows, restore-awareness, strip polish. All but the availability filter (§13.1).

Milestones 2–3 are testable entirely server↔server; the macbook story lands at 4–5.

### 13.1 What is not built

- **The availability filter** (§10): a grid cannot yet be narrowed to "originals on this
  device". The detail panel says it per photograph; a list-level filter would want a
  `PhotoListParams` flag and a join against this peer's `blob_locations` rows.
- **Choosing to catch up instead of keeping a restore.** A restore now re-stamps, so what was
  restored is what travels (§8.2). The other half of the choice - "no, take what the peers
  have" - is not offered, and getting it means restoring and then letting a peer's copy win,
  which nothing helps you do.

## 14. Passive peers: backing originals up to a folder

One-way originals backup to a drive, NAS share or separate local directory, without a remote
catalogue or Bowerbird. Keep every original elsewhere and only recently needed copies locally.

### 14.1 A peer is either active or passive

`replication_peers.kind`. An **active** peer is everything §2-§13 is about: a device that merges a
catalogue, answers for its own disk, and dials or is dialled. A **passive** peer is a directory,
and its `address` is that directory's path.

Catalogue queries are active-only: `reachablePeers`, `pairedPeers`, `assertPaired`. Folders have
no sessions or vectors. **Both kinds share transfer queue, staging, hashes and materialisation.**
`PassivePeers` implements the blob protocol (`GET /<photo>/stage`, `PUT`, `POST /<photo>/commit`,
`GET /<photo>/original`, `GET /<photo>/hash`) on the mount. `Peers` selects transport;
`TransferService` knows a folder only where a failure must mark the copy unhealthy. Never duplicate verification on a path whose result permits
original deletion.

Read **`.bowerbird-backup.json` before any write**. Its library identity distinguishes a mounted
backup from an empty mountpoint that would otherwise receive the whole library on local disk.
Reject other-library markers, preventing shared mirror trees. Moving a backup between machines
retains its peer id through the marker, avoiding duplicate identity and retransfers. A marker whose
peer id names a device (an active peer, or this device) is refused before anything is written:
registering it would turn that device's row passive.

**A pass never writes a marker.** Only selecting the folder does, so a missing marker blocks every
write until somebody chooses the folder again; an empty mountpoint looks exactly like a cleared
backup. Missing folder, missing marker, unreadable marker, malformed marker, another library's
marker and another backup's peer id are separate `BackupAccess` states, each with its own remedy.

A backup folder may not be inside its library, or hold it. The scan walks everything under the
root, so a mirror there is imported as a second copy of every photograph - which is then backed up
in turn.

### 14.2 What it holds is this device's reading of it, not a claim

`backup_locations` is `blob_locations`' opposite number and a **local** table: photo, peer, the
path the copy was last written to, its hash, its size, and when this device last saw it.

Keep these readings local: a directory asserts nothing and other devices may not reach the
mount. Replicating them would advertise impossible fetches and unretractable claims to
sole-holder checks (§8.4).

`rel_path` records the actual backup location, which can lag bin or shoot moves until replay.
Finding that copy requires its old path, not the catalogue's new one.

`health` is `held`, `missing` or `changed`. **Only `held` counts**: as a holder a fetch can use, a
cull candidate, a covered original. An unhealthy row is kept rather than deleted, because for an
offloaded photograph it is the only evidence an original was lost; dropping it would take the photo
out of both "backed up" and "to copy" and the loss would read as nothing. `record` restores `held`.
`current_issues` holds up to two unresolved problems per copy (a blocked move, a local copy that
failed its hash at eviction) until a later check proves them gone.

### 14.3 A pass: follow, copy, cull

`Mirror.run` is one pass over one library, and runs after any scan that changed something (which
covers every import), once at startup after the startup scan and sync, every fifteen minutes, and
when somebody presses the button. In that order, and the order is load-bearing:

1. **Follow the moves.** Every held copy whose `rel_path` is not the photograph's current path is
   renamed on the mount. That includes a bin move and a restore: the Bin is a folder inside the
   library, so mirroring the tree mirrors the binning for free. The source is hashed first, so a
   same-size damaged copy is marked `changed` instead of moved; a destination already holding the
   right bytes is adopted and the source left alone; an occupied destination becomes a current
   issue on that copy.
2. **Look again at the copies gone longest unchecked** - five hundred of them, oldest first, so a
   library is covered a couple of times a day without a pass that never ends. A row saying a file
   was copied in March is evidence about March, and a drive somebody tidied says nothing until
   something looks. Existence and size for a held copy, not a hash: reading every byte of a library
   on a timer is not a check, it is a job. An unhealthy copy is hashed, since only that can clear
   it. A copy that is not there is marked **`missing`**, which puts a photograph still on this
   device back among what the folder is owed; one that is offloaded stays reported as lost.
3. **Copy what is owed**, which is every photograph this device holds that the folder has no
   current copy of: never copied, hash no longer the one the catalogue records, or size moved.
4. **Cull to the ceiling** (§14.5), once the queue has drained - what may be given back is what the
   folder holds _now_, and half of it is still in flight until then.

**Nothing here ever deletes from the backup.** A photograph removed from the library leaves its
copy on the drive, which is what a backup is for; a file somebody takes off the drive by hand is
marked `missing` and copied again by the next pass if this device still has it. The only deletions
on the mount are part-copied files in its staging directory that no queued, active, paused or
failed transfer is waiting to finish, and the staging directory itself once it is empty. Removing
the backup or switching folders sweeps the old folder's staging the same way.

**Pairing discovers existing copies by hash, never name alone.** Only bytes matching the
catalogue count as a backup eligible to permit eviction. This also makes unpairing reversible:
offloaded photos have no local copy or pending transfer, so re-pairing must rediscover them.

**Stopping offers to restore offloaded originals first.** Fetch under the pass exclusion to
prevent simultaneous cull. Forget the folder only after every sole backup copy returns; failures
keep it paired and report the remaining count. Only `done` pulls count as restored.

**Choosing another folder is refused while an original would be stranded.** Every photo the current
backup holds must be in the new folder (by hash) or on this device (by hash) first; `is_missing`
alone misses a local file deleted since the last scan. An unmarked folder gets a new peer id.
Selecting, removing, restoring and a pass share one per-library operation, so a target never
changes under a pass that captured the old root.

Nothing overwrites, either. A name already taken by something that is not this photograph is
skipped and reported, as §7.7 has it.

### 14.4 An original is reached through one module

`Originals` (`services/blobs/originals.ts`) is the only way to a photograph's bytes. `here` answers
what is on this disk; `open` fetches it back from the folder first when it is not, and records the
access; `openAll` does the same for a composite's frames.

Every RAW consumer - renditions, image routes, embedded JPEG, downloads and quality page -
gets its path through this class. Decoders and renderers remain path-based; only it knows about
offloading. Whole-file pulls precede pushes so an open need not wait behind ten thousand backups.

**Fetch before starting a flow.** Prepare, export and composite services acquire all needed
files first; renderers below take paths. Repeated merge `open` calls on local files cost a stat.

**A folder that is not there is `UNAVAILABLE`, not `NOT_FOUND`.** The file exists, the answer
changes when the drive does, and what the reader is told is which folder to connect.

A caller that would rather do without than wait uses `here`: a metadata refresh over a selection, a
grid tile repairing itself, the detail view's "is it here". Fetching a RAW per row would turn a
stat into an hour.

### 14.5 The cull, and the one deletion

`replication_libraries.local_budget_bytes` caps each library; null disables it. Evict **least
recently wanted first** by `photos.last_accessed_at`, updated by `Originals` opens and viewer
`full`/`max` serves. Unopened photos use import time, evicting oldest first. A fetched photo
becomes newest, so the next cull chooses another.

Each copy goes through the same eviction the manual action does (§7.6), and there the two kinds of
peer part: a device is **asked**, because only it can say what it holds at that moment and its yes
is a promise it keeps by refusing to evict its own copy at the same time; a folder is **read**,
because it promises nothing.

`deleteBackedUpOriginal` in the sole deletion module, `utils/deletions.ts`, hashes both files
immediately before unlink. Require agreement among backup bytes, local bytes and recorded hash.
Never omit the local read: a good backup is evidence only if it is this file's copy, and local
rot must refuse deletion. Two passes over two files are acceptable for disk-full eviction,
outside hot paths. A refusal is typed (`backup_missing`, `backup_changed`, `local_changed`): the
first two mark the copy unhealthy, the last stays on the copy as a current issue until a scrub
hashes the local file back to the recorded hash. A cull against a folder that is not there blocks
the pass.

Leave `is_missing` plus `backup_locations`, exposed as `is_offloaded`: tile snowflake, detail
status and backup count. Local renditions preserve viewing, sorting, rating and culling;
editing or other RAW consumers fetch it once.

### 14.6 What the reader is told

`Mirror.status` is the one answer for the library strip, the Backup panel and the API: access,
activity, coverage, transfer counts, current issues, and one `status` chosen in this order:
unavailable, working, attention, paused, waiting, then empty or current. Precedence lives on the
server so a manual run, a scheduled one, a reload and a second window all agree.

**Current issues come from current facts; reports are history.** Issues are rebuilt on every read
from folder access, unhealthy rows, per-copy `current_issues`, this peer's stopped transfers and
missing originals with no held copy. A later successful pass therefore cannot erase an unresolved
problem, and a resolved one disappears without anything having to clear it. Each pass, restore and
selection also writes a report (`last_backup_report`, `last_restore_report` on the peer row): what
was copied, moved, offloaded or restored, and issue totals by code with ten samples. Copies are
counted from transfers that finished with a held row. Issues carry codes, not sentences; the client
words them.

`backup` on the event stream carries only a library id; clients re-read status. A busy or
unconfigured run is `CONFLICT` or `NOT_FOUND`.

### 14.7 What is not built here

- **Reading a region off the mount.** A fetch brings the whole file back, so the first loupe tile
  over an offloaded photograph costs the whole RAW where a local one costs a partial unpack -
  which is the region decode the rawler fork exists for (DESIGN §2). Ranged reads against the
  folder are the upgrade, and they want an IO seam that reaches through the FFI rather than a path
  handed to a decoder.
- **More than one folder per library.** The schema is keyed for it (`backup_locations` carries a
  peer id, and the peer table is the same one devices use); the service takes the first.
- **Backing the catalogue up to the same folder.** `maintenance/backup_service.ts` snapshots the
  catalogue where it always did (§4.9); the two are the same word and not yet the same action.
- **A bulk "remove local copies" against a folder.** The route exists - eviction takes any peer id
  - and no screen offers it; the ceiling is how copies are given back today.
