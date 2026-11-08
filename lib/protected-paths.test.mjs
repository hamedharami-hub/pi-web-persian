import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, symlink, rm } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import register, { resolveToolPath } from "/home/ubuntu/.pi/agent/extensions/protected-paths.ts";
import { resolveToCwd } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/tools/path-utils.js";
import { createWriteToolDefinition } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/tools/write.js";
import { createEditToolDefinition } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/tools/edit.js";

function guard(cwd) {
  let handler;
  register({ on: (name, fn) => { assert.equal(name, "tool_call"); handler = fn; } });
  return (path, toolName = "write") => handler({ toolName, input: { path } }, { cwd });
}

test("mirrored resolver matches installed SDK and actual write/edit operations", async () => {
  const cwd = join(tmpdir(), "pi-sdk-path-fixture");
  const paths = [
    "@.env", "@.env.local", "@.git/config", "@node_modules/pkg/index.js",
    "@@.env", "./@.env", "@", "~", "~/fixture/.env", "@~/fixture/.env",
    "~someone/.env", "/tmp/plain.txt", "@/tmp/.env", " a.txt ",
    "a\\ b.txt", "$HOME/.env", "caf\u00e9.txt", "cafe\u0301.txt", "a'b.txt",
    "file:///tmp/.env", "@file:///tmp/%2eenv", "file:///tmp/a%20b.txt",
    "file:///tmp/a%23b.txt", "relative/../.env", "", ".",
    ...Array.from("\u00a0\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u202f\u205f\u3000", (space) => `@dir${space}name/.env`),
  ];
  for (const base of [cwd, "~/fixture", pathToFileURL(cwd).href]) {
    for (const path of paths) {
      const expected = resolveToCwd(path, base);
      assert.equal(resolveToolPath(path, base), expected, `${base}: ${path}`);
      const seen = [];
      // All operations are offline mocks; no SDK write touches the filesystem.
      const write = createWriteToolDefinition(base, { operations: {
        mkdir: async () => {}, writeFile: async (target) => { seen.push(target); },
      } });
      await write.execute("fixture", { path, content: "new" });
      const edit = createEditToolDefinition(base, { operations: {
        access: async () => {}, readFile: async () => Buffer.from("old"),
        writeFile: async (target) => { seen.push(target); },
      } });
      await edit.execute("fixture", { path, edits: [{ oldText: "old", newText: "new" }] });
      assert.deepEqual(seen, [expected, expected]);
    }
  }
  assert.equal(resolveToolPath("@~/.env", cwd), join(homedir(), ".env"));
  for (const path of ["file:///tmp/%", "file:///tmp/a%2Fb", "file://remote/tmp/file"]) {
    assert.throws(() => resolveToCwd(path, cwd));
    assert.throws(() => resolveToolPath(path, cwd));
  }
});

test("normalized logical and physical protected paths fail closed; ordinary files stay allowed", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-protected-paths-"));
  try {
    // Protected names are empty fixture directories, never live secrets or repositories.
    for (const dir of [".env", ".git", "node_modules", "safe", "dir name"]) await mkdir(join(cwd, dir));
    await symlink(join(cwd, ".env"), join(cwd, "alias"));
    await symlink(join(cwd, ".git", "missing"), join(cwd, "dangling"));
    await symlink("loop", join(cwd, "loop"));
    await symlink(join(cwd, "safe"), join(cwd, ".env.alias"));
    const call = guard(cwd);
    for (const tool of ["write", "edit"]) {
      for (const path of ["@.env", "@.env.local", "@.git/config", "@node_modules/a", "alias/new/deep", "@alias/new", "dangling", "loop", ".env.alias/new", pathToFileURL(join(cwd, ".env", "new")).href, "@file:///tmp/%2eenv", "@~/.env", "@dir\u202fname/../.git/config", "file:///tmp/%", undefined, "  "]) {
        assert.equal((await call(path, tool)).block, true, `${tool}: ${path}`);
      }
      for (const path of ["safe/new/deep", "@safe/new", "@@.env", "./@.env", "environment.txt", "@dir\u202fname/plain.txt", "a\\ b.txt"]) {
        assert.equal(await call(path, tool), undefined, `${tool}: ${path}`);
      }
    }
    assert.equal(await call("@.env", "read"), undefined);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
