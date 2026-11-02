# Persian presentation & performance overlay

Based on upstream v0.13.0. Scope: message prose, Markdown lists/quotes/tables,
oversized raw messages, the chat composer, and low-conflict performance
optimizations across hot paths. No account, model, session, authentication, or
UI-language changes.

Prose blocks choose direction from the dominant Arabic/Hebrew versus Latin
letters, not the first strong character. A tie in mixed prose favours RTL;
scriptless blocks stay `auto`. List markers follow the majority of immediate
items. Code and visible autolink URLs do not decide surrounding prose; code
fences, inline code and display mathematics stay LTR and isolated. In the
composer, Markdown code/URLs do not choose direction; a leading `!` shell
command stays LTR. Explicit RTL/LTR direction avoids CSS `unicode-bidi:
plaintext`, which would otherwise override it for a Latin-first sentence.
Multi-paragraph drafts still share one textarea direction (not per-paragraph).

## Performance & upstream-friendly (zero-conflict) design

To keep `git rebase` against upstream `@agegr/pi-web` releases effortless, custom
logic lives in standalone modules (`lib/text-direction.ts`, `lib/perf-cache.ts`,
and `bin/sync-upstream.sh`) with minimal 1-to-3 line touchpoints in upstream files:

- **`lib/text-direction.ts`**:
  - Bounded script sampling (`4 KB` prose / `8 KB` composer) + single-entry
    memoization so multi-megabyte raw messages and keystrokes in `ChatInput`
    stay sub-millisecond.
  - Single-pass bottom-up `rehypeProseDirection()` HAST plugin (moved out of
    `lib/markdown.ts` so `lib/markdown.ts` only carries a 1-line import).
- **`components/MessageView.tsx` & `components/ChatMinimap.tsx`**:
  - `SafeMarkdownBody` is wrapped in `React.memo` so hover state toggles on
    message bubbles do not re-render or re-scan message bodies.
  - `AssistantOutline` in `ChatMinimap.tsx` memoizes `ReactMarkdown` `components`
    via refs and compares `turnNode` so `onMouseMove` across the minimap never
    re-parses assistant Markdown outlines.
- **`hooks/useStreamingSelector.ts`**:
  - Coalesces bursty mid-frame SSE streaming deltas via `requestAnimationFrame`
    (after painting the first delta of each frame immediately) while keeping
    boolean selectors and stream start/end transitions synchronous.
- **`lib/perf-cache.ts`**:
  - `getEntriesByIdMap()`: mutation-safe `WeakMap` index of `SessionEntry[]` so
    `sliceActiveBranch`, `countTurnsBefore`, `getSessionSettings`, and
    `collectTranscriptNotices` share one lookup map instead of rebuilding
    `new Map()` repeatedly.
  - `getDirectSessionSettings()`: resolves active branch `model` and
    `thinkingLevel` by walking `parentId` from `leafId` without copying or
    reversing the full branch array.
  - `getCachedSessionStats()` & `getCachedSessionTree()`: `WeakMap` caches on
    `SessionManager` instances shared by `GET /api/sessions/[id]` and
    `POST /api/sessions/stats` (alongside `computeLiveSessionTotalActiveMs` and
    concurrent `Promise.all` stats reads).
  - `getCachedTranscriptNotices()`: caches computed cache-miss/warm notices per
    `(entries, leafId)` across history pagination requests.
  - `canSkipSearchJsonLine()`: fast pre-filter in `lib/session-search.ts` that
    skips non-message lines and non-matching plain lines before `JSON.parse`.
- **`lib/file-fuzzy.ts` & `app/api/file-index/route.ts`**:
  - `WeakMap`-cached `{ lowerPath, lowerName, depth }` per `FileIndexEntry` and
    an $O(1)$ cursor index replacing `queue.shift()` in `listWithWalk`.
- **`bin/sync-upstream.sh`**:
  - Automated upstream synchronization helper (`./bin/sync-upstream.sh --check`
    and `./bin/sync-upstream.sh --apply`) that verifies zero-conflict rebasing
    with `git merge-tree`, creates a safety backup branch, rebases onto
    `agegr/pi-web` (reusing the existing `origin` remote instead of adding a
    duplicate), runs `tsc --noEmit` plus the overlay tests, and pushes the
    rewritten branch to `backup/main` with `--force-with-lease` so the cron
    deploy pipeline (`~/.config/pi-web/sync.sh`) picks it up.

Production launcher: `/home/ubuntu/.config/pi-web/start.sh`.
The original installed package at `/usr/lib/node_modules/@agegr/pi-web` is left
untouched. To roll back, restore the saved launcher (start.before-persian.sh)
and restart only PM2 process `pi-web-ui`.

Build in this isolated source directory, not in the installed package or a
running development server. Targeted tests were run with user approval. A source change alone does not
publish the production UI; build/restart and live-page checks are separate.

## Two-way sync with GitHub

Since 2026-11-02 `~/.config/pi-web/sync.sh` runs from cron every three minutes.
Local edits in this directory are committed and pushed to `backup/main`
(`hamedharami-hub/pi-web-persian`) after a secret/size check. Commits that
arrive on `main` from anywhere else are fetched, rebased when needed and, for
runtime changes, rebuilt in `~/projects/pi-web-build`, swapped into `.next` and
applied with a PM2 restart plus an HTTP health check — only while the app is
idle. Docs-only changes skip the rebuild. Pause with
`touch ~/.config/pi-web/sync.pause`; log at `~/.config/pi-web/sync.log`.

Sync pipeline verified end-to-end on 2026-11-02 (GitHub pull and local push).
