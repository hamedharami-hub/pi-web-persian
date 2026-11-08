import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

// Native Node TS stripping loads the actual global extension, not a copied policy.
const { default: register, isSelfHostMutation } = await import(
  "/home/ubuntu/.pi/agent/extensions/permission-gate.ts"
);
const blocked = [
  "systemctl --user restart pi-web-contabo",
  "systemctl stop pi-web.service",
  "sudo -n /usr/bin/systemctl --user --no-block restart pi-web-contabo.service",
  "sudo -u ubuntu systemctl --user kill --signal SIGTERM pi-web-contabo",
  "systemctl --user --signal=KILL kill pi-web-contabo.service",
  "systemctl reload-or-restart pi-web",
  "systemctl try-restart pi-web-contabo",
  "systemctl --user stop other.service pi-web-contabo.service",
  "printf ready\nsystemctl --user restart pi-web-contabo",
  "true && systemctl --user restart 'pi-web-contabo.service'",
  "systemctl --user \\\n restart pi-web-contabo",
  "env FOO=bar sudo --user ubuntu systemctl --user restart pi-web-contabo",
  'bash -lc "sudo systemctl --user restart pi-web-contabo"',
  "sh -c 'systemctl stop pi-web'",
  "if true; then systemctl stop pi-web; fi",
  "nohup systemctl --user restart pi-web-contabo >/tmp/restart.log &",
  'systemctl --user restart "pi-web"-contabo.service',
  "pm2 stop pi-web",
  "pm2 restart pi-web-contabo --update-env",
  "sudo -n pm2 delete pi-web",
  "pm2 --silent restart pi-web",
  "pm2 stop all",
  "pm2 reload pi-web",
];
const allowed = [
  "systemctl --user status pi-web-contabo",
  "systemctl --user show pi-web-contabo.service",
  "systemctl is-active pi-web",
  "journalctl --user -u pi-web-contabo -n 50 --no-pager",
  "systemctl restart nginx",
  "sudo systemctl stop another.service",
  "systemctl restart not-pi-web.service",
  "systemctl status pi-web; systemctl restart nginx",
  "systemctl restart nginx; echo pi-web-contabo",
  "pm2 status pi-web",
  "pm2 logs pi-web --lines 20",
  "pm2 restart other-app",
  "npm run build",
  'echo "systemctl restart pi-web-contabo"',
  "printf '%s' 'pm2 delete pi-web'",
  "grep 'systemctl restart pi-web' README.md",
  "# systemctl stop pi-web\nsystemctl status pi-web",
];

for (const command of blocked) test(`detect: ${command}`, () => {
  assert.equal(isSelfHostMutation(command), true);
});
for (const command of allowed) test(`allow: ${command}`, () => {
  assert.equal(isSelfHostMutation(command), false);
});

function mock() {
  const handlers = new Map();
  register({ on: (name, handler) => handlers.set(name, handler) });
  return (command, ctx = { hasUI: true, ui: { select() { throw Error("unexpected approval"); } } }, toolName = "bash") =>
    handlers.get("tool_call")({ toolName, input: { command } }, ctx);
}
function withEnv(values, fn) {
  return async () => {
    const saved = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
    try {
      for (const [key, value] of Object.entries(values)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
      await fn();
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
    }
  };
}
for (const optIn of [undefined, "0", "1"]) {
  test(`web blocks without approval independently of opt-in=${optIn}`, withEnv({
    PI_WEB_HOSTNAME: "127.0.0.1", PI_BLOCK_DANGEROUS_COMMANDS: optIn,
  }, async () => {
    const call = mock();
    for (const command of blocked) {
      for (const hasUI of [true, false]) {
        const result = await call(command, { hasUI, ui: { select() { throw Error("unexpected approval"); } } });
        assert.equal(result.block, true, command);
        assert.match(result.reason, /external controlled restart after the response/);
        assert.match(result.reason, /میزبان همین گفتگو/);
      }
    }
    assert.equal(await call("anything", undefined, "read"), undefined);
  }));
}
test("plain CLI retains unattended behavior", withEnv({ PI_WEB_HOSTNAME: undefined, PI_BLOCK_DANGEROUS_COMMANDS: undefined }, async () => {
  for (const command of blocked) assert.equal(await mock()(command), undefined);
}));
test("web read-only/build/other-service commands remain allowed", withEnv({ PI_WEB_HOSTNAME: "localhost", PI_BLOCK_DANGEROUS_COMMANDS: "0" }, async () => {
  for (const command of allowed) assert.equal(await mock()(command), undefined);
}));
test("existing opt-in dangerous command policy is preserved", withEnv({ PI_WEB_HOSTNAME: undefined, PI_BLOCK_DANGEROUS_COMMANDS: "1" }, async () => {
  const call = mock();
  assert.equal((await call("sudo systemctl restart pi-web", { hasUI: false })).reason, "Dangerous command blocked (no UI for confirmation)");
  for (const command of ["rm -r -f scratch", "sudo true", "chmod 777 scratch", "chown 777 scratch"]) {
    let approvals = 0;
    assert.equal(await call(command, { hasUI: true, ui: { select: async () => { approvals++; return "Yes"; } } }), undefined);
    assert.equal(approvals, 1);
    assert.equal((await call(command, { hasUI: true, ui: { select: async () => "No" } })).reason, "Blocked by user");
  }
}));
test("dangerous approval passes the actual signal and abort settles blocked", { timeout: 2000 }, withEnv({
  PI_WEB_HOSTNAME: undefined, PI_BLOCK_DANGEROUS_COMMANDS: "1",
}, async () => {
  for (const alreadyAborted of [false, true]) {
    const controller = new AbortController();
    if (alreadyAborted) controller.abort();
    let selected = 0;
    const pending = mock()("sudo true", {
      hasUI: true, signal: controller.signal,
      ui: { select(title, choices, options) {
        selected++;
        assert.match(title, /Dangerous command/);
        assert.deepEqual(choices, ["Yes", "No"]);
        assert.equal(options.signal, controller.signal);
        // SDK select contract: abort dismisses with undefined, not an approval.
        return new Promise((resolve) => {
          if (options.signal.aborted) resolve(undefined);
          else options.signal.addEventListener("abort", () => resolve(undefined), { once: true });
        });
      } },
    });
    controller.abort();
    assert.equal((await pending).block, true);
    assert.equal(selected, 1);
  }
}));
test("cancel and raced Yes never approve an aborted dangerous call", withEnv({
  PI_WEB_HOSTNAME: undefined, PI_BLOCK_DANGEROUS_COMMANDS: "1",
}, async () => {
  const call = mock();
  assert.equal((await call("sudo true", { hasUI: true, ui: { select: async () => undefined } })).block, true);
  const controller = new AbortController();
  assert.equal((await call("sudo true", {
    hasUI: true, signal: controller.signal,
    ui: { select: async () => { controller.abort(); return "Yes"; } },
  })).block, true);
}));
test("launcher explicitly supplies the web marker", async () => {
  const launcher = await readFile(new URL("../bin/pi-web.js", import.meta.url), "utf8");
  assert.match(launcher, /env: \{ \.\.\.process\.env, PI_WEB_HOSTNAME: hostname \}/);
});
