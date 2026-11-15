"use client";

import { stripAnsi } from "@/lib/ansi";
import type { ExtensionStatusItem, ExtensionWidgetItem } from "@/lib/types";
import { AnsiText } from "./AnsiText";
import { ExtensionWidgets } from "./ExtensionWidgets";

/**
 * `ctx.ui.setStatus("command:/mode toggle", "Build")` shows "Build" as a button
 * that sends `/mode toggle`. The command lives in the key because setStatus has
 * no room for it, and Pi's own footer prints only the text, so the same status
 * is still plain text there.
 */
export const EXTENSION_STATUS_COMMAND_PREFIX = "command:";

/** The slash command a status key asks for, or null for an ordinary status. */
export function extensionStatusCommand(key: string): string | null {
  if (!key.startsWith(EXTENSION_STATUS_COMMAND_PREFIX)) return null;
  const command = key.slice(EXTENSION_STATUS_COMMAND_PREFIX.length).trim();
  return command.length > 1 && command.startsWith("/") ? command : null;
}

export function sanitizeExtensionStatusText(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/\t/g, " ").replace(/ +/g, " ").trim())
    .join("\n")
    .trim();
}

const WORKFLOW_STATUS_PRIORITY = new Map<string, number>([
  ["command:/plan", -40],
  ["command:/agents", -35],
  ["command:/team", -35],
  ["command:/agents select", -30],
  ["command:/team select", -30],
  ["command:/goal", -20],
  ["command:/goal plan", -18],
  ["command:/goal clear", -16],
  ["command:/plan execute", -10],
  ["command:/todos", -8],
  ["command:/todos refine", -6],
  ["command:/todos clear", -4],
  ["plan-mode", -2],
]);

const REDUNDANT_WHEN_PLAN_OPEN = new Set<string>([
  "command:/plan execute",
  "command:/todos refine",
  "command:/todos clear",
  "plan-mode",
]);

export type StatusGroup = "mode" | "goal" | "plan" | "other";

export function getStatusSortPriority(key: string): number {
  return WORKFLOW_STATUS_PRIORITY.get(key) ?? 0;
}

export function getStatusGroup(key: string): StatusGroup {
  if (
    key === "command:/plan"
    || key === "command:/agents"
    || key === "command:/agents select"
    || key === "command:/team"
    || key === "command:/team select"
  ) {
    return "mode";
  }
  if (key.startsWith("command:/goal")) return "goal";
  if (
    key === "command:/plan execute"
    || key === "command:/todos"
    || key === "command:/todos refine"
    || key === "command:/todos clear"
    || key === "plan-mode"
  ) {
    return "plan";
  }
  return "other";
}

function sortedStatuses(statuses: ExtensionStatusItem[]): ExtensionStatusItem[] {
  return [...statuses].sort((a, b) => {
    const priorityDiff = getStatusSortPriority(a.key) - getStatusSortPriority(b.key);
    return priorityDiff !== 0 ? priorityDiff : a.key.localeCompare(b.key);
  });
}

export function filterStatusesForExpandedWidget(
  statuses: ExtensionStatusItem[],
  expandedWidgetKey: string | null,
  hasCommandHandler: boolean,
): ExtensionStatusItem[] {
  if (expandedWidgetKey !== "plan-todos" || !hasCommandHandler) return statuses;
  return statuses.filter((item) => !REDUNDANT_WHEN_PLAN_OPEN.has(item.key));
}

export function formatExtensionStatusLine(statuses: ExtensionStatusItem[]): string {
  return sortedStatuses(statuses)
    .map(({ text }) => sanitizeExtensionStatusText(text))
    .join(" ");
}

type StatusCell =
  | { kind: "text"; key: string; group: StatusGroup; text: string }
  | { kind: "command"; key: string; group: StatusGroup; command: string; label: string };

type StatusCellVariant = "active" | "primary" | "danger" | "subtle";

