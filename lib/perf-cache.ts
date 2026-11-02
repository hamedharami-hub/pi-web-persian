import { projectTreeForResponse, toSummaryTree, type SummaryTreeNode } from "./project-tree";
import { computeSessionStats, type SessionFileStats } from "./session-stats";
import type { TranscriptNotice } from "./transcript-notices";
import type { SessionContext, SessionEntry } from "./types";

interface CachedEntryIndex {
  length: number;
  lastId: string | undefined;
  map: Map<string, SessionEntry>;
}

const entryIndexCache = new WeakMap<readonly SessionEntry[], CachedEntryIndex>();

/**
 * Returns a cached `id -> SessionEntry` lookup map for an entries array.
 * Avoids rebuilding `new Map()` three times per `buildSessionContext` call
 * (in `sliceActiveBranch`, `countTurnsBefore`, and `getSessionSettings`),
 * while staying safe when a live SessionManager appends entries in-place.
 */
export function getEntriesByIdMap(entries: readonly SessionEntry[]): Map<string, SessionEntry> {
  const len = entries.length;
  const lastId = len > 0 ? entries[len - 1]?.id : undefined;
  const cached = entryIndexCache.get(entries);
  if (cached) {
    if (cached.length === len && cached.lastId === lastId) {
      return cached.map;
    }
    // Fast incremental update if entries only grew at the tail.
    if (len > cached.length) {
      for (let i = cached.length; i < len; i++) {
        const entry = entries[i];
        if (entry) cached.map.set(entry.id, entry);
      }
      cached.length = len;
      cached.lastId = lastId;
      return cached.map;
    }
  }

  const map = new Map<string, SessionEntry>();
  for (let i = 0; i < len; i++) {
    const entry = entries[i];
    if (entry) map.set(entry.id, entry);
  }
  entryIndexCache.set(entries, { length: len, lastId, map });
  return map;
}

/**
 * Walks backwards from `leafId` using the cached `byId` map to resolve the
 * active branch's `thinkingLevel` and `model` without allocating or reversing
 * the entire branch array via `sliceActiveBranch(..., entries.length)`.
 */
export function getDirectSessionSettings(
  entries: readonly SessionEntry[],
  leafId?: string | null,
): Pick<SessionContext, "thinkingLevel" | "model"> {
  if (leafId === null || entries.length === 0) {
    return { thinkingLevel: "off", model: null };
  }
  const byId = getEntriesByIdMap(entries);
  let current: SessionEntry | undefined = leafId ? byId.get(leafId) : entries[entries.length - 1];

  let thinkingLevel: string | undefined;
  let modelChange: SessionContext["model"] | undefined;
  let responseModel: SessionContext["model"] | undefined;

  while (current && (thinkingLevel === undefined || modelChange === undefined)) {
    if (thinkingLevel === undefined && current.type === "thinking_level_change") {
      thinkingLevel = current.thinkingLevel;
    }
    if (modelChange === undefined && current.type === "model_change") {
      modelChange = { provider: current.provider, modelId: current.modelId };
    }
    if (
      modelChange === undefined &&
      responseModel === undefined &&
      current.type === "message" &&
      current.message.role === "assistant"
    ) {
      const message = current.message as { provider?: unknown; model?: unknown };
      if (typeof message.provider === "string" && typeof message.model === "string") {
        responseModel = { provider: message.provider, modelId: message.model };
      }
    }
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }

  return {
    thinkingLevel: thinkingLevel ?? "off",
    model: modelChange ?? responseModel ?? null,
  };
}

interface CachedStatsEntry {
  entryCount: number;
  lastEntryId: string | undefined;
  stats: SessionFileStats;
}

const sessionStatsCache = new WeakMap<object, CachedStatsEntry>();

/**
 * Reuses `computeSessionStats(entries)` for a SessionManager instance until its
 * entry count or last entry ID changes, matching `computeLiveSessionTotalActiveMs`.
 */
