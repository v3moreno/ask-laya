// laya gate for opencode — delegates to local-laya/laya-gate.py so the same
// doc-gate / danger-gate / injection-screen rules apply here as in claude hooks.
// tool.execute.before throws to block; after prefixes injection warnings.
import { appendFileSync } from "fs"

const GATE = `${process.env.HOME}/Projects/local-laya/.venv/bin/python`
const GATE_SCRIPT = `${process.env.HOME}/Projects/local-laya/laya-gate.py`

// opencode tool names -> claude-style names the gate understands
const NAME = { read: "Read", bash: "Bash", grep: "Grep", glob: "Glob" }

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

const ASK = `${process.env.HOME}/Projects/ask-laya/bin/ask`

export const LayaPlugin = async ({ $, directory }) => ({
  // pi's before_agent_start equivalent: route each user prompt, append advisory
  "experimental.chat.messages.transform": async (input, output) => {
    const msgs = output?.messages
    if (process.env.LAYA_GATE_DEBUG)
      appendFileSync("/tmp/oc-plugin-debug.log",
        `transform fired msgs=${msgs?.length} roles=${msgs?.map(m => m?.info?.role).join(",")}\n`)
    if (!Array.isArray(msgs)) return
    const lastUser = [...msgs].reverse().find(m => m?.info?.role === "user")
    const parts = lastUser?.parts?.filter(p => p?.type === "text" && p.text)
    const text = parts?.map(p => p.text).join("\n").slice(0, 2000)
    if (!text || text.includes("[laya route]")) return
    const route = (await $`${ASK} route ${text}`.quiet().nothrow().text()).trim()
    if (!route) return
    // in-place mutation only — reassigning output.messages is a silent no-op
    parts[parts.length - 1].text += `\n\n[laya route] ${route}\n` +
      `You have local tools: laya_laya_filter/triage route file access (call with files:["docs/*"] ` +
      `to find relevant docs), laya_laya_yesno for decisions, plus bash/glob/read. ` +
      `If this request could relate to local files, call laya_laya_filter BEFORE answering — ` +
      `do not refuse without checking tools first.`
  },
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
