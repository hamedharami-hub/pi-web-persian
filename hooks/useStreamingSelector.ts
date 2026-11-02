"use client";

import { useLayoutEffect, useRef, useState } from "react";
import type { StreamingState, StreamingStore } from "@/lib/streaming-message";

/**
 * One value of the streaming store; the component re-renders only when that
 * value changes. `select` must be stable (a module-level function).
 *
 * Boolean selectors (`isStreaming`, `hasStreamingContent`) and stream start/end
 * transitions (`streamingMessage === null`) update synchronously so `message_end`
 * commits the final message and hides the streaming bubble in one React batch.
 * High-frequency object updates during active streaming coalesce via
 * `requestAnimationFrame` (when available) so the first delta paints immediately
 * and bursty deltas within the same 16ms frame parse Markdown only once.
 */
export function useStreamingSelector<T>(store: StreamingStore, select: (state: StreamingState) => T): T {
  const [value, setValue] = useState(() => select(store.getState()));
  const rafRef = useRef<number | null>(null);
  const pendingRef = useRef(false);

  useLayoutEffect(() => {
    const cancelRaf = () => {
      if (rafRef.current !== null && typeof window !== "undefined" && typeof window.cancelAnimationFrame === "function") {
        window.cancelAnimationFrame(rafRef.current);
      }
      rafRef.current = null;
      pendingRef.current = false;
    };

    const update = () => {
      const state = store.getState();
      const next = select(state);
      const canBatchFrame =
        state.isStreaming &&
        typeof next === "object" &&
        next !== null &&
        typeof window !== "undefined" &&
        typeof window.requestAnimationFrame === "function";

      if (!canBatchFrame) {
        cancelRaf();
        setValue(next);
        return;
      }

      if (rafRef.current === null) {
        // First delta in this frame: commit immediately and coalesce any subsequent deltas in the same frame.
        setValue(next);
        rafRef.current = window.requestAnimationFrame(() => {
          rafRef.current = null;
          if (pendingRef.current) {
            pendingRef.current = false;
            setValue(select(store.getState()));
          }
        });
      } else {
        pendingRef.current = true;
      }
    };

    // A chunk may have landed between this render and the subscription.
    setValue(select(store.getState()));
    const unsubscribe = store.subscribe(update);
    return () => {
      cancelRaf();
      unsubscribe();
    };
  }, [store, select]);

  return value;
}

export const selectIsStreaming = (state: StreamingState) => state.isStreaming;
export const selectHasStreamingContent = (state: StreamingState) => Boolean(state.streamingMessage?.content.length);
export const selectStreamingMessage = (state: StreamingState) => state.streamingMessage;
