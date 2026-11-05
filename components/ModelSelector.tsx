"use client";

import { useEffect, useRef, useState, type CSSProperties } from "react";
import { useI18n } from "@/hooks/useI18n";
import { useIsMobile } from "@/hooks/useIsMobile";
import { SelectorRow } from "./SelectorRow";
import {
  isModelFavorite,
  MODEL_FAVORITES_STORAGE_KEY,
  parseModelFavorites,
  serializeModelFavorites,
  toggleModelFavorite,
} from "@/lib/model-favorites";

export interface ModelSelectorOption {
  provider: string;
  modelId: string;
  name: string;
  /** The provider charges no tokens for this model. */
  free?: boolean;
}

interface ModelSelectorProps {
  options: ModelSelectorOption[];
  value?: { provider: string; modelId: string } | null;
  onChange: (provider: string, modelId: string) => void;
  /** Live sessions can reapply saved metadata by choosing their current model again. */
  onReselect?: (provider: string, modelId: string) => void;
  onClear?: () => void;
  emptyLabel?: string;
  selectedLabel?: string;
  disabled?: boolean;
  busy?: boolean;
  isAutoSelection?: boolean;
  ariaLabel?: string;
  variant?: "toolbar" | "field";
  placement?: "up" | "auto";
  /** The model new sessions start with; its row gets a filled star. */
  defaultValue?: { provider: string; modelId: string } | null;
  /** Shows a star on every row that saves it as the default. */
  onSetDefault?: (provider: string, modelId: string) => void;
  /** Shows the multi-select starred-favourites toggle, stored in this browser. */
  enableFavorites?: boolean;
}

const MODEL_FILTER_THRESHOLD = 8;

export function filterModelOptions(options: ModelSelectorOption[], query: string): ModelSelectorOption[] {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  if (!normalizedQuery) return options;

  return options.filter((option) => (
    `${option.name} ${option.modelId} ${option.provider}/${option.modelId}`
      .toLocaleLowerCase()
      .includes(normalizedQuery)
  ));
}

export interface ModelProviderGroup {
  provider: string;
  options: ModelSelectorOption[];
}

/** Groups models without changing either provider order or model order. */
export function groupModelOptionsByProvider(options: ModelSelectorOption[]): ModelProviderGroup[] {
  const groups: ModelProviderGroup[] = [];
  for (const option of options) {
    const group = groups.find((item) => item.provider === option.provider);
    if (group) group.options.push(option);
    else groups.push({ provider: option.provider, options: [option] });
  }
  return groups;
}

/** Keeps only models whose provider charges no tokens. */
export function filterFreeModelOptions(options: ModelSelectorOption[]): ModelSelectorOption[] {
  return options.filter((option) => option.free);
}

/** Finds the saved default model, which is the model marked with a filled star. */
export function findStarredModelOption(
  options: ModelSelectorOption[],
  defaultValue?: { provider: string; modelId: string } | null,
): ModelSelectorOption | undefined {
  return options.find((option) => (
    option.provider === defaultValue?.provider && option.modelId === defaultValue?.modelId
  ));
}

