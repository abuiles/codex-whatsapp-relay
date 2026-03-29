import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { resolvePermissionLevel } from "./controller-permissions.mjs";
import { repoRoot } from "./paths.mjs";

const DEFAULT_PROJECT_ALIAS = "main";
const DEFAULT_SEARCH_ROOT_NAMES = ["code", "src", "workspace", "projects", "work"];
const INVISIBLE_PROJECT_SPEC_PATTERN = /[\u200B-\u200F\u202A-\u202E\u2060\uFEFF]/g;
const MARKDOWN_LINK_PATTERN = /\[([^\]]*)\]\(([^)]+)\)/g;
const PATH_REFERENCE_PATTERN = /(?:^|[\s<])((?:~\/|\.{1,2}\/|\/)[^\s)>]+)/;

function stripDiacritics(value) {
  return String(value ?? "")
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "");
}

function normalizeSearchText(value) {
  return stripDiacritics(value)
    .toLowerCase()
    .replace(/[`"'()[\]{}]/g, " ")
    .replace(/[/\\]+/g, " ")
    .replace(/[-_.]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenizeSearchText(value) {
  return normalizeSearchText(value)
    .split(" ")
    .filter(Boolean);
}

function cleanProjectWords(value) {
  return normalizeSearchText(value)
    .replace(/\b(?:directory|folder|repo|repository|project|the|this|that|my|our)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function sanitizeProjectSpec(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .replace(INVISIBLE_PROJECT_SPEC_PATTERN, " ")
    .replace(MARKDOWN_LINK_PATTERN, (_, label, target) => {
      const normalizedTarget = String(target ?? "").trim();
      if (isDirectoryPathLike(normalizedTarget)) {
        return normalizedTarget;
      }

      return String(label ?? "").trim() || normalizedTarget;
    })
    .replace(/\s+/g, " ")
    .trim();
}

function isDirectoryPathLike(value) {
  const source = String(value ?? "").trim();
  return (
    source.startsWith("/") ||
    source.startsWith("~") ||
    source.startsWith(".") ||
    source.includes(path.sep)
  );
}

function expandHomePath(value, homeDir = os.homedir()) {
  const source = String(value ?? "").trim();
  if (!source) {
    return "";
  }

  if (source === "~") {
    return homeDir;
  }

  if (source.startsWith("~/")) {
    return path.join(homeDir, source.slice(2));
  }

  return source;
}

async function directoryExists(targetPath) {
  try {
    const stat = await fs.stat(targetPath);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

async function listChildDirectories(rootPath) {
  try {
    const entries = await fs.readdir(rootPath, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(rootPath, entry.name));
  } catch {
    return [];
  }
}

function ensureUniqueAlias(alias, seenAliases) {
  const base = normalizeProjectAlias(alias, DEFAULT_PROJECT_ALIAS);
  if (!seenAliases.has(base)) {
    seenAliases.add(base);
    return base;
  }

  let counter = 2;
  while (seenAliases.has(`${base}-${counter}`)) {
    counter += 1;
  }

  const nextAlias = `${base}-${counter}`;
  seenAliases.add(nextAlias);
  return nextAlias;
}

export function normalizeProjectAlias(value, fallback = DEFAULT_PROJECT_ALIAS) {
  const normalized = stripDiacritics(sanitizeProjectSpec(value))
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return normalized || fallback;
}

export function defaultProjectConfig() {
  return {
    alias: DEFAULT_PROJECT_ALIAS,
    workspace: repoRoot,
    model: null,
    profile: null,
    permissionLevel: null,
    search: null
  };
}

function normalizeProjectConfig(project = {}, { fallbackAlias = DEFAULT_PROJECT_ALIAS } = {}) {
  const workspace = path.resolve(String(project.workspace ?? repoRoot));
  return {
    alias: normalizeProjectAlias(
      project.alias ?? path.basename(workspace) ?? fallbackAlias,
      fallbackAlias
    ),
    workspace,
    model: project.model ?? null,
    profile: project.profile ?? null,
    permissionLevel: project.permissionLevel
      ? resolvePermissionLevel(project.permissionLevel)
      : null,
    search: typeof project.search === "boolean" ? project.search : null
  };
}

export function normalizeConfiguredProjects(config = {}) {
  const rawProjects =
    Array.isArray(config.projects) && config.projects.length
      ? config.projects
      : [
          {
            alias: config.defaultProject ?? DEFAULT_PROJECT_ALIAS,
            workspace: config.workspace ?? repoRoot,
            model: config.model ?? null,
            profile: config.profile ?? null,
            permissionLevel: null,
            search: null
          }
        ];

  const seenAliases = new Set();
  const seenWorkspaces = new Set();
  const projects = rawProjects.flatMap((project, index) => {
    const normalized = normalizeProjectConfig(project, {
      fallbackAlias: index === 0 ? DEFAULT_PROJECT_ALIAS : `project-${index + 1}`
    });
    const workspaceKey = path.resolve(normalized.workspace);
    if (seenWorkspaces.has(workspaceKey)) {
      return [];
    }

    seenWorkspaces.add(workspaceKey);
    return [{
      ...normalized,
      alias: ensureUniqueAlias(normalized.alias, seenAliases)
    }];
  });

  const defaultAlias = normalizeProjectAlias(
    config.defaultProject ?? projects[0]?.alias ?? DEFAULT_PROJECT_ALIAS,
    projects[0]?.alias ?? DEFAULT_PROJECT_ALIAS
  );
  const defaultProject =
    projects.find((project) => project.alias === defaultAlias)?.alias ?? projects[0].alias;

  return {
    defaultProject,
    projects,
    workspace:
      projects.find((project) => project.alias === defaultProject)?.workspace ??
      defaultProjectConfig().workspace
  };
}

export function findConfiguredProject(config = {}, token = null) {
  return resolveConfiguredProjectSelection(config, token).match;
}

export function resolveExplicitConfiguredProject(config = {}, token = null) {
  const { projects, defaultProject } = normalizeConfiguredProjects(config);
  const sanitizedToken = sanitizeProjectSpec(token);
  if (!sanitizedToken) {
    return null;
  }

  const pathReference =
    sanitizedToken.match(PATH_REFERENCE_PATTERN)?.[1] ??
    (isDirectoryPathLike(sanitizedToken) ? sanitizedToken : null);
  if (pathReference) {
    const resolvedPath = path.resolve(expandHomePath(pathReference));
    const workspaceMatch = projects.find(
      (project) => path.resolve(project.workspace) === resolvedPath
    );
    if (workspaceMatch) {
      return workspaceMatch;
    }
  }

  const normalizedToken = normalizeProjectAlias(sanitizedToken, defaultProject);

  return (
    projects.find((project) => project.alias === normalizedToken) ??
    projects.find(
      (project) =>
        normalizeProjectAlias(path.basename(project.workspace), project.alias) === normalizedToken
    ) ??
    null
  );
}

export function resolveConfiguredProjectSelection(config = {}, token = null) {
  const { projects, defaultProject } = normalizeConfiguredProjects(config);
  const sanitizedToken = sanitizeProjectSpec(token);
  if (!sanitizedToken) {
    return {
      match: null,
      candidates: []
    };
  }

  const direct = resolveExplicitConfiguredProject(config, sanitizedToken);
  if (direct) {
    return {
      match: direct,
      candidates: [direct]
    };
  }

  const normalizedToken = normalizeProjectAlias(sanitizedToken, defaultProject);

  const prefixMatches = projects.filter((project) => {
    const workspaceAlias = normalizeProjectAlias(
      path.basename(project.workspace),
      project.alias
    );
    return (
        project.alias.startsWith(normalizedToken) || workspaceAlias.startsWith(normalizedToken)
    );
  });

  if (prefixMatches.length) {
    return {
      match: prefixMatches.length === 1 ? prefixMatches[0] : null,
      candidates: prefixMatches
    };
  }

  return {
    match: null,
    candidates: []
  };
}

export function resolveConfiguredProject(config = {}, token = null) {
  const { projects, defaultProject } = normalizeConfiguredProjects(config);
  return (
    resolveConfiguredProjectSelection(config, token ?? defaultProject).match ??
    projects.find((project) => project.alias === defaultProject) ??
    null
  );
}

function parseWorkspaceReference(spec) {
  const source = cleanProjectWords(spec);
  if (!source) {
    return {
      projectHint: "",
      parentHint: null
    };
  }

  const match = source.match(/^(.*?)\s+(?:inside|under|in)\s+(.+)$/i);
  if (!match) {
    return {
      projectHint: source,
      parentHint: null
    };
  }

  return {
    projectHint: cleanProjectWords(match[1]),
    parentHint: cleanProjectWords(match[2])
  };
}

async function collectSearchRoots({ homeDir, repoRootDir, parentHint }) {
  const roots = new Set();
  const parentRepoDir = path.dirname(repoRootDir);
  roots.add(parentRepoDir);

  for (const rootName of DEFAULT_SEARCH_ROOT_NAMES) {
    roots.add(path.join(homeDir, rootName));
  }

  if (parentHint) {
    const parentTokens = tokenizeSearchText(parentHint);

    const homeChildren = await listChildDirectories(homeDir);
    for (const child of homeChildren) {
      const childTokens = tokenizeSearchText(path.basename(child));
      if (parentTokens.every((token) => childTokens.includes(token))) {
        roots.add(child);
      }
    }

    const directChildren = await listChildDirectories(parentRepoDir);
    for (const child of directChildren) {
      const childTokens = tokenizeSearchText(path.basename(child));
      if (parentTokens.every((token) => childTokens.includes(token))) {
        roots.add(child);
      }
    }
  }

  const candidates = [];
  for (const root of roots) {
    if (await directoryExists(root)) {
      candidates.push(root);
    }
  }

  return candidates;
}

function scoreWorkspaceCandidate(candidatePath, { projectTokens, projectText, parentTokens }) {
  const baseName = path.basename(candidatePath);
  const baseText = normalizeSearchText(baseName);
  const baseTokens = tokenizeSearchText(baseName);
  const parentText = normalizeSearchText(path.basename(path.dirname(candidatePath)));

  let score = 0;

  if (baseText === projectText) {
    score += 100;
  } else if (baseText.startsWith(projectText) || projectText.startsWith(baseText)) {
    score += 80;
  }

  if (projectTokens.every((token) => baseTokens.includes(token))) {
    score += 60;
  } else if (projectTokens.some((token) => baseText.includes(token))) {
    score += 30;
  }

  if (parentTokens.length && parentTokens.every((token) => parentText.includes(token))) {
    score += 20;
  }

  score -= candidatePath.split(path.sep).length;
  return score;
}

async function searchWorkspaceFromReference(spec, { homeDir, repoRootDir }) {
  const reference = parseWorkspaceReference(spec);
  const projectTokens = tokenizeSearchText(reference.projectHint);
  if (!projectTokens.length) {
    return {
      workspace: null,
      candidates: []
    };
  }

  const projectText = projectTokens.join(" ");
  const parentTokens = tokenizeSearchText(reference.parentHint);
  const roots = await collectSearchRoots({
    homeDir,
    repoRootDir,
    parentHint: reference.parentHint
  });

  const candidates = [];
  for (const root of roots) {
    const children = await listChildDirectories(root);
    for (const child of children) {
      const score = scoreWorkspaceCandidate(child, {
        projectTokens,
        projectText,
        parentTokens
      });
      if (score > 0) {
        candidates.push({
          path: child,
          score
        });
      }
    }
  }

  candidates.sort((left, right) => right.score - left.score || left.path.localeCompare(right.path));

  if (!candidates.length) {
    return {
      workspace: null,
      candidates: []
    };
  }

  const best = candidates[0];
  const second = candidates[1] ?? null;
  const unique = !second || best.score > second.score;

  return {
    workspace: unique ? best.path : null,
    candidates: candidates.map((candidate) => candidate.path).slice(0, 10)
  };
}

export function deriveProjectAlias(workspace, config = {}) {
  const { projects } = normalizeConfiguredProjects(config);
  const seenAliases = new Set(projects.map((project) => project.alias));
  return ensureUniqueAlias(path.basename(workspace), seenAliases);
}

export async function resolveProjectReference(
  config = {},
  spec,
  { homeDir = os.homedir(), repoRootDir = repoRoot, skipConfiguredSelection = false } = {}
) {
  const trimmed = sanitizeProjectSpec(spec);
  if (!trimmed) {
    return null;
  }

  if (!skipConfiguredSelection) {
    const configuredSelection = resolveConfiguredProjectSelection(config, trimmed);
    if (configuredSelection.match) {
      return {
        project: configuredSelection.match,
        created: false,
        matchType: "configured"
      };
    }

    if (configuredSelection.candidates.length) {
      return {
        project: null,
        created: false,
        matchType: "ambiguousConfigured",
        candidates: configuredSelection.candidates
      };
    }
  }

  const pathReference =
    trimmed.match(PATH_REFERENCE_PATTERN)?.[1] ??
    (isDirectoryPathLike(trimmed) ? trimmed : null);
  const directPath = pathReference
    ? path.resolve(expandHomePath(pathReference, homeDir))
    : null;
  if (directPath && (await directoryExists(directPath))) {
    const existingWorkspace = findConfiguredProject(config, directPath);
    if (existingWorkspace) {
      return {
        project: existingWorkspace,
        created: false,
        matchType: "configured"
      };
    }

    return {
      project: {
        ...defaultProjectConfig(),
        alias: deriveProjectAlias(directPath, config),
        workspace: directPath
      },
      created: true,
      matchType: "workspace"
    };
  }

  const discovered = await searchWorkspaceFromReference(trimmed, {
    homeDir,
    repoRootDir
  });

  if (discovered.workspace) {
    const existingWorkspace = findConfiguredProject(config, discovered.workspace);
    if (existingWorkspace) {
      return {
        project: existingWorkspace,
        created: false,
        matchType: "configured"
      };
    }

    return {
      project: {
        ...defaultProjectConfig(),
        alias: deriveProjectAlias(discovered.workspace, config),
        workspace: discovered.workspace
      },
      created: true,
      matchType: "discovered"
    };
  }

  if (discovered.candidates.length) {
    return {
      project: null,
      created: false,
      matchType: "ambiguous",
      candidates: discovered.candidates
    };
  }

  return null;
}
