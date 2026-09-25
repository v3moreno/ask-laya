# Test results

6-task smoke suite in `smoke/` (`./run.sh`), 5 fixture docs, AGENTS.md rules
active. "Laya used" counts both MCP/`laya_*` tool calls and `ask` CLI calls.

## Per-agent

| Agent | Backend | Laya used | Correct | Notes |
|---|---|---:|---:|---|
| claude | remote | 5/6 | 6/6 | Read denied → laya ran → allowed; preferred `ask` CLI over MCP tools; t6 (no-doc QA) correctly skipped laya |
| codex | remote | 6/6 | 6/6 | `ask` CLI + MCP calls; audit line every test |
| hermes | remote | 6/6 | 6/6 | `ask relevant`/`triage`/`yesno`; `laya:` audit lines |
| opencode | remote (gpt-6-luna) | 6/6 | 6/6 | filter/route/yesno via MCP tools |
| opencode | local 4B | 4/6 | 4/6 | t3/t4 refused without attempting; route-advisory hook fixed t4 — see below |

`experimental.chat.messages.transform` (in `opencode-plugin/laya.js`) injects
`[laya route] …` + "check tools before refusing" into every user turn — same
mechanism that fixed pi's small-model wanderings.

## Per-model (pi, local)

| Setup | Laya used | Correct | Wall (doc tasks) |
|---|---:|---:|---|
| 4B + skill (laya CPU) | 4/6 | 6/6 | 9–45 s |
| **4B + extension v2 (laya CPU)** | 5/6 | **6/6** | 4–19 s |
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
<summary>4B + laya-CPU — prompt skill vs extension v2, per-test</summary>

Prompt skill (AGENTS.md + `ask` CLI):

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

Extension v2 — every doc task ran `laya_filter`/`laya_triage` first, then
read only the kept file:

| Test | Wall | Tokens in/out | Laya calls | Correct? |
|---|---:|---:|---:|---|
| filter docs | 13 s | 3162/185 | filter | yes (isp-billing.txt) |
| summarize ISP email | 9 s | 924/266 | filter → read isp-billing | yes |
| draft reply | 12 s | 1133/449 | filter → read isp-billing | yes |
| flight lookup | 19 s | 1091/417 | filter + triage → read flight.txt | yes (dates + ref) |
| triage all docs | 6 s | 545/184 | triage | yes |
| no-doc QA | 4 s | 179/154 | none (correctly skipped) | yes |

Best quality configuration: 6/6 correct with full enforcement, at the cost
of ~1 s CPU laya decisions and 4B thinking time.
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
- **The win is tokens and reliability.** The 2B's best skill-run attempt at
  flight lookup burned 3884 input tokens wandering; with the extension it
  filters before reading — and can't read a doc before laya scores it.
- **Recommended stacks:** **4B + extension + laya-CPU** for max quality with
  full enforcement (6/6, no GPU co-location constraint), or
  **2B + extension + laya-GPU** for fastest agent tasks (~2–5 s, 5.5 GB
  co-resident at 128K ctx). The 0.8B only for trivial tasks.
