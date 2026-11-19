import { existsSync } from "fs";
import { stat } from "fs/promises";
import { resolve } from "path";
import { createAgentSessionServices, getAgentDir, type SettingsManager } from "@earendil-works/pi-coding-agent";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import {
  loadModelsWithCache,
  withModelRuntimeError,
  withSafeModelLoadFailure,
  type ModelsData,
} from "@/lib/models-cache";
import { orderSelectorModels, resolveVisibleModels, selectInitialModelScope } from "@/lib/model-scope";
import { getAllowedFileRoots, isExistingFilePathAllowed } from "@/lib/file-access";
import { projectTrustReloadOptions } from "@/lib/project-trust";
import { llamaCppExtension } from "@/lib/pi-sdk-internals";
import { providerDisplayNames, rememberProviderModels, withDeferredProviderModels } from "@/lib/deferred-provider-models";
import { inferRemovedWorktree } from "@/lib/worktree";
import { cwdMissingBody } from "@/lib/missing-cwd";
import { filterStaleLiveModels } from "@/lib/live-free-sync";
import { isFreeModel } from "@/lib/model-free";

export const dynamic = "force-dynamic";

async function loadModels(cwd: string, scopeAll = false): Promise<ModelsData> {
  const nameMap = new Map<string, string>();
  let modelList: ModelsData["modelList"] = [];
  let defaultModel: { provider: string; modelId: string } | null = null;
  const thinkingLevels: Record<string, string[]> = {};
  const thinkingLevelMaps: Record<string, Record<string, string | null>> = {};

  const agentDir = getAgentDir();
  // Gate untrusted project extensions: enumerating models still imports and
  // runs a repository's .pi/extensions factories, so honor project trust here
  // too (see lib/project-trust.ts, #236).
  const trustReloadOptions = projectTrustReloadOptions(cwd, agentDir);
  const services = await createAgentSessionServices({
    cwd,
    agentDir,
    resourceLoaderOptions: { extensionFactories: [llamaCppExtension] },
    ...(trustReloadOptions ? { resourceLoaderReloadOptions: trustReloadOptions } : {}),
  });
  const modelError = services.modelRuntime.getError();
  const settings: SettingsManager = services.settingsManager;
  await rememberProviderModels(services.modelRuntime);
  const providerNames = providerDisplayNames(services.modelRuntime);
  const runtimeWithDeferred = withDeferredProviderModels(services.modelRuntime);
  const customProviderCache = new Map<string, boolean>();
  const isCustomModelsJsonProvider = (providerId: string): boolean => {
    const cached = customProviderCache.get(providerId);
    if (cached !== undefined) return cached;
    const source = services.modelRuntime.getProviderAuthStatus(providerId).source;
    const custom = source === "models_json_key" || source === "models_json_command";
    customProviderCache.set(providerId, custom);
    return custom;
  };
  const toModelEntry = (m: (typeof visible)[number]) => ({
    id: m.id,
    name: m.name,
    provider: m.provider,
    // The selector groups by provider id, but labels the group with its display
    // name; models.json providers get theirs from `name` too.
    providerName: providerNames.get(m.provider) ?? m.provider,
    input: m.input,
    free: isFreeModel({
      id: m.id,
      provider: m.provider,
      baseUrl: m.baseUrl,
      api: m.api,
      isCustomProvider: isCustomModelsJsonProvider(m.provider),
      cost: m.cost,
    }),
    ...(m.cost && (m.cost.input > 0 || m.cost.output > 0)
      ? { cost: { input: m.cost.input, output: m.cost.output } }
      : {}),
  });

  // `enabledModels` supports globs and fuzzy patterns, so resolve it the same
  // way the CLI does instead of comparing pattern strings literally (#307).
  const scope = await resolveVisibleModels(
    runtimeWithDeferred,
    scopeAll ? undefined : settings.getEnabledModels(),
  );
  const { thinkingLevelPins, warnings } = scope;
  const visible = await filterStaleLiveModels(scope.visible, agentDir);
  modelList = orderSelectorModels({ ...scope, visible }).map(toModelEntry);
  const allAvailable = await filterStaleLiveModels(await runtimeWithDeferred.getAvailable(), agentDir);
  const freeModels = [...allAvailable]
    .sort((a, b) => a.provider.localeCompare(b.provider))
    .map(toModelEntry)
    .filter((entry) => entry.free);
  const freeRawModels = allAvailable.filter((m) => isFreeModel({
    id: m.id,
    provider: m.provider,
    baseUrl: m.baseUrl,
    api: m.api,
    isCustomProvider: isCustomModelsJsonProvider(m.provider),
    cost: m.cost,
  }));
  for (const m of [...visible, ...freeRawModels]) {
    const key = `${m.provider}:${m.id}`;
    nameMap.set(key, m.name);
    thinkingLevels[key] = getSupportedThinkingLevels(m);
    if (m.thinkingLevelMap) thinkingLevelMaps[key] = m.thinkingLevelMap;
  }

  const defaultProvider = settings.getDefaultProvider();
  const defaultModelId = settings.getDefaultModel();
  const initial = selectInitialModelScope(scope, {
    ...(defaultProvider && defaultModelId
      ? { defaultModel: { provider: defaultProvider, modelId: defaultModelId } }
      : {}),
  });
  if (initial.model) {
    defaultModel = { provider: initial.model.provider, modelId: initial.model.id };
  }
  const defaultThinkingLevel = initial.thinkingLevel
    ?? (initial.model
      ? settings.getModelThinkingLevel(initial.model.provider, initial.model.id)
      : undefined)
    ?? settings.getDefaultThinkingLevel()
    ?? null;

  return withModelRuntimeError(
    {
      models: Object.fromEntries(nameMap),
      modelList,
      freeModelList: freeModels,
      defaultModel,
      defaultThinkingLevel,
      savedDefaultThinkingLevel: settings.getDefaultThinkingLevel() ?? null,
      thinkingLevels,
      thinkingLevelMaps,
      thinkingLevelPins,
      ...(warnings.length > 0 ? { modelScopeWarnings: warnings } : {}),
      isScoped: scopeAll ? false : scope.scopedModels.length > 0,
    },
    modelError,
  );
}

