#!/usr/bin/env bash
# Smoke suite: 6 tasks over ./docs with laya enforcement active.
#   ./run.sh "Qwen3.5-4B"            # pi on the omarchy-local gateway (default agent)
#   ./run.sh pi Qwen3.5-2B
#   ./run.sh claude|codex|hermes|opencode [model]
# Writes /tmp/<agent>-smoke-<test>.jsonl and prints a per-test summary table.
# Token counts are pi-only; other agents report wall time + laya calls seen.
set -uo pipefail
case "${1:-}" in
  pi|claude|codex|hermes|opencode) AGENT=$1; MODEL="${2:-}" ;;
  *) AGENT=pi; MODEL="${1:-}" ;;
esac
[[ $AGENT == pi && -z $MODEL ]] && MODEL=Qwen3.5-4B
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

run_agent() {  # <prompt>
  local m=()
  case $AGENT in
    pi)       pi --provider omarchy-local --model "$MODEL" --mode json -p "$1" ;;
    claude)   [[ -n $MODEL ]] && m=(--model "$MODEL")
              claude -p "$1" "${m[@]}" --output-format stream-json --verbose ;;
    codex)    [[ -n $MODEL ]] && m=(-m "$MODEL")
              codex exec --json --dangerously-bypass-approvals-and-sandbox "${m[@]}" "$1" ;;
    opencode) [[ -n $MODEL ]] && m=(-m "$MODEL")
              opencode run --format json "${m[@]}" "$1" ;;
    hermes)   [[ -n $MODEL ]] && m=(--model "$MODEL")
              hermes chat --oneshot --accept-hooks "${m[@]}" -q "$1" ;;
  esac
}
export -f run_agent; export AGENT MODEL

printf "%-14s %7s %6s %6s %6s  %s\n" test wall input output asks used-laya
for t in t1-filter t2-summarize t3-draft t4-lookup t5-triage t6-nodoc; do
  f=/tmp/$AGENT-smoke-$t.jsonl
  t0=$EPOCHSECONDS
  timeout 300 bash -c 'run_agent "$1"' _ "${TESTS[$t]}" >"$f" 2>&1
  t1=$EPOCHSECONDS
  python3 - "$f" "$((t1 - t0))" "$t" <<'PYEOF'
import json, re, sys
f, wall, test = sys.argv[1], int(sys.argv[2]), sys.argv[3]
LAYA = re.compile(r"\b(?:laya|jev)_(?:route|filter|triage|yesno|pick|decide|truth)\b|\bask(?:-jev)? (?:route|relevant|triage|yesno|predict)\b")
cmds, inp, out, texts, raw = [], 0, 0, [], []

def walk(o):  # last human-readable text anywhere in an event
    if isinstance(o, dict):
        for k, v in o.items():
            if k in ("text", "result", "message") and isinstance(v, str) and v.strip():
                texts.append(v)
            else:
                walk(v)
    elif isinstance(o, list):
        for v in o:
            walk(v)

for line in open(f, errors="replace"):
    try:
        e = json.loads(line)
    except ValueError:
        raw.append(line); continue
    if not isinstance(e, dict):
        continue
    if e.get("type") == "tool_execution_start":  # pi
        a = e.get("args", {})
        cmds.append(e.get("toolName", "") + " " + str(a.get("command") or a.get("path") or a.get("files") or "")[:120])
    if e.get("type") == "message_end":  # pi
        u = (e.get("message") or {}).get("usage") or {}
        inp += u.get("input", 0); out += u.get("output", 0)
    walk(e)
if not cmds:  # other agents: laya calls as seen anywhere in the transcript
    cmds = sorted(set(LAYA.findall(open(f, errors="replace").read())))
asks = [c for c in cmds if LAYA.search(c)]
answer = (texts[-1] if texts else "".join(raw))[-150:]
print("%-14s %6ds %6s %6s %6d  %s" % (test, wall, inp or "-", out or "-", len(asks), "yes" if asks else "NO"), file=sys.stderr)
open(f + ".cmds", "w").write("\n".join(cmds))
open(f + ".answer", "w").write(answer)
PYEOF
done
echo "--- laya/tool calls per test ---"
for t in t1-filter t2-summarize t3-draft t4-lookup t5-triage t6-nodoc; do
  echo "[$t]"; sed 's/^/  /' /tmp/$AGENT-smoke-$t.jsonl.cmds | sort -u | head -8
done
