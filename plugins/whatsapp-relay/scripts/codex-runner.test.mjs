import test from "node:test";
import assert from "node:assert/strict";

import {
  buildProjectIntentPrompt,
  buildVoiceCommandIntentPrompt,
  normalizeProjectIntentSelection,
  normalizeVoiceCommandIntent
} from "./codex-runner.mjs";

test("buildVoiceCommandIntentPrompt includes project context for Codex classification", () => {
  const prompt = buildVoiceCommandIntentPrompt({
    transcript: "switch to alpha app",
    activeProjectAlias: "current-project",
    projects: [
      { alias: "current-project", workspace: "/workspace/current-project" },
      { alias: "alpha-app", workspace: "/workspace/alpha-app" }
    ]
  });

  assert.match(prompt, /Active project:\ncurrent-project/);
  assert.match(prompt, /Known projects:/);
  assert.match(prompt, /- alpha-app/);
  assert.match(prompt, /Transcript:\nswitch to alpha app/);
  assert.match(prompt, /workspace write/);
  assert.match(prompt, /read only/);
  assert.doesNotMatch(prompt, /workspace\/alpha-app/);
});

test("normalizeVoiceCommandIntent converts structured project controls into bridge commands", () => {
  assert.deepEqual(
    normalizeVoiceCommandIntent(
      { type: "project", payload: "alpha app" },
      "switch to alpha app"
    ),
    { type: "project", payload: "alpha app" }
  );

  assert.deepEqual(
    normalizeVoiceCommandIntent(
      { type: "sessions", payload: "alpha app" },
      "list sessions for alpha app"
    ),
    { type: "sessions", payload: "alpha app" }
  );

  assert.deepEqual(
    normalizeVoiceCommandIntent(
      { type: "connect", payload: "alpha app 2" },
      "session alpha app 2"
    ),
    { type: "connect", payload: "alpha app 2" }
  );

  assert.deepEqual(
    normalizeVoiceCommandIntent(
      { type: "permissions", payload: "ww" },
      "workspace write"
    ),
    { type: "permissions", payload: "ww" }
  );
});

test("normalizeVoiceCommandIntent falls back to a normal prompt when classification is invalid", () => {
  assert.deepEqual(
    normalizeVoiceCommandIntent(
      { type: "project" },
      "switch to alpha app"
    ),
    { type: "prompt", prompt: "switch to alpha app" }
  );

  assert.deepEqual(
    normalizeVoiceCommandIntent(
      { type: "prompt" },
      "please fix the checkout button"
    ),
    { type: "prompt", prompt: "please fix the checkout button" }
  );

  assert.deepEqual(
    normalizeVoiceCommandIntent(
      { type: "prompt", prompt: "please fix the checkout button" },
      "please fix the checkout button",
      false
    ),
    { type: "ignored" }
  );
});

test("buildProjectIntentPrompt includes known project aliases and the raw hint", () => {
  const prompt = buildProjectIntentPrompt({
    intent: "blood project",
    activeProjectAlias: "main",
    projects: [
      { alias: "main", workspace: "/workspace/main" },
      { alias: "sample-service", workspace: "/workspace/sample-service" }
    ]
  });

  assert.match(prompt, /Active project:\nmain/);
  assert.match(prompt, /Known projects:/);
  assert.match(prompt, /- sample-service \(repo: sample-service\)/);
  assert.match(prompt, /Hint:\nblood project/);
  assert.doesNotMatch(prompt, /workspace\/sample-service/);
  assert.match(prompt, /Prefer `noMatch` over guessing/);
});

test("normalizeProjectIntentSelection accepts only known aliases", () => {
  const projects = [
    { alias: "main", workspace: "/workspace/main" },
    { alias: "sample-service", workspace: "/workspace/sample-service" },
    { alias: "sample-web", workspace: "/workspace/sample-web" }
  ];

  assert.deepEqual(
    normalizeProjectIntentSelection(
      { outcome: "match", projectAlias: "sample-service", candidateAliases: [] },
      projects
    ),
    {
      outcome: "match",
      projectAlias: "sample-service",
      candidateAliases: []
    }
  );

  assert.deepEqual(
    normalizeProjectIntentSelection(
      {
        outcome: "ambiguous",
        projectAlias: null,
        candidateAliases: ["sample-service", "unknown-project", "sample-web"]
      },
      projects
    ),
    {
      outcome: "ambiguous",
      projectAlias: null,
      candidateAliases: ["sample-service", "sample-web"]
    }
  );

  assert.deepEqual(
    normalizeProjectIntentSelection(
      { outcome: "match", projectAlias: "invented-project", candidateAliases: [] },
      projects
    ),
    {
      outcome: "noMatch",
      projectAlias: null,
      candidateAliases: []
    }
  );
});
