const DEFAULT_PERMISSION_LEVEL = "workspace-write";

const PERMISSION_LEVELS = {
  "read-only": {
    approvalPolicyCli: "never",
    approvalPolicyAppServer: "never",
    description: "Read files only. Codex cannot edit files or run write-enabled commands.",
    dangerous: false,
    helpName: "read-only",
    sandboxModeCli: "read-only",
    sandboxPolicyAppServer: {
      type: "readOnly"
    }
  },
  "workspace-write": {
    approvalPolicyCli: "on-request",
    approvalPolicyAppServer: "on-request",
    description:
      "Read and edit within the workspace, but require explicit approval for guarded actions.",
    dangerous: false,
    helpName: "workspace-write",
    sandboxModeCli: "workspace-write",
    sandboxPolicyAppServer: {
      type: "workspaceWrite"
    }
  },
  "danger-full-access": {
    approvalPolicyCli: "never",
    approvalPolicyAppServer: "never",
    description: "Disable the sandbox and approvals for this chat session.",
    dangerous: true,
    helpName: "danger-full-access",
    sandboxModeCli: "danger-full-access",
    sandboxPolicyAppServer: {
      type: "dangerFullAccess"
    }
  }
};

const LEVEL_ALIASES = new Map([
  ["auto", "workspace-write"],
  ["danger", "danger-full-access"],
  ["danger-full-access", "danger-full-access"],
  ["full-access", "danger-full-access"],
  ["fullauto", "workspace-write"],
  ["readonly", "read-only"],
  ["read-only", "read-only"],
  ["workspace", "workspace-write"],
  ["workspace-write", "workspace-write"],
  ["write", "workspace-write"],
  ["yolo", "danger-full-access"]
]);

export function defaultPermissionLevel() {
  return DEFAULT_PERMISSION_LEVEL;
}

export function normalizePermissionLevel(value) {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase();
  return LEVEL_ALIASES.get(normalized) ?? null;
}

export function resolvePermissionLevel(value) {
  return normalizePermissionLevel(value) ?? DEFAULT_PERMISSION_LEVEL;
}

export function permissionLevelHelpList() {
  return Object.entries(PERMISSION_LEVELS).map(([level, config]) => ({
    level,
    description: config.description,
    dangerous: config.dangerous
  }));
}

export function permissionLevelConfig(level) {
  const resolved = resolvePermissionLevel(level);
  return {
    level: resolved,
    ...PERMISSION_LEVELS[resolved]
  };
}

export function appServerPermissionParams(level) {
  const config = permissionLevelConfig(level);
  return {
    approvalPolicy: config.approvalPolicyAppServer,
    sandboxPolicy: {
      ...config.sandboxPolicyAppServer
    }
  };
}

export function cliPermissionOverrides(level) {
  const config = permissionLevelConfig(level);
  return {
    approvalPolicy: config.approvalPolicyCli,
    sandboxMode: config.sandboxModeCli
  };
}
