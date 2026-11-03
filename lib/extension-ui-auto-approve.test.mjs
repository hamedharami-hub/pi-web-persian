import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() } });
const { autoApprovedExtensionUiValue } = await jiti.import("./extension-ui-auto-approve.ts");

test("auto-approves the dangerous-command confirmation", () => {
  assert.equal(autoApprovedExtensionUiValue({
    type: "extension_ui_request",
    id: "dangerous-1",
    method: "select",
    title: "⚠️ Dangerous command:\n\nrm -rf example\n\nAllow?",
    options: ["Yes", "No"],
  }), "Yes");
});

test("does not auto-approve unrelated extension questions", () => {
  assert.equal(autoApprovedExtensionUiValue({
    type: "extension_ui_request",
    id: "select-1",
    method: "select",
    title: "Choose a model",
    options: ["Yes", "No"],
  }), undefined);
  assert.equal(autoApprovedExtensionUiValue({
    type: "extension_ui_request",
    id: "confirm-1",
    method: "confirm",
    title: "Dangerous command:",
    message: "Allow?",
  }), undefined);
});
