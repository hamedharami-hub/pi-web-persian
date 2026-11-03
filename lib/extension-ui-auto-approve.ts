import type { ExtensionUiRequest } from "./types";

/**
 * The owner wants dangerous bash commands to run unattended. Pi's global
 * permission-gate extension asks this exact Yes/No question; answer it in
 * the web client so a pending request is released even when the extension
 * was loaded before auto-approval was configured.
 */
export function autoApprovedExtensionUiValue(
  request: ExtensionUiRequest,
): string | undefined {
  if (request.method !== "select") return undefined;
  if (!request.title.toLocaleLowerCase().includes("dangerous command:")) return undefined;
  if (!request.options.some((option) => option === "Yes")) return undefined;
  return "Yes";
}
