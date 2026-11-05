"use client";

import { useEffect, useRef, useState, type ComponentProps } from "react";
import { ChatWindow } from "./ChatWindow";
import type { ChatInputHandle } from "./ChatInput";
import { useI18n } from "@/hooks/useI18n";
import type { SessionInfo } from "@/lib/types";

type ChatProps = ComponentProps<typeof ChatWindow>;

interface Props extends Pick<ChatProps, "modelsRefreshKey" | "onOpenFile" | "onOpenSubagent" | "onToolEnd" | "onFilesUploaded" | "initialPrompt" | "onInitialPromptConsumed" | "soundEnabled" | "onSoundToggle" | "playDoneSound" | "unlockAudio" | "holdAudio" | "quoteSelectionEnabled" | "onSessionForked" | "onOpenSettings"> {
  sessionId: string;
  running: boolean;
}

const RETRY_MS = 1000;

/**
 * A subagent's or side chat's right-panel tab: the chat, scoped to that
 * session. It is never the page's main chat: no URL, no sidebar row, and the
 * page's global shortcuts stay with the main chat. Info is fetched here because
 * a tab opens by id, and again while a run just started has no session to read.
 */
export function SessionChatPanel({ sessionId, running, ...chatProps }: Props) {
  const { t } = useI18n();
  const [info, setInfo] = useState<SessionInfo | null>(null);
  const [state, setState] = useState<"loading" | "missing" | "error">("loading");
  const [retryKey, setRetryKey] = useState(0);
  const [stopBusy, setStopBusy] = useState(false);
  const [stopError, setStopError] = useState<string | null>(null);
  // Edit from here, dropped files and a failed send's text all reach the composer through this.
  const chatInputRef = useRef<ChatInputHandle | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    let retry: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      try {
        const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}`, { signal: controller.signal, cache: "no-store" });
        if (res.status === 404) {
          setState("missing");
          if (running) retry = setTimeout(() => void load(), RETRY_MS);
          return;
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json() as { info?: SessionInfo };
        if (data.info) setInfo(data.info);
        else throw new Error("Missing session info");
      } catch {
        if (!controller.signal.aborted) {
          setState("error");
          if (running) retry = setTimeout(() => void load(), RETRY_MS);
        }
      }
    };
    void load();
    return () => {
      controller.abort();
      clearTimeout(retry);
    };
  }, [sessionId, running, retryKey]);

  if (info) {
    const subagent = info.relation?.kind === "subagent" ? info.relation : null;
    const canStopSubagent = subagent && (running || subagent.status === "running" || subagent.status === "queued");
    const stopSubagent = async () => {
      setStopBusy(true);
      setStopError(null);
      try {
        const res = await fetch(`/api/subagents/${encodeURIComponent(sessionId)}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "abort" }),
        });
        const body = await res.json().catch(() => ({})) as { error?: string };
        if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
        setInfo((current) => current?.relation?.kind === "subagent"
          ? { ...current, relation: { ...current.relation, status: "aborted" } }
          : current);
      } catch (error) {
        setStopError(error instanceof Error ? error.message : String(error));
      } finally {
        setStopBusy(false);
      }
    };
    return <div style={{ height: "100%", display: "flex", flexDirection: "column", minHeight: 0 }}>
      {canStopSubagent && <div style={{ padding: "4px 10px", flexShrink: 0 }}>
        <button type="button" disabled={stopBusy} onClick={() => void stopSubagent()}>{t("chat.stopAgent")}</button>
        {stopError && <span role="alert">{stopError}</span>}
      </div>}
      <div style={{ flex: 1, minHeight: 0 }}><ChatWindow {...chatProps} session={info} sessionRunning={running} newSessionCwd={null} newSessionDraftKey={null} chatInputRef={chatInputRef} panel /></div>
    </div>;
  }
  return (
    <div role={state === "error" ? "alert" : undefined} style={{ padding: "24px 16px", color: "var(--text-dim)", fontSize: 12, textAlign: "center" }}>
      {t(state === "loading" || (state === "missing" && running) ? "sessionPanel.loading" : state === "missing" ? "sessionPanel.missing" : "sessionPanel.error")}
      {state === "error" && <div><button type="button" onClick={() => { setState("loading"); setRetryKey((key) => key + 1); }}>{t("sessionPanel.retry")}</button></div>}
    </div>
  );
}
