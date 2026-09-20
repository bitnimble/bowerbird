#!/usr/bin/env bash
# Re-point this worktree's submodules at the main clone, as git worktrees of it,
# so commits made here live in the main clone's object store and survive
# `git worktree remove`.
set -euo pipefail

wt=$(git rev-parse --show-toplevel)
main=$(git worktree list --porcelain | sed -n '1s/^worktree //p')
[ "$wt" = "$main" ] && { echo "$wt is the main worktree"; exit 0; }

while read -r _ path; do
  # Without this, rev-parse below walks up and answers with the superproject.
  [ -e "$main/$path/.git" ] || { echo "$path: not checked out in $main" >&2; exit 1; }
  gitdir=$(git -C "$main/$path" rev-parse --absolute-git-dir)
  case "$gitdir" in *"/worktrees/"*) echo "$path: main clone is itself a worktree" >&2; exit 1;; esac

  # core.worktree is shared across worktrees unless this is on, so a `submodule
  # update` in any worktree repoints the main tree's checkout at that worktree.
  # Keyed on the shared setting still being there rather than on the extension
  # being off: `submodule update` puts it back long after the extension is on,
  # and a shared core.worktree beats every worktree's own. It is also relative to
  # the main clone's gitdir, so from a linked worktree - two directories deeper -
  # it resolves onto the module's gitdir, and the submodule reads as every file
  # deleted and git's own internals untracked.
  cw=$(git -C "$gitdir" config --local --get core.worktree || true)
  if [ -n "$cw" ]; then
    git -C "$gitdir" config extensions.worktreeConfig true
    git -C "$gitdir" config --worktree core.worktree "$cw"
    git -C "$gitdir" config --unset-all --local core.worktree
  fi

  pinned=$(git -C "$wt" rev-parse "HEAD:$path")
  if [ -e "$wt/$path/.git" ]; then
    [ -n "$(git -C "$wt/$path" status --porcelain)" ] && { echo "$path: uncommitted changes" >&2; exit 1; }
    shared=$(git -C "$wt/$path" rev-parse --path-format=absolute --git-common-dir)
    [ "$shared" = "$gitdir" ] && { echo "$path: already shared"; continue; }
    git -C "$gitdir" fetch -q "$wt/$path" HEAD
    pinned=$(git -C "$wt/$path" rev-parse HEAD)
    for tip in $(git -C "$wt/$path" for-each-ref --format='%(objectname)' refs/heads); do
      git -C "$gitdir" cat-file -e "$tip^{commit}" 2>/dev/null ||
        { echo "$path: branch tip $tip is only in this clone; push or fetch it first" >&2; exit 1; }
    done
    rm -rf "$wt/$path"
  fi

  branch="sub/$(basename "$wt")"
  git -C "$gitdir" worktree prune
  git -C "$gitdir" worktree add -q -B "$branch" "$wt/$path" "$pinned"
  echo "$path -> worktree of $gitdir on $branch"
done < <(git config -f "$wt/.gitmodules" --get-regexp '^submodule\..*\.path$')
