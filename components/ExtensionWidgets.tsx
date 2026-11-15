"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { useI18n } from "@/hooks/useI18n";
import { stripAnsi } from "@/lib/ansi";
import { AnsiText } from "@/components/AnsiText";
import type { ExtensionWidgetItem } from "@/lib/types";

export const DEFAULT_EXPANDED_WIDGET_LINES = 3;
export const WIDGET_UPDATE_IDLE_MS = 1100;

export function formatExtensionWidgetContent(lines: string[]): string {
  return lines.join("\n");
}

export function snapshotExtensionWidgetContents(
  widgets: ExtensionWidgetItem[],
): Map<string, string[]> {
  return new Map(widgets.map((widget) => [widget.key, [...widget.lines]]));
}

export function getUpdatedExtensionWidgetKeys(
  previous: ReadonlyMap<string, readonly string[]> | null,
  next: ReadonlyMap<string, readonly string[]>,
): string[] {
  if (!previous) return [];
  return Array.from(next, ([key, lines]) => {
    const previousLines = previous.get(key);
    if (!previousLines || previousLines.length !== lines.length) {
      return previousLines ? key : null;
    }
    return lines.some((line, index) => line !== previousLines[index]) ? key : null;
  }).filter((key): key is string => key !== null);
}

function getDefaultExpandedWidgetKey(widgets: ExtensionWidgetItem[]): string | null {
  const planWidget = widgets.find((widget) => widget.key === "plan-todos" && widget.lines.length > 0);
  if (planWidget) return planWidget.key;
  return widgets.find((widget) => {
    const lineCount = widget.lines.length;
    return lineCount > 1 && lineCount <= DEFAULT_EXPANDED_WIDGET_LINES;
  })?.key ?? null;
}

export interface ParsedPlanStep {
  step: number;
  text: string;
  completed: boolean;
}

export interface PlanTodosSummary {
  completed: number;
  total: number;
  status: "executing" | "planning" | "complete" | "saved";
  statusKey: string;
  paused: boolean;
  hasWarning: boolean;
  steps: ParsedPlanStep[];
}

export function parsePlanTodosSummary(lines: string[]): PlanTodosSummary | null {
  if (lines.length === 0) return null;
  const steps: ParsedPlanStep[] = [];
  let completed = 0;
  for (let i = 1; i < lines.length; i += 1) {
    const plain = stripAnsi(lines[i]).trim();
    if (!plain) continue;
    const checked = plain.startsWith("☑");
    const unchecked = plain.startsWith("☐");
    if (!checked && !unchecked) continue;
    const body = plain.slice(1).trim();
    const numMatch = body.match(/^([0-9]+)\.\s+(.*)$/);
    const stepNumber = numMatch ? Number(numMatch[1]) : steps.length + 1;
    const stepText = numMatch ? numMatch[2] : body;
    if (checked) completed += 1;
    steps.push({
      step: Number.isFinite(stepNumber) && stepNumber > 0 ? stepNumber : steps.length + 1,
      text: stepText,
      completed: checked,
    });
  }
  const headerText = stripAnsi(lines[0]).replace(/\s*—\s*\/todos\s*$/i, "").trim();
  const status = /^EXECUTING/i.test(headerText)
    ? "executing"
    : /^PLANNING/i.test(headerText)
      ? "planning"
      : /^COMPLETE/i.test(headerText)
        ? "complete"
        : "saved";
  const paused = /\(paused\)/i.test(headerText);
  const hasWarning = /⚠|failed/i.test(headerText);
  const statusKey = status === "executing"
    ? "chat.planStatus.executing"
    : status === "planning"
      ? "chat.planStatus.planning"
      : status === "complete"
        ? "chat.planStatus.complete"
        : "chat.planStatus.saved";
  return { completed, total: steps.length, status, statusKey, paused, hasWarning, steps };
}

