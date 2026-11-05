import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const script = fileURLToPath(new URL("./sync-upstream.sh", import.meta.url));
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

test("refreshes stale main, never pushes, and retries failed verification", () => {
  const tmp = mkdtempSync(join(tmpdir(), "sync-upstream-test-"));
  try {
    const upstream = join(tmp, "agegr", "pi-web.git");
    const seed = join(tmp, "seed");
    const repo = join(tmp, "repo");
    const bin = join(tmp, "bin");
    mkdirSync(join(tmp, "agegr"));
    mkdirSync(seed); mkdirSync(bin);
    git(tmp, "init", "--bare", "--initial-branch=main", upstream);
    git(seed, "init", "--initial-branch=main");
    git(seed, "config", "user.email", "test@example.invalid");
    git(seed, "config", "user.name", "Test");
    writeFileSync(join(seed, "upstream.txt"), "one\n");
    git(seed, "add", "."); git(seed, "commit", "-m", "initial");
    git(seed, "remote", "add", "origin", upstream);
    git(seed, "push", "origin", "main");
    git(tmp, "clone", upstream, repo);
    git(repo, "config", "user.email", "test@example.invalid");
    git(repo, "config", "user.name", "Test");
    writeFileSync(join(repo, "overlay.txt"), "overlay\n");
    git(repo, "add", "."); git(repo, "commit", "-m", "overlay");
    git(repo, "config", "remote.origin.fetch", "+refs/tags/*:refs/tags/*");
    writeFileSync(join(seed, "upstream.txt"), "two\n");
    git(seed, "commit", "-am", "upstream update");
    git(seed, "push", "origin", "main");
    const target = git(seed, "rev-parse", "HEAD");
    assert.notEqual(git(repo, "rev-parse", "origin/main"), target);
    const marker = join(tmp, "verification.log");
    writeFileSync(join(bin, "date"), '#!/bin/sh\necho 20260101-000000\n', { mode: 0o755 });
    const originalHead = git(repo, "rev-parse", "HEAD");
    writeFileSync(join(bin, "npx"), '#!/bin/sh\necho tsc >> "$MARKER"\n[ "${FAIL_VERIFY:-0}" != 1 ]\n', { mode: 0o755 });
    writeFileSync(join(bin, "node"), '#!/bin/sh\necho tests >> "$MARKER"\n', { mode: 0o755 });
    const run = (args, extra = {}) => spawnSync("bash", [script, ...args], {
      cwd: repo, encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, MARKER: marker, ...extra },
    });
    const invalid = run(["--apply", "origin/main", "--no-push", "--bogus"]);
    assert.notEqual(invalid.status, 0);
    assert.equal(git(repo, "rev-parse", "origin/main") === target, false, "invalid arguments do not fetch");
    const failed = run(["--apply", "origin/main", "--no-push"], { FAIL_VERIFY: "1" });
    assert.notEqual(failed.status, 0, failed.stdout + failed.stderr);
    assert.equal(git(repo, "rev-parse", "origin/main"), target);
    assert.equal(git(repo, "merge-base", "HEAD", target), target, "rebased before verification failure");
    const retryFailed = run(["--apply", "origin/main", "--no-push"], { FAIL_VERIFY: "1" });
    assert.notEqual(retryFailed.status, 0, "up-to-date retry must not skip verification");
    const retry = run(["--apply", "--no-push", "origin/main"]);
    assert.equal(retry.status, 0, retry.stdout + retry.stderr);
    assert.match(retry.stdout, /Verification passed; no push performed/);
    assert.equal(git(upstream, "rev-parse", "main"), target, "remote remains unchanged");
    writeFileSync(join(seed, "upstream.txt"), "three\n");
    git(seed, "commit", "-am", "another update");
    git(seed, "push", "origin", "main");
    const next = git(seed, "rev-parse", "HEAD");
    const secondHead = git(repo, "rev-parse", "HEAD");
    const applied = run(["--apply", "origin/main", "--no-push"]);
    assert.equal(applied.status, 0, applied.stdout + applied.stderr);
    assert.match(applied.stdout, /no push was performed/);
    assert.equal(git(repo, "merge-base", "HEAD", next), next);
    assert.equal(git(repo, "rev-parse", "backup/pre-upstream-20260101-000000"), originalHead);
    assert.equal(git(repo, "rev-parse", "backup/pre-upstream-20260101-000000-1"), secondHead);
    assert.equal(git(upstream, "rev-parse", "main"), next);
    const check = run(["--check"]);
    assert.equal(check.status, 0, check.stdout + check.stderr);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
