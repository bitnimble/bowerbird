# Library replication

Multi-client support for one library: several installs of Bowerbird (a hosted server, a
macbook, later a desktop or a phone) each holding a **replica** of the same library, working
fully offline, and converging deterministically when any two of them talk.

§14 is the other half, and the half most people will use: a **passive peer**, which is a folder on
a drive or a share that originals are copied to one way, with no Bowerbird on the other side. It
shares everything below the catalogue with the peers above - the transfer queue, the hashes, the
staging - and it is what lets a laptop hold a ceiling's worth of its library and reach the rest.

Replication is the protocol name. In product copy, a library syncs between devices and is backed
up to a folder; a scan reads its files into the catalogue (§9 of DESIGN.md). Code keeps the
protocol under `replication_*`, while `ScanService` owns the disk scan. A library's jobs in
Settings are "Scan library" for the disk, "Sync library" for the network, and "Back up originals"
for the folder.

## 1. Goals and non-goals

Goals:

- A replica is a **true library**, not a cache: import, triage, edit, stack, bin, all of it
  works with no network at all, generating tiles and renditions locally.
- Replication is **pairwise and symmetric**: any two replicas of a library can replicate, no
  master role. In practice every device talks to the server because the server is the reachable
  one; that is topology, not protocol.
- **Deterministic convergence**: after any sequence of replication sessions that connects the
  peers, all peers replicating a library hold identical replicated state for it (values *and*
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

- **Albums.** Albums are cross-library by design (that is what distinguishes them from shoots),
  which puts them outside per-library replication entirely: `albums`, `album_photos` and
  `album_banners` stay per-install local state, untouched by this design. Syncing them is a
  separate future project. One consequence inside this design: a replicated photo hard-delete
  (a folder removed from the library on another peer) cascades this peer's local album
  memberships through the existing FK, as a local library-delete already would.
- Linking two pre-existing independent libraries. A replica is **born from** an existing
  library (§9), never merged with one. Possibly in scope much later, leaning on a dedup tool;
  nothing below may *preclude* it, but nothing builds it.
- Readonly libraries. Replication requires rw and refuses otherwise.
- Deleting files on other peers. Replication propagates catalogue-row tombstones and never a
  file deletion: bin is a move and library removal is DB-rows-only, and the two places a RAW is
  unlinked (§7.6, §14.5) are each one device giving up its own copy on evidence it holds
  another. If purge ships later it rides the same tombstone machinery.
- Deduplicating the same RAW imported independently on two peers. Two imports are two photos; a
  future dedup tool is the answer, not the merge engine.
- **The phone peer**, in the sense of a build and a UI shaped for one. What made it impossible -
  full catalogue, near-zero blobs, per-peer renditions, and so a wall of placeholders it could
  never thumbnail - is answered by rendition fetch-through (§7.9), and a device that holds no
  RAWs at all is now a setting rather than a special case (§7.10). What is left is a phone
  client, and that is its own project.
- Evicting against another *device* on a policy. Between peers the only eviction is the manual
  "remove local copy" action (§7.6), which requires live verification at the moment it deletes.
  A ceiling that gives copies back on its own exists only against a backup folder (§14.5), where
  this device can read both copies itself rather than take a peer's word for one.
- **Authentication.** Deployment requirement instead (§11.1): the server is reachable only over
  a trusted network (tailscale/VPN/LAN). An auth layer is a future project.
- Multi-user. Every peer is the same person; per-peer identity exists for clocks, blob
  locations, and lifecycle, not authorship.

Accepted risk, named: anything that can reach the server on the trusted network, including a
buggy peer, can rewrite catalogue state through perfectly legitimate operations. No message from
a peer deletes a file; the two places an original is unlinked are actions taken here, and each
reads its own evidence first - a peer's live possession check for §7.6, and both copies' bytes,
hashed here, for §14.5. Payloads are validated (§11.2), stamps are bounded (§2.2), and the
server's rolling DB backups (§8.2, DESIGN.md §4.9) are the recovery story for the rest.

## 2. Peers, identity, clocks

### 2.1 Peer identity

Each install mints a `peer_id` once (16-char id, §2.3) with a user-visible device name
("Macbook", "Home server"). App-level, not per-library: one machine is one peer however many
libraries it replicates. Re-pairing after a reinstall mints a **fresh** peer_id; the old one is
forgotten (§6.5), never resumed.

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

LWW needs a unit: the thing a stamp covers and a conflict clobbers whole. Units are chosen per
"control": fields a user changes together move together; fields changed independently must not
clobber each other. **Every column of every table is assigned** either to a replicated unit or
to the per-peer list; a column missing from both is a design bug (the first draft missed
seven).

### 3.1 Photos

| Unit | Columns | Notes |
|---|---|---|
| `imported` | `content_hash` (§7.1), `file_size`, `width`, `height`, `orientation`, `date_taken`, `date_taken_offset`, `date_added`, `latitude`, `longitude`, exif columns (`iso` … `lens_model`) | Import facts. `date_added` replicates: it drives the `added_*` orderings, which must agree everywhere |
| `triage` | `rating`, `triage`, `notes` | The cull verdict |
| `placement` | `recipe`, `shoot_id` | Tree position. The recipe is where a photograph's path lives (DESIGN §4.2.1), and for a file photograph it *is* the placement: a rename rewrites it. Split from bin state so a bulk path rewrite (folder rename) cannot clobber a concurrent binning |
| `bin` | `is_deleted`, `deleted_from_path`, `deleted_batch` | Binned or not, and where it restores to |
| `stack` | `stack_state` | The human verdict 'unstacked' must replicate or another peer's auto-detection re-stacks the photo. Membership itself is `stack_members` rows (§3.3) |
| `hidden` | `is_hidden` | Put away (DESIGN §12.4). Apart from `triage` because the two are decided at separate moments: sharing that stamp, a rating arriving from a peer would bring back what somebody had hidden |

Per-peer, never replicated: `file_hash` (a stat-hash including mtime, meaningful only for this
disk's scan, §7.1), `is_missing`, `date_updated`, `needs_tile`, `needs_renditions`,
`tile_built_at`, `renditions_built_at`, `built_from`,
`processing_error`, `descriptor`, `viewer_rendition`, photo-level `rendition_source`. `stack_id` and `is_representative` are locally-maintained
derivations (§3.3), not replicated.

A folder rename rewrites member `placement` units (as the scan does today) and only them; it
never touches `bin` units. The repair pass (§5.5) keeps `shoot_id` coherent with paths.

**Which leaves `deleted_from_path` corrected locally and not replicated, deliberately.** A rename
has to fix it - it is where a restore puts the photograph back, and left at the old path a
restore recreates the folder that was renamed away - but the two obvious ways to make that
correction travel are both worse than the residual, and both have been tried:

- *Stamp the `bin` unit.* The correction then asserts that the binning was decided now, so a peer
  that restored the photograph while apart loses that restore to a rename which knew nothing
  about it. What somebody did is silently undone, everywhere.
- *Move the column to `placement`.* Worse. A peer that still believes the row is live holds NULL
  for it, so its ordinary path writes null the origin of a binning it never heard of - and the
  restore then puts the RAW in the library root.

So the correction stays local, and the residual is the small one: a peer that has not scanned the
rename still holds the old origin, and restoring *there* recreates the folder. A tidy-up, against
silently undoing a person's action or losing the file's way home. Both failures are pinned in
`converge.test.ts`, and `peers.ts` asks of every seed that no binned photograph is left with
nowhere to go back to.

### 3.2 Shoots, rules, banners, libraries, settings

| Table | Unit | Per-peer (not replicated) |
|---|---|---|
| `shoots` | `shoot`: `name`, `description`, `ordering`, `parent_id`. `shoot.folder`: `folder_path`. `shoot.hidden`: `is_hidden`. Each on its own stamp | `folder_dev`, `folder_ino`, `folder_birthtime` (disk identity is per-disk) |
| `folder_rules` | one stamp per row | none |
| `shoot_banners` | one stamp per row | none |
| `libraries` | one stamp over `name`, `ordering`, `include_subfolders`, `bin_name`, `auto_stack`, `auto_stack_similarity`, `auto_stack_window_seconds` | `root_path`, `read_only`, `bin_dev/ino/birthtime`, `last_synced_at`, `rendition_source`, `rendition_hdr` (what to build is a per-device choice; a laptop may build SDR where the server builds HDR) |
| `settings` | not replicated: per-install (HDR viewing on a device that can't, backup schedule) | everything |

Albums (`albums`, `album_photos`, `album_banners`) are not replicated at all (§1).

`bin_name` replicates; each peer replays the folder rename locally on merge (§7.7 for what
happens when the replay cannot run).

**`folder_path` is a unit of its own**, which is the rule in §3 applied literally: only the scan
writes it, by following a rename on disk (§9.4.1), where the label and the ordering are written by a
person. It also has to be *settled* when two peers rename onto one folder (§5.6), and a resolution
that moved the shoot's shared stamp would assert that the label and the ordering had been rewritten
at that moment too - so a rename of the label still in flight from a third peer would arrive looking
stale, be skipped, have its coverage claimed, and then be overwritten everywhere from the peer that
resolved. That is the same failure `bin` is split off `placement` to avoid, one table over, and it is
silent.

`is_hidden` is split off for the same reason: on one stamp, a folder rename would assert a hidden
flag decided now and clobber a hide - or an unhide - made on another peer while they were apart.

**It is one row's flag, and the subtree is derived from it** (DESIGN §12.4). That is what keeps the
split above worth having: the alternative, writing the flag down every descendant, puts a rename and
a hide back in each other's way even on separate stamps - not by clobbering a stamp but by leaving a
shoot moved into or out of a hidden subtree carrying the wrong bit, on every peer, with nothing to
correct it. Derived, the two writes are independent in fact and not merely in bookkeeping: a rename
moves paths, a hide sets one flag, and whatever order they arrive in, every peer reads the same
answer off the result.

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

**`photos.stack_id` stays in the database**, demoted to an ad-hoc materialised view over
`stack_members`. It is not redundant decoration: the listing hot path's stack-collapse filter
(`photo_query.ts`) runs on every row an index walk visits, and for the unstacked majority
it short-circuits on `stack_id IS NULL`, a column read from the row in hand. Replacing it with
a join makes "is this photo stacked" a b-tree probe per visited row, including every row a deep
OFFSET skips: hundreds of thousands of probes per block at scale, the exact regression class
DESIGN.md §4.2 documents. A view cannot substitute: SQLite views are macros, not materialised,
so a view over the join would run the join per query, and a view cannot be indexed into the
covering walk.

**One writer module owns both.** Every write to `stack_members` goes through a single
membership writer (its own class/module), which updates `photos.stack_id` in the same
transaction (removal falls back to the photo's remaining membership, if any). Nothing else,
not repositories, not merge apply, not repair, touches either the table or the column directly;
they all call the writer, so the pair cannot drift without a bug inside one small file. Never
replicated, never diffed. `is_representative` keeps its existing refresh logic (a choice, not a
copy), recomputed by the repair pass.

### 3.4 Edits

`photo_edits` replicates whole (doc, history, cursor, session lineage) under session semantics
(§5.3). `rev` stays local (per-replica optimistic-lock token for tab-vs-tab; bumped on merge so
an open editor 409s instead of overwriting merged state). `photo_edit_history` travels with its
row, always whole, never delta-spliced.

### 3.5 Tombstones

Hard-deleted rows leave `(entity, id, stamp)`. Sources: shoot deleted, stack dissolved, stack
membership removed, folder rule removed, shoot banner cleared, photo rows removed by taking a
folder out of the library (catalogue rows only, no file touched), blob location retracted
(§7.2). Merge in §5.1, GC in §8.3.

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

**The log is maintained by triggers, not by the code that writes the row.** There is no
existing single write choke point - all runtime SQL writes do live in repository classes, but
around forty of those sites are reached by photo id alone and never learn which library they
touched, so a hand-written log call at each would mean threading a library through every
signature. A trigger keyed on the stamp column has `NEW.library_id` for free, and makes the two
impossible to drift: there is no way to move a stamp without the log following. What a write
site owes is therefore exactly one thing - set your unit's stamp when you write your unit's
columns - which is small enough to hold in the head at every site.

**Nothing is logged for a library that does not replicate**, which the trigger tests rather than
the caller. The stamp columns are written regardless, since the site that writes them has no
cheap way to know; the rows behind them are what would cost an import its write amplification,
and a catalogue nobody syncs should pay none of it.

Pre-replication rows therefore carry stamps only for units written since this build landed, and
no log at all. Pairing is what settles both (§9): it walks the library, gives every unit still
unstamped one genesis stamp, and builds the log from the stamp columns - which is the rebuild
the log's status as an index promises, run for the first time. Deliberately not a migration:
stamping every row of every catalogue on upgrade would be a full rewrite of the photos table for
a feature most catalogues never turn on.

Two stragglers sit inside the boundary: choosing a stack's representative, which is part of
`StackMembership` rather than a bare function over `db` shared by two repositories, and any
future migration that writes replicated columns, which stamps what it writes.

## 5. Merge rules

All merges are per unit, newest stamp wins, byte-compared; the peer_id inside the stamp breaks
exact ties deterministically. The exceptions and mechanics:

### 5.1 Tombstone vs write

Newer stamp wins: a delete after a write removes the row. Whether a write after a delete brings
it back depends on what the delete meant.

**A photograph's and a shoot's tombstone is final.** Neither row is ever hard-deleted on its
own: the single path that removes them is a folder leaving the library (§4.7), which writes that
folder's rule in the same transaction. So a rating that arrives from a peer which had not heard
yet is not somebody asking to keep the photograph - it is somebody working in a folder that has
since left, and bringing the row back would have the repair pass remove it again. If the folder
is ever let back in, the scan imports its files as **new photographs with new ids**, carrying no
rating, no verdict and no edits, which is the resurrection a person would recognise and it needs
nothing from the merge.

Making them final is also what closes the last convergence hole. A resurrected row arrives
carrying the *resurrecting* peer's copy of every unit, which may be older than what the peer
applying it held and destroyed - and the deletion is erased as the row returns (below), so
nothing is left that can settle the difference. Two peers then disagree about one control of one
photograph, permanently and silently. With final tombstones the grave stands, travels, and wins
everywhere.

**A stack's tombstone is not final**, and stacks are the only rows this applies to: dissolving
one is a statement about the stack alone, with no folder rule behind it, so a later write to it
is somebody saying the more recent thing. Exact tie: tombstone wins.

**A row a foreign key takes is tombstoned on a stamp minted where the cascade ran.** SQLite
performs a cascade itself and tells nobody, so a banner or a membership removed because its
photograph was is a row that left with no record of leaving, which every other peer reads as one
this peer has not heard of and sends straight back.

The parent's stamp looks like the better choice, and was: every peer running the same fan-out
would then write byte-identical tombstones and the value would need no agreeing on. It is also
**undeliverable**, which is fatal. A peer buries only the children it was holding, and a row
stamped inside another peer's origin can never be sent to anyone already claiming coverage of
that origin - so a membership created on one peer while a second deleted the photograph ends up
buried on the peers that saw both and alive on the peer that made it, with nothing left that can
say so. It takes three peers and a resurrection to reach, which is to say it would have been
found in use rather than in a test.

Minting locally makes it an ordinary write and it travels like one. Peers do then disagree about
*when* a child died, each having stamped its own, but those tombstones replicate like any other
row and the log keeps the newest - so the threshold a later write must beat to bring the child
back converges too. The cost, accepted deliberately and unchanged: a photograph brought back by
a later write elsewhere comes back without its memberships, its banner or its edits.

**A row that has come back must stop being logged as deleted.** A resurrection leaves the
entity's tombstone standing beside the live entries its own columns just wrote, and a log saying
both things at once streams the tombstone rather than the row - so the peer receiving it deletes
exactly what it was being handed. The grave is a statement about a row that no longer applies,
and it goes when the row returns.

**Nothing may claim coverage of a change it discarded.** A change whose parent this peer has
deleted cannot be written, and SQLite refuses the reference rather than inventing one. Such a
change is left unclaimed: the session holds that origin's vector to just below the stamp it could
not take, so the change arrives again next time, by which point the deletion has usually reached
the sender and it stops being sent at all. Advancing over it instead is how a row goes missing
between two peers that both believe they are in step.

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
edit could not attach to. What the merge refuses to do is lose it *quietly*: an edit newer than
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

**A stack dissolves when a removal leaves it with nothing to be a stack of, whatever did the
removing** - a person here, or a merge applying somebody else's. One photograph is a photograph.
Two peers each taking a different member out of a three-member stack are each left holding two,
so neither dissolves anything alone; the stack ends when they meet, on both, because both then
hold both removals.

**The rule hangs on the removal, and is asked at the close of a session, never inside one.**
That is the whole of what three earlier attempts got wrong. A page is a slice of the sender's
log in stamp order, so the removal that empties a stack routinely arrives pages before the
additions that would keep it whole: a rule that reads the state mid-session dissolves a stack
whose other members are still coming, then refuses them when they land, while the peer that had
them all along dissolves nothing - and the two never agree again. At the close, this peer holds
everything the sender had, so a stack of one is a stack of one. Only stacks a membership has
actually *left* are considered, which the graves say; a stack that is small because nobody has
sent its members yet has none.

What it writes is an ordinary tombstone under the dissolving peer's own origin - not derived
from anything - which is what lets it reach the peer whose removal was the other half of the
story. A derived stamp would carry that peer's origin and be undeliverable to it, which is the
trap §5.1 describes and which two of those earlier attempts fell into.

Every peer computes the same collapse, but what it writes is stamped **where it ran**, not
derived from the surviving stack. A stamp carrying another peer's origin cannot be delivered to
that peer, whose coverage of itself is total, so the peer that collapsed first could never say
so and the others would keep the stack it dissolved - the same trap as §5.1's cascade, with the
same answer: an ordinary write travels like one, and peers disagreeing about *when* settle it by
exchanging tombstones.

### 5.3 Edits: sessions, and the one user-facing conflict

Opening the editor begins a **session**: a random 16-char `session_id` on every save until the
editor closes. The `photo_edits` row carries the current `session_id`, its stamp, and the
**full lineage chain**: the list of `(session_id, stamp)` hops from the current session back to
the root, appended on every session open. One hop is not enough: the log carries latest state
only, so intermediate sessions are routinely never seen by other peers, and a one-hop parent
would flag a conflict every time a photo is edited in two sessions between replications, i.e.
constantly, on perfectly linear history.

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

**Which peers hold the candidates is not something that converges, and cannot be.** A parked
candidate carries the stamp of the peer whose edit it is, so it can never be streamed *to* that
peer, whose coverage of its own origin is total by construction. Each peer that ever holds both
sides rebuilds them from the same bytes instead; a peer that only ever received the winner has
nothing to resolve and correctly holds none. What converges is the document everyone renders and
the resolution when somebody picks one, which is an ordinary edit like any other. The rows do
replicate where they can - a peer that has heard of neither side gets them - which is why they
are a replicated entity at all.

Accepted asymmetry, by design: a two-hour session loses *provisional rendering* to a one-slider
tweak made later on another device; nothing is lost, both candidates sit in the conflict entry.

### 5.4 Derived writes happen only when the value differs

Repairs and collapses are machine writes. **A derived write happens only when the value actually
differs**, or repair churns forever: that half is absolute and every derived write obeys it.

The other half of the original design - that a derived write's stamp is a pure function of its
inputs, "the maximum input stamp with counter+1, peer_id taken from that maximum input stamp",
byte-identical on every peer - **cannot be built, and both ways of trying it fail.**

Taking the *origin* from the input makes the write undeliverable. A peer's coverage of its own
origin is total by construction, so a row carrying peer A's id is never selected to send to A -
the trap behind several of this engine's worst divergences (§5.1). Derived writes therefore mint
under the origin of whoever ran them, and two peers computing the same repair produce stamps
differing in the tail. They still converge, because LWW settles it and both are deliverable.

Taking only the *time* from the inputs, under a local origin, looks like the way out and is
worse, because it fails silently. A version vector's promise is "everything this origin wrote
below this stamp is applied here", and that holds only because nothing a peer mints ever sorts
below something it has already minted. A stamp placed in the past under this peer's own origin is
one a receiver advances its vector straight past, having never been sent it, and never is again.
Measured rather than argued: the collapse stamped this way diverged 2 seeds in 1500 - a stack
alive on one peer and buried on another, the grave sitting below the receiver's coverage.

So **a derived write is stamped where it ran**, and the consequence is faced rather than
engineered away: it outranks a deliberate action made before it that has not arrived yet. Where
that matters, the repair *asks* instead of relying on the ordering - `collapseOverlappingStacks`
checks for a grave on the winning stack before moving a membership into it, because a photograph
somebody took out of a stack must not be put back by machine work (§3.3).

The monotonicity this rests on is pinned in `clock.test.ts`; the asking is pinned in
`converge.test.ts`. Both exist because this section has been "corrected" back towards the
original design once already.

### 5.5 Repair pass

After every apply batch, deterministic, same code and order on every peer, all writes per §5.4:

- `shoot_id` pointing at a shoot this peer has *buried* → unassign (photo keeps its path). Absent
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

Same RAW imported on two peers = two photos, kept (dedup tool later). Two *different* photos
converging onto one path: the newer `placement` stamp keeps the path; the older is
flagged for the user to resolve (rename/move). This flag is a **new user-facing surface**
(nothing like it exists today; the current importer silently suffixes filenames), it is
per-peer derived state, not replicated, and materialisation's matching rule is in §7.7.

**Two shoots claiming one folder: the earlier rename keeps it.** `shoots` is unique on
`(library_id, folder_path)`, and the reachable way to reach that constraint is two peers each
renaming a *different* folder to the same name while apart - which needs only a folder rename on
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
peer that *cannot* say where the loser was: that is the other peer's row. So it takes the contested
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

Each replica keeps **one local coverage vector per library**: for every origin peer_id, the
highest stamp up to which it has applied *everything* that origin ever wrote in that library.
Not per-pair; what a replica has is a property of the replica. (Cached copies of remote vectors
exist only for UI.) Origin is recoverable from the stamp's embedded peer_id, so writes need no
extra bookkeeping. Vectors, the replication log, HLC persisted state, and pairing records all
live **inside the catalogue file**, so a backup restore rewinds them atomically with the data
they describe (§8.2).

### 6.2 Session

Either side initiates; the flow is symmetric. One session between two peers covers every
library both replicate.

1. **Handshake**: protocol version (stamp widths included), app schema version, the shared
   library ids, rw check, both clocks (skew guard), both coverage vectors. A downlevel peer is
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

The close-only, capped advance is what makes the vector sound. Advancing per page to a global
high-water mark over-claims origins the sender itself lacks, and a unit overwritten mid-stream
can slip behind a page watermark; both silently and permanently lose data between fully live
peers. Resumability therefore comes from a **session cursor** (page position keyed to the
sender's snapshot), not from the vector: an interrupted session resumes its snapshot from the
cursor, and if the snapshot is gone, the next session simply restarts from the unchanged
durable vector, re-streaming work that idempotent apply makes harmless.

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

Pairing is a **record of which devices sync which library**, not an authentication layer (§11.1).
The joining device asks a peer what it holds (§9.1), picks one, and pairs: its peer_id and device
name are registered and the library is linked. No secrets are exchanged and none are stored;
requests carry the peer_id, and what it identifies is which peer's opinions and coverage a row
belongs to, never whether the caller is allowed to ask.

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

The stated trade: the integrity baseline is the bytes as of first share, not as of import, so
corruption before a photo's first transfer becomes canonical. Import-time integrity is not a
property Bowerbird has ever claimed; if it grows one later, it is this same column written
earlier, not new machinery.

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

Replicated (per-row LWW, tombstone on retraction). It answers **where to fetch from** and
drives the awaiting-originals counts in the UI. It is deliberately **not sufficient** for
"safe to evict": replicated rows are stale by construction, and two peers each trusting the
other's row can destroy the last two copies concurrently. Any eviction, v1's manual one
included, requires a live confirmation at evict time from a peer that verifies possession of
the bytes then (§7.6). The doc states this now so the table is never later trusted for a job it
cannot do.

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

The catalogue is the tree spec; each peer materialises it for the blobs it holds, **plus every
shoot folder regardless of blob possession**. Folders are cheap, they keep the replica's tree
browsable, and without them the scan's mirroring would read an absent folder as the user
deleting the shoot and tombstone it back to every peer.

**The queue is durable and written in the same transaction as the page apply.** Each entry is
one pending disk action derived from a merged unit (move from→to, bin transition, folder
create/rename). This is the mechanism that keeps the scan honest, because an unfinished
materialisation is otherwise indistinguishable from deliberate user file-moves *in the opposite
direction*: the scan (disk is truth) would read catalogue-ahead-of-disk as "the user moved
these back", re-stamp the reversal, and replicate it, silently undoing a folder rename
library-wide or un-binning half a binned batch because some peer crashed mid-drain. Hence:

- The scan lease spans apply **and** drain (§6.3); a scan acquiring the lease **drains the
  pending queue first** (idempotent: entries already satisfied on disk are skipped) before it
  may conclude any removal, move, or bin crossing.
- Backstop: the scan refuses to re-stamp a `placement`/`bin` unit whose current stamp is
  remote-origin and newer than the local materialisation watermark; such rows surface as
  "pending materialisation" instead of being adopted as disk truth.
- Queue entries execute against the row's **current** merged state at drain time (a rename
  merged mid-queue retargets the entry), with `mkdir -p` as needed.
- A file the editor holds open (EBUSY on Windows) retries; the entry stays queued.

Materialisation moves files with the extracted move primitives (the halves of today's
bin/restore/shoot-move that touch disk), **without re-stamping the already-merged rows**. The
existing service methods keep their move+write welding for local user actions; materialisation
is the same disk half driven by remote state.

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

The refusal is per photograph, not per batch, so a partial answer is the normal one and the UI
reports both halves of it. The route takes a `PhotoTarget` as the other bulk routes do (§12.3):
the bar names positions in a filtered collection, and a selection of a hundred thousand is one
small request rather than the client reading every id back to send them.

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
one thing the manual-assets rule (§7.3) exists to prevent. So a *built rendition* is itself
something a peer can serve: the holder answers with its own file, the asking side verifies the
bytes against a hash the sender computed over them, and caches the result at exactly the path
its own pipeline would have written. Everything downstream - the staleness rule, the URL
versioning, the startup sweep - then reads a fetched copy as a built one.

Freshness is one predicate applied on both sides. The holder refuses a copy its own edits have
moved past, because the caller cannot rebuild and would cache a stale picture as current; the
caller checks what the sender reports it rendered (`X-Rendition-Built-From`) against the edit
stamp *it* holds, which may be newer than anything the holder has replicated. When no peer can
answer and a stale copy is already cached, the stale picture is kept: on a device that cannot
rebuild it beats a hole, and the next request asks again.

**What a render was built from is a stamp, not a time.** A build happens on whichever peer holds
the original and an edit on whichever peer made it - a catalogue-only peer never builds anything
at all - so "is this stale" asked of two wall clocks is asked of two machines' clocks. A peer a
minute slow hides its own edit for good: nothing re-queues it, every holder serves the old
picture as current, and the person who made the edit watches it fail to appear. A minute fast
does the reverse, refusing a correct render to every peer until something else moves. Both are
silent, and both sit inside the hour of skew §2.2 deliberately absorbs, so the clock the protocol
hardened is precisely the one this must not use. `built_from` holds the `photo_edits` stamp each
stored variant rendered, keyed by `renditionVariant` - `grid`, `full`, `full-hdr`, `max`,
`max-hdr` - so a fetched copy answers for itself; `renditions_built_at` and `tile_built_at` are
the version a client builds its image URLs from, and answer nothing about staleness.

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
same setting on a laptop that wants the library without the terabyte.

**Local, and deliberately not a replicated unit.** It is a statement about one device's disk, so
a laptop that wants the catalogue only must not have that answer overwritten by the desktop's.
Nothing about it converges, and nothing should.

**The refusal that counts is the receiving peer's**, taken before a byte is staged: an incoming
push and a bulk fetch are both refused where the setting is off. The handshake carries each
side's answer so neither offers what the other would refuse - and that is advisory only, because
it is minutes old by the time a transfer starts. A peer on a build that does not send it reads
as wanting originals, which is what every peer did before the setting existed.

Turning it off also cancels what is still queued to arrive, or the queue goes on delivering
exactly what was just turned off.

Three things it deliberately does not do. It does not delete: turning it off keeps every
original already here, and §7.6 is what gives the disk back. It does not stop **this** device
sending its own originals out, which is about somebody else's disk. And it does not block the
§7.5 single fetch - a device that browses everything and edits the occasional photograph is the
whole point, so asking for one by hand still works.

## 8. Failure modes and hygiene

### 8.1 Crash safety

Apply is transactional per page; the durable vector moves only at session close, atomically
with the final page; the materialisation queue is written with the pages it derives from and
drains idempotently; blob staging is temp-plus-rename on one filesystem. Every crash window
lands in a state the next session, drain, or scan resolves without minting wrong stamps (§7.4).

### 8.2 Backup restore on a replicated peer

DESIGN.md §4.9's backups now cover a catalogue that other peers hold newer opinions of, and an
un-designed restore is defeated by replication within minutes: the next automatic session
streams back everything since the backup with newer stamps, quietly re-applying exactly what
the user restored to escape; or, had vectors lived outside the catalogue, the restored peer's
vector would over-claim and the gap would never be re-fetched: permanent silent divergence.

So: vectors, log, HLC state, and pairing live inside the catalogue (§6.1), rewound atomically by
restore. That is the half that keeps convergence - a vector living outside the catalogue would
over-claim after a rewind and the gap would never be re-fetched.

The other half is that **a restore of a replicated library keeps what was restored**. Every
replicated row is re-stamped on one fresh stamp, which makes the restore itself the newest write,
so it is what the peers take. Somebody restoring a backup is undoing something, and a restore
quietly undone by the first session ten minutes later is the one outcome that makes backups
worthless.

The stamp is taken **above the pre-restore clock**, read from the catalogue this one replaces
rather than from the snapshot's own log: stamps from the week being rolled back are already out on
other peers, and a clock that only knew what the backup knew would mint below them and lose. It
also means a rewound clock can never re-mint a stamp already used for a different write, which is
what idempotence rests on.

**Re-stamping is not deleting.** Rows the peers hold and the backup does not - photographs
imported since - arrive on the next session and are kept. The restore is a statement about the
values it holds, not a claim that nothing has happened since; rolling a catalogue back a week
should not discard a card imported on Tuesday.

**All of it happens before the swap, which is what makes the rest of this section short.** The
snapshot is vacuumed to a staged file beside the catalogue; that file is migrated forward and
re-stamped there, while it is still nothing; only then is anything renamed. So a backup older
than this build, a clock the mint guard refuses (§2.2), and a disk with nothing left are ordinary
failures of a restore that has changed not one byte - the operator is told, and running it again
is a complete remedy.

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

Older app ↔ newer catalogue: unknown columns in replicated payloads are preserved and
round-tripped, not stripped (`EditDoc` is already `.loose()` end to end; the same rule one
layer up). Validation checks the fields it knows and passes through what it does not (§11.2).
A breaking protocol change (including stamp-encoding widths) bumps the protocol version and the
handshake refuses downlevel peers by name.

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

**The addresses traded are *web* addresses.** The deployment publishes one port and it is the web
one - in the dev compose the API is bound to loopback inside the container and reachable only
through the web server's proxy - so a peer recorded at this server's own address would be
recorded at a port nothing exposes. Every peer-to-peer call therefore goes to the address a
browser reaches, and is proxied to the API behind it. The production image serves the built client
from the bun server for the same reason: one published address that answers both, or the address
the reader is told to type shows nothing.

On the joining device: **"Connect to another Bowerbird"** is three steps. The address; the list of what
that device offers; then the folder, which the picker can create, and whether to keep originals
(§7.10). A replica that keeps them queues a fetch of every original the device it joined holds as
soon as the catalogue has landed.

**Nothing is presented and nothing is exchanged to earn the pairing** - the network is the
boundary and no part of this is a security boundary (§11.1). Asking a peer what it holds is a
read that registers nothing on either side, so a reader who stops at the list has left no trace;
the pairing happens with the add, at the end, together with the clone.

Ordering is what keeps a failure cheap: the local half - already-present library, empty folder,
writable root - is checked *before* the remote is asked to pair, so the usual refusal costs the
other device nothing. The one case that cannot be ordered away is a local failure after the
remote has recorded us, and that is rolled back by unpairing (§8.4) rather than left as a peer
whose vector bounds tombstone collection forever on behalf of a device that never arrives (§8.3).
The retraction is sent broadly rather than only where the pairing is known to have landed,
because the case worth covering is exactly the one this side cannot tell apart: a reply that
never arrived over a pairing that did.

An add is **serialised per library, across the network call**. Two of the same library would
otherwise both pass the existence check and both pair - the peer id is the whole device's, so the
second is an upsert of the first - and the loser's rollback would retract the winner's pairing,
leaving a replica whose every later session is refused. Nothing local can be waiting on that
lock, because until the transaction commits there is no library here to wait on.

**The local folder must be new or empty**, checked on the server rather than in the dialog.
Anything already there is imported as this library's own, which then replicates to every other
peer as photographs that appeared on their disks.

Browsing also compares the two peers' wall clocks and, when they differ by minutes, says so:
a notification only, blocking nothing, so the user can go fix NTP before the skew ever grows
into the session guard's refusal (§2.2). Clocks that drift tend to have been drifting long
before this; it is the cheapest moment to catch it.

**Pairing requires the server reachable, so the replica must exist before the trip.** A
standalone library created on the road can never become a replica (§1). Settings puts "Add
library" and "Connect to another Bowerbird" side by side so the fork is visible at the moment it matters,
and this sentence is the one that belongs in the user docs in bold.

## 10. UI

- **Device sync strip** per synced library: per-device last sync, in-flight state,
  awaiting-originals counts in both directions, and errors. What is moving - a session, fetches,
  sends, a backup pass - is also said on the library's own status line beside its scan, and
  "Sync library" is a library job.
- **"Automatically send and fetch originals"** per library, off by default: every session that
  reaches a device also queues the originals either side lacks, in each direction the two sides'
  §7.10 answers allow.
- **Transfer manager**: the persistent queue: per-item progress, pause/resume/cancel, errors.
- **Conflict page**: candidate cards (§5.3), fetch-to-preview when the original is remote.
- **Remote badge** names the holding peer ("Original on: Macbook"); opening fetches with
  progress, size, cancel (§7.5).
- **Availability filter** ("original on this device") in the existing filter menu. No
  availability *sort*: sorts are collection-owned and replicated; availability is per-peer.
- **Peer list** (§6.5): rename, forget, holdings, last seen.
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

Replicated payloads are remote input to disk operations, and a *buggy* peer is in the threat
model even where a malicious one is excluded. A photograph's recipe path, `folder_path` and
`bin_name` arrive from a peer and are later joined onto the library root and executed as moves,
renames, and blob reads/writes; a malformed `../../…` row would be an arbitrary file write. Apply
therefore validates every payload with the same zod schemas the local API uses, including the
folder-path refinement (no absolute paths, no `..`) applied to every path-like value - reaching
*into* the recipe for the path it carries (`RecipeCellSchema`) - and the blob
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
4. **Offline desktop**: bun server as Tauri sidecar. The seam is `origin()` in `api.rs`, which
   all three channels (commands, `bowerbird://` assets, the SSE follower) already route
   through, so pointing it at the sidecar carries everything; the genuinely new work is sidecar
   lifecycle (spawn, health, shutdown; `externalBin` packaging) and the note that `origin` is
   app-global: local-vs-remote is per-app, which matches this design. Loopback bind (§11.3).
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

A drive, a NAS share, a directory somewhere else on this machine. One way, no catalogue, nobody
running Bowerbird on the other side - and with it, the thing a laptop actually wants: every
original safe somewhere else, and only the recent ones taking up the laptop's disk.

### 14.1 A peer is either active or passive

`replication_peers.kind`. An **active** peer is everything §2-§13 is about: a device that merges a
catalogue, answers for its own disk, and dials or is dialled. A **passive** peer is a directory,
and its `address` is that directory's path.

Every query that walks peers to do catalogue work is active-only - `reachablePeers`, `pairedPeers`,
`assertPaired` - because a folder has no session to open, no vector to compare and no request to
make. What it does share is everything below the catalogue: **the transfer queue, the staging, the
content hashes and the materialisation are one implementation for both kinds**. `PassivePeers`
answers the blob protocol (`GET /<photo>/stage`, `PUT` it, `POST /<photo>/commit`,
`GET /<photo>/original`, `GET /<photo>/hash`) against the mount, `Peers` routes each request to
whichever transport the peer id belongs to, and `TransferService` never learns which it is talking
to. A second copy of that loop is the thing worth refusing here: it would be free to verify a
little less carefully than the first, on the path where a wrong answer deletes an original.

The folder carries **a marker**, `.bowerbird-backup.json`, naming the library it is the backup of.
Read before anything is written into it, and for one reason: an unmounted share is an empty
directory that reads as a backup with nothing in it yet, so without the marker the first pass after
a reboot would write the whole library onto the machine's own disk and report success. A folder
whose marker names another library is refused, which is also what stops two libraries mirroring
into one tree. A backup carried to another machine keeps its marker, so re-pairing it there adopts
the peer id it already had rather than minting a second one and re-sending everything.

A backup folder may not be inside its library, or hold it. The scan walks everything under the
root, so a mirror there is imported as a second copy of every photograph - which is then backed up
in turn.

### 14.2 What it holds is this device's reading of it, not a claim

`backup_locations` is `blob_locations`' opposite number and a **local** table: photo, peer, the
path the copy was last written to, its hash, its size, and when this device last saw it.

Not the replicated table, deliberately. A location row is a fact a peer asserts about itself, and a
directory asserts nothing; every row here is this device's own reading of a mount only it can see.
Replicated, it would tell another device that a peer it cannot reach holds the photograph, offer a
fetch nobody can serve, and count towards a sole-holder check that peer can never retract (§8.4).

`rel_path` is where the copy actually is rather than where the catalogue now says the photograph
belongs. The two disagree from the moment a photo is binned or a shoot renamed until a pass replays
the move, and finding the file again is what needs the old one.

### 14.3 A pass: follow, copy, cull

`Mirror.run` is one pass over one library, and runs after any scan that changed something (which
covers every import), every fifteen minutes, and when somebody presses the button. In that order,
and the order is load-bearing:

1. **Follow the moves.** Every copy whose `rel_path` is not the photograph's current path is
   renamed on the mount. That includes a bin move and a restore: the Bin is a folder inside the
   library, so mirroring the tree mirrors the binning for free.
2. **Look again at the copies gone longest unchecked** - five hundred of them, oldest first, so a
   library is covered a couple of times a day without a pass that never ends. A row saying a file
   was copied in March is evidence about March, and a drive somebody tidied says nothing until
   something looks. Existence and size, not a hash: reading every byte of a library on a timer is
   not a check, it is a job. A copy that is not there is **forgotten**, which puts the photograph
   back among what the folder is owed and copies it again.
3. **Copy what is owed**, which is every photograph this device holds that the folder has no
   current copy of: never copied, hash no longer the one the catalogue records, or size moved.
4. **Cull to the ceiling** (§14.5), once the queue has drained - what may be given back is what the
   folder holds *now*, and half of it is still in flight until then.

**Nothing here ever deletes from the backup.** A photograph removed from the library leaves its
copy on the drive, which is what a backup is for; a file somebody takes off the drive by hand is
forgotten from `backup_locations` and copied again by the next pass. The only deletions on the
mount are part-copied files in its staging directory that no queued transfer is waiting to finish.

**Pairing a folder asks it what it already holds.** A copy sitting at a photograph's path counts
once its bytes hash to what the catalogue records for that photograph - never off the name alone,
which would record a backup of whatever somebody happened to leave there and let the cull read it
as permission to delete the only other copy. The same read is what makes unpairing reversible: the
photographs a ceiling has already given back have no local bytes and are owed nothing, so
re-pairing the drive is the only thing that can find them, and it does.

**Stopping a backup offers to fetch those photographs back first.** With that chosen, every
original only the folder holds is pulled onto this device under the pass's own exclusion, so a cull
cannot give one back mid-fetch, and the folder is forgotten only once none is left there alone. One
that does not come back keeps the folder paired and says how many.

Nothing overwrites, either. A name already taken by something that is not this photograph is
skipped and reported, as §7.7 has it.

### 14.4 An original is reached through one module

`Originals` (`services/blobs/originals.ts`) is the only way to a photograph's bytes. `here` answers
what is on this disk; `open` fetches it back from the folder first when it is not, and records the
access; `openAll` does the same for a composite's frames.

Everything that decodes, exports, measures or hands over a RAW goes through it - the rendition
build, the image routes, the embedded JPEG, the download, the quality page - and gets a path back.
That is the point: the decoders, the render pipeline and the routes were written against a path and
still are, and the one thing that knows a photograph's bytes might be on a drive is this class.
A fetch is a whole-file copy over whatever the mount is, and the queue takes pulls before pushes so
that opening one photograph does not wait out a backup pass of ten thousand.

**The fetch is at the top of a flow, not inside it.** The prepare route, the export and the
composite service ask for every file the work is about to open before they start, so the renderers
below them still take a path and decode it. A merge opens each frame several times over, and `open`
on a file that is already here is a stat.

**A folder that is not there is `UNAVAILABLE`, not `NOT_FOUND`.** The file exists, the answer
changes when the drive does, and what the reader is told is which folder to connect.

A caller that would rather do without than wait uses `here`: a metadata refresh over a selection, a
grid tile repairing itself, the detail view's "is it here". Fetching a RAW per row would turn a
stat into an hour.

### 14.5 The cull, and the one deletion

Per library, `replication_libraries.local_budget_bytes`, null for no ceiling. Over it, local copies
are given back **least recently wanted first**: `photos.last_accessed_at`, which `Originals` writes
on every open, and which the viewer's own route writes when it serves a `full` or a `max` - looking
at a photograph is wanting it. A photograph nothing has ever opened falls back to when it was
added, so a first cull gives back the oldest imports rather than treating a whole library as
equally cold. A photograph fetched back is, by the same rule, the most recently wanted thing in the
library, so the next cull takes something else.

Each copy goes through the same eviction the manual action does (§7.6), and there the two kinds of
peer part: a device is **asked**, because only it can say what it holds at that moment and its yes
is a promise it keeps by refusing to evict its own copy at the same time; a folder is **read**,
because it promises nothing.

So `deleteBackedUpOriginal` (`utils/deletions.ts`, the only module allowed to remove anything)
hashes both files itself, at the moment of the unlink, and refuses unless all three agree: the
backup's bytes, this device's bytes, and the hash the catalogue recorded. Reading the local copy as
well as the backup's is the half that is easy to argue away and the one that matters most - a copy
that has rotted here does not hash to the recorded value, and deleting it because "the backup has a
good copy" is only correct if the backup's copy is of *this* file, which the recorded hash is the
whole of the evidence for. Two passes over two files per photograph, on an action that runs when a
disk is full and never in a hot path.

What is left behind is `is_missing` with a `backup_locations` row, which is `is_offloaded` on the
wire: a snowflake on the tile, the state line in the detail panel, and a count in the backup panel.
Everything still works - the renditions are here, the photograph sorts, rates, culls, shows and
opens in the editor - and anything that needs the RAW fetches it, slowly, once.

### 14.6 What is not built here

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
