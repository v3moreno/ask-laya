---
name: ask-laya
description: Enforced use of the local Laya decision daemon for ALL classification, routing, relevance-filtering, yes/no and scoring questions. Never answer such questions by reasoning about the text yourself — run `ask` and use its output.
---

# ask-laya — decisions go through Laya, not through you

You have a local decision daemon (Laya) on this machine. It answers typed
questions — choice, score, yes/no — in a single encoder forward pass: ~20 ms on
GPU, ~130 ms on CPU, zero generated tokens.

## The rule

Whenever you are about to **classify, route, filter, score, rank or decide
yes/no about a piece of text** — including deciding whether a request needs the
web, which documents are relevant, what kind of task something is, whether
reasoning is required — you MUST call `ask` instead of deciding yourself.
Your own judgment on these questions is slower, costs tokens, and is not
calibrated. `ask` output is the decision; do not second-guess it.

## Commands

```bash
BIN=~/Projects/ask-laya/bin/ask

$BIN route "the user's request"          # -> {"task": ..., "needs_web": 0.x, "needs_docs": 0.x, "needs_reasoning": 0.x}
$BIN relevant "question" file1 file2...  # -> [{"file": ..., "relevant": 0.x}, ...] — keep files >= 0.5
$BIN triage file1 file2...               # -> [{"file": ..., "kind": "..."}, ...] — classifies each doc
$BIN yesno "state text" "instruction"    # -> {"answer": 0.x}
$BIN predict "state" '<questions-json>'  # raw call, full answer objects
```

## Rules

1. **Route first.** On any multi-step or document-touching request — including
   drafting replies to documents — run `ask route` before planning your answer.
2. **Filter before reading.** Given several documents/emails, run
   `ask relevant` first and only read files scoring >= 0.5. Never read them all
   "to be safe". To say WHAT each document is, use `ask triage` — never
   classify documents yourself.
3. **Batch.** One `ask predict` call can carry several questions — use one call
   rather than several invocations.
4. **Trust the numbers.** Do not re-derive a decision in prose to "check" it.
   If a score is borderline (~0.4–0.6), act on it anyway or ask the user — do
   not silently substitute your own judgment.
5. **Report.** When you used `ask`, say so in one line (e.g. `laya: route=email,
   kept 2/5 docs`) so decisions stay auditable.
6. If `ask` fails (daemon down), fall back to your own judgment and say
   `laya unavailable: reasoned manually`.

Daemon: `~/Projects/local-laya/laya-serve cpu` (:8123) or `gpu` (:8124).
`ask` prefers GPU when both are up.
