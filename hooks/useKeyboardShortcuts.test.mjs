import assert from "node:assert/strict";
import test from "node:test";
import { handleGlobalEscape, isNewSessionShortcut, registerAbortHandler } from "./useKeyboardShortcuts.ts";

function keydown(key, { tagName = "BUTTON", defaultPrevented = false } = {}) {
  return {
    key,
    target: { tagName },
    defaultPrevented,
    preventDefault() { this.defaultPrevented = true; },
  };
}

test("Escape stops a running agent when nothing else took the key", (t) => {
  let stopped = 0;
  registerAbortHandler(() => { stopped += 1; });
  t.after(() => registerAbortHandler(null));

  const event = keydown("Escape");
  assert.equal(handleGlobalEscape(event), true);
  assert.equal(stopped, 1);
  assert.equal(event.defaultPrevented, true);
  // Focus on the page itself, as after a click on nothing in particular.
  assert.equal(handleGlobalEscape(keydown("Escape", { tagName: "BODY" })), true);
  assert.equal(stopped, 2);
  assert.equal(handleGlobalEscape(keydown("Enter")), false);
  assert.equal(stopped, 2);
});

test("an Escape something nearer already handled does not stop the agent too", (t) => {
  let stopped = 0;
  registerAbortHandler(() => { stopped += 1; });
  t.after(() => registerAbortHandler(null));

  // Settings, the Mermaid viewer or a menu closed on it and marked it handled.
  assert.equal(handleGlobalEscape(keydown("Escape", { defaultPrevented: true })), false);
  // ChatInput and other fields keep their own Escape.
  assert.equal(handleGlobalEscape(keydown("Escape", { tagName: "TEXTAREA" })), false);
  assert.equal(handleGlobalEscape(keydown("Escape", { tagName: "INPUT" })), false);
  assert.equal(stopped, 0);
});

test("with no run to stop, Escape is left alone", () => {
  registerAbortHandler(null);
  const event = keydown("Escape");
  assert.equal(handleGlobalEscape(event), false);
  assert.equal(event.defaultPrevented, false);
});

function shortcut({ key = "n", code = "KeyN", ctrlKey = true, altKey = true } = {}) {
  return isNewSessionShortcut({ key, code, ctrlKey, altKey });
}

test("Ctrl+Alt+N starts a new session", () => {
  assert.equal(shortcut(), true);
  // Caps Lock and Shift still deliver the letter; code is unchanged.
  assert.equal(shortcut({ key: "N" }), true);
  assert.equal(shortcut({ key: "N", code: "KeyN" }), true);
});

test("macOS reports a dead key for Option+N, so the physical key decides", () => {
  // Option+N is `˜` in the U.S., ABC and British layouts. Chrome sends
  // key="Dead" with the modifiers intact, which the old key-only match missed.
  assert.equal(shortcut({ key: "Dead" }), true);
});

test("a character Ctrl+Alt types is the user's text, not the shortcut", () => {
  // Windows reports AltGr as Ctrl+Alt: Polish AltGr+N types `\u0144`, Czech `}`.
  assert.equal(shortcut({ key: "\u0144" }), false);
  assert.equal(shortcut({ key: "}" }), false);
  // Dvorak's physical N is `b`; its `n` (KeyL) still matches by the letter.
  assert.equal(shortcut({ key: "b" }), false);
  assert.equal(shortcut({ key: "n", code: "KeyL" }), true);
});

test("the shortcut needs both Ctrl and Alt", () => {
  assert.equal(shortcut({ ctrlKey: false }), false);
  assert.equal(shortcut({ altKey: false }), false);
  assert.equal(shortcut({ ctrlKey: false, altKey: false }), false);
});

test("another key with Ctrl and Alt is not the shortcut", () => {
  assert.equal(shortcut({ key: "m", code: "KeyM" }), false);
  assert.equal(shortcut({ key: "Dead", code: "KeyM" }), false);
});

test("a KeyboardEvent without a code still matches by key", () => {
  // Older Safari and events built by hand carry no `code`.
  assert.equal(isNewSessionShortcut({ key: "n", code: null, ctrlKey: true, altKey: true }), true);
  assert.equal(isNewSessionShortcut({ key: "Dead", code: null, ctrlKey: true, altKey: true }), false);
  assert.equal(shortcut({ key: "n", code: "" }), true);
  assert.equal(shortcut({ key: "Dead", code: "" }), false);
});

const {
  isPlanToggleShortcut,
  isTeamToggleShortcut,
  registerWorkflowShortcutHandlers,
  handleGlobalWorkflowShortcut,
} = await import("./useKeyboardShortcuts.ts");

test("isPlanToggleShortcut and isTeamToggleShortcut handle Ctrl+Alt, Dead keys, and AltGr text", () => {
  assert.equal(isPlanToggleShortcut({ key: "p", code: "KeyP", ctrlKey: true, altKey: true }), true);
  assert.equal(isPlanToggleShortcut({ key: "Dead", code: "KeyP", ctrlKey: true, altKey: true }), true);
  assert.equal(isPlanToggleShortcut({ key: "π", code: "KeyP", ctrlKey: true, altKey: true }), false);
  assert.equal(isPlanToggleShortcut({ key: "p", code: "KeyP", ctrlKey: true, altKey: false }), false);

  assert.equal(isTeamToggleShortcut({ key: "t", code: "KeyT", ctrlKey: true, altKey: true }), true);
  assert.equal(isTeamToggleShortcut({ key: "Dead", code: "KeyT", ctrlKey: true, altKey: true }), true);
  assert.equal(isTeamToggleShortcut({ key: "þ", code: "KeyT", ctrlKey: true, altKey: true }), false);
  assert.equal(isTeamToggleShortcut({ key: "t", code: "KeyT", ctrlKey: false, altKey: true }), false);
});

test("registerWorkflowShortcutHandlers dispatches plan and team toggles and respects defaultPrevented", () => {
  let planCalls = 0;
  let teamCalls = 0;
  let prevented = 0;

  registerWorkflowShortcutHandlers({
    onTogglePlan: () => { planCalls++; },
    onToggleTeam: () => { teamCalls++; },
  });

  try {
    assert.equal(
      handleGlobalWorkflowShortcut({
        key: "p",
        code: "KeyP",
        ctrlKey: true,
        altKey: true,
        preventDefault: () => { prevented++; },
      }),
      true,
    );
    assert.equal(planCalls, 1);
    assert.equal(teamCalls, 0);
    assert.equal(prevented, 1);

    assert.equal(
      handleGlobalWorkflowShortcut({
        key: "t",
        code: "KeyT",
        ctrlKey: true,
        altKey: true,
        preventDefault: () => { prevented++; },
      }),
      true,
    );
    assert.equal(teamCalls, 1);
    assert.equal(prevented, 2);

    assert.equal(
      handleGlobalWorkflowShortcut({
        key: "p",
        code: "KeyP",
        ctrlKey: true,
        altKey: true,
        defaultPrevented: true,
        preventDefault: () => { prevented++; },
      }),
      false,
    );
    assert.equal(planCalls, 1);
  } finally {
    registerWorkflowShortcutHandlers(null);
  }

  assert.equal(
    handleGlobalWorkflowShortcut({
      key: "p",
      code: "KeyP",
      ctrlKey: true,
      altKey: true,
    }),
    false,
  );
});
