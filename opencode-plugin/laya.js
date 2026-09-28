// laya gate for opencode — delegates to local-laya/laya-gate.py so the same
// doc-gate / danger-gate / injection-screen / route-advisory rules apply here
// as in claude and hermes hooks. tool.execute.before throws to block; after
// credits filter calls and prefixes injection warnings.
const GATE = `${process.env.HOME}/Projects/local-laya/.venv/bin/python`
const GATE_SCRIPT = `${process.env.HOME}/Projects/local-laya/laya-gate.py`

// opencode tool names -> claude-style names the gate understands
const NAME = { read: "Read", bash: "Bash" }

function translate(tool) {
  if (NAME[tool]) return NAME[tool]
  // opencode names MCP tools <server>_<tool>, e.g. laya_laya_filter / jev_jev_filter
  const m = tool.match(/^(?:mcp__)?(laya|jev)[_:](\w+)$/i)
  if (m) {
    const srv = m[1].toLowerCase()
    return `mcp__${srv}__` + (m[2].startsWith(srv + "_") ? m[2] : srv + "_" + m[2])
  }
  return tool
}

// only these reach the gate; everything else skips the python spawn
const PRE = new Set(["Read", "Bash"])
const POST = (name) => PRE.has(name) || /^mcp__(laya|jev)__/.test(name)

async function gate($, event, sessionID, directory, fields) {
  const input = { session_id: "opencode-" + sessionID, cwd: directory || process.cwd(), ...fields }
  const stdout = await $`echo ${JSON.stringify(input)} | ${GATE} ${GATE_SCRIPT} ${event} opencode`
    .quiet().nothrow().text()
  try { return JSON.parse(stdout || "{}") } catch { return {} }
}

const toolInput = (args) => ({
  file_path: args?.filePath ?? args?.file_path ?? args?.path,
  command: args?.command,
})

export const LayaPlugin = async ({ $, directory }) => ({
  // pi's before_agent_start equivalent: route each user prompt, append advisory
  "experimental.chat.messages.transform": async (_input, output) => {
    const msgs = output?.messages
    if (!Array.isArray(msgs)) return
    const lastUser = [...msgs].reverse().find(m => m?.info?.role === "user")
    const parts = lastUser?.parts?.filter(p => p?.type === "text" && p.text)
    const text = parts?.map(p => p.text).join("\n").slice(0, 2000)
    if (!text || text.includes("[laya route]")) return
    const r = await gate($, "prompt", lastUser.info.sessionID, directory, { prompt: text })
    const ctx = r?.hookSpecificOutput?.additionalContext
    // in-place mutation only — reassigning output.messages is a silent no-op
    if (ctx) parts[parts.length - 1].text += `\n\n${ctx}\n`
  },
  "tool.execute.before": async (input, output) => {
    const name = translate(input.tool)
    if (!PRE.has(name)) return
    const r = await gate($, "pretool", input.sessionID, directory,
      { tool_name: name, tool_input: toolInput(output?.args) })
    const d = r?.hookSpecificOutput
    if (d?.permissionDecision === "deny")
      throw new Error(`BLOCKED by laya gate: ${d.permissionDecisionReason}`)
  },
  "tool.execute.after": async (input, output) => {
    const name = translate(input.tool)
    if (!POST(name)) return
    const r = await gate($, "posttool", input.sessionID, directory,
      { tool_name: name, tool_input: toolInput(input.args), tool_response: output?.output ?? null })
    const ctx = r?.hookSpecificOutput?.additionalContext
    if (ctx && typeof output?.output === "string") output.output = ctx + "\n\n" + output.output
  },
})
