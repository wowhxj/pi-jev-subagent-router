const SECRET_PATTERNS = [
  /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
  /\b(?:Bearer\s+)[A-Z0-9._~+/-]+=*/gi,
  /\b(?:sk-[A-Za-z0-9_-]{12,}|(?:api[_-]?key|token|password|secret)\s*[:=]\s*[^\s,;]+)/gi,
];

export function prepareTask(task, maxChars = 4_000) {
  let safe = task;
  for (const pattern of SECRET_PATTERNS) safe = safe.replace(pattern, "[REDACTED]");
  return safe.length > maxChars ? `${safe.slice(0, maxChars)}\n[TRUNCATED]` : safe;
}

export function selectCandidate(answer, candidates) {
  if (typeof answer?.choice !== "string" || !Number.isFinite(answer.confidence)) return undefined;
  const candidate = candidates.find(({ id }) => id === answer.choice);
  return candidate ? { ...candidate, confidence: answer.confidence } : undefined;
}

export function formatProbabilities(answer, candidates) {
  const probabilities = answer?.probabilities;
  return candidates.map(({ id }) => {
    const value = probabilities && Object.hasOwn(probabilities, id) ? probabilities[id] : undefined;
    return `${id}=${Number.isFinite(value) ? value.toFixed(3) : "n/a"}`;
  }).join(", ");
}

export function resolveMode(value) {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  return normalized === "off" || normalized === "shadow" ? normalized : "active";
}

export function shouldRoute(input) {
  return typeof input?.task === "string" && input.task.trim().length > 0 &&
    !(typeof input.model === "string" && input.model.trim().length > 0);
}

