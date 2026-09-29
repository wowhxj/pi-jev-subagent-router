import { choice, TypeSafeClient } from "@typesafe-ai/sdk";
import { DynamicBorder, getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionCommandContext, ToolCallEvent } from "@earendil-works/pi-coding-agent";
import { Container, Input, Key, SelectList, Text, matchesKey, type SelectItem } from "@earendil-works/pi-tui";
import { readFile, mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { filterCandidates, filterModelsByQuery, formatProbabilities, prepareTask, resolveMode, selectCandidate } from "../src/router.js";

type Candidate = { id: string; name: string };

const MODE_ENV = "PI_JEV_SUBAGENT_ROUTER";
const MAX_TASK_ENV = "PI_JEV_ROUTER_MAX_TASK_CHARS";
const DEFAULT_MAX_TASK_CHARS = 4_000;
const REQUEST_TIMEOUT_MS = 6_000;
const SELECTION_PATH = join(getAgentDir(), "jev-subagent-router.json");
const SAVE_ACTION = "Save model selection";
const SELECT_ALL_ACTION = "Select all available models";
const SELECT_NONE_ACTION = "Select no models";
const RESET_ACTION = "Use all available models (clear selection)";

type RouterInput = { task?: unknown; model?: unknown };

function mode(): "off" | "shadow" | "active" {
  return resolveMode(process.env[MODE_ENV]);
}

function maxTaskChars(): number {
  const parsed = Number.parseInt(process.env[MAX_TASK_ENV] ?? "", 10);
  return Number.isFinite(parsed) ? Math.max(256, Math.min(parsed, 12_000)) : DEFAULT_MAX_TASK_CHARS;
}

function candidatesFrom(ctx: { modelRegistry: { getAvailable(): Array<{ provider: string; id: string; name?: string }> }; scopedModels: readonly { model: { provider: string; id: string; name?: string } }[] }): Candidate[] {
  const models = ctx.scopedModels.length ? ctx.scopedModels.map(({ model }) => model) : ctx.modelRegistry.getAvailable();
  return models.map((model) => ({ id: `${model.provider}/${model.id}`, name: model.name || model.id }));
}

async function readSelection(): Promise<string[] | undefined> {
  try {
    const value = JSON.parse(await readFile(SELECTION_PATH, "utf8")) as { version?: unknown; models?: unknown };
    if (value.version === 1 && Array.isArray(value.models) && value.models.every((id) => typeof id === "string")) return value.models;
    console.warn("[jev-router] Invalid model selection config; Jev routing is skipped");
    return [];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    console.warn("[jev-router] Cannot read model selection config; Jev routing is skipped");
    return [];
  }
}

async function writeSelection(models: string[]): Promise<void> {
  await mkdir(getAgentDir(), { recursive: true });
  const temporaryPath = `${SELECTION_PATH}.${process.pid}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify({ version: 1, models }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporaryPath, SELECTION_PATH);
}

async function clearSelection(): Promise<void> {
  try {
    await unlink(SELECTION_PATH);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

type PickerResult = { action: "save"; models: string[] } | { action: "reset" } | null;

async function configureModels(ctx: ExtensionCommandContext): Promise<void> {
  if (!ctx.hasUI) {
    ctx.ui.notify("Model selection requires Pi's interactive UI.", "warning");
    return;
  }
  const models = ctx.modelRegistry.getAvailable()
    .map((model) => ({ id: `${model.provider}/${model.id}`, name: model.name || model.id }))
    .sort((a, b) => a.id.localeCompare(b.id));
  const existing = await readSelection();
  const availableIds = new Set(models.map(({ id }) => id));
  const selected = new Set(existing === undefined ? availableIds : existing.filter((id) => availableIds.has(id)));
  const result = await ctx.ui.custom<PickerResult>((tui, theme, keybindings, done) => {
    const actionItems: SelectItem[] = [
      { value: "", label: SAVE_ACTION },
      { value: "", label: SELECT_ALL_ACTION },
      { value: "", label: SELECT_NONE_ACTION },
      { value: "", label: RESET_ACTION },
    ];
    const modelItems: SelectItem[] = models.map(({ id, name }) => ({ value: "", label: "", description: name }));
    const modelByItem = new Map(modelItems.map((item, index) => [item, models[index]]));
    const actionByItem = new Map(actionItems.map((item, index) => [item, ["save", "all", "none", "reset"][index]]));
    const allItems = [...actionItems, ...modelItems];
    const modelIndexById = new Map(models.map(({ id }, index) => [id, index]));
    const listTheme = {
      selectedPrefix: (text: string) => theme.fg("accent", text),
      selectedText: (text: string) => theme.fg("accent", text),
      description: (text: string) => theme.fg("muted", text),
      scrollInfo: (text: string) => theme.fg("dim", text),
      noMatch: (text: string) => theme.fg("warning", text),
    };
    const list = new SelectList(allItems, 12, listTheme);
    const filter = new Input({ prompt: theme.fg("accent", "Filter: "), placeholder: "type provider, model, or name" });
    filter.focused = true;
    const status = new Text();
    const frame = new Container();
    const border = new DynamicBorder((text) => theme.fg("accent", text));
    frame.addChild(border);
    frame.addChild(new Text(theme.fg("accent", theme.bold("Toggle models included in Jev routing"))));
    frame.addChild(filter);
    frame.addChild(list);
    frame.addChild(status);
    frame.addChild(new Text(theme.fg("dim", "C-n/C-p or ↑/↓ move • Enter toggle • Save to apply • Esc cancel")));
    frame.addChild(new DynamicBorder((text) => theme.fg("accent", text)));

    let query = "";
    let visibleItems: SelectItem[] = [];
    const labelModel = (item: SelectItem, id: string) => {
      item.label = `${selected.has(id) ? "☑" : "☐"} ${id}`;
    };
    for (let index = 0; index < models.length; index++) labelModel(modelItems[index], models[index].id);

    function refreshFilter(preserveSelection: boolean) {
      const current = preserveSelection ? modelByItem.get(list.getSelectedItem()!) : undefined;
      const matching = filterModelsByQuery(models, query);
      const matchingIds = new Set(matching.map(({ id }) => id));
      for (const item of actionItems) item.value = query;
      for (let index = 0; index < modelItems.length; index++) {
        modelItems[index].value = matchingIds.has(models[index].id) ? query : `\u0000${query}`;
      }
      list.setFilter(query);
      visibleItems = [...actionItems, ...matching.map(({ id }) => modelItems[modelIndexById.get(id)!])];
      const currentIndex = current ? matching.findIndex(({ id }) => id === current.id) : -1;
      list.setSelectedIndex(currentIndex >= 0 ? actionItems.length + currentIndex : matching.length ? actionItems.length : 0);
      status.setText(`${selected.size} selected • ${matching.length} matching / ${models.length} available`);
      list.invalidate();
      frame.invalidate();
      tui.requestRender();
    }

    function activate(item: SelectItem) {
      const action = actionByItem.get(item);
      if (action === "save") {
        done({ action: "save", models: [...selected] });
        return;
      }
      if (action === "all") {
        for (const id of availableIds) selected.add(id);
      } else if (action === "none") {
        selected.clear();
      } else if (action === "reset") {
        done({ action: "reset" });
        return;
      } else {
        const model = modelByItem.get(item);
        if (!model) return;
        selected.has(model.id) ? selected.delete(model.id) : selected.add(model.id);
        labelModel(item, model.id);
      }
      status.setText(`${selected.size} selected • ${filterModelsByQuery(models, query).length} matching / ${models.length} available`);
      for (let index = 0; index < modelItems.length; index++) labelModel(modelItems[index], models[index].id);
      list.invalidate();
      frame.invalidate();
      tui.requestRender();
    }

    list.onSelect = activate;
    list.onCancel = () => done(null);
    refreshFilter(false);
    list.setSelectedIndex(models.length ? actionItems.length : 0);

    return {
      render: (width: number) => frame.render(width),
      invalidate: () => frame.invalidate(),
      handleInput(data: string) {
        const previousQuery = query;
        if (matchesKey(data, Key.ctrl("n"))) {
          const index = visibleItems.indexOf(list.getSelectedItem()!);
          list.setSelectedIndex((index + 1) % visibleItems.length);
        } else if (matchesKey(data, Key.ctrl("p"))) {
          const index = visibleItems.indexOf(list.getSelectedItem()!);
          list.setSelectedIndex((index - 1 + visibleItems.length) % visibleItems.length);
        } else if (keybindings.matches(data, "tui.select.up") || keybindings.matches(data, "tui.select.down") || keybindings.matches(data, "tui.select.confirm") || keybindings.matches(data, "tui.select.cancel")) {
          list.handleInput(data);
        } else {
          filter.handleInput(data);
          query = filter.getValue();
          if (query !== previousQuery) refreshFilter(true);
        }
        tui.requestRender();
      },
    };
  });
  if (!result) return;
  if (result.action === "reset") {
    await clearSelection();
    ctx.ui.notify("Model selection cleared; routing will use all available models.", "info");
  } else {
    await writeSelection(result.models);
    ctx.ui.notify(result.models.length ? `Saved ${result.models.length} routing model(s).` : "Saved an empty list; Jev routing will be skipped.", "info");
  }
}

function isToolCall(event: ToolCallEvent): event is ToolCallEvent & { toolName: "subagent"; input: RouterInput } {
  return event.toolName === "subagent";
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("jev-router-models", {
    description: "Choose which available models Jev may route subagents to",
    handler: async (_args, ctx) => {
      try {
        await configureModels(ctx);
      } catch (error) {
        ctx.ui.notify(`Could not save model selection: ${error instanceof Error ? error.message : "unknown error"}`, "error");
      }
    },
  });

  let client: TypeSafeClient | undefined;
  let warnedMissingKey = false;
  const runDecisions = new Map<string, { selectedModel: string; shadow: boolean }>();

  pi.on("tool_call", async (event, ctx) => {
    if (!isToolCall(event) || mode() === "off") return;
    const input = event.input;
    // Preserve explicit user/agent choice; never replace an existing model field.
    if (typeof input.model === "string" && input.model.trim()) return;
    if (typeof input.task !== "string" || !input.task.trim()) return;

    const available = candidatesFrom(ctx);
    const selection = await readSelection();
    const candidates = filterCandidates(available, selection);
    if (selection !== undefined && candidates.length === 1) {
      const isShadow = mode() !== "active";
      runDecisions.set(event.toolCallId, { selectedModel: candidates[0].id, shadow: isShadow });
      if (!isShadow) input.model = candidates[0].id;
      console.info(`[jev-router] ${isShadow ? "shadow" : "route"}: selected=${candidates[0].id}, source=single-model-selection`);
      return;
    }
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
      const probabilities = formatProbabilities(result.answers.model, candidates);
      console.info(`[jev-router] ${isShadow ? "shadow" : "route"}: selected=${decision.id}, choice-confidence=${decision.confidence.toFixed(2)}, probabilities={${probabilities}}`);
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

