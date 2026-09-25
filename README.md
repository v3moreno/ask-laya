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
- `pi-extension/laya.js` — pi agent extension: registers `laya_route`,
  `laya_filter`, `laya_triage`, `laya_yesno` as real tools, and blocks direct
  `read`/`cat` of `docs/*.txt` until a laya tool has run.
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

## pi extension — tool-level enforcement

Prompt rules (AGENTS.md/SKILL.md) work on 4B-class models but are ignored by
2B-class models (0/6 compliance). The pi extension puts laya in the tool
schema instead — compliance becomes immediate, and a `tool_call` hook blocks
document reads until laya has run. Install:

```bash
cp pi-extension/laya.js "$PI_CODING_AGENT_DIR/extensions/laya.js"
# or project-level (requires trusting the project):
mkdir -p .pi/extensions && cp pi-extension/laya.js .pi/extensions/
```

`laya_route` / `laya_filter` / `laya_triage` / `laya_yesno` then appear in
pi's tool list; `files` params accept globs like `docs/*.txt`. Same daemon
discovery as `bin/ask` (GPU :8124 → CPU :8123, `LAYA_URL`/`LAYA_API_KEY`).

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

## pi extension results — same 2B, laya as registered tools

Same model, same daemon (GPU), same prompts — only `pi-extension/laya.js`
added:

| Test | Wall | Tokens in/out | Laya calls | Correct? |
|---|---:|---:|---:|---|
| filter docs | 3 s | 774/228 | filter + triage | yes (isp-billing.txt) |
| summarize ISP email | 2 s | 405/109 | triage | no — hallucinated a doc path |
| draft reply | 3 s | 691/173 | filter | yes |
| flight lookup | 2 s | 703/177 | filter → read flight.txt only | yes (dates + ref) |
| triage all docs | 2 s | 304/95 | triage (one glob call) | yes |
| no-doc QA | 0 s | 77/9 | none (not needed) | yes |

Same-model comparison:

| | AGENTS.md skill | pi extension |
|---|---:|---:|
| laya used | 0/6 | 5/6 |
| correct | 4/6 | 5/6 |
| flight lookup | 16 s, 3884 in-tokens | 2 s, 703 in-tokens |
| triage | 12 s wandering | 2 s, one call |

Findings:

- Tool registration *is* enforcement: the 2B called laya on its own the first
  time a decision came up. The doc-read block was never even needed.
- Wall time dropped 3–8× and input tokens dropped ~80% on doc tasks — the
  model filters before reading instead of cat'ing everything.
- Remaining failure mode is comprehension, not enforcement: on summarize it
  invented `smtp.insta.com/*` as a path instead of listing the docs dir.

## pi extension — Qwen3.5-0.8B-exl3-6bpw (plugin gateway, laya on GPU)

The 0.8B was hardened against with three extension tweaks: `files` param is
optional (defaults to `docs/*` — the model fumbles arrays), unreadable paths
return per-file errors instead of throwing, a `laya_truth` alias absorbs the
model's favourite hallucinated tool name, and a **blocked doc read embeds a
pre-run `laya_triage(docs/*)` result** in the block reason — the block becomes
a redirect with data instead of a dead end.

| Mode | Laya used | Correct | Notes |
|---|---:|---:|---|
| AGENTS.md skill | 0/6 | 1/6 | wandered `~/.config` 231 s on flight lookup |
| extension v1 | 3/6 (broken args) | 2/6 | `laya_truth` hallucination, junk array args |
| extension v2 (smart block) | 4/6 | 3/6 | blocked reads now carry triage + next-step hint |

Smart-block recovery observed: a hallucinated `docs/formats.md` read was
blocked, the model read the embedded triage, called `laya_filter` itself,
then read only `flight.txt` — the full intended pipeline executed by a 0.8B.

Verdict: still below a reliable daily floor (comprehension errors remain —
it once tried to *edit* the email it was summarizing), but the smart block
moved it from catastrophic wandering to a usable-if-supervised agent. The
2B + extension remains the recommendation; 0.8B only where tasks are trivial.