const EMPTY_MODELS: ModelsData = {
  models: {},
  modelList: [],
  defaultModel: null,
  defaultThinkingLevel: null,
  savedDefaultThinkingLevel: null,
  thinkingLevels: {},
  thinkingLevelMaps: {},
  thinkingLevelPins: {},
  isScoped: false,
};

export async function GET(req: Request) {
  const url = new URL(req.url);
  const requestedCwd = resolve(url.searchParams.get("cwd") || process.cwd());
  const scopeAll = url.searchParams.get("scope") === "all";
  // A subagent run isolated in a worktree has that worktree removed when the run
  // finishes, yet its session file still records the worktree as its cwd. Fall back
  // to the main repo it branched from, so opening a finished subagent resolves the
  // same models a non-isolated one would. The roots check below runs on the folder
  // actually answered from, so the fallback reaches no project that was not allowed
  // by name already.
  const cwd = existsSync(requestedCwd)
    ? requestedCwd
    : inferRemovedWorktree(requestedCwd)?.projectRoot ?? requestedCwd;

  let cwdStat;
  try {
    cwdStat = await stat(cwd);
  } catch {
    // Typed: a moved project's session is not a model problem (#1422).
    return Response.json(cwdMissingBody(cwd), { status: 400 });
  }
  if (!cwdStat.isDirectory()) {
    return Response.json({ error: `Not a directory: ${cwd}` }, { status: 400 });
  }
  const allowedRoots = await getAllowedFileRoots();
  if (!isExistingFilePathAllowed(cwd, allowedRoots)) {
    return Response.json({ error: "Access denied" }, { status: 403 });
  }

  try {
    const cacheKey = scopeAll ? `${cwd}#all` : cwd;
    return Response.json(await loadModelsWithCache(cacheKey, () => loadModels(cwd, scopeAll)));
  } catch {
    return Response.json(withSafeModelLoadFailure(EMPTY_MODELS));
  }
}
