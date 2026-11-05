#!/usr/bin/env bash
# Rebase the Persian overlay onto upstream pi-web locally and verify it.
# Never push the rewritten branch automatically.
#
#   ./bin/sync-upstream.sh --check                 # fetch and check for conflicts
#   ./bin/sync-upstream.sh --apply [ref]           # rebase and verify locally
#   ./bin/sync-upstream.sh --apply ref --no-push   # same (legacy option)
#
# Upstream remote is reused when one already points at agegr/pi-web (this repo's
# `origin`), so no duplicate remote is created. Local edits are committed by
# ~/.config/pi-web/sync.sh every three minutes; this script refuses to run on a
# dirty tree and never resets --hard.
set -euo pipefail

UPSTREAM_URL="https://github.com/agegr/pi-web.git"
MODE="${1:---check}"
[ "$#" -eq 0 ] || shift
TARGET_REF=""
NO_PUSH_SEEN=0
usage() { echo "Usage: $0 [--check | --apply] [target-ref] [--no-push]" >&2; exit 1; }
case "$MODE" in --check|--apply) ;; *) usage ;; esac
for arg in "$@"; do
  case "$arg" in
    --no-push) [ "$NO_PUSH_SEEN" = 0 ] || usage; NO_PUSH_SEEN=1 ;;
    -*) usage ;;
    *) [ -z "$TARGET_REF" ] || usage; TARGET_REF="$arg" ;;
  esac
done

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
# A tag-only fetch refspec can leave an existing remote-tracking main stale.
# Refresh it explicitly even when the ref already resolves.
if [ "$TARGET_REF" = "$upstream_remote/main" ] || [ "$TARGET_REF" = "refs/remotes/$upstream_remote/main" ]; then
  git fetch "$upstream_remote" "+refs/heads/main:refs/remotes/$upstream_remote/main"
fi
if ! git rev-parse --verify -q "${TARGET_REF}^{commit}" >/dev/null 2>&1; then
  # A partial or single-tag clone has no branch refspec yet; fetch the upstream
  # branches so the default target resolves.
  echo "Resolving $TARGET_REF ..."
  git fetch "$upstream_remote" "+refs/heads/*:refs/remotes/$upstream_remote/*"
fi

target="$(git rev-parse --verify "${TARGET_REF}^{commit}")"
base="$(git merge-base HEAD "$target")"
if [ "$base" = "$target" ]; then
  echo "Already up to date with $TARGET_REF ($target)."
  if [ "$MODE" = "--check" ]; then exit 0; fi
  echo "Verifying the current branch (including any previous rebase) ..."
  NODE_OPTIONS="${NODE_OPTIONS:---max-old-space-size=1536}" npx tsc --noEmit
  node --experimental-strip-types --test lib/text-direction.test.mjs lib/perf-cache.test.mjs
  echo "Verification passed; no push performed."
  exit 0
fi

echo "New upstream commits in $TARGET_REF:"
git log --oneline -n 20 "$base..$target"

conflict=0
git merge-tree --write-tree HEAD "$target" >/dev/null 2>&1 || conflict=1
if [ "$conflict" = 1 ]; then
  echo "Warning: git merge-tree reports a conflict against $TARGET_REF." >&2
  [ "$MODE" = "--check" ] && exit 2
fi

if [ "$MODE" = "--check" ]; then
  echo "Dry run complete. Apply with: $0 --apply $TARGET_REF"
  exit 0
fi
branch="$(git rev-parse --abbrev-ref HEAD)"
safety_base="backup/pre-upstream-$(date +%Y%m%d-%H%M%S)"
safety="$safety_base"
suffix=0
# Branch creation is atomic: never overwrite an existing backup, even if
# another invocation chooses the same name between the check and creation.
while ! git branch "$safety" HEAD 2>/dev/null; do
  git show-ref --verify --quiet "refs/heads/$safety" || fail "could not create safety branch '$safety'"
  suffix=$((suffix + 1))
  safety="${safety_base}-${suffix}"
done
echo "Safety branch: $safety"

if ! git rebase "$target"; then
  git rebase --abort || true
  echo "Rebase conflicted and was aborted; '$branch' is unchanged ($(git rev-parse --short HEAD))." >&2
  exit 1
fi

echo "Rebased onto $TARGET_REF; verifying ..."
NODE_OPTIONS="${NODE_OPTIONS:---max-old-space-size=1536}" npx tsc --noEmit
node --experimental-strip-types --test lib/text-direction.test.mjs lib/perf-cache.test.mjs

echo "The local branch is rebased and verified; no push was performed."

echo "Done. Keep or delete the safety branch: $safety"
