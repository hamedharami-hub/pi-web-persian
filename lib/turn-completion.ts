import type { AgentMessage, AssistantMessage, ToolResultMessage } from "./types";

export type IncompleteTurnReason = "missing_tool_result" | "no_final_response";

/** Describe evidence of an unfinished turn, never infer that a tool failed or replay it.
 * Call only for a settled turn: pending calls are normal while its run is active.
 */
export function getIncompleteTurnReason(
  messages: readonly AgentMessage[],
  start: number,
  end: number,
): IncompleteTurnReason | null {
  let lastAssistant: AssistantMessage | undefined;
  const pending = new Set<string>();
  for (let i = start; i < end; i++) {
    const message = messages[i];
    if (message.role === "assistant") {
      lastAssistant = message;
      for (const block of message.content ?? []) {
        if (block.type === "toolCall") pending.add(block.toolCallId);
      }
    } else if (message.role === "toolResult") {
      pending.delete(message.toolCallId);
    }
  }
  if (!lastAssistant) return null; // A slash command need not produce an assistant reply.
  // These have their own explicit notices (or were deliberately stopped).
  if (["error", "length", "aborted"].includes(lastAssistant.stopReason ?? "")) return null;
  if (pending.size) return "missing_tool_result";
  // Text before a tool call is a progress update, not a final answer.
  const blocks = lastAssistant.content ?? [];
  const lastProcess = blocks.findLastIndex((block) => block.type !== "text" && block.type !== "image");
  const hasFinalAnswer = blocks.slice(lastProcess + 1).some((block) =>
    block.type === "image" || (block.type === "text" && block.text.trim().length > 0));
  return hasFinalAnswer ? null : "no_final_response";
}

/** Settlement evidence is separate from display notices: suppressed notices do not imply success. */
export function getTurnSettlementOutcome(messages: readonly AgentMessage[], start: number, end: number):
  IncompleteTurnReason | "answered" | "aborted" | "error" | "length" | "unknown" {
  let lastAssistant: AssistantMessage | undefined;
  for (let i = start; i < end; i++) if (messages[i].role === "assistant") lastAssistant = messages[i] as AssistantMessage;
  if (!lastAssistant) return "unknown";
  const stop = lastAssistant.stopReason;
  if (stop === "aborted" || stop === "error" || stop === "length") return stop;
  return getIncompleteTurnReason(messages, start, end) ?? "answered";
}

/** No recorded result is not a success, even after the host process was lost. */
export function toolResultColors(result: ToolResultMessage | undefined, isError: boolean, running = false) {
  if (isError) return { border: "rgba(248,113,113,0.45)", background: "rgba(248,113,113,0.05)", text: "#f87171", divider: "rgba(248,113,113,0.25)" };
  if (!result || result.isPartial || running) return { border: "var(--border)", background: "var(--bg-subtle)", text: "var(--text-muted)", divider: "var(--border)" };
  return { border: "rgba(34,197,94,0.25)", background: "rgba(34,197,94,0.04)", text: "#16a34a", divider: "rgba(34,197,94,0.2)" };
}
