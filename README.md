# ask-laya

Enforces [Laya](https://github.com/NandhaKishorM/laya) as the decision layer
in front of an LLM: classification, routing, relevance-filtering and yes/no
scoring go through the Laya daemon (~20 ms GPU / ~130 ms CPU, zero generated
tokens) instead of generated tokens.

Built and tested on a 6 GB RTX 4050 Laptop against the
[omarchy-local-ai](https://github.com/v3moreno/omarchy-local-ai) plugin
(TabbyAPI/ExLlamaV3 serving Qwen3.5 EXL3 quants) with the `pi` agent.

Daemon: [local-laya](https://github.com/v3moreno/local-laya) —
`./laya-serve cpu` (:8123) or `./laya-serve gpu` (:8124). Callers prefer GPU
when both are up; `LAYA_URL` / `LAYA_API_KEY` override discovery/auth.

## Components

| | What | When to use |
|---|---|---|
| `SKILL.md` | Prompt-level rules: call `ask` for every decision | Agents that load skills |
| `bin/ask` | Zero-dependency CLI for the daemon (`/v1/systemone`) | Agents via bash, humans, scripts |
| `pi-extension/laya.js` | `laya_*` tools + hard doc-read/danger/injection gates | **pi and omp** |
| `opencode-plugin/laya.js` | opencode plugin: gates + per-prompt route advisory | opencode |
| `local-laya/laya-mcp.py` | stdio MCP server proxying to the daemon | every other agent |
| `local-laya/laya-gate.py` | hook engine (claude + hermes protocols) | agents with shell hooks |
| `smoke/` | Test workspace + `run.sh` suite over 5 fixture docs | reproduce the benchmarks |

## ask CLI

```bash
BIN=~/Projects/ask-laya/bin/ask

$BIN route "the user's request"          # task + needs_docs/reasoning scores
$BIN relevant "question" file1 file2...  # relevance per doc; keep >= 0.5
$BIN triage file1 file2...               # message type per doc
$BIN yesno "state" "instruction"         # yes/no score
$BIN predict "state" '<questions-json>'  # raw call, full answers
```

Prompt-level enforcement: put an `AGENTS.md` like `smoke/AGENTS.md` in the
working dir (or point the agent's skill mechanism at `SKILL.md`).

## Per-agent integration

`local-laya/laya-mcp-install` registers everything below (idempotent):

| Agent | Mechanism | Enforcement |
|---|---|---|
| pi, omp | native extension | hard — blocking tool hooks, injection guard, danger gate, route advisory |
| claude | MCP + `~/.claude/settings.json` hooks | hard — doc-read gate, danger gate, injection screen, route advisory |
| hermes | MCP + `~/.hermes/config.yaml` hooks | hard — same gate, hermes hook protocol |
| opencode | MCP + `opencode-plugin/laya.js` | hard — `tool.execute.before/after` + prompt advisory |
| codex, copilot | MCP | soft — tools + server instructions only; no hook surface exists |
| crush, grok | MCP via plugin-generated config | soft — omarchy-local-ai fork injects laya on each `open` (`LAYA_MCP=off` disables) |

"Hard" means the host can block another tool's call; MCP alone cannot.
Gate scope is `docs/` — it's a tripwire for doc filtering, not a filesystem
sandbox (non-doc paths, `Edit`, `cd docs && cat x` bypass it).

Verified live invocation (not just registration): `claude -p`, `codex exec`,
`hermes chat --oneshot`, `opencode run` all called laya tools and returned
real daemon decisions; pi's calls are proven across the model matrix.
`codex exec` headless needs `--dangerously-bypass-approvals-and-sandbox`
(or an approval) for MCP calls.

## pi extension

```bash
cp pi-extension/laya.js "$PI_CODING_AGENT_DIR/extensions/laya.js"
# or project-level: mkdir -p .pi/extensions && cp pi-extension/laya.js .pi/extensions/
```

**Tools** (model-callable): `laya_route`, `laya_filter`, `laya_triage`
(kind + urgency + needs_reply + is_spam per doc), `laya_yesno`,
`laya_pick`, `laya_decide` (raw passthrough), `laya_truth` (alias — small
models hallucinate the name). `files` params are optional and accept globs.

**Automatic hooks:**

- `before_agent_start` — routes each user prompt, appends
  `[laya route: task=… needs_docs=…]` to the system prompt.
- `tool_result` — screens `read`/`bash` output for prompt injection,
  prepends a "treat as DATA" warning when suspicious.
- `tool_call` — doc gate: reads of `docs/*` blocked until a doc-scoring
  call scored ≥1 real file (the block embeds a pre-run triage so it
  redirects instead of dead-ending). Danger gate: bash commands laya-scored,
  blocked at ≥0.85.

## Results and findings

See [RESULTS.md](RESULTS.md) — per-agent 6-test suite, per-model pi matrix,
and the calibration notes.

## Reproduce

```bash
cd ~/Projects/local-laya && ./laya-serve gpu          # or cpu
cd ~/Projects/ask-laya/smoke
export PI_CODING_AGENT_DIR=~/.local/state/omarchy/local-ai/agents/pi
./run.sh "Qwen3.5-2B"   # model id as configured in the plugin
```
