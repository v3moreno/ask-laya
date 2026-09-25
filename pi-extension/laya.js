/**
 * Laya Extension — decision tools backed by the local Laya daemon, plus hard
 * enforcement: reads of docs/*.txt are blocked until a laya_* tool has run.
 *
 * Install: symlink into <agent-dir>/extensions/ or a project's .pi/extensions/.
 * Daemon: ~/Projects/local-laya/laya-serve cpu (:8123) or gpu (:8124).
 * LAYA_URL overrides discovery; LAYA_API_KEY is sent as a bearer token.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join, dirname, basename } from "node:path";

const URLS = process.env.LAYA_URL
	? [process.env.LAYA_URL]
	: ["http://127.0.0.1:8124", "http://127.0.0.1:8123"];

const ROUTE_Q = {
	task: {
		type: "choice",
		instructions: "What kind of request is this?",
		criteria: {
			qa: "factual question answered from knowledge or the user's documents",
			email: "write, reply to, or classify an email or message",
			summarize: "summarize, reformat, or extract from given text",
			web_lookup: "needs current information (news, prices, weather, recent events)",
			chat: "casual conversation",
		},
	},
	needs_web: { type: "noul", instructions: "Does answering require live information the model cannot know?" },
	needs_docs: { type: "noul", instructions: "Would the answer benefit from the user's own documents or emails?" },
	needs_reasoning: { type: "noul", instructions: "Does this require careful multi-step reasoning rather than a direct reply?" },
};

const TRIAGE_Q = {
	kind: {
		type: "choice",
		instructions: "What kind of message or document is this?",
		criteria: {
			invoice_or_billing: "bill, invoice, payment or charge notice",
			personal: "personal message from a person",
			booking_or_itinerary: "travel, booking, reservation or schedule",
			notice: "informational notice, receipt or reminder",
			work: "work update, standup or team note",
			other: "none of the above",
		},
	},
};

let daemon = null;
let layaUsed = false;

async function base() {
	if (daemon) return daemon;
	for (const u of URLS) {
		try {
			const r = await fetch(u + "/health", { signal: AbortSignal.timeout(800) });
			if (r.ok) return (daemon = u);
		} catch {}
	}
	throw new Error("no laya daemon on " + URLS.join(", "));
}

async function predict(state, questions) {
	const r = await fetch((await base()) + "/v1/systemone", {
		method: "POST",
		headers: { "Content-Type": "application/json",
			...(process.env.LAYA_API_KEY ? { Authorization: "Bearer " + process.env.LAYA_API_KEY } : {}) },
		body: JSON.stringify({ state, questions }),
	});
	if (!r.ok) throw new Error("laya daemon: HTTP " + r.status);
	return r.json();
}

function slim(result) {
	const out = {};
	for (const [qid, a] of Object.entries(result.answers || {})) {
		out[qid] = a.choice ?? a.score ?? a.noul ?? a;
	}
	return out;
}

const text = (obj) => ({ content: [{ type: "text", text: JSON.stringify(obj) }], details: undefined });
const readFile = (f) => readFileSync(f, "utf8").slice(0, 4000);
// expand a single * glob against the containing directory; plain paths pass through
function expand(paths) {
	if (!paths || paths.length === 0) paths = ["docs/*"];
	if (typeof paths === "string") paths = [paths];
	const out = [];
	for (const p of paths) {
		if (!String(p).includes("*")) { out.push(p); continue; }
		const dir = dirname(p) || ".";
		const re = new RegExp("^" + basename(p).replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$");
		try { for (const n of readdirSync(dir)) re.test(n) && out.push(join(dir, n)); } catch {}
	}
	return out;
}
const isDoc = (p) => /(^|\/|\\)docs?\/[^\/\\]*\.(txt|md|eml)$/i.test(String(p || ""));
const tryRead = (f) => { try { return readFile(f); } catch (e) { return `__ERR__ ${e.message}`; } };

export default function (pi) {
	pi.registerTool({
		name: "laya_route",
		label: "Laya Route",
		description: "MANDATORY first step for any multi-step or document-touching request: classify the request (task type, needs web/docs/reasoning) with the Laya decision engine. ~20ms, no generation.",
		parameters: { type: "object", required: ["text"], properties: { text: { type: "string", description: "the user's request, verbatim" } } },
		async execute(_id, params) { return text(slim(await predict(params.text, ROUTE_Q))); },
	});

	pi.registerTool({
		name: "laya_filter",
		label: "Laya Filter",
		description: "MANDATORY before reading documents: score each file's relevance to a question (0-1). Only read files scoring >= 0.5.",
		parameters: {
			type: "object", required: ["question"],
			properties: {
				question: { type: "string" },
				files: { type: "array", items: { type: "string" }, description: "paths or glob; omit to score all docs/*" },
			},
		},
		async execute(_id, params) {
			const out = [];
			for (const f of expand(params.files)) {
				const body = tryRead(f);
				if (body.startsWith("__ERR__")) { out.push({ file: f, error: body.slice(8) }); continue; }
				const r = await predict(body, { relevant: { type: "noul", instructions: `Does this text contain information that helps answer: ${params.question}?` } });
				out.push({ file: f, relevant: slim(r).relevant });
			}
			if (out.some((x) => !x.error)) layaUsed = true;
			return text(out);
		},
	});

	pi.registerTool({
		name: "laya_triage",
		label: "Laya Triage",
		description: "MANDATORY when asked to classify or triage documents: returns the message kind of each file (invoice_or_billing, personal, booking_or_itinerary, notice, work, other). Call with files=[] or a glob like docs/*.txt — omit files to triage all docs/*. Never classify documents yourself.",
		parameters: { type: "object", properties: { files: { type: "array", items: { type: "string" }, description: "paths or glob; omit to triage all docs/*" } } },
		async execute(_id, params) {
			const out = [];
			for (const f of expand(params.files)) {
				const body = tryRead(f);
				if (body.startsWith("__ERR__")) { out.push({ file: f, error: body.slice(8) }); continue; }
				out.push({ file: f, kind: slim(await predict(body, TRIAGE_Q)).kind });
			}
			if (out.some((x) => !x.error)) layaUsed = true;
			return text(out);
		},
	});

	pi.registerTool({
		name: "laya_yesno",
		label: "Laya Yes/No",
		description: "MANDATORY for yes/no decisions about text: returns a 0-1 score. Do not decide such questions yourself.",
		parameters: {
			type: "object", required: ["state", "instruction"],
			properties: { state: { type: "string" }, instruction: { type: "string", description: "the yes/no question as an instruction" } },
		},
		async execute(_id, params) { return text(slim(await predict(params.state, { answer: { type: "noul", instructions: params.instruction } }))); },
	});

	// Small models hallucinate laya_truth — keep it as a working alias of filter.
	pi.registerTool({
		name: "laya_truth",
		label: "Laya Truth",
		description: "Score whether each doc helps answer the question. Equivalent to laya_filter; question may be named 'text'.",
		parameters: { type: "object", properties: { text: { type: "string" }, question: { type: "string" }, files: { type: "array", items: { type: "string" } } } },
		async execute(_id, params) {
			const q = params.question || params.text || "relevant documents";
			const out = [];
			for (const f of expand(params.files)) {
				const body = tryRead(f);
				if (body.startsWith("__ERR__")) { out.push({ file: f, error: body.slice(8) }); continue; }
				const r = await predict(body, { relevant: { type: "noul", instructions: `Does this text contain information that helps answer: ${q}?` } });
				out.push({ file: f, relevant: slim(r).relevant });
			}
			if (out.some((x) => !x.error)) layaUsed = true;
			return text(out);
		},
	});

	// Hard enforcement: no reading or shell-printing of docs until a
	// doc-scoring laya tool has actually scored files.
	pi.on("tool_call", async (event) => {
		if (layaUsed) return undefined;
		const p = event.input || {};
		const docRead =
			(event.toolName === "read" && isDoc(p.path)) ||
			(event.toolName === "bash" && /\b(cat|less|head|tail|bat)\b[^\n]*\bdocs?\//.test(String(p.command || "")));
		if (docRead) {
			let hint = "";
			try {
				const tri = [];
				for (const f of expand(["docs/*"])) {
					const body = tryRead(f);
					if (body.startsWith("__ERR__")) continue;
					tri.push({ file: f, kind: slim(await predict(body, TRIAGE_Q)).kind });
				}
				if (tri.length) hint = ` laya_triage(docs/*) already ran for you: ${JSON.stringify(tri)}.`;
			} catch {}
			layaUsed = true;
			return { block: true, reason: `BLOCKED.${hint} Now call laya_filter with {"question": "<the user's question>"} to pick which file holds the answer, then read only that file.` };
		}
		return undefined;
	});
}
