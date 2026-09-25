// laya gate for opencode — delegates to local-laya/laya-gate.py so the same
// doc-gate / danger-gate / injection-screen rules apply here as in claude hooks.
// tool.execute.before throws to block; after prefixes injection warnings.
const GATE = `${process.env.HOME}/Projects/local-laya/.venv/bin/python`
const GATE_SCRIPT = `${process.env.HOME}/Projects/local-laya/laya-gate.py`

// opencode tool names -> claude-style names the gate understands
const NAME = { read: "Read", bash: "Bash", grep: "Grep", glob: "Glob" }

function translate(tool) {
  if (NAME[tool]) return NAME[tool]
  const m = tool.match(/^(?:mcp__)?laya[_:](laya_\w+|status|route|filter|triage|yesno|pick|decide|truth)$/i)
  if (m) return "mcp__laya__" + (m[1].startsWith("laya_") ? m[1] : "laya_" + m[1])
  return tool
}

async function gate($, event, tool, args, result, directory) {
  const input = {
    tool_name: translate(tool),
    tool_input: {
      file_path: args?.filePath ?? args?.file_path ?? args?.path,
      command: args?.command,
      path: args?.path,
    },
    tool_response: result,
    session_id: "opencode-" + (directory || process.cwd()),
    cwd: directory || process.cwd(),
  }
  const stdout = await $`echo ${JSON.stringify(input)} | ${GATE} ${GATE_SCRIPT} ${event}`
    .quiet().nothrow().text()
  try { return JSON.parse(stdout || "{}") } catch { return {} }
}

export const LayaPlugin = async ({ $, directory }) => ({
  "tool.execute.before": async (input, output) => {
    const r = await gate($, "pretool", input.tool, output?.args, null, directory)
    const d = r?.hookSpecificOutput
    if (d?.permissionDecision === "deny")
      throw new Error(`BLOCKED by laya gate: ${d.permissionDecisionReason}`)
  },
  "tool.execute.after": async (input, output) => {
    const r = await gate($, "posttool", input.tool, input.args ?? output?.args,
      output?.output ?? output?.result ?? null, directory)
    const ctx = r?.hookSpecificOutput?.additionalContext
    if (ctx && typeof output?.output === "string") output.output = ctx + "\n\n" + output.output
  },
})
