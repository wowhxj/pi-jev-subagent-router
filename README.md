# pi-jev-subagent-router

A Pi extension that asks TypeSafe Jev which configured Pi model best fits each `subagent` task. Requires `pi-subagents` to be installed and `TYPESAFE_API_KEY` to be present.

## Install

From this directory:

```sh
pi install .
```

Or install the Git repository at a fixed tag once published:

```sh
pi install git:github.com/<owner>/pi-jev-subagent-router@v0.1.0
```

The extension package installs the TypeSafe SDK dependency. `pi-subagents` is intentionally separate and must already provide the `subagent` tool.

## Modes

- Default `active`: apply the selected model only when the subagent call has no explicit `model`.
- `shadow`: ask Jev and log its proposed model, but leave dispatch unchanged.
- `off`: disable routing.

Set `PI_JEV_SUBAGENT_ROUTER=active|shadow|off`. Unknown or unset values use `active`. Select available candidates from the current Pi model registry; when Pi has scoped models configured, only those candidates are considered. With fewer than two available candidates, routing is skipped.

```sh
export TYPESAFE_API_KEY=...
export PI_JEV_SUBAGENT_ROUTER=active
```

Set `PI_JEV_ROUTER_MAX_TASK_CHARS` to adjust the transmitted task limit (256–12000, default 4000). The extension sends task text to TypeSafe's API after redacting common email, bearer-token, API-key, token, password, and secret patterns. Redaction is best-effort, not a privacy boundary; do not enable this for sensitive prompts unless you accept that disclosure. Task content is not written to logs. Jev requests use a 6-second timeout and no retry; failures fall back to normal Pi model selection.

## Verification

```sh
node --test
```

## Current limitations

Routing logs include the selected model, TypeSafe's scalar `choice-confidence`, and the per-candidate `probabilities` distribution. Final synchronous/async result metadata is logged to the Pi process console. Async completion events currently record completion state but cannot reliably associate the finished child with an earlier tool call in all `pi-subagents` execution paths. Model choice behavior and confidence are not calibrated yet; consider starting in shadow mode to assess representative tasks before relying on active routing.
