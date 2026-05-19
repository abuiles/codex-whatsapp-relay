import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const roots = [
  path.join("plugins", "whatsapp-relay", "scripts"),
  "scripts"
];

function listModuleFiles(root) {
  return fs.existsSync(root)
    ? fs
        .readdirSync(root, { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.endsWith(".mjs"))
        .map((entry) => path.join(root, entry.name))
    : [];
}

const files = roots.flatMap(listModuleFiles);

for (const file of files) {
  const result = spawnSync(process.execPath, ["--check", file], {
    stdio: "inherit"
  });

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}
