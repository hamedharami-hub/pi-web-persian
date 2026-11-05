/**
 * Decides when a sub-agent run that ran out of tokens, credits or context
 * should be continued on the parent session's model instead of failing.
 *
 * Only provider-side exhaustion counts. A transient rate limit, a network
 * error or a plain provider bug is left alone: switching models would not fix
 * it and would hide the real failure.
 */

const EXHAUSTION_PATTERNS: RegExp[] = [
  /context[_ ]length[_ ]exceeded/i,
  /maximum context length/i,
  /context window (?:is )?(?:full|exceeded)/i,
  /too many tokens/i,
  /token (?:limit|quota|budget) (?:exceeded|reached)/i,
  /exceed(?:ed|s)? (?:the )?(?:model'?s? )?(?:maximum )?(?:token|context)/i,
  /insufficient[_ ](?:quota|credits?|balance)/i,
  /quota (?:exceeded|exhausted)/i,
  /out of (?:tokens|credits|quota)/i,
  /credit balance is too low/i,
  /billing (?:hard )?limit/i,
  /\b402\b.*(?:payment|credit|quota)/i,
  /(?:no|not enough) (?:tokens|credits) remaining/i,
];

/** Whether a provider error means the run cannot continue on that model. */
export function isModelExhaustionError(message: string | undefined | null): boolean {
  if (!message) return false;
  return EXHAUSTION_PATTERNS.some((pattern) => pattern.test(message));
}

export interface ModelIdentity {
  provider: string;
  id: string;
}

/**
 * A fallback is only meaningful on a different model: retrying the exhausted
 * one costs the same failure. A missing parent model (no model resolved yet)
 * also refuses.
 */
export function shouldFallbackToParentModel(options: {
  error: string | undefined | null;
  childModel: ModelIdentity | undefined;
  parentModel: ModelIdentity | undefined;
}): boolean {
  const { error, childModel, parentModel } = options;
  if (!isModelExhaustionError(error)) return false;
  if (!parentModel) return false;
  if (!childModel) return true;
  return childModel.provider !== parentModel.provider || childModel.id !== parentModel.id;
}

/** What the child is asked after the model switch, so it resumes instead of repeating. */
export const MODEL_FALLBACK_INSTRUCTION =
  "Your previous model could not continue (its token quota or context limit was reached). Continue the same task from exactly where it stopped, using the work already done in this session. Do not restart from the beginning and do not repeat completed tool calls.";

/** Shown in the run's result so the parent model knows the answer came from a fallback. */
export function modelFallbackNote(previous: string | undefined, next: ModelIdentity | undefined): string {
  const from = previous ?? "the profile's model";
  return next
    ? `Completed on the parent session's model (${next.provider}/${next.id}) after ${from} ran out of tokens.`
    : `Completed on the parent session's model after ${from} ran out of tokens.`;
}
