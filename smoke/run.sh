#!/usr/bin/env bash
# Smoke suite: pi on the omarchy-local gateway, enforcing laya via AGENTS.md.
#   ./run.sh "Qwen3.5-4B"      # or Qwen3.5-2B / Qwen3.5-0.8B
# Writes /tmp/pi-smoke-<test>.jsonl and prints a per-test summary table.
set -uo pipefail
MODEL="${1:-Qwen3.5-4B}"
export PI_CODING_AGENT_DIR=~/.local/state/omarchy/local-ai/agents/pi
cd "$(dirname "$0")"

declare -A TESTS=(
  [t1-filter]="Which files in ./docs/ are relevant to: what did my ISP say about the charge? List filenames only."
  [t2-summarize]="Summarize my ISP email in two sentences."
  [t3-draft]="Draft a short reply to my ISP confirming I received their message about the refund."
  [t4-lookup]="Do I have a flight coming up? Give me the dates and booking ref."
  [t5-triage]="Triage ./docs/*.txt: for each file, one line saying what kind of message it is."
  [t6-nodoc]="Is Pluto a planet? One sentence."
)

printf "%-14s %7s %6s %6s %6s  %s\n" test wall input output asks used-ask
for t in t1-filter t2-summarize t3-draft t4-lookup t5-triage t6-nodoc; do
  f=/tmp/pi-smoke-$t.jsonl
  t0=$EPOCHSECONDS
  PI_CODING_AGENT_DIR=$PI_CODING_AGENT_DIR timeout 300 pi --provider omarchy-local \
    --model "$MODEL" --mode json -p "${TESTS[$t]}" >"$f" 2>&1
  t1=$EPOCHSECONDS
  python3 - "$f" "$((t1 - t0))" <<'PYEOF'
import json, sys
f, wall = sys.argv[1], int(sys.argv[2])
cmds, inp, out = [], 0, 0
answer = ""
for line in open(f):
    try: e = json.loads(line)
    except: continue
    if e.get("type") == "tool_execution_start" and e.get("toolName") == "bash":
        cmds.append(e.get("args", {}).get("command", ""))
    if e.get("type") == "message_end":
        u = (e.get("message") or {}).get("usage") or {}
        inp += u.get("input", 0); out += u.get("output", 0)
        for c in e.get("message", {}).get("content", []):
            if c.get("type") == "text": answer = c["text"][-150:]
asks = [c for c in cmds if "ask" in c.split()[0].split("/")[-1] or "bin/ask" in c]
print("%-14s %6ds %6d %6d %6d  %s" % (sys.argv[1].split("-smoke-")[-1][:14], wall, inp, out, len(asks),
      "yes" if asks else "NO"), file=sys.stderr)
open(f + ".cmds", "w").write("\n".join(cmds))
open(f + ".answer", "w").write(answer)
PYEOF
done
echo "--- commands per test ---"
for t in t1-filter t2-summarize t3-draft t4-lookup t5-triage t6-nodoc; do
  echo "[$t]"; sed 's/^/  /' /tmp/pi-smoke-$t.jsonl.cmds | sort -u | head -8
done
