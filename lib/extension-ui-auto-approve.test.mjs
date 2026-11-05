import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

test("extension select requests are queued rather than automatically approved", () => {
  const source = readFileSync(new URL("../hooks/useAgentSession.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /autoApprovedExtensionUiValue/);
  assert.match(source, /case "select":\s*case "confirm":\s*case "input":\s*case "editor":\s*setExtensionDialogs/);
});