export function getCachedSessionStats(
  manager: object,
  entries: readonly SessionEntry[],
): SessionFileStats {
  const entryCount = entries.length;
  const lastEntryId = (entries[entryCount - 1] as { id?: string } | undefined)?.id;
  const cached = sessionStatsCache.get(manager);
  if (cached && cached.entryCount === entryCount && cached.lastEntryId === lastEntryId) {
    return cached.stats;
  }
  const stats = computeSessionStats(entries as SessionEntry[]);
  sessionStatsCache.set(manager, { entryCount, lastEntryId, stats });
  return stats;
}

interface CachedTreeEntry {
  entryCount: number;
  lastEntryId: string | undefined;
  projected?: unknown[];
  summary?: SummaryTreeNode[];
}

const sessionTreeCache = new WeakMap<object, CachedTreeEntry>();

/**
 * Reuses `projectTreeForResponse(sm.getTree())` and `toSummaryTree(...)` for a
 * SessionManager instance while its entries are unchanged.
 */
export function getCachedSessionTree<T extends Parameters<typeof projectTreeForResponse>[0][number]>(
  manager: object,
  entries: readonly unknown[],
  summaryTree: boolean,
  getRawTree: () => T[],
): T[] | SummaryTreeNode[] {
  const entryCount = entries.length;
  const lastEntryId = (entries[entryCount - 1] as { id?: string } | undefined)?.id;
  let cached = sessionTreeCache.get(manager);
  if (!cached || cached.entryCount !== entryCount || cached.lastEntryId !== lastEntryId) {
    cached = { entryCount, lastEntryId };
    sessionTreeCache.set(manager, cached);
  }
  if (!cached.projected) {
    cached.projected = projectTreeForResponse(getRawTree());
  }
  if (!summaryTree) {
    return cached.projected as T[];
  }
  if (!cached.summary) {
    cached.summary = toSummaryTree(cached.projected as Parameters<typeof toSummaryTree>[0]);
  }
  return cached.summary;
}

interface CachedNoticesEntry {
  length: number;
  lastId: string | undefined;
  leafId: string | null | undefined;
  hasRuntimeModels: boolean;
  notices: Map<string, TranscriptNotice[]>;
}

const transcriptNoticesCache = new WeakMap<readonly SessionEntry[], CachedNoticesEntry>();

/**
 * Caches `collectTranscriptNotices` per `(entries, leafId)` so repeated history
 * pagination requests (`GET /api/sessions/[id]/context?before=...`) do not
 * rescan the entire session log on every scroll page.
 */
export function getCachedTranscriptNotices(
  entries: readonly SessionEntry[],
  leafId: string | null | undefined,
  hasRuntimeModels: boolean,
  compute: () => Map<string, TranscriptNotice[]>,
): Map<string, TranscriptNotice[]> {
  const len = entries.length;
  const lastId = len > 0 ? entries[len - 1]?.id : undefined;
  const cached = transcriptNoticesCache.get(entries);
  if (
    cached &&
    cached.length === len &&
    cached.lastId === lastId &&
    cached.leafId === leafId &&
    cached.hasRuntimeModels === hasRuntimeModels
  ) {
    return cached.notices;
  }
  const notices = compute();
  transcriptNoticesCache.set(entries, {
    length: len,
    lastId,
    leafId,
    hasRuntimeModels,
    notices,
  });
  return notices;
}

// Characters that JSON string serialization escapes; when absent from the query
// and the raw line has no `\uXXXX` escape, a match in decoded text must also
// match the raw JSONL line directly.
const JSON_ESCAPED_QUERY_CHAR = /[\x00-\x1f\\"\/]/;

/**
 * Fast pre-filter before `JSON.parse(line)` during full-text session search.
 * Skips non-message JSONL lines (e.g. compaction/custom/header entries) and
 * skips massive toolResult/message lines when a plain query does not appear in
 * the raw line and the line contains no `\uXXXX` unicode escapes.
 */
export function canSkipSearchJsonLine(
  line: string,
  needle: string,
  matcher: RegExp,
): boolean {
  if (!line.includes('"message"')) return true;
  if (!JSON_ESCAPED_QUERY_CHAR.test(needle) && !line.includes("\\u")) {
    matcher.lastIndex = 0;
    if (!matcher.test(line)) return true;
  }
  return false;
}
