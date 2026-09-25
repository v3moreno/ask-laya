# ask-laya

An agent skill + CLI that enforces [Laya](https://github.com/NandhaKishorM/laya)
as the decision layer in front of a local LLM: all classification, routing,
relevance-filtering and yes/no scoring goes through the Laya daemon (~20 ms on
GPU, ~130 ms on CPU) instead of burning generated tokens on decisions.

Built and tested on a 6 GB RTX 4050 Laptop against the
[omarchy-local-ai](https://github.com/v3moreno/omarchy-local-ai) plugin
(TabbyAPI/ExLlamaV3 serving Qwen3.5 EXL3 quants) with the `pi` agent.

## Layout

- `SKILL.md` — the skill document: rules that require the agent to call `ask`
  for every decision-type question.
- `bin/ask` — zero-dependency CLI for the Laya daemon (`/v1/systemone`).
- `smoke/` — test workspace (`AGENTS.md` applies the skill; `run.sh` reruns
  the suite) plus `docs/` sample emails.

## Usage

```bash
BIN=~/Projects/ask-laya/bin/ask

$BIN route "the user's request"          # task + needs_web/docs/reasoning scores
$BIN relevant "question" file1 file2...  # relevance per doc; keep >= 0.5
$BIN triage file1 file2...               # message type per doc
$BIN yesno "state" "instruction"         # yes/no score
$BIN predict "state" '<questions-json>'  # raw call, full answers
```

Daemon: [local-laya](https://github.com/v3moreno/local-laya) —
`./laya-serve cpu` (:8123) or `./laya-serve gpu` (:8124); `ask` prefers GPU.
`LAYA_URL` / `LAYA_API_KEY` override discovery/auth.

To make an agent follow it: put `AGENTS.md` like `smoke/AGENTS.md` in the
working dir (or use your agent's skill mechanism pointing at `SKILL.md`).

## Baseline — pi + Qwen3.5-4B-exl3-6hb-6bpw (plugin gateway, laya on CPU)

`smoke/run.sh "Qwen3.5-4B"`, 6 tasks over 5 docs:

| Test | Wall | Tokens in/out | Used `ask`? | Correct? |
|---|---:|---:|:---:|:---:|
| filter docs | 9 s | 1259/422 | yes | yes (isp-billing.txt) |
| summarize ISP email | 15 s | 2104/624 | yes | yes |
| draft reply | 4 s | 157/179 | no | yes |
| flight lookup | 45 s | 6844/1695 | yes | yes (dates + ref) |
| triage all docs | 12 s | 1373/477 | no | yes |
| no-doc QA | 11 s | 867/386 | yes | yes |

Findings:

- Quality: 6/6 correct answers; laya filtering picked the right document and
  the LLM only read what scored >= 0.5.
- Prompt-level enforcement: 4/6 tasks used `ask`. The 4B skipped it on tasks it
  judged as direct generation or trivial reading — a custom tool (pi extension)
  would enforce it harder than doc rules.
- Laya decisions cost ~0.1–1 s on CPU — invisible vs the LLM's think/generate
  time; the win is tokens not burned on reading/filtering docs.

## Baseline — pi + Qwen3.5-2B-exl3-6hb-6bpw (plugin gateway, laya on GPU)

Same suite, MTP drafting on, laya daemon in GPU mode (~20 ms/decision):

| Test | Wall | Tokens in/out | Used `ask`? | Correct? |
|---|---:|---:|:---:|:---:|
| filter docs | 14 s | 4001/454 | no | yes |
| summarize ISP email | 6 s | 2248/484 | no | yes |
| draft reply | 10 s | 2480/588 | no | yes |
| flight lookup | 16 s | 3884/631 | no | no — never opened flight.txt |
| triage all docs | 2 s | 561/50 | no | no — degenerate output |
| no-doc QA | 1 s | 151/19 | no | yes |

Findings:

- **The 2B ignores prompt-level rules entirely** (0/6 `ask` calls) — it
  wanders the filesystem with ls/find/cat and once searched pi's own install
  docs for "flight". Prompt-skill enforcement needs a 4B-class model minimum;
  for the 2B, enforcement must be tool-level (a pi extension).
- Quality is task-dependent: fine for direct QA/summaries, unreliable as an
  agent (2/6 tasks failed outright).
- Per-task wall time is comparable to the 4B because failures waste calls;
  when it does the right thing it's quick (6 s summarize, 1 s QA).
