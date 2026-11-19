/** The token-price fields pi-ai exposes for a model. */
export interface ModelCostLike {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
}

export interface FreeModelLike {
  id: string;
  provider?: string;
  baseUrl?: string;
  api?: string;
  isCustomProvider?: boolean;
  cost?: ModelCostLike;
}

const NON_CHAT_MODEL_PATTERN = /(?:^|\/)lyria-|^whisper|^distil-whisper|^playai-tts|canopylabs\/orpheus|llama-(?:prompt-)?guard|safeguard/i;

function isGoogleGenerativeAiUrl(baseUrl?: string): boolean {
  if (!baseUrl) return false;
  try {
    return new URL(baseUrl).hostname === "generativelanguage.googleapis.com";
  } catch {
    return baseUrl.includes("generativelanguage.googleapis.com");
  }
}

export function isLoopbackBaseUrl(baseUrl?: string): boolean {
  if (!baseUrl) return false;
  try {
    const host = new URL(baseUrl).hostname.replace(/^\[|\]$/g, "").toLowerCase();
    return host === "localhost" || host === "127.0.0.1" || host === "::1";
  } catch {
    return false;
  }
}

/**
 * A model is free when it is usable on a free tier or has no token charge.
 *
 * Excludes non-chat models (audio/guardrails), OpenRouter's paid meta-routers
 * whose catalog entry reports zero cost, and personal Google Generative AI
 * entries from `models.json` that leave token pricing at zero.
 */
export function isFreeModel(model: FreeModelLike): boolean {
  const id = model.id;
  const lowerId = id.toLocaleLowerCase();
  const provider = model.provider?.toLocaleLowerCase();

  if (NON_CHAT_MODEL_PATTERN.test(id)) return false;

  if (provider === "openrouter") {
    return lowerId === "openrouter/free" || lowerId.endsWith(":free");
  }

  // Personal Google Gemini accounts in models.json use `cost: 0` placeholders.
  if (
    model.isCustomProvider
    && (model.api === "google-generative-ai" || isGoogleGenerativeAiUrl(model.baseUrl))
    && !lowerId.endsWith(":free")
  ) {
    return false;
  }

  if (lowerId.endsWith(":free")) return true;

  // Groq developer keys provide a free rate-limited tier for chat models.
  if (provider === "groq") return true;

  const prices = [
    model.cost?.input,
    model.cost?.output,
    model.cost?.cacheRead,
    model.cost?.cacheWrite,
  ].filter((price): price is number => typeof price === "number");
  return prices.length > 0 && prices.every((price) => price === 0);
}
