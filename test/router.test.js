import test from "node:test";
import assert from "node:assert/strict";
import { filterCandidates, formatProbabilities, prepareTask, resolveMode, selectCandidate, shouldRoute } from "../src/router.js";

const candidates = [{ id: "openai/gpt-4.1", name: "General" }, { id: "anthropic/claude-sonnet", name: "Coding" }];

test("redacts common secrets and truncates task before sending", () => {
  const task = prepareTask("Contact jane@example.com; Authorization: Bearer abc.def; api_key=secret-value " + "x".repeat(300), 256);
  assert.doesNotMatch(task, /jane@example\.com|abc\.def|secret-value/);
  assert.match(task, /\[REDACTED\]/);
  assert.match(task, /\[TRUNCATED\]$/);
});

test("defaults to active and honors shadow/off overrides", () => {
  assert.equal(resolveMode(undefined), "active");
  assert.equal(resolveMode("typo"), "active");
  assert.equal(resolveMode("shadow"), "shadow");
  assert.equal(resolveMode("OFF"), "off");
});

test("preserves explicit model choices and ignores empty tasks", () => {
  assert.equal(shouldRoute({ task: "review", model: "openai/gpt-4.1" }), false);
  assert.equal(shouldRoute({ task: "  " }), false);
  assert.equal(shouldRoute({ task: "review" }), true);
});

test("defaults to all candidates, or filters to the configured selection", () => {
  assert.deepEqual(filterCandidates(candidates, undefined), candidates);
  assert.deepEqual(filterCandidates(candidates, ["anthropic/claude-sonnet"]), [candidates[1]]);
  assert.deepEqual(filterCandidates(candidates, []), []);
});

test("formats per-candidate probabilities in registry order", () => {
  assert.equal(formatProbabilities({ probabilities: { "anthropic/claude-sonnet": 0.73, "openai/gpt-4.1": 0.27 } }, candidates),
    "openai/gpt-4.1=0.270, anthropic/claude-sonnet=0.730");
  assert.equal(formatProbabilities({ probabilities: { "openai/gpt-4.1": "high" } }, candidates),
    "openai/gpt-4.1=n/a, anthropic/claude-sonnet=n/a");
});

test("accepts only a listed model from a valid Jev choice", () => {
  assert.deepEqual(selectCandidate({ choice: "anthropic/claude-sonnet", confidence: 0.82 }, candidates), {
    ...candidates[1], confidence: 0.82,
  });
  assert.equal(selectCandidate({ choice: "unknown/model", confidence: 0.9 }, candidates), undefined);
  assert.equal(selectCandidate({ choice: "openai/gpt-4.1", confidence: "high" }, candidates), undefined);
});
