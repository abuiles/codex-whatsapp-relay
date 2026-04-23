import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const roots = [
  path.join("plugins", "whatsapp-relay", "scripts"),
  "scripts"
];

function listTestFiles(root) {
  return fs.existsSync(root)
    ? fs
        .readdirSync(root, { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.endsWith(".test.mjs"))
        .map((entry) => path.join(root, entry.name))
    : [];
}

const files = roots.flatMap(listTestFiles);
const result = spawnSync(process.execPath, ["--test", ...files], {
  stdio: "inherit"
});

process.exit(result.status ?? 1);
