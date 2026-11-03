/** The token-price fields pi-ai exposes for a model. */
export interface ModelCostLike {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
}

export interface FreeModelLike {
  id: string;
  cost?: ModelCostLike;
}

/**
 * A model is free when it has no token charge. Providers may explicitly mark
 * a model with a `:free` id even when the catalog omits its cost.
 */
export function isFreeModel(model: FreeModelLike): boolean {
  if (model.id.toLocaleLowerCase().endsWith(":free")) return true;

  const prices = [
    model.cost?.input,
    model.cost?.output,
    model.cost?.cacheRead,
    model.cost?.cacheWrite,
  ].filter((price): price is number => typeof price === "number");
  return prices.length > 0 && prices.every((price) => price === 0);
}
