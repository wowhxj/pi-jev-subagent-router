import { choice, TypeSafeClient } from "@typesafe-ai/sdk";
import type { ExtensionAPI, ToolCallEvent } from "@earendil-works/pi-coding-agent";
import { prepareTask, resolveMode, selectCandidate } from "../src/router.js";

type Candidate = { id: string; name: string };

const MODE_ENV = "PI_JEV_SUBAGENT_ROUTER";
const MAX_TASK_ENV = "PI_JEV_ROUTER_MAX_TASK_CHARS";
const DEFAULT_MAX_TASK_CHARS = 4_000;
const REQUEST_TIMEOUT_MS = 6_000;

type RouterInput = { task?: unknown; model?: unknown };

function mode(): "off" | "shadow" | "active" {
  return resolveMode(process.env[MODE_ENV]);
}

function maxTaskChars(): number {
  const parsed = Number.parseInt(process.env[MAX_TASK_ENV] ?? "", 10);
  return Number.isFinite(parsed) ? Math.max(256, Math.min(parsed, 12_000)) : DEFAULT_MAX_TASK_CHARS;
}

function candidatesFrom(ctx: { modelRegistry: { getAll(): Array<{ provider: string; id: string; name?: string }> }; scopedModels: readonly { model: { provider: string; id: string; name?: string } }[] }): Candidate[] {
  const models = ctx.scopedModels.length ? ctx.scopedModels.map(({ model }) => model) : ctx.modelRegistry.getAll();
  return models.map((model) => ({
    id: `${model.provider}/${model.id}`,
    name: model.name || model.id,
  }));
}

function isToolCall(event: ToolCallEvent): event is ToolCallEvent & { toolName: "subagent"; input: RouterInput } {
  return event.toolName === "subagent";
}

export default function (pi: ExtensionAPI) {
  let client: TypeSafeClient | undefined;
  let warnedMissingKey = false;
  const runDecisions = new Map<string, { selectedModel: string; shadow: boolean }>();

  pi.on("tool_call", async (event, ctx) => {
    if (!isToolCall(event) || mode() === "off") return;
    const input = event.input;
    // Preserve explicit user/agent choice; never replace an existing model field.
    if (typeof input.model === "string" && input.model.trim()) return;
    if (typeof input.task !== "string" || !input.task.trim()) return;

    const candidates = candidatesFrom(ctx);
    if (candidates.length < 2) return;

    try {
      if (!process.env.TYPESAFE_API_KEY?.trim()) {
        if (!warnedMissingKey) console.warn("[jev-router] TYPESAFE_API_KEY is unset; routing is skipped");
        warnedMissingKey = true;
        return;
      }
      client ??= new TypeSafeClient({ timeout: REQUEST_TIMEOUT_MS, retry: { maxRetries: 0 }, logLevel: "off" });
      const task = prepareTask(input.task, maxTaskChars());
      const criteria = Object.fromEntries(candidates.map((candidate) => [candidate.id, candidate.name]));
      const result = await client.systemOne({
        state: { task, candidates },
        questions: {
          model: choice(
            "Which available model ID is the best fit for this subagent task? Infer task requirements and choose only among the listed provider/model IDs. Prefer the model most likely to perform the requested work well.",
            criteria,
          ),
        },
      }, { timeout: REQUEST_TIMEOUT_MS, retry: { maxRetries: 0 } });
      const decision = selectCandidate(result.answers.model, candidates);
      if (!decision) return;

      const isShadow = mode() !== "active";
      runDecisions.set(event.toolCallId, { selectedModel: decision.id, shadow: isShadow });
      console.info(`[jev-router] ${isShadow ? "shadow" : "route"}: ${decision.id} (confidence ${decision.confidence.toFixed(2)})`);
      if (!isShadow) input.model = decision.id;
    } catch (error) {
      const kind = error instanceof Error ? error.name : "unknown error";
      console.warn(`[jev-router] Jev unavailable (${kind}); using Pi's normal model selection`);
    }
  });

  pi.on("tool_result", (event) => {
    if (event.toolName !== "subagent") return;
    const decision = runDecisions.get(event.toolCallId);
    if (!decision) return;
    runDecisions.delete(event.toolCallId);
    const details = event.details as { model?: unknown; results?: Array<{ model?: unknown; progressSummary?: { durationMs?: unknown } }>; progressSummary?: { durationMs?: unknown } } | undefined;
    const child = details?.results?.[0];
    const actualModel = typeof details?.model === "string" ? details.model : typeof child?.model === "string" ? child.model : "unreported (async or unavailable)";
    const durationMs = details?.progressSummary?.durationMs ?? child?.progressSummary?.durationMs;
    const duration = typeof durationMs === "number" ? `, ${durationMs}ms` : "";
    console.info(`[jev-router] result: selected=${decision.selectedModel}, actual=${actualModel}${duration}${decision.shadow ? " (shadow; unchanged)" : ""}`);
  });

  // pi-subagents emits this only after an async child's final result is available.
  pi.events.on("subagent:async-complete", (payload) => {
    if (!payload || typeof payload !== "object") return;
    const data = payload as { runId?: unknown; state?: unknown; success?: unknown; results?: unknown };
    const models = Array.isArray(data.results)
      ? [...new Set(data.results.flatMap((result) => result && typeof result === "object" && typeof (result as { model?: unknown }).model === "string" ? [(result as { model: string }).model] : []))]
      : [];
    const modelSummary = models.length ? `, models=${models.join(",")}` : "";
    console.info(`[jev-router] async result: run=${String(data.runId ?? "unknown")}, state=${String(data.state ?? "unknown")}, success=${String(data.success ?? "unknown")}${modelSummary}`);
  });
}

