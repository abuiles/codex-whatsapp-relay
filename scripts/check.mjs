import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = fileURLToPath(new URL("..", import.meta.url));
const files = process.argv.length > 2 ? process.argv.slice(2)
  : ["plugins/whatsapp-relay/scripts", "scripts"].flatMap(directory =>
    fs.readdirSync(path.join(root, directory)).filter(name => name.endsWith(".mjs")).sort().map(name => path.join(root, directory, name)));
for (const file of files) {
  const result = spawnSync(process.execPath, ["--check", file], { stdio: "inherit" });
  if (result.error || result.status !== 0) process.exit(result.status || 1);
}
