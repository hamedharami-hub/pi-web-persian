/**
 * Starred models, kept in the browser so several models can be marked at once.
 *
 * The filled star in the model picker means "the model new sessions start
 * with" and only one model can hold it. These favorites are a separate,
 * multi-value list the user curates for quick access.
 */

export const MODEL_FAVORITES_STORAGE_KEY = "pi-web:model-favorites";
export const MAX_MODEL_FAVORITES = 25;

/** The stable identity of a model in the favorites list. */
export function modelFavoriteKey(provider: string, modelId: string): string {
  return `${provider}/${modelId}`;
}

/** Keeps only well-formed `provider/modelId` entries, first occurrence wins. */
export function parseModelFavorites(raw: string | null | undefined): string[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const seen = new Set<string>();
  const favorites: string[] = [];
  for (const entry of parsed) {
    if (typeof entry !== "string") continue;
    const value = entry.trim();
    if (!/^[^\s/]+\/\S+$/.test(value)) continue;
    if (seen.has(value)) continue;
    seen.add(value);
    favorites.push(value);
    if (favorites.length >= MAX_MODEL_FAVORITES) break;
  }
  return favorites;
}

export function serializeModelFavorites(favorites: readonly string[]): string {
  return JSON.stringify(favorites.slice(0, MAX_MODEL_FAVORITES));
}

export function isModelFavorite(favorites: readonly string[], provider: string, modelId: string): boolean {
  return favorites.includes(modelFavoriteKey(provider, modelId));
}

/** Adds an unmarked model, removes a marked one; order is the order they were starred. */
export function toggleModelFavorite(
  favorites: readonly string[],
  provider: string,
  modelId: string,
): string[] {
  const key = modelFavoriteKey(provider, modelId);
  if (favorites.includes(key)) return favorites.filter((entry) => entry !== key);
  return [...favorites, key].slice(-MAX_MODEL_FAVORITES);
}
