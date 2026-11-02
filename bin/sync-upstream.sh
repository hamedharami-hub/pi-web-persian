#!/usr/bin/env bash
# Rebase the Persian overlay onto upstream pi-web and hand the rewritten branch
# back to the two-way sync pipeline (backup remote + cron deploy).
#
#   ./bin/sync-upstream.sh --check                 # fetch and check for conflicts
#   ./bin/sync-upstream.sh --apply [ref]           # rebase, verify, force-push to backup
#   ./bin/sync-upstream.sh --apply ref --no-push   # rebase and verify only
#
# Upstream remote is reused when one already points at agegr/pi-web (this repo's
# `origin`), so no duplicate remote is created. Local edits are committed by
# ~/.config/pi-web/sync.sh every three minutes; this script refuses to run on a
# dirty tree and never resets --hard.
set -euo pipefail

UPSTREAM_URL="https://github.com/agegr/pi-web.git"
BACKUP_REMOTE="backup"
BACKUP_BRANCH="main"

MODE="${1:---check}"
TARGET_REF="${2:-}"
PUSH=1
if [ "$TARGET_REF" = "--no-push" ]; then
  TARGET_REF="${3:-}"
  PUSH=0
fi

cd "$(git rev-parse --show-toplevel 2>/dev/null)" || { echo "Error: not inside the pi-web repository." >&2; exit 1; }

fail() { echo "Error: $*" >&2; exit 1; }

if [ -d .git/rebase-merge ] || [ -d .git/rebase-apply ] || [ -f .git/MERGE_HEAD ]; then
  fail "a rebase or merge is already in progress"
fi

if ! git diff --quiet || ! git diff --cached --quiet; then
  fail "working tree has uncommitted changes; the auto-sync commits them within ~3 minutes, rerun then"
fi

upstream_remote=""
for remote in $(git remote); do
  url="$(git remote get-url "$remote" 2>/dev/null || true)"
  case "$url" in
    *agegr/pi-web*) upstream_remote="$remote"; break ;;
  esac
done
if [ -z "$upstream_remote" ]; then
  upstream_remote="upstream"
  git remote add "$upstream_remote" "$UPSTREAM_URL"
  echo "Added remote '$upstream_remote' -> $UPSTREAM_URL"
fi
[ -n "$TARGET_REF" ] || TARGET_REF="$upstream_remote/main"

echo "Fetching $upstream_remote ..."
git fetch "$upstream_remote" --tags --prune
if ! git rev-parse --verify -q "$TARGET_REF" >/dev/null 2>&1; then
  # A partial or single-tag clone has no branch refspec yet; fetch the upstream
  # branches so the default target resolves.
  echo "Resolving $TARGET_REF ..."
  git fetch "$upstream_remote" "+refs/heads/*:refs/remotes/$upstream_remote/*"
fi

base="$(git merge-base HEAD "$TARGET_REF")"
target="$(git rev-parse "$TARGET_REF")"
if [ "$base" = "$target" ]; then
  echo "Already up to date with $TARGET_REF ($target)."
  exit 0
fi

echo "New upstream commits in $TARGET_REF:"
git log --oneline -n 20 "$base..$TARGET_REF"

conflict=0
git merge-tree --write-tree HEAD "$TARGET_REF" >/dev/null 2>&1 || conflict=1
if [ "$conflict" = 1 ]; then
  echo "Warning: git merge-tree reports a conflict against $TARGET_REF." >&2
  [ "$MODE" = "--check" ] && exit 2
fi

if [ "$MODE" = "--check" ]; then
  echo "Dry run complete. Apply with: $0 --apply $TARGET_REF"
  exit 0
fi
[ "$MODE" = "--apply" ] || fail "usage: $0 [--check | --apply] [target-ref] [--no-push]"

branch="$(git rev-parse --abbrev-ref HEAD)"
safety="backup/pre-upstream-$(date +%Y%m%d-%H%M%S)"
git branch "$safety" HEAD
echo "Safety branch: $safety"

if ! git rebase "$TARGET_REF"; then
  git rebase --abort || true
  echo "Rebase conflicted and was aborted; '$branch' is unchanged ($(git rev-parse --short HEAD))." >&2
  exit 1
fi

echo "Rebased onto $TARGET_REF; verifying ..."
NODE_OPTIONS="${NODE_OPTIONS:---max-old-space-size=1536}" npx tsc --noEmit
node --experimental-strip-types --test lib/text-direction.test.mjs lib/perf-cache.test.mjs

if [ "$PUSH" = 1 ]; then
  git fetch "$BACKUP_REMOTE" "$BACKUP_BRANCH"
  echo "Force-pushing rewritten $branch to $BACKUP_REMOTE/$BACKUP_BRANCH (lease-protected) ..."
  if git push --force-with-lease="$BACKUP_BRANCH" "$BACKUP_REMOTE" "HEAD:$BACKUP_BRANCH"; then
    echo "Pushed. The auto-sync will build and deploy at the next idle window;"
    echo "to apply immediately: /home/ubuntu/.config/pi-web/sync.sh --deploy-now"
  else
    echo "Push was rejected (someone else moved $BACKUP_REMOTE/$BACKUP_BRANCH)." >&2
    echo "Nothing was forced; reconcile, then rerun or delete $safety when done." >&2
    exit 1
  fi
else
  echo "Skipped the push (--no-push). The local branch is rebased and verified."
fi

echo "Done. Keep or delete the safety branch: $safety"
