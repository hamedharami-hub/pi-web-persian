#!/usr/bin/env bash
# Safe, zero-conflict upstream synchronization helper for pi-web-persian.
# Usage:
#   ./bin/sync-upstream.sh --check              # Fetch upstream and test if rebase is conflict-free
#   ./bin/sync-upstream.sh --apply [ref]        # Create backup branch, rebase onto upstream/main (or ref), and run tests

set -euo pipefail

UPSTREAM_URL="https://github.com/agegr/pi-web.git"
UPSTREAM_REMOTE="upstream"
MODE="${1:---check}"
TARGET_REF="${2:-upstream/main}"

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "Error: must be run inside the pi-web git repository." >&2
  exit 1
fi

if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "Error: working tree has uncommitted changes. Commit or stash them first." >&2
  exit 1
fi

if ! git remote get-url "$UPSTREAM_REMOTE" >/dev/null 2>&1; then
  echo "Adding remote '$UPSTREAM_REMOTE' -> $UPSTREAM_URL"
  git remote add "$UPSTREAM_REMOTE" "$UPSTREAM_URL"
fi

echo "Fetching latest commits and tags from $UPSTREAM_REMOTE..."
git fetch "$UPSTREAM_REMOTE" --tags --prune

CURRENT_BRANCH="$(git rev-parse --abbrev-ref HEAD)"
BASE_COMMIT="$(git merge-base HEAD "$TARGET_REF")"
UPSTREAM_COMMIT="$(git rev-parse "$TARGET_REF")"

if [ "$BASE_COMMIT" = "$UPSTREAM_COMMIT" ]; then
  echo "Already up to date with $TARGET_REF ($UPSTREAM_COMMIT)."
  exit 0
fi

echo "New upstream commits in $TARGET_REF:"
git log --oneline "${BASE_COMMIT}..${TARGET_REF}" | head -n 20

if git merge-tree --write-tree HEAD "$TARGET_REF" >/dev/null 2>&1; then
  echo "Conflict check passed: 0 merge conflicts detected with $TARGET_REF."
else
  echo "Warning: potential conflict detected by git merge-tree against $TARGET_REF." >&2
  if [ "$MODE" = "--check" ]; then
    exit 2
  fi
fi

if [ "$MODE" = "--check" ]; then
  echo "Dry-run complete. Run './bin/sync-upstream.sh --apply $TARGET_REF' to apply."
  exit 0
fi

if [ "$MODE" != "--apply" ]; then
  echo "Usage: $0 [--check | --apply] [target-ref]" >&2
  exit 1
fi

BACKUP_BRANCH="backup/pre-upstream-$(date +%Y%m%d-%H%M%S)"
echo "Creating safety backup branch: $BACKUP_BRANCH"
git branch "$BACKUP_BRANCH" HEAD

echo "Rebasing $CURRENT_BRANCH onto $TARGET_REF..."
if ! git rebase "$TARGET_REF"; then
  echo "Rebase encountered a conflict. Aborting and restoring $BACKUP_BRANCH..." >&2
  git rebase --abort || true
  git reset --hard "$BACKUP_BRANCH"
  exit 1
fi

echo "Running targeted overlay & cache tests..."
node --experimental-strip-types --test lib/text-direction.test.mjs lib/perf-cache.test.mjs

echo "Successfully rebased onto $TARGET_REF! Backup branch kept at: $BACKUP_BRANCH"
