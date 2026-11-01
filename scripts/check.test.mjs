import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

test("syntax check detects an error after the first supplied file", async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "wa-syntax-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const good = path.join(directory, "good.mjs"), bad = path.join(directory, "bad.mjs");
  await fs.writeFile(good, "export const value = 1;\n"); await fs.writeFile(bad, "export const broken = ;\n");
  const script = fileURLToPath(new URL("check.mjs", import.meta.url));
  assert.equal(spawnSync(process.execPath, [script, good]).status, 0);
  assert.notEqual(spawnSync(process.execPath, [script, good, bad], { stdio: "pipe" }).status, 0);
});
