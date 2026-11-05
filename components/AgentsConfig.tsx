"use client";

import { useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";
import { useI18n } from "@/hooks/useI18n";
import { useIsMobile } from "@/hooks/useIsMobile";
import type { ProjectTrustStatus, SubagentProfilesResponse, SubagentSettingsResponse } from "@/lib/api-types";
import { sendAgentCommand } from "@/lib/agent-client";
import { displayPathWithin, shortenPath } from "@/lib/display-path";
import type { ModelsData } from "@/lib/models-cache";
import { isSubagentProfileOverridden } from "@/lib/subagent-profile-precedence";
import type { SubagentProfile, SubagentScope, SubagentWritableScope } from "@/lib/subagents";
import {
  getLastSettingsSelection,
  setLastSettingsSelection,
} from "@/lib/settings-navigation";
import {
  ConfigButton,
  ConfigDetail,
  ConfigDetailActions,
  ConfigDetailHeader,
  ConfigDetailHeaderInfo,
  ConfigDetailStack,
  ConfigEmptyState,
  ConfigField,
  ConfigFooter,
  ConfigListAction,
  ConfigPanelShell,
  ConfigSaveTarget,
  ConfigScopeTag,
  ConfigSidebar,
  ConfigSidebarGroupLabel,
  ConfigSidebarItem,
  ConfigSidebarList,
  ConfigSidebarText,
  ConfigSplitView,
  ConfigStatusDot,
  ConfigSwitch,
} from "./SettingsUi";
import { ModelSelector } from "./ModelSelector";
import { projectTrustReloadKey } from "./settings-ui-helpers";

const TOOL_OPTIONS = ["read", "bash", "edit", "write", "grep", "find", "ls"];
const THINKING_OPTIONS = ["", "off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

/**
 * What each shipped profile is for, which model class suits it, and how its
 * tokens are billed. Shown behind the "?" button so an empty model field
 * (inherit the parent's model) is a deliberate choice rather than a guess.
 */
interface ProfileGuidance {
  summary: string;
  /** Model classes to prefer, cheapest first. */
  recommended: string;
  /** `provider/modelId` hints the panel looks up in the loaded catalog. */
  suggestions: string[];
  costNote: string;
}

const PROFILE_GUIDANCE: Record<string, ProfileGuidance> = {
  explore: {
    summary: "Searches the codebase and reports paths, symbols and line numbers. Read-only: read, grep, find, ls. Uses a short replacement prompt, so it stays cheap.",
    recommended: "A fast, small-context model (flash/haiku class) with thinking low or off.",
    suggestions: ["antigravity/gemini-3.8-flash", "openrouter/anthropic/claude-haiku-5.5", "inception/mercury-3"],
    costNote: "Searching is many small calls: the cheapest capable model usually wins here.",
  },
  plan: {
    summary: "Inspects the repository and writes an implementation-ready plan: steps, dependencies, risks and how to verify. Never edits files.",
    recommended: "A strong reasoning model with thinking medium or high.",
    suggestions: ["antigravity/claude-sonnet-5-5", "openrouter/anthropic/claude-sonnet-5.5", "openai-codex/gpt-6.1-terra"],
    costNote: "One long planning answer, so a costly model is affordable; it saves far more downstream.",
  },
  "general-purpose": {
    summary: "Does the actual work: reads, edits, runs shell commands and tests. Loads the safe-ops and verify-first skills plus the protected-paths and permission-gate extensions.",
    recommended: "The parent's model, or a strong general model with thinking medium.",
    suggestions: ["antigravity/claude-sonnet-5-5", "openrouter/openai/gpt-6.1-terra", "openai-codex/gpt-6.1-sol"],
    costNote: "Highest token volume of all profiles: file reads, patches and test output. Watch max turns.",
  },
  reviewer: {
    summary: "Reviews the diff and the changed files for real defects, security issues, error handling and regressions. Reports file:line, severity and a verdict.",
    recommended: "A different model family from the one that wrote the code, thinking high.",
    suggestions: ["antigravity/claude-opus-5-5", "openrouter/openai/gpt-6.1-terra-pro", "openai-codex/gpt-6.1-terra"],
    costNote: "Reads whole files once, so cost stays moderate while catching blind spots of the author model.",
  },
  researcher: {
    summary: "Researches the web, GitHub and docs and extracts PDF/Word/Excel/PowerPoint content with the agent-reach and doc-tools skills. Never edits code.",
    recommended: "A fast model with a large context window, thinking low.",
    suggestions: ["antigravity/gemini-3.8-flash", "openrouter/google/gemini-4-argon", "openrouter/openai/gpt-6.1-terra"],
    costNote: "Long page and document text fills the context: prefer a large-window cheap model.",
  },
};

function formatModelCost(cost: { input: number; output: number } | undefined, free: boolean | undefined): string {
  if (cost) {
    const fmt = (value: number) => `$${(Math.round(value * 1000) / 1000).toFixed(3)}`;
    return `${fmt(cost.input)} in / ${fmt(cost.output)} out per 1M tokens`;
  }
  if (free) return "Free (no token charge reported)";
  return "No price listed for this model";
}

type EditableProfile = Omit<SubagentProfile, "scope" | "filePath">;
type EditorMode = "view" | "edit" | "create";

const EMPTY_PROFILE: EditableProfile = {
  name: "custom-agent",
  displayName: "Custom agent",
  description: "",
  systemPrompt: "",
  tools: ["read", "bash", "edit", "write", "grep", "find", "ls"],
  loadSkills: false,
  loadExtensions: false,
  codemode: "off",
  mcp: "off",
  promptMode: "append",
  inheritContext: false,
  runInBackground: false,
  enabled: true,
};

const inputStyle: CSSProperties = {
  width: "100%",
  minWidth: 0,
  height: 34,
  padding: "0 9px",
  border: "1px solid var(--border)",
  borderRadius: 5,
  background: "var(--bg)",
  color: "var(--text)",
  fontSize: 12,
  outline: "none",
};

const disabledInputStyle: CSSProperties = {
  background: "var(--bg-panel)",
  color: "var(--text-dim)",
  cursor: "default",
};

function editableProfile(profile: SubagentProfile): EditableProfile {
  return {
    name: profile.name,
    displayName: profile.displayName,
    description: profile.description,
    systemPrompt: profile.systemPrompt,
    tools: [...profile.tools],
    loadSkills: profile.loadSkills,
    ...(profile.skills !== undefined ? { skills: [...profile.skills] } : {}),
    loadExtensions: profile.loadExtensions,
    codemode: profile.codemode ?? "off",
    mcp: profile.mcp ?? "off",
    ...(profile.extensions !== undefined ? { extensions: [...profile.extensions] } : {}),
    promptMode: profile.promptMode,
    ...(profile.isolation ? { isolation: profile.isolation } : {}),
    ...(profile.model ? { model: profile.model } : {}),
    ...(profile.thinking ? { thinking: profile.thinking } : {}),
    ...(profile.maxTurns ? { maxTurns: profile.maxTurns } : {}),
    inheritContext: profile.inheritContext,
    runInBackground: profile.runInBackground,
    enabled: profile.enabled,
  };
}

/**
 * The model a profile reference names. It may end in pi's `:<thinking level>` (`provider/model:high`),
 * which the runtime reads as the model plus its level; a listed id that contains a colon matches whole.
 */
function profileModelBase(reference: string, isListed: (reference: string) => boolean): string {
  if (isListed(reference)) return reference;
  const colon = reference.lastIndexOf(":");
  const level = reference.slice(colon + 1);
  return colon > 0 && level && (THINKING_OPTIONS as readonly string[]).includes(level) ? reference.slice(0, colon) : reference;
}

function profileKey(profile: Pick<SubagentProfile, "scope" | "name">): string {
  return `${profile.scope}:${profile.name}`;
}

function duplicateProfileName(name: string, profiles: readonly SubagentProfile[]): string {
  const existing = new Set(profiles.map((profile) => profile.name.toLowerCase()));
  const base = `${name}-copy`;
  let candidate = base;
  let suffix = 2;
  while (existing.has(candidate.toLowerCase())) candidate = `${base}-${suffix++}`;
  return candidate;
}

function isWritableScope(scope: SubagentScope): scope is SubagentWritableScope {
  return scope === "global" || scope === "project";
}

/**
 * A built-in has no file to edit, so its fields stay read-only, but its switch is
 * live: the server records the name in `agents/settings.json` instead of writing a
 * copy of the profile to disk.
 */
function isTogglableScope(scope: SubagentScope): boolean {
  return isWritableScope(scope) || scope === "builtin";
}

function displayProfilePath(profile: SubagentProfile, cwd: string): string | null {
  if (!profile.filePath) return null;
  return profile.scope === "project" || profile.scope === "workspace"
    ? displayPathWithin(profile.filePath, cwd)
    : shortenPath(profile.filePath);
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <ConfigField label={label}>{children}</ConfigField>;
}

function Toggle({ checked, disabled, label, onChange }: { checked: boolean; disabled: boolean; label: string; onChange: (checked: boolean) => void }) {
  return (
    <label style={{ display: "flex", alignItems: "center", gap: 7, color: disabled ? "var(--text-dim)" : "var(--text-muted)", fontSize: 12, cursor: disabled ? "default" : "pointer" }}>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(event) => onChange(event.target.checked)} />
      {label}
    </label>
  );
}

export function AgentsConfig({
  cwd,
  sessionId = null,
  onClose,
  onReloaded,
  embedded = false,
  trust,
}: {
  cwd: string;
  sessionId?: string | null;
  onClose: () => void;
  onReloaded?: () => void;
  embedded?: boolean;
  /** The page's trust status for `cwd`; a new decision loads the model list again. */
  trust?: ProjectTrustStatus | null;
}) {
  const isMobile = useIsMobile();
  const { t } = useI18n();
  const [profiles, setProfiles] = useState<SubagentProfile[]>([]);
  const [modelOptions, setModelOptions] = useState<ModelsData["modelList"]>([]);
  const [modelsLoading, setModelsLoading] = useState(true);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [selectedKey, setSelectedKey] = useState<string | null>(() => getLastSettingsSelection("agents", cwd));
  const [draft, setDraft] = useState<EditableProfile>(EMPTY_PROFILE);
  const [mode, setMode] = useState<EditorMode>("view");
  const [targetScope, setTargetScope] = useState<SubagentWritableScope>("global");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [savedOk, setSavedOk] = useState(false);
  const [toggling, setToggling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [builtInEnabled, setBuiltInEnabled] = useState(false);
  const [maxConcurrent, setMaxConcurrent] = useState(10);
  const [settingsLoading, setSettingsLoading] = useState(true);
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [reloadNeeded, setReloadNeeded] = useState(false);
  const [reloading, setReloading] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);

  const selected = useMemo(
    () => profiles.find((profile) => profileKey(profile) === selectedKey) ?? null,
    [profiles, selectedKey],
  );
  const modelSelectorOptions = useMemo(() => modelOptions.map((model) => ({
    provider: model.provider,
    providerName: model.providerName,
    modelId: model.id,
    name: model.name,
    free: model.free,
  })), [modelOptions]);

  const loadProfiles = useCallback(async (preferredKey?: string) => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(`/api/subagents/profiles?cwd=${encodeURIComponent(cwd)}`, { cache: "no-store" });
      const data = await response.json() as Partial<SubagentProfilesResponse> & { error?: string };
      if (!response.ok || data.error) throw new Error(data.error ?? `HTTP ${response.status}`);
      const next = data.profiles ?? [];
      setProfiles(next);
      const rememberedKey = preferredKey ?? getLastSettingsSelection("agents", cwd);
      const chosen = next.find((profile) => profileKey(profile) === rememberedKey)
        ?? next.find((profile) => profile.scope === "project")
        ?? next.find((profile) => profile.scope === "global")
        ?? next[0]
        ?? null;
      setSelectedKey(chosen ? profileKey(chosen) : null);
      if (chosen) {
        setDraft(editableProfile(chosen));
        setMode(isWritableScope(chosen.scope) ? "edit" : "view");
        if (isWritableScope(chosen.scope)) setTargetScope(chosen.scope);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, [cwd]);

  useEffect(() => {
    void loadProfiles();
  }, [loadProfiles]);

  useEffect(() => {
    const controller = new AbortController();
    setSettingsLoading(true);
    setSettingsError(null);
    void (async () => {
      try {
        const response = await fetch("/api/subagents/settings", {
          cache: "no-store",
          signal: controller.signal,
        });
        const data = await response.json() as Partial<SubagentSettingsResponse> & { error?: string };
        if (!response.ok || data.error || typeof data.enabled !== "boolean") {
          throw new Error(data.error ?? `HTTP ${response.status}`);
        }
        setBuiltInEnabled(data.enabled);
        if (typeof data.maxConcurrent === "number") setMaxConcurrent(data.maxConcurrent);
      } catch (cause) {
        if (controller.signal.aborted) return;
        setSettingsError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        if (!controller.signal.aborted) setSettingsLoading(false);
      }
    })();
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (selectedKey) setLastSettingsSelection("agents", selectedKey, cwd);
  }, [cwd, selectedKey]);

  // The model list follows the folder's trust: GET /api/models leaves out an
  // untrusted project's extensions, which can register providers. Trust can
  // change while this section stays mounted (hidden) in Settings, by trusting
  // from Settings › MCP; a new decision loads the list again in place, keeping
  // any profile draft.
  const trustKey = projectTrustReloadKey(trust);
  useEffect(() => {
    const controller = new AbortController();
    setModelsLoading(true);
    setModelsError(null);
    void (async () => {
      try {
        const response = await fetch(`/api/models?cwd=${encodeURIComponent(cwd)}`, { signal: controller.signal });
        const data = await response.json() as Partial<ModelsData> & { error?: string };
        if (!response.ok || data.error) throw new Error(data.error ?? `HTTP ${response.status}`);
        setModelOptions(data.modelList ?? []);
        setModelsError(data.modelError ?? null);
      } catch (cause) {
        if (controller.signal.aborted) return;
        setModelsError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        if (!controller.signal.aborted) setModelsLoading(false);
      }
    })();
    return () => controller.abort();
  }, [cwd, trustKey]);

  const selectProfile = (profile: SubagentProfile) => {
    setSelectedKey(profileKey(profile));
    setDraft(editableProfile(profile));
    setMode(isWritableScope(profile.scope) ? "edit" : "view");
    if (isWritableScope(profile.scope)) setTargetScope(profile.scope);
    setError(null);
  };

  const beginCreate = () => {
    let name = "custom-agent";
    let suffix = 2;
    while (profiles.some((profile) => profile.name === name)) name = `custom-agent-${suffix++}`;
    setSelectedKey(null);
    setDraft({ ...EMPTY_PROFILE, name, displayName: name });
    setMode("create");
    setTargetScope("global");
    setError(null);
  };

  const beginDuplicate = () => {
    if (!selected) return;
    const name = duplicateProfileName(selected.name, profiles);
    setSelectedKey(null);
    setDraft({
      ...editableProfile(selected),
      name,
      displayName: t("agents.copyName", { name: selected.displayName }),
    });
    setMode("create");
    setTargetScope(isWritableScope(selected.scope) ? selected.scope : "global");
    setError(null);
  };

  const beginCustomize = () => {
    if (!selected) return;
    setSelectedKey(null);
    setDraft({
      ...editableProfile(selected),
      name: selected.name,
      displayName: selected.displayName,
    });
    setMode("create");
    setTargetScope("global");
    setError(null);
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    setSavedOk(false);
    try {
      const response = await fetch("/api/subagents/profiles", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd, scope: targetScope, profile: draft }),
      });
      const data = await response.json() as { profile?: SubagentProfile; error?: string };
      if (!response.ok || data.error || !data.profile) throw new Error(data.error ?? `HTTP ${response.status}`);
      await loadProfiles(profileKey(data.profile));
      setSavedOk(true);
      setTimeout(() => setSavedOk(false), 2000);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!selected || !isWritableScope(selected.scope)) return;
    if (!window.confirm(t("agents.deleteConfirm", { name: selected.displayName }))) return;
    setSaving(true);
    setError(null);
    try {
      const response = await fetch("/api/subagents/profiles", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd, scope: selected.scope, name: selected.name }),
      });
      const data = await response.json() as { error?: string };
      if (!response.ok || data.error) throw new Error(data.error ?? `HTTP ${response.status}`);
      await loadProfiles();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  const editing = mode !== "view";
  const creating = mode === "create";
  const disabled = !editing || saving || toggling;
  const displayedScope = creating ? targetScope : selected?.scope;
  const displayedPath = creating
    ? targetScope === "global"
      ? `~/.pi/agent/agents/${draft.name || "..."}.md`
      : `./.pi/agents/${draft.name || "..."}.md`
    : selected
      ? displayProfilePath(selected, cwd) ?? t("agents.builtinPath")
      : "";
  const fullPath = creating ? displayedPath : selected?.filePath ?? displayedPath;
  const isListedModel = (reference: string) => modelOptions.some((model) => `${model.provider}/${model.id}` === reference);
  const draftModelBase = draft.model && profileModelBase(draft.model, isListedModel);
  const selectedModelAvailable = !draftModelBase || isListedModel(draftModelBase);
  const selectedModel = (() => {
    if (!draftModelBase) return null;
    const separator = draftModelBase.indexOf("/");
    return separator < 0
      ? { provider: "", modelId: draftModelBase }
      : { provider: draftModelBase.slice(0, separator), modelId: draftModelBase.slice(separator + 1) };
  })();
  const controlStyle = disabled ? { ...inputStyle, ...disabledInputStyle } : inputStyle;
  const switchDisabled = creating
    ? disabled
    : !selected || !isTogglableScope(selected.scope) || saving || toggling;
  const update = <K extends keyof EditableProfile>(key: K, value: EditableProfile[K]) => {
    setDraft((current) => ({ ...current, [key]: value }));
  };
  // As `buildSubagentPromptPlan()` decides: no tools, skills or extensions.
  const chatOnlyDraft = draft.tools.length === 0 && !draft.loadSkills && !draft.loadExtensions;

  const toggleEnabled = async (enabled: boolean) => {
    if (creating) {
      update("enabled", enabled);
      return;
    }
    if (!selected || !isTogglableScope(selected.scope)) return;
    setToggling(true);
    setError(null);
    try {
      const response = await fetch("/api/subagents/profiles", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd, scope: selected.scope, name: selected.name, enabled }),
      });
      const data = await response.json() as { profile?: SubagentProfile; error?: string };
      if (!response.ok || data.error || !data.profile) throw new Error(data.error ?? `HTTP ${response.status}`);
      const saved = data.profile;
      setProfiles((current) => current.map((profile) => profileKey(profile) === profileKey(saved) ? saved : profile));
      setDraft((current) => ({ ...current, enabled: saved.enabled }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setToggling(false);
    }
  };

  const toggleBuiltInSubagents = async (enabled: boolean) => {
    setSettingsSaving(true);
    setSettingsError(null);
    try {
      const response = await fetch("/api/subagents/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled }),
      });
      const data = await response.json() as Partial<SubagentSettingsResponse> & { error?: string };
      if (!response.ok || data.error || typeof data.enabled !== "boolean") {
        throw new Error(data.error ?? `HTTP ${response.status}`);
      }
      setBuiltInEnabled(data.enabled);
      setReloadNeeded(Boolean(sessionId));
    } catch (cause) {
      setSettingsError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSettingsSaving(false);
    }
  };

  const updateMaxConcurrent = async (value: number) => {
    setMaxConcurrent(value);
    setSettingsError(null);
    try {
      const response = await fetch("/api/subagents/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ maxConcurrent: value }),
      });
      const data = await response.json() as Partial<SubagentSettingsResponse> & { error?: string };
      if (!response.ok || data.error || typeof data.maxConcurrent !== "number") throw new Error(data.error ?? `HTTP ${response.status}`);
      setMaxConcurrent(data.maxConcurrent);
    } catch (cause) {
      setSettingsError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const reloadSession = async () => {
    if (!sessionId) return;
    setReloading(true);
    setSettingsError(null);
    try {
      await sendAgentCommand(sessionId, { type: "reload" });
      setReloadNeeded(false);
      onReloaded?.();
    } catch (cause) {
      setSettingsError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setReloading(false);
    }
  };

  return (
    <ConfigPanelShell embedded={embedded} title={t("common.agents")} subtitle={shortenPath(cwd)} closeLabel={t("agents.close")} onClose={onClose}>
      <div className="agents-feature-setting">
        <div className="agents-feature-copy">
          <strong>{t("agents.builtInTitle")}</strong>
          <span>{t("agents.builtInDescription")}</span>
          {reloadNeeded && <span role="status" className="agents-feature-reload-notice">{t("agents.reloadRequired")}</span>}
        </div>
        <div className="agents-feature-actions">
          {reloadNeeded && sessionId && (
            <ConfigButton size="small" onClick={() => void reloadSession()} disabled={reloading || settingsSaving}>
              {reloading ? t("agents.reloading") : t("agents.reloadSession")}
            </ConfigButton>
          )}
          <label className="agents-concurrency-control" title={t("agents.maxConcurrentDescription")}>
            <span>{t("agents.maxConcurrent")}</span>
            <input
              aria-label={t("agents.maxConcurrent")}
              type="number"
              min={1}
              max={32}
              value={maxConcurrent}
              disabled={settingsLoading || settingsSaving}
              onChange={(event) => setMaxConcurrent(Number(event.target.value))}
              onBlur={() => void updateMaxConcurrent(maxConcurrent)}
            />
          </label>
          <ConfigSwitch
            checked={builtInEnabled}
            disabled={settingsLoading || reloading}
            loading={settingsSaving}
            label={t("agents.builtInTitle")}
            onChange={(enabled) => void toggleBuiltInSubagents(enabled)}
          />
        </div>
      </div>
      <ConfigSplitView>
        <ConfigSidebar>
          <ConfigSidebarList>
              {loading ? (
                <div style={{ padding: 10, color: "var(--text-dim)", fontSize: 12 }}>{t("agents.loading")}</div>
              ) : (["project", "global", "workspace", "builtin"] as const).map((scope) => {
                const scopedProfiles = profiles.filter((profile) => profile.scope === scope);
                if (scopedProfiles.length === 0) return null;
                return (
                  <div key={scope} className="config-sidebar-group">
                    <ConfigSidebarGroupLabel>{t(`agents.scope.${scope}`)}</ConfigSidebarGroupLabel>
                    {scopedProfiles.map((profile) => {
                      const overridden = isSubagentProfileOverridden(profile, profiles);
                      return (
                        <ConfigSidebarItem
                          key={profileKey(profile)}
                          active={selectedKey === profileKey(profile) && !creating}
                          onClick={() => selectProfile(profile)}
                        >
                          <ConfigStatusDot active={profile.enabled} />
                          <ConfigSidebarText className={`is-grow${profile.enabled ? "" : " is-muted"}`}>{profile.displayName}</ConfigSidebarText>
                          <button
                            type="button"
                            className="agents-help-button"
                            aria-label={`About ${profile.displayName}`}
                            title={`About ${profile.displayName}`}
                            onClick={(event) => {
                              event.stopPropagation();
                              selectProfile(profile);
                              setHelpOpen(true);
                            }}
                          >
                            ?
                          </button>
                          {!overridden && (profile.model || profile.thinking) && (
                            <span style={{ fontSize: 10, color: "var(--text-dim)", maxWidth: 110, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={[profile.model, profile.thinking].filter(Boolean).join(" · ")}>
                              {[profile.model?.split("/").pop(), profile.thinking].filter(Boolean).join(" · ")}
                            </span>
                          )}
                          {overridden && <span className="agents-overridden-label">{t("agents.overridden")}</span>}
                        </ConfigSidebarItem>
                      );
                    })}
                  </div>
                );
              })}
          </ConfigSidebarList>
          <ConfigListAction
                active={creating}
                onClick={beginCreate}
              >
                {t("agents.new")}
          </ConfigListAction>
        </ConfigSidebar>

        <ConfigDetail>
          <ConfigDetailStack className="is-fill">
              {!selected && !creating ? (
                <ConfigEmptyState>{t("agents.empty")}</ConfigEmptyState>
              ) : (
                <ConfigDetailStack>
                  <ConfigDetailHeader>
                    <button
                      type="button"
                      className="agents-help-button is-inline"
                      aria-expanded={helpOpen}
                      aria-label="What this profile does"
                      title="What this profile does, which model suits it, and its cost"
                      onClick={() => setHelpOpen((current) => !current)}
                    >
                      ?
                    </button>
                    <ConfigDetailHeaderInfo>
                      {/* A new profile chooses its scope where a saved one shows it. */}
                      {creating ? (
                        <ConfigSaveTarget
                          value={targetScope}
                          label={t("config.saveTo")}
                          options={(["global", "project"] as const).map((scope) => ({
                            value: scope,
                            label: t(`agents.scope.${scope}`),
                            disabled: saving,
                          }))}
                          path={displayedPath}
                          onChange={setTargetScope}
                        />
                      ) : (
                        <>
                          {displayedScope && (
                            <ConfigScopeTag scope={displayedScope}>{t(`agents.scope.${displayedScope}`)}</ConfigScopeTag>
                          )}
                          <span title={fullPath} className="config-detail-path">
                            {displayedPath}
                          </span>
                        </>
                      )}
                    </ConfigDetailHeaderInfo>
                    <ConfigDetailActions>
                      {selected && mode === "view" && <ConfigButton size="small" onClick={beginCustomize} disabled={saving || toggling}>Customize</ConfigButton>}
                      {selected && (mode === "view" || mode === "edit") && <ConfigButton size="small" onClick={beginDuplicate} disabled={saving || toggling}>{t("agents.duplicate")}</ConfigButton>}
                      {selected && isWritableScope(selected.scope) && mode === "edit" && <ConfigButton variant="danger" size="small" onClick={() => void remove()} disabled={saving || toggling}>{t("agents.delete")}</ConfigButton>}
                      <ConfigSwitch checked={draft.enabled} disabled={switchDisabled} label={draft.enabled ? t("agents.disable") : t("agents.enable")} onChange={(checked) => void toggleEnabled(checked)} />
                    </ConfigDetailActions>
                  </ConfigDetailHeader>

                  {helpOpen && (() => {
                    const guidance = PROFILE_GUIDANCE[draft.name.trim().toLowerCase()];
                    const activeModel = modelOptions.find((model) => `${model.provider}/${model.id}` === draftModelBase);
                    const suggestions = (guidance?.suggestions ?? [])
                      .map((reference) => {
                        const separator = reference.indexOf("/");
                        const provider = reference.slice(0, separator);
                        const modelId = reference.slice(separator + 1);
                        return modelOptions.find((model) => model.provider === provider && model.id === modelId);
                      })
                      .filter((model): model is NonNullable<typeof model> => model !== undefined);
                    return (
                      <div className="agents-help-panel" role="note">
                        <div className="agents-help-panel-head">
                          <strong>{guidance ? `About ${draft.displayName}` : "About this profile"}</strong>
                          <button type="button" className="agents-help-panel-close" aria-label="Close help" onClick={() => setHelpOpen(false)}>×</button>
                        </div>
                        <p>{guidance?.summary ?? (draft.systemPrompt.trim() || draft.description || "No instructions yet. Describe what this sub-agent should do, and it is appended to (or replaces) the base prompt.")}</p>
                        <p><strong>Suggested model:</strong> {guidance?.recommended ?? "Pick the model the parent uses, or the cheapest one that can do the job."} <strong>Currently:</strong> {draftModelBase ? `${draftModelBase} (${formatModelCost(activeModel?.cost, activeModel?.free)})` : "inherits the parent session's model and thinking level"}.</p>
                        {suggestions.length > 0 && (
                          <p><strong>Available matches:</strong> {suggestions.map((model) => `${model.name} — ${formatModelCost(model.cost, model.free)}`).join(" · ")}</p>
                        )}
                        <p className="agents-help-panel-note">{guidance?.costNote ?? "Token cost follows the selected model; leaving the model empty costs the same as the parent session."} Thinking level changes reasoning tokens only where the model supports it. If a child runs out of tokens or credits mid-run, Pi Web retries it once on the parent session model.</p>
                      </div>
                    );
                  })()}

                  <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : "minmax(0, 1fr) minmax(0, 1fr)", gap: 12 }}>
                    <Field label={t("agents.name")}>
                      {creating ? (
                        <input aria-label={t("agents.name")} value={draft.name} disabled={disabled} onChange={(event) => update("name", event.target.value)} style={inputStyle} />
                      ) : (
                        <code style={{ minHeight: 34, display: "flex", alignItems: "center", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--text)", fontSize: 12 }}>
                          {draft.name}
                        </code>
                      )}
                    </Field>
                    <Field label={t("agents.displayName")}>
                      <input aria-label={t("agents.displayName")} value={draft.displayName} disabled={disabled} onChange={(event) => update("displayName", event.target.value)} style={controlStyle} />
                    </Field>
                  </div>
                  <Field label={t("agents.description")}>
                    <input aria-label={t("agents.description")} value={draft.description} disabled={disabled} onChange={(event) => update("description", event.target.value)} style={controlStyle} />
                  </Field>
                  <Field label={t("agents.prompt")}>
                    <textarea className="agents-system-prompt" aria-label={t("agents.prompt")} value={draft.systemPrompt} disabled={disabled} onChange={(event) => update("systemPrompt", event.target.value)} style={{ ...controlStyle, height: 195, minHeight: 195, maxHeight: "60vh", padding: 9, overflow: "auto", resize: disabled ? "none" : "vertical", lineHeight: 1.5 }} />
                  </Field>

                  <Field label={t("agents.tools")}>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: "8px 16px" }}>
                      {TOOL_OPTIONS.map((tool) => (
                        <Toggle key={tool} label={tool} disabled={disabled} checked={draft.tools.includes(tool)} onChange={(checked) => update("tools", checked ? [...draft.tools, tool] : draft.tools.filter((item) => item !== tool))} />
                      ))}
                    </div>
                  </Field>

                  <Field label={t("agents.resources")}>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: "8px 20px" }}>
                      <Toggle label={t("agents.loadSkills")} disabled={disabled} checked={draft.loadSkills} onChange={(checked) => update("loadSkills", checked)} />
                      <Toggle label={t("agents.loadExtensions")} disabled={disabled} checked={draft.loadExtensions} onChange={(checked) => update("loadExtensions", checked)} />
                      {/* A chat-only child cannot start with MCP on; the switch still turns it off. */}
                      <Toggle label={t("agents.mcp")} disabled={disabled || (chatOnlyDraft && draft.mcp !== "on")} checked={draft.mcp === "on"} onChange={(checked) => update("mcp", checked ? "on" : "off")} />
                    </div>
                    {/* `skills:` and `extensions:` lists are edited in the profile file; show what they load. */}
                    {draft.loadSkills && draft.skills !== undefined && (
                      <span style={{ color: "var(--text-dim)", fontSize: 11, lineHeight: 1.4, overflowWrap: "anywhere" }}>
                        {draft.skills.length > 0
                          ? t("agents.skillsOnly", { skills: draft.skills.join(", ") })
                          : t("agents.skillsNone")}
                      </span>
                    )}
                    {draft.loadExtensions && draft.extensions !== undefined && (
                      <span style={{ color: "var(--text-dim)", fontSize: 11, lineHeight: 1.4, overflowWrap: "anywhere" }}>
                        {draft.extensions.length > 0
                          ? t("agents.extensionsOnly", { extensions: draft.extensions.join(", ") })
                          : t("agents.extensionsNone")}
                      </span>
                    )}
                    {!disabled && chatOnlyDraft ? (
                      <span style={{ color: "var(--text-dim)", fontSize: 11, lineHeight: 1.4 }}>
                        {t("agents.mcpChatOnly")}
                      </span>
                    ) : draft.mcp === "on" && (
                      <span style={{ color: "var(--text-dim)", fontSize: 11, lineHeight: 1.4 }}>
                        {t("agents.mcpHint")}
                      </span>
                    )}
                  </Field>

                  <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : "minmax(0, 1fr) minmax(0, 1fr) minmax(0, 1fr)", gap: 12 }}>
                    <Field label={t("agents.codemode")}>
                      <select
                        aria-label={t("agents.codemode")}
                        value={draft.codemode ?? "off"}
                        disabled={disabled}
                        onChange={(event) => update("codemode", event.target.value as EditableProfile["codemode"])}
                        style={controlStyle}
                      >
                        <option value="inherit">{t("agents.codemode.inherit")}</option>
                        <option value="on">{t("agents.codemode.on")}</option>
                        <option value="off">{t("agents.codemode.off")}</option>
                      </select>
                    </Field>
                    <Field label="Prompt mode">
                      <select
                        aria-label="Prompt mode"
                        value={draft.promptMode ?? "append"}
                        disabled={disabled}
                        onChange={(event) => update("promptMode", event.target.value as EditableProfile["promptMode"])}
                        style={controlStyle}
                      >
                        <option value="append">Append to base prompt</option>
                        <option value="replace">Replace base prompt</option>
                      </select>
                    </Field>
                    <Field label="Isolation">
                      <select
                        aria-label="Isolation"
                        value={draft.isolation ?? "off"}
                        disabled={disabled}
                        onChange={(event) => update("isolation", (event.target.value === "worktree" ? "worktree" : undefined) as EditableProfile["isolation"])}
                        style={controlStyle}
                      >
                        <option value="off">Shared workspace</option>
                        <option value="worktree">Isolated git worktree</option>
                      </select>
                    </Field>
                  </div>
                  <span style={{ color: "var(--text-dim)", fontSize: 11, lineHeight: 1.4, marginTop: -6 }}>
                    {t("agents.codemodeHint")}
                  </span>

                  <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : "minmax(0, 1.5fr) minmax(120px, 0.75fr) minmax(100px, 0.5fr)", gap: 12 }}>
                    <Field label={t("agents.model")}>
                      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                        <ModelSelector
                          options={modelSelectorOptions}
                          value={selectedModel}
                          onChange={(provider, modelId) => update("model", `${provider}/${modelId}`)}
                          onClear={() => update("model", undefined)}
                          emptyLabel={modelsLoading ? t("agents.modelsLoading") : t("agents.inherit")}
                          selectedLabel={draft.model && !selectedModelAvailable
                            ? t("agents.modelUnavailable", { model: draft.model })
                            : draft.model !== draftModelBase ? draft.model : undefined}
                          disabled={disabled || modelsLoading || (modelOptions.length === 0 && !draft.model)}
                          ariaLabel={t("agents.model")}
                          variant="field"
                          placement="auto"
                        />
                        {modelsError && <span style={{ color: "#ef4444", fontSize: 10 }}>{modelsError}</span>}
                      </div>
                    </Field>
                    <Field label={t("agents.thinking")}>
                      <select aria-label={t("agents.thinking")} value={draft.thinking ?? ""} disabled={disabled} onChange={(event) => update("thinking", (event.target.value || undefined) as EditableProfile["thinking"])} style={controlStyle}>
                        {THINKING_OPTIONS.map((value) => <option key={value || "default"} value={value}>{value || t("agents.inherit")}</option>)}
                      </select>
                    </Field>
                    <Field label={t("agents.maxTurns")}>
                      <input aria-label={t("agents.maxTurns")} type="number" min={1} value={draft.maxTurns ?? ""} disabled={disabled} onChange={(event) => update("maxTurns", event.target.value ? Number(event.target.value) : undefined)} style={controlStyle} />
                    </Field>
                  </div>

                  <div style={{ display: "flex", flexWrap: "wrap", gap: "10px 20px" }}>
                    <Toggle label={t("agents.inheritContext")} disabled={disabled} checked={draft.inheritContext} onChange={(checked) => update("inheritContext", checked)} />
                    <Toggle label={t("agents.background")} disabled={disabled} checked={draft.runInBackground} onChange={(checked) => update("runInBackground", checked)} />
                  </div>
                </ConfigDetailStack>
              )}
          </ConfigDetailStack>
        </ConfigDetail>
      </ConfigSplitView>
      <ConfigFooter status={(settingsError || error) && <span role="alert" style={{ color: "#ef4444" }}>{settingsError || error}</span>}>
        {editing && (
          <ConfigButton
            variant="primary"
            onClick={() => void save()}
            disabled={saving || savedOk || toggling || !draft.name.trim()}
            className={savedOk ? "is-success" : undefined}
          >
            {savedOk && (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" className="config-button-success-icon">
                <polyline points="20 6 9 17 4 12" />
              </svg>
            )}
            <span>{savedOk ? t("i18n.saved") : saving ? t("agents.saving") : t("agents.save")}</span>
          </ConfigButton>
        )}
      </ConfigFooter>
    </ConfigPanelShell>
  );
}
