const REASONING_EFFORTS = ["low", "medium", "high", "xhigh"];

function normalizeText(value) {
  return String(value ?? "")
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[_\s]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function normalizeReasoningEffort(value) {
  const normalized = normalizeText(value);
  if (!normalized) {
    return null;
  }

  const aliases = new Map([
    ["l", "low"],
    ["lo", "low"],
    ["low", "low"],
    ["bas", "low"],
    ["faible", "low"],
    ["leger", "low"],
    ["light", "low"],
    ["m", "medium"],
    ["med", "medium"],
    ["medium", "medium"],
    ["moyen", "medium"],
    ["normal", "medium"],
    ["standard", "medium"],
    ["h", "high"],
    ["hi", "high"],
    ["high", "high"],
    ["haut", "high"],
    ["eleve", "high"],
    ["approfondi", "high"],
    ["x", "xhigh"],
    ["xh", "xhigh"],
    ["xhigh", "xhigh"],
    ["extra-high", "xhigh"],
    ["very-high", "xhigh"],
    ["max", "xhigh"],
    ["maximum", "xhigh"],
    ["tres", "xhigh"],
    ["tres-approfondi", "xhigh"],
    ["tres-approfondie", "xhigh"],
    ["ultra", "xhigh"]
  ]);

  return aliases.get(normalized) ?? (REASONING_EFFORTS.includes(normalized) ? normalized : null);
}

export function isReasoningResetToken(value) {
  const normalized = normalizeText(value);
  return ["reset", "inherit", "default", "clear", "none", "auto", "heriter"].includes(
    normalized
  );
}

export function reasoningEffortHelpList() {
  return [
    { value: "low", label: "bas", description: "rapide, raisonnement leger" },
    { value: "medium", label: "moyen", description: "equilibre vitesse/profondeur" },
    { value: "high", label: "eleve", description: "raisonnement pousse" },
    { value: "xhigh", label: "tres approfondi", description: "profondeur maximale" }
  ];
}

export function formatReasoningEffortSetting(value) {
  return value ? value : "inherit";
}