export function getNextExpandedWidgetKey(
  currentKey: string | null,
  requestedKey: string,
): string | null {
  return currentKey === requestedKey ? null : requestedKey;
}

/**
 * `children` (the status line) joins the triggers in one row, so the whole row
 * scrolls sideways together; the expanded panel stays above it, out of the scroll.
 */
export function ExtensionWidgets({
  widgets,
  onCommand,
  commandsDisabled = false,
  children,
}: {
  widgets: ExtensionWidgetItem[];
  onCommand?: (command: string) => void;
  commandsDisabled?: boolean;
  children?: ReactNode | ((info: { expandedWidgetKey: string | null }) => ReactNode);
}) {
  const { t } = useI18n();
  const idPrefix = useId();
  const previousContentsRef = useRef<Map<string, string[]> | null>(null);
  const updateClearTimersRef = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const [expandedWidgetKey, setExpandedWidgetKey] = useState<string | null>(
    () => getDefaultExpandedWidgetKey(widgets),
  );
  const [tallPlanPanel, setTallPlanPanel] = useState(false);
  const [updatingWidgetKeys, setUpdatingWidgetKeys] = useState<ReadonlySet<string>>(
    () => new Set(),
  );

  useEffect(() => {
    const prevContents = previousContentsRef.current;
    const nextContents = snapshotExtensionWidgetContents(widgets);
    const updatedKeys = getUpdatedExtensionWidgetKeys(
      prevContents,
      nextContents,
    );
    previousContentsRef.current = nextContents;

    if (
      prevContents !== null
      && !prevContents.has("plan-todos")
      && nextContents.has("plan-todos")
      && (nextContents.get("plan-todos")?.length ?? 0) > 0
    ) {
      setExpandedWidgetKey("plan-todos");
    }

    for (const [key, timer] of updateClearTimersRef.current) {
      if (nextContents.has(key)) continue;
      clearTimeout(timer);
      updateClearTimersRef.current.delete(key);
    }

    setUpdatingWidgetKeys((current) => {
      const next = new Set(Array.from(current).filter((key) => nextContents.has(key)));
      for (const key of updatedKeys) next.add(key);
      if (
        next.size === current.size
        && Array.from(next).every((key) => current.has(key))
      ) return current;
      return next;
    });

    for (const key of updatedKeys) {
      const currentTimer = updateClearTimersRef.current.get(key);
      if (currentTimer) clearTimeout(currentTimer);
      updateClearTimersRef.current.set(key, setTimeout(() => {
        updateClearTimersRef.current.delete(key);
        setUpdatingWidgetKeys((current) => {
          if (!current.has(key)) return current;
          const next = new Set(current);
          next.delete(key);
          return next;
        });
      }, WIDGET_UPDATE_IDLE_MS));
    }
  }, [widgets]);

  useEffect(() => () => {
    for (const timer of updateClearTimersRef.current.values()) clearTimeout(timer);
    updateClearTimersRef.current.clear();
  }, []);

  if (widgets.length === 0) return null;

  const expandedWidget = widgets.find((widget) => (
    widget.key === expandedWidgetKey
    && widget.lines.length > 0
  ));

  const toggleWidget = (widget: ExtensionWidgetItem) => {
    setExpandedWidgetKey((current) => getNextExpandedWidgetKey(current, widget.key));
  };

  const resolvedExpandedKey = expandedWidget?.key ?? null;
  const isTallPlan = tallPlanPanel && resolvedExpandedKey === "plan-todos";

  return (
    <>
      {expandedWidget && (
        <div className={`extension-widget-panels${isTallPlan ? " is-tall" : ""}`}>
          {(() => {
            const widget = expandedWidget;
            const index = widgets.indexOf(widget);
            const triggerId = `${idPrefix}-trigger-${index}`;
            const panelId = `${idPrefix}-panel-${index}`;
            const planSummary = widget.key === "plan-todos" ? parsePlanTodosSummary(widget.lines) : null;
            const bodyLines = planSummary && widget.lines.length > 1 ? widget.lines.slice(1) : widget.lines;
            const showPlanActions = Boolean(onCommand) && Boolean(planSummary);
            const canRunPlan = planSummary !== null
              && planSummary.completed < planSummary.total
              && (planSummary.status !== "executing" || planSummary.paused);
            const nextPendingStep = planSummary?.steps.find((step) => !step.completed)?.step;
            return (
              <section
                key={widget.key}
                id={panelId}
                className={`extension-widget-panel${planSummary ? " is-plan-todos" : ""}`}
                aria-labelledby={triggerId}
              >
                <div className="extension-widget-panel-heading">
                  {planSummary ? (
                    <div className="plan-widget-header">
                      <div className="plan-widget-title-group">
                        <span className={`plan-widget-badge is-${planSummary.status}`}>{t(planSummary.statusKey)}</span>
                        {planSummary.hasWarning && (
                          <span className="plan-widget-warning" title={t("chat.planVerifyWarning")}>
                            ⚠
                          </span>
                        )}
                        <span className="plan-widget-key">{widget.key}</span>
                        {planSummary.total > 0 && (
                          <span className="plan-widget-progress-text">
                            {planSummary.completed}/{planSummary.total}
                          </span>
                        )}
                        {planSummary.total > 0 && (
                          <span className="plan-widget-progress-bar" aria-hidden="true">
                            <span
                              className="plan-widget-progress-fill"
                              style={{ width: `${Math.round((planSummary.completed / planSummary.total) * 100)}%` }}
                            />
                          </span>
                        )}
                      </div>
                      <div className="plan-widget-actions">
                        {showPlanActions && canRunPlan && (
                          <>
                            <button
                              type="button"
                              className="plan-widget-action is-primary"
                              disabled={commandsDisabled}
                              onClick={() => onCommand?.("/plan execute")}
                            >
                              {t(planSummary.status === "executing" ? "chat.planAction.continue" : "chat.planAction.execute")}
                            </button>
                            <button
                              type="button"
                              className="plan-widget-action"
                              disabled={commandsDisabled}
                              title={t("chat.planAction.autoHint")}
                              onClick={() => onCommand?.("/plan auto")}
                            >
                              {t("chat.planAction.auto")}
                            </button>
                          </>
                        )}
                        {showPlanActions && (
                          <>
                            <button
                              type="button"
                              className="plan-widget-action"
                              disabled={commandsDisabled}
                              onClick={() => onCommand?.("/todos refine")}
                            >
                              {t("chat.planAction.refine")}
                            </button>
                            <button
                              type="button"
                              className="plan-widget-action"
                              disabled={commandsDisabled}
                              title={t("chat.planAction.exportHint")}
                              onClick={() => onCommand?.("/todos export")}
                            >
                              {t("chat.planAction.export")}
                            </button>
                          </>
                        )}
                        <button
                          type="button"
                          className="plan-widget-action is-icon"
                          aria-expanded={tallPlanPanel}
                          aria-label={t(tallPlanPanel ? "chat.planRestoreHeight" : "chat.planExpandHeight")}
                          title={t(tallPlanPanel ? "chat.planRestoreHeight" : "chat.planExpandHeight")}
                          onClick={() => setTallPlanPanel((prev) => !prev)}
                        >
                          {tallPlanPanel ? "⤡" : "⤢"}
                        </button>
                        {showPlanActions && (
                          <button
                            type="button"
                            className="plan-widget-action is-danger"
                            disabled={commandsDisabled}
                            title={t("chat.planAction.delete")}
                            aria-label={t("chat.planAction.delete")}
                            onClick={() => onCommand?.("/todos clear")}
                          >
                            🗑
                          </button>
                        )}
                      </div>
                    </div>
                  ) : (
                    widget.key
                  )}
                </div>
                {planSummary && planSummary.steps.length > 0 ? (
                  <ul className="plan-todo-list">
                    {planSummary.steps.map((step) => (
                      <li
                        key={step.step}
                        dir="auto"
                        className={`plan-todo-item${step.completed ? " is-done" : ""}${step.step === nextPendingStep ? " is-next" : ""}`}
                      >
                        <button
                          type="button"
                          className="plan-todo-checkbox"
                          disabled={!onCommand || commandsDisabled}
                          aria-label={t("chat.planToggleStep", { step: step.step })}
                          title={t("chat.planToggleStep", { step: step.step })}
                          onClick={() => onCommand?.(`/todos toggle ${step.step}`)}
                        >
                          {step.completed ? "☑" : "☐"}
                        </button>
                        <span className="plan-todo-step-num">{step.step}.</span>
                        <span className="plan-todo-step-text" dir="auto">{step.text}</span>
                        {!step.completed && onCommand && (
                          <button
                            type="button"
                            className="plan-todo-run-step"
                            disabled={commandsDisabled}
                            aria-label={t("chat.planRunStep", { step: step.step })}
                            title={t("chat.planRunStep", { step: step.step })}
                            onClick={() => onCommand(`/todos step ${step.step}`)}
                          >
                            ▶
                          </button>
                        )}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <pre className="extension-widget-content">
                    <AnsiText text={formatExtensionWidgetContent(bodyLines)} />
                  </pre>
                )}
              </section>
            );
          })()}
        </div>
      )}
      <div className="extension-status-row">
        <div className="extension-widget-triggers" aria-label={t("chat.extensionWidgets")}>
          {widgets.map((widget, index) => {
            const expandable = widget.lines.length > 0;
            const expanded = expandable && widget.key === expandedWidget?.key;
            const updating = updatingWidgetKeys.has(widget.key);
            const lineCountLabel = t(
              widget.lines.length === 1 ? "chat.extensionWidgetLine" : "chat.extensionWidgetLines",
              { count: widget.lines.length },
            );
            const placementLabel = t(
              widget.placement === "belowEditor"
                ? "chat.extensionWidgetBelow"
                : "chat.extensionWidgetAbove",
            );
            const triggerId = `${idPrefix}-trigger-${index}`;
            const panelId = `${idPrefix}-panel-${index}`;
            const content = (
              <>
                <span className="extension-widget-update-pulse" aria-hidden="true" />
                <span className="extension-widget-placement" aria-hidden="true">
                  <svg
                    className="extension-widget-placement-icon"
                    viewBox="0 0 8 6"
                    width="8"
                    height="6"
                    data-direction={widget.placement === "belowEditor" ? "down" : "up"}
                    focusable="false"
                  >
                    <path
                      d={widget.placement === "belowEditor"
                        ? "M0 0h8L4 6z"
                        : "M4 0l4 6H0z"}
                    />
                  </svg>
                </span>
                <span className="extension-widget-key">{widget.key}</span>
              </>
            );

            return expandable ? (
              <button
                key={widget.key}
                id={triggerId}
                type="button"
                className={`extension-widget-trigger${expanded ? " is-expanded" : ""}${updating ? " is-updating" : ""}`}
                aria-controls={panelId}
                aria-expanded={expanded}
                aria-label={`${placementLabel}: ${widget.key}, ${lineCountLabel}`}
                title={`${widget.key} - ${placementLabel} - ${expanded ? t("i18n.collapse") : t("i18n.expand")}`}
                onClick={() => toggleWidget(widget)}
              >
                {content}
              </button>
            ) : (
              <div
                key={widget.key}
                className={`extension-widget-trigger${updating ? " is-updating" : ""}`}
                aria-label={`${placementLabel}: ${widget.key}, ${lineCountLabel}`}
                title={`${widget.key} - ${placementLabel}`}
              >
                {content}
              </div>
            );
          })}
        </div>
        {typeof children === "function" ? children({ expandedWidgetKey: resolvedExpandedKey }) : children}
      </div>
    </>
  );
}
