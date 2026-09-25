# Project rules

This project has a Laya decision daemon and the `ask` CLI at
~/Projects/ask-laya/bin/ask. Read ~/Projects/ask-laya/SKILL.md and follow it:
ALL classification, routing, relevance-filtering, ranking and yes/no decisions
about text MUST go through `ask` — never decide them yourself. When you use it,
report one line like `laya: route=email kept 2/5 docs`.

`./docs/` contains several emails and notes. Before reading any of them for a
question, run `ask relevant` to decide which are worth reading.