function getStatusCellVariant(cell: StatusCell): StatusCellVariant | undefined {
  if (cell.kind !== "command") return undefined;
  if (cell.command === "/plan execute") return "primary";
  if (cell.command === "/todos clear" || cell.command === "/goal clear") return "danger";
  if (
    (cell.command === "/plan" && /\bON\b/i.test(cell.label))
    || ((cell.command === "/agents" || cell.command === "/team") && /\bON\b/i.test(cell.label))
    || (cell.command === "/goal" && /Edit goal/i.test(cell.label))
  ) {
    return "active";
  }
  if (cell.command === "/todos refine" || cell.command === "/todos" || cell.command === "/goal plan") {
    return "subtle";
  }
  return undefined;
}

/** One cell per status, grouped semantically. A status with nothing visible to show has no cell. */
export function buildExtensionStatusCells(statuses: ExtensionStatusItem[]): StatusCell[] {
  const cells: StatusCell[] = [];
  for (const item of sortedStatuses(statuses)) {
    const text = sanitizeExtensionStatusText(item.text);
    const command = extensionStatusCommand(item.key);
    const group = getStatusGroup(item.key);
    if (command) {
      const label = stripAnsi(text).replace(/\s+/g, " ").trim();
      cells.push({ kind: "command", key: item.key, group, command, label: label || command });
    } else if (stripAnsi(text).trim()) {
      cells.push({ kind: "text", key: item.key, group, text });
    }
  }
  return cells;
}

export function ExtensionStatusBar({
  statuses,
  widgets = [],
  onCommand,
  commandsDisabled = false,
}: {
  statuses: ExtensionStatusItem[];
  widgets?: ExtensionWidgetItem[];
  /** Sends the command of a `command:` status; without it those buttons stay disabled. */
  onCommand?: (command: string) => void;
  commandsDisabled?: boolean;
}) {
  const baseCells = buildExtensionStatusCells(statuses);
  if (baseCells.length === 0 && widgets.length === 0) return null;

  const hasCommands = baseCells.some((cell) => cell.kind === "command");

  const renderStatusLine = (expandedWidgetKey: string | null) => {
    const visibleStatuses = filterStatusesForExpandedWidget(statuses, expandedWidgetKey, Boolean(onCommand));
    const cells = buildExtensionStatusCells(visibleStatuses);
    if (cells.length === 0) return null;

    const plainStatusLine = cells
      .map((cell) => (cell.kind === "text" ? stripAnsi(cell.text) : cell.label))
      .join(" ");

    return (
      <div
        role="status"
        className="extension-status-line"
        aria-label={plainStatusLine}
        title={plainStatusLine}
      >
        <span className="extension-status-text">
          {cells.map((cell, index) => {
            const prevGroup = index > 0 ? cells[index - 1].group : cell.group;
            const showDivider = index > 0 && prevGroup !== cell.group;
            const element = cell.kind === "text" ? (
              <span key={cell.key} className="extension-status-item">
                <AnsiText text={cell.text} />
              </span>
            ) : (
              <button
                key={cell.key}
                type="button"
                className="extension-status-item extension-status-command"
                data-variant={getStatusCellVariant(cell)}
                disabled={!onCommand || commandsDisabled}
                title={`${cell.label} · ${cell.command}`}
                aria-label={`${cell.label} (${cell.command})`}
                onClick={() => onCommand?.(cell.command)}
              >
                {cell.label}
              </button>
            );
            return showDivider
              ? [<span key={`sep-${cell.key}`} className="extension-status-divider" aria-hidden="true" />, element]
              : element;
          })}
        </span>
      </div>
    );
  };

  return (
    <div
      className={`extension-status-shelf${widgets.length > 0 ? " has-widgets" : ""}${baseCells.length > 0 ? " has-status" : ""}${hasCommands ? " has-commands" : ""}`}
    >
      {widgets.length > 0 ? (
        <ExtensionWidgets widgets={widgets} onCommand={onCommand} commandsDisabled={commandsDisabled}>
          {({ expandedWidgetKey }) => renderStatusLine(expandedWidgetKey)}
        </ExtensionWidgets>
      ) : renderStatusLine(null)}
    </div>
  );
}