export function ModelSelector({
  options,
  value,
  onChange,
  onReselect,
  onClear,
  emptyLabel,
  selectedLabel,
  disabled = false,
  busy = false,
  isAutoSelection = false,
  ariaLabel,
  variant = "toolbar",
  placement = "up",
  defaultValue,
  onSetDefault,
  enableFavorites = true,
}: ModelSelectorProps) {
  const { t } = useI18n();
  const isMobile = useIsMobile();
  const rootRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [anchorRect, setAnchorRect] = useState<{ top: number; right: number; bottom: number; left: number; width: number } | null>(null);
  const [filter, setFilter] = useState("");
  const [listView, setListView] = useState<"all" | "free">("all");
  const [openProvider, setOpenProvider] = useState<string | null>(null);
  const locked = disabled || busy;
  const [favorites, setFavorites] = useState<string[]>([]);
  const favoritesLoadedRef = useRef(false);
  useEffect(() => {
    if (favoritesLoadedRef.current) return;
    favoritesLoadedRef.current = true;
    try {
      setFavorites(parseModelFavorites(window.localStorage.getItem(MODEL_FAVORITES_STORAGE_KEY)));
    } catch {
      /* storage can be unavailable (private mode); favorites stay empty */
    }
  }, []);
  const updateFavorites = (next: string[]) => {
    setFavorites(next);
    try {
      window.localStorage.setItem(MODEL_FAVORITES_STORAGE_KEY, serializeModelFavorites(next));
    } catch {
      /* keep the in-memory list when storage refuses the write */
    }
  };
  const favoriteRow = (option: ModelSelectorOption) => enableFavorites ? {
    isFavorite: isModelFavorite(favorites, option.provider, option.modelId),
    addLabel: t("chat.starModel"),
    removeLabel: t("chat.unstarModel"),
    onToggle: () => updateFavorites(toggleModelFavorite(favorites, option.provider, option.modelId)),
  } : undefined;
  // Options arrive in pi's /model order (orderSelectorModels()); never re-sort
  // them, or a models.json provider loses the order its file gives (#783).
  const filteredOptions = filterModelOptions(options, filter);
  const favoriteOptions = enableFavorites
    ? favorites
        .map((key) => {
          const separator = key.indexOf("/");
          const provider = key.slice(0, separator);
          const modelId = key.slice(separator + 1);
          return filteredOptions.find((option) => option.provider === provider && option.modelId === modelId);
        })
        .filter((option): option is ModelSelectorOption => option !== undefined)
    : [];
  const showFilter = options.length > MODEL_FILTER_THRESHOLD;
  const freeOptions = filterFreeModelOptions(options);
  const visibleOptions = listView === "free" ? filterFreeModelOptions(filteredOptions) : filteredOptions;
  const modelsByProvider = groupModelOptionsByProvider(visibleOptions);
  const starredOption = onSetDefault && listView === "all"
    ? findStarredModelOption(filteredOptions, defaultValue)
    : undefined;
  // The default model already has its own section; listing it among the
  // starred rows too would show the same model twice.
  const favoriteRows = starredOption
    ? favoriteOptions.filter((option) => option.provider !== starredOption.provider || option.modelId !== starredOption.modelId)
    : favoriteOptions;

  const currentName = selectedLabel ?? (value
    ? options.find((option) => option.modelId === value.modelId && option.provider === value.provider)?.name ?? value.modelId
    : emptyLabel ?? (options.length > 0 ? "Select model" : "No models"));

  useEffect(() => {
    const handleOutsideClick = (event: MouseEvent) => {
      if (
        rootRef.current && !rootRef.current.contains(event.target as Node)
        && panelRef.current && !panelRef.current.contains(event.target as Node)
      ) {
        setOpen(false);
        setFilter("");
      }
    };
    document.addEventListener("mousedown", handleOutsideClick);
    return () => document.removeEventListener("mousedown", handleOutsideClick);
  }, []);

  // While the picker is open, a phone keyboard shrinks the app height
  // (useViewportHeight writes the root's style, sometimes with no viewport
  // event) and moves the trigger; follow it instead of the rect from the tap.
  useEffect(() => {
    if (!open) return;
    const remeasure = () => {
      const rect = rootRef.current?.querySelector("button")?.getBoundingClientRect();
      // A new object even for an unmoved trigger: the panel also reads the
      // visual viewport, which may have changed alone.
      if (rect?.height) setAnchorRect({ top: rect.top, right: rect.right, bottom: rect.bottom, left: rect.left, width: rect.width });
    };
    const viewport = window.visualViewport;
    const rootObserver = new MutationObserver(remeasure);
    rootObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["style", "data-keyboard-open"] });
    window.addEventListener("resize", remeasure);
    viewport?.addEventListener("resize", remeasure);
    viewport?.addEventListener("scroll", remeasure);
    return () => {
      rootObserver.disconnect();
      window.removeEventListener("resize", remeasure);
      viewport?.removeEventListener("resize", remeasure);
      viewport?.removeEventListener("scroll", remeasure);
    };
  }, [open]);

  useEffect(() => {
    if (!locked) return;
    setOpen(false);
    setFilter("");
  }, [locked]);

  // A catalog refresh can remove the last free model while the picker is open.
  useEffect(() => {
    if (listView === "free" && freeOptions.length === 0) setListView("all");
  }, [freeOptions.length, listView]);

  const buttonStyle: CSSProperties = variant === "field"
    ? {
        display: "flex",
        alignItems: "center",
        gap: 7,
        width: "100%",
        minWidth: 0,
        height: 34,
        padding: "0 9px",
        overflow: "hidden",
        border: "1px solid var(--border)",
        borderRadius: 5,
        background: locked ? "var(--bg-panel)" : "var(--bg)",
        color: locked ? "var(--text-dim)" : "var(--text)",
        cursor: locked ? "default" : "pointer",
        fontSize: 12,
        textAlign: "left",
      }
    : {
        display: "flex",
        alignItems: "center",
        justifyContent: isMobile ? "flex-start" : undefined,
        gap: 6,
        width: isMobile ? "100%" : undefined,
        maxWidth: isMobile ? "100%" : 220,
        height: 32,
        padding: isMobile ? "8px 10px" : "8px 12px",
        overflow: "hidden",
        border: "none",
        borderRadius: 9,
        background: open ? "var(--bg-hover)" : "none",
        color: "var(--text-muted)",
        cursor: locked ? "not-allowed" : "pointer",
        fontSize: 12,
        opacity: locked ? 0.5 : 1,
        transition: "background 0.12s, color 0.12s",
      };

  const choose = (option: ModelSelectorOption) => {
    const active = option.modelId === value?.modelId && option.provider === value?.provider;
    setOpen(false);
    setFilter("");
    if (!active || isAutoSelection) onChange(option.provider, option.modelId);
    else onReselect?.(option.provider, option.modelId);
  };

  const saveDefault = (option: ModelSelectorOption) => {
    setOpen(false);
    setFilter("");
    onSetDefault?.(option.provider, option.modelId);
  };

  const renderModelRow = (option: ModelSelectorOption, showProvider = false) => (
    <SelectorRow
      key={`${option.provider}:${option.modelId}`}
      active={option.modelId === value?.modelId && option.provider === value?.provider}
      onSelect={() => choose(option)}
      star={onSetDefault ? {
        isDefault: option.modelId === defaultValue?.modelId && option.provider === defaultValue?.provider,
        saveLabel: t("chat.saveDefaultModel"),
        defaultLabel: t("chat.defaultModel"),
        onSave: () => saveDefault(option),
      } : undefined}
      favorite={favoriteRow(option)}
    >
      <OptionLabel label={option.name} provider={showProvider ? option.provider : undefined} />
    </SelectorRow>
  );

  return (
    <div
      ref={rootRef}
      className={`model-selector is-${variant}${locked ? " is-disabled" : ""}`}
      style={{ position: "relative", width: variant === "field" || isMobile ? "100%" : undefined, minWidth: 0, flex: variant === "toolbar" && isMobile ? "1 1 auto" : undefined }}
      onKeyDown={(event) => {
        if (event.key !== "Escape" || !open) return;
        event.preventDefault();
        event.stopPropagation();
        setFilter("");
        setOpen(false);
      }}
    >
      <button
        type="button"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-busy={busy || undefined}
        disabled={locked}
        title={busy ? "Switching model" : locked ? currentName : options.length > 0 || onClear ? "Change model" : "No available models"}
        style={buttonStyle}
        onClick={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          setAnchorRect({ top: rect.top, right: rect.right, bottom: rect.bottom, left: rect.left, width: rect.width });
          setOpen((current) => {
            if (current) setFilter("");
            return !current;
          });
        }}
        onMouseEnter={(event) => {
          if (locked) return;
          event.currentTarget.style.background = "var(--bg-hover)";
          event.currentTarget.style.color = "var(--text)";
        }}
        onMouseLeave={(event) => {
          if (locked) {
            event.currentTarget.style.background = variant === "field" ? "var(--bg-panel)" : "none";
            event.currentTarget.style.color = variant === "field" ? "var(--text-dim)" : "var(--text-muted)";
            return;
          }
          event.currentTarget.style.background = open ? "var(--bg-hover)" : variant === "field" ? "var(--bg)" : "none";
          event.currentTarget.style.color = variant === "field" ? "var(--text)" : "var(--text-muted)";
        }}
      >
        {busy ? (
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" style={{ animation: "spin 0.8s linear infinite", flexShrink: 0 }} aria-hidden="true">
            <path d="M21 12a9 9 0 1 1-2.64-6.36" />
          </svg>
        ) : (
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flexShrink: 0 }}>
            <rect x="4" y="4" width="16" height="16" rx="2" />
            <rect x="9" y="9" width="6" height="6" />
            <line x1="9" y1="1" x2="9" y2="4" /><line x1="15" y1="1" x2="15" y2="4" />
            <line x1="9" y1="20" x2="9" y2="23" /><line x1="15" y1="20" x2="15" y2="23" />
            <line x1="20" y1="9" x2="23" y2="9" /><line x1="20" y1="14" x2="23" y2="14" />
            <line x1="1" y1="9" x2="4" y2="9" /><line x1="1" y1="14" x2="4" y2="14" />
          </svg>
        )}
        <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{currentName}</span>
        {variant === "field" && (
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flexShrink: 0, color: "var(--text-dim)" }}>
            <polyline points="6 9 12 15 18 9" />
          </svg>
        )}
      </button>

      {open && anchorRect && (() => {
        // Fixed coordinates belong to the layout viewport, which a phone
        // keyboard does not shrink: measure from the visible part's top and
        // hang an upward panel from `top` rather than from `bottom`.
        const viewportTop = window.visualViewport?.offsetTop ?? 0;
        const viewportHeight = window.visualViewport?.height ?? window.innerHeight;
        const viewportWidth = window.visualViewport?.width ?? window.innerWidth;
        // A trigger the keyboard covers (a Settings field) still gets a
        // panel ending above the keyboard.
        const aboveEnd = Math.min(anchorRect.top - 6, viewportTop + viewportHeight - 8);
        const spaceAbove = aboveEnd - viewportTop - 8;
        const spaceBelow = viewportTop + viewportHeight - anchorRect.bottom - 6 - 8;
        const openAbove = placement === "up" || spaceAbove > spaceBelow;
        const maxHeight = Math.max(120, Math.min(openAbove ? spaceAbove : spaceBelow, viewportHeight * 0.6));
        const verticalPosition: CSSProperties = openAbove
          ? { top: aboveEnd, transform: "translateY(-100%)" }
          : { top: anchorRect.bottom + 6 };
        const horizontalPosition: CSSProperties = isMobile
          ? { left: 8, right: 8, maxWidth: "calc(100vw - 16px)" }
          : { left: anchorRect.left, width: "max-content", minWidth: anchorRect.width, maxWidth: Math.max(anchorRect.width, viewportWidth - anchorRect.left - 8) };

        return (
          <div
            ref={panelRef}
            role="listbox"
            aria-label={ariaLabel}
            style={{
              position: "fixed",
              ...verticalPosition,
              ...horizontalPosition,
              zIndex: 500,
              display: "flex",
              flexDirection: "column",
              maxHeight,
              overflow: "hidden",
              border: "1px solid var(--border)",
              borderRadius: 8,
              background: "var(--bg)",
              boxShadow: openAbove ? "0 -4px 16px rgba(0,0,0,0.10)" : "0 4px 16px rgba(0,0,0,0.10)",
            }}
          >
            {freeOptions.length > 0 && (
              <div
                role="tablist"
                aria-label={t("chat.modelListTabs")}
                style={{
                  display: "flex", flexShrink: 0, gap: 4,
                  padding: "6px 8px", borderBottom: "1px solid var(--border)",
                }}
              >
                <button
                  type="button"
                  role="tab"
                  aria-selected={listView === "all"}
                  onClick={() => setListView("all")}
                  style={{
                    flex: 1, minWidth: 0, padding: "5px 8px",
                    border: listView === "all" ? "1px solid var(--border)" : "1px solid transparent",
                    borderRadius: 5,
                    background: listView === "all" ? "var(--bg-hover)" : "transparent",
                    color: listView === "all" ? "var(--text)" : "var(--text-dim)",
                    cursor: "pointer", fontSize: 11, fontWeight: listView === "all" ? 600 : 400,
                    whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
                  }}
                >
                  {t("chat.allModels")} ({options.length})
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={listView === "free"}
                  onClick={() => setListView("free")}
                  style={{
                    flex: 1, minWidth: 0, padding: "5px 8px",
                    border: listView === "free" ? "1px solid var(--border)" : "1px solid transparent",
                    borderRadius: 5,
                    background: listView === "free" ? "var(--bg-hover)" : "transparent",
                    color: listView === "free" ? "var(--text)" : "var(--text-dim)",
                    cursor: "pointer", fontSize: 11, fontWeight: listView === "free" ? 600 : 400,
                    whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
                  }}
                >
                  {t("chat.freeModels")} ({freeOptions.length})
                </button>
              </div>
            )}
            {showFilter && (
              <div style={{ flexShrink: 0, padding: "6px 8px", borderBottom: "1px solid var(--border)" }}>
                <input
                  value={filter}
                  onChange={(event) => setFilter(event.target.value)}
                  placeholder={t("chat.filterModels")}
                  aria-label={t("chat.filterModels")}
                  // On phones, focusing the filter opens the on-screen keyboard,
                  // which shrinks the viewport and pushes the list off-screen
                  // before the user has decided to filter. Tap to filter instead.
                  autoFocus={!isMobile}
                  autoComplete="off"
                  spellCheck={false}
                  style={{
                    boxSizing: "border-box",
                    width: "100%",
                    minWidth: isMobile ? 0 : 220,
                    padding: "5px 8px",
                    border: "1px solid var(--border)",
                    borderRadius: 5,
                    outline: "none",
                    background: "var(--bg)",
                    color: "var(--text)",
                    fontFamily: "var(--font-mono)",
                    fontSize: 11,
                  }}
                />
              </div>
            )}
            <div style={{ minHeight: 0, overflowY: "auto" }}>
              {listView === "free" ? (
                visibleOptions.length === 0 ? (
                  <div style={{ padding: "8px 12px", color: "var(--text-dim)", fontSize: 12, whiteSpace: "nowrap" }}>
                    {t("chat.noMatchingModels")}
                  </div>
                ) : visibleOptions.map((option) => renderModelRow(option, true))
              ) : (
                <>
                  {favoriteRows.length > 0 && (
                    <section className="model-starred-section" aria-label={t("chat.starredModels")}>
                      <div style={{ padding: "7px 12px 4px", color: "var(--text-dim)", fontSize: 10, fontWeight: 600, textTransform: "uppercase" }}>
                        {t("chat.starredModels")} ({favoriteRows.length})
                      </div>
                      {favoriteRows.map((option) => renderModelRow(option, true))}
                    </section>
                  )}
                  {starredOption && (
                    <section className="model-starred-section" aria-label={t("chat.starredModels")}>
                      <div style={{ padding: "7px 12px 4px", color: "var(--text-dim)", fontSize: 10, fontWeight: 600, textTransform: "uppercase" }}>
                        {t("chat.starredModels")}
                      </div>
                      <SelectorRow
                        active={starredOption.modelId === value?.modelId && starredOption.provider === value?.provider}
                        onSelect={() => choose(starredOption)}
                        star={{
                          isDefault: true,
                          saveLabel: t("chat.saveDefaultModel"),
                          defaultLabel: t("chat.defaultModel"),
                          onSave: () => saveDefault(starredOption),
                        }}
                      >
                        <OptionLabel label={starredOption.name} />
                      </SelectorRow>
                    </section>
                  )}
                  {onClear && !filter.trim() && (
                    <SelectorRow active={!value} gutter={Boolean(onSetDefault)} onSelect={() => {
                      setOpen(false);
                      setFilter("");
                      onClear();
                    }}>
                      <OptionLabel label={emptyLabel ?? "Default"} />
                    </SelectorRow>
                  )}
                  {modelsByProvider.length === 0 ? (
                    <div style={{ padding: "8px 12px", color: "var(--text-dim)", fontSize: 12, whiteSpace: "nowrap" }}>
                      {filter.trim() ? t("chat.noMatchingModels") : "No available models"}
                    </div>
                  ) : modelsByProvider.map((group) => {
                    const expanded = Boolean(filter.trim()) || openProvider === group.provider;
                    return (
                      <section className="model-provider-group" key={group.provider}>
                        <button
                          type="button"
                          className="model-provider-header"
                          aria-expanded={expanded}
                          onClick={() => setOpenProvider((current) => current === group.provider ? null : group.provider)}
                          style={{
                            display: "flex", alignItems: "center", gap: 7,
                            width: "100%", padding: "7px 10px 7px 12px",
                            border: "none", borderTop: "1px solid var(--border)",
                            background: "transparent", color: "var(--text-dim)",
                            cursor: "pointer", fontSize: 10, fontWeight: 600,
                            textAlign: "left", textTransform: "uppercase",
                          }}
                        >
                          <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>{group.provider}</span>
                          <span style={{ marginLeft: "auto", color: "var(--text-dim)", fontSize: 10, fontWeight: 400 }}>{group.options.length}</span>
                          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flexShrink: 0, transform: expanded ? "rotate(180deg)" : "none", transition: "transform 0.12s" }}>
                            <polyline points="6 9 12 15 18 9" />
                          </svg>
                        </button>
                        {expanded && group.options.map((option) => renderModelRow(option))}
                      </section>
                    );
                  })}
                </>
              )}
            </div>
          </div>
        );
      })()}
    </div>
  );
}

function OptionLabel({ label, provider }: { label: string; provider?: string }) {
  return (
    <span style={{ display: "flex", alignItems: "center", gap: 7, minWidth: 0, flex: 1 }}>
      <span title={label} style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>{label}</span>
      {provider && (
        <span
          title={provider}
          style={{
            flexShrink: 0, maxWidth: 110, overflow: "hidden", textOverflow: "ellipsis",
            padding: "1px 5px", border: "1px solid var(--border)", borderRadius: 4,
            color: "var(--text-dim)", fontSize: 9, fontWeight: 400,
          }}
        >
          {provider}
        </span>
      )}
    </span>
  );
}
