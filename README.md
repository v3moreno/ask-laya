# ask-laya

An agent skill + CLI + pi extension that enforces
[Laya](https://github.com/NandhaKishorM/laya) as the decision layer in front of
a local LLM: classification, routing, relevance-filtering and yes/no scoring
go through the Laya daemon (~20 ms on GPU, ~130 ms on CPU) instead of burning
generated tokens on decisions.

Built and tested on a 6 GB RTX 4050 Laptop against the
[omarchy-local-ai](https://github.com/v3moreno/omarchy-local-ai) plugin
(TabbyAPI/ExLlamaV3 serving Qwen3.5 EXL3 quants) with the `pi` agent.

Daemon: [local-laya](https://github.com/v3moreno/local-laya) —
`./laya-serve cpu` (:8123) or `./laya-serve gpu` (:8124). Everything here
prefers GPU when both are up; `LAYA_URL` / `LAYA_API_KEY` override
discovery/auth.

## Components

| | What | When to use |
|---|---|---|
| `SKILL.md` | Prompt-level rules: the agent must call `ask` for every decision | Agents that load skills; works on 4B-class models |
| `bin/ask` | Zero-dependency CLI for the daemon (`/v1/systemone`) | Agents via bash, humans, scripts |
| `pi-extension/laya.js` | Registers `laya_*` tools + blocks doc reads until laya runs | **pi agent — required for 2B-class and below** |
| `smoke/` | Test workspace + `run.sh` suite over 5 sample docs | Reproduce the benchmarks |

## ask CLI

```bash
BIN=~/Projects/ask-laya/bin/ask

$BIN route "the user's request"          # task + needs_web/docs/reasoning scores
$BIN relevant "question" file1 file2...  # relevance per doc; keep >= 0.5
$BIN triage file1 file2...               # message type per doc
$BIN yesno "state" "instruction"         # yes/no score
$BIN predict "state" '<questions-json>'  # raw call, full answers
```

To apply prompt-level enforcement: put `AGENTS.md` like `smoke/AGENTS.md` in
the working dir (or point your agent's skill mechanism at `SKILL.md`).

## pi extension — tool-level enforcement

Prompt rules are ignored by small models (2B: 0/6 compliance). The extension
puts laya in pi's tool schema instead, and a `tool_call` hook blocks
`read`/`cat` of `docs/*` until a laya tool has run — the block embeds a
pre-run `laya_triage` result plus the concrete next call, so it redirects
rather than dead-ends.

```bash
cp pi-extension/laya.js "$PI_CODING_AGENT_DIR/extensions/laya.js"
# or project-level (requires trusting the project):
mkdir -p .pi/extensions && cp pi-extension/laya.js .pi/extensions/
```

Registered tools: `laya_route`, `laya_filter`, `laya_triage`, `laya_yesno`
(plus `laya_truth`, an alias small models hallucinate). `files` params are
optional and accept globs — omitted means `docs/*`.

## Results — 6-task smoke suite (`smoke/run.sh`)

| Setup | Laya used | Correct | Wall (doc tasks) |
|---|---:|---:|---|
| 4B + skill (laya CPU) | 4/6 | **6/6** | 9–45 s |
| 2B + skill (laya GPU) | ~1/6* | 4/6 | 1–300 s |
| **2B + extension v2 (laya GPU)** | **6/6** | 4/6 | **2–5 s** |
| 0.8B + skill | 0/6 | 1/6 | up to 231 s wandering |
| 0.8B + extension v2 | 4/6 | 3/6 | 1–9 s |

\* the 2B *attempted* `ask` once and thrashed on CLI usage for 300 s;
cleaner runs call the laya tools zero times.

Extension gate semantics: doc reads under `docs/` stay blocked until a
doc-scoring laya call (`filter`/`triage`/`truth`) has scored at least one
real file — an empty glob no longer unlocks the gate, and `laya_route` /
`laya_yesno` don't authorize document reads on their own.

<details>
<summary>4B + laya-CPU, prompt skill — per-test</summary>

| Test | Wall | Tokens in/out | Used `ask`? | Correct? |
|---|---:|---:|:---:|:---:|
| filter docs | 9 s | 1259/422 | yes | yes (isp-billing.txt) |
| summarize ISP email | 15 s | 2104/624 | yes | yes |
| draft reply | 4 s | 157/179 | no | yes |
| flight lookup | 45 s | 6844/1695 | yes | yes (dates + ref) |
| triage all docs | 12 s | 1373/477 | no | yes |
| no-doc QA | 11 s | 867/386 | yes | yes |

Skips `ask` on tasks it judges as direct generation or trivial reading —
soft enforcement, but quality is flawless.
</details>

<details>
<summary>2B + laya-GPU — prompt skill vs extension v2, per-test</summary>

Skill only (~1/6): t1 tried `ask` and thrashed on CLI usage for the full
300 s timeout; every other task self-served with ls/read/cat (same 0/6
pattern as the earlier baseline — the 2B does not follow prompt rules).

With extension v2 (smart block, optional `files`, real-file gate):

| Test | Wall | Tokens in/out | Laya calls | Correct? |
|---|---:|---:|---:|---|
| filter docs | 4 s | 3750/201 | filter + triage | yes (isp-billing.txt top score) |
| summarize ISP email | 16 s | 3988/901 | triage | no — "(Surrender. 2 of 2)" |
| draft reply | 5 s | 1193/319 | triage + yesno | no — asked a clarifying question |
| flight lookup | 5 s | 1391/317 | triage + filter → read flight.txt | yes (dates + ref) |
| triage all docs | 4 s | 1247/273 | triage | yes |
| no-doc QA | 3 s | 441/67 | yesno | yes |

Retest of the gate exploit: `laya_triage('docs/*.pdf')` on an empty glob no
longer unlocks reads — the model then ran the textbook pipeline:
`laya_triage([])` → `laya_filter(flight.txt)` 0.65 → `read flight.txt` →
correct answer in 4 s.

Enforcement is now decoupled from correctness: 6/6 laya usage; the two
misses are the model giving up mid-task, not skipping laya.
</details>

<details>
<summary>0.8B + laya-GPU — extension, per-test</summary>

| Test | Wall | Tokens in/out | Laya calls | Correct? |
|---|---:|---:|---:|---|
| filter docs | 3 s | 3712/179 | triage | yes |
| summarize ISP email | 16 s | 16991/1211 | yes | no — wandered pi's install dir |
| draft reply | 3 s | 1175/341 | none | partial — triage → read → drafted |
| flight lookup | 6 s | 949/183 | filter (via smart block) | partial — read flight.txt |
| triage all docs | 4 s | 2133/441 | triage | yes |
| no-doc QA | 1 s | 1092/67 | none | yes |

Smart-block recovery observed: a hallucinated `docs/formats.md` read was
blocked, the model used the embedded triage, called `laya_filter` itself,
then read only `flight.txt`. Still not daily-reliable — it once tried to
*edit* the email it was summarizing.
</details>

## Findings

- **Tool registration is enforcement.** The moment `laya_*` tools were in
  pi's schema, the 2B used them unprompted — no prompt convincing needed.
- **Blocking works, but small models read `BLOCKED` as refusal.** Embedding
  a pre-run triage + the concrete next call turns the block into a redirect.
- **The win is tokens.** Flight lookup on 2B: 3884 → 703 input tokens because
  the model filters before reading instead of cat'ing everything.
- **Recommended stack:** Qwen3.5-2B (62.8 T/s, 128K ctx) + pi extension +
  laya-GPU — ~2 s agent tasks with enforced decisions. Use the 4B when
  answer quality matters more than enforcement rigor; the 0.8B only for
  trivial tasks.

## Reproduce

```bash
# daemon
cd ~/Projects/local-laya && ./laya-serve gpu

# suite (pi + omarchy-local-ai plugin, model loaded in the plugin panel)
cd ~/Projects/ask-laya/smoke
export PI_CODING_AGENT_DIR=~/.local/state/omarchy/local-ai/agents/pi
./run.sh "Qwen3.5-2B"   # model id as configured in the plugin
```
