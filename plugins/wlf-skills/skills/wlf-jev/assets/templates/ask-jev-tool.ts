// ask-jev-tool.ts — an agent tool that writes and runs its own Jev questions
// (TypeSafe Jev, @typesafe-ai/sdk 0.7.x, Node >= 22).
//
// Register `ASK_JEV_TOOL` with your agent framework and route calls to `askJev`.
// Use it for cheap typed judgments over many items: screening documents, triaging
// a list, checking a batch of records. The agent should confirm flagged items by
// reading them; answers are a screen, not a verdict.
//
// Everything placed in `state` is sent to TypeSafe. Items with secret-like text
// are skipped and reported, never sent.

import { TypeSafeClient, type EntryType, type Question, type Questions } from "@typesafe-ai/sdk";

export interface AskJevOptions {
  model: string;          // pin a versioned id in production
  timeoutMs: number;      // per attempt
  maxRetries: number;
  concurrency: number;    // bounded; keep well under your organisation's rate limit
  maxItems: number;
  stateTokenBudget: number;   // default limits (vendor, accessed 2026-11-02): 32k per state+question, 64k per request
  requestTokenBudget: number;
}

export const ASK_JEV_DEFAULTS: AskJevOptions = {
  model: "jev-1.14.0", timeoutMs: 20000, maxRetries: 0, concurrency: 8, maxItems: 2000,
  stateTokenBudget: 32000, requestTokenBudget: 64000,
};

// Tool description shown to the agent. Keep it short; it is part of every turn.
export const ASK_JEV_TOOL = {
  name: "ask_jev",
  description:
    "Ask TypeSafe Jev typed questions about one state or many items. Types: noul (yes/no probability), " +
    "choice (one of named options, with probabilities), score (position on 2–10 described levels, low to high). " +
    "One narrow judgment per question; point at fields with backticks, e.g. `doc.text`; put facts in named fields; " +
    "describe situations, not degrees. Treat answers as a screen and read flagged items before acting.",
  input_schema: {
    type: "object",
    properties: {
      questions: { type: "object", description: "snake_case id -> {type, instructions, criteria}" },
      state: { description: "one state object to ask about" },
      items: { type: "array", description: "or: many states, one request each" },
    },
    required: ["questions"],
  },
} as const;

export interface AskJevInput { questions: Record<string, Question>; state?: unknown; items?: unknown[] }

const SECRET_LIKE = /(sk-[A-Za-z0-9]{16,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----|ghp_[A-Za-z0-9]{20,})/;
const estTokens = (x: unknown) => Math.ceil(JSON.stringify(x ?? null).length / 4); // heuristic, not the vendor tokenizer

export function validate(questions: Record<string, Question>): string[] {
  const problems: string[] = [];
  const entries = Object.entries(questions ?? {});
  if (!entries.length) problems.push("no questions");
  for (const [id, q] of entries) {
    if (!/^[a-z][a-z0-9_]*$/.test(id)) problems.push(`${id}: use a snake_case id`);
    const text = typeof q.instructions === "string" ? q.instructions : "";
    if (q.type !== "box" && text.length < 8) problems.push(`${id}: instructions are too short to be a real question`);
    if (text && !text.includes("`")) problems.push(`${id}: point at the state field it judges, e.g. \`doc.text\``);
    if (q.type === "choice") {
      const n = Object.keys(q.criteria ?? {}).length;
      if (n < 2 || n > 255) problems.push(`${id}: choice needs 2–255 options`);
    }
    if (q.type === "score" && (!Array.isArray(q.criteria) || q.criteria.length < 2 || q.criteria.length > 10)) problems.push(`${id}: score needs 2–10 levels`);
    if (q.type === "box") problems.push(`${id}: box is image-only and opt-in; not offered through this tool`);
  }
  return problems;
}

// Trim the state until it fits min(state budget − largest question, request budget − all questions).
// Each pass shortens the single largest leaf anywhere in the tree: a long string (cut to 75%) or an
// array (drop its last quarter). It stops when the state fits, when nothing is left to cut, when a
// pass makes no progress, or after MAX_TRIM_PASSES, and then reports "over budget" rather than
// sending or looping.
//
// Regression case (an earlier version looped forever here): state
//   { title: "Quarterly report", doc: { text: "x".repeat(200_000) } }
// with one short noul. The bulk is nested and a short top-level string exists. Expected: terminates
// in a few dozen passes with ok: true and trimmed: ["doc.text"]. With stateTokenBudget: 10 it
// terminates with ok: false ("over budget"), because "title" is too short to cut further.
const MAX_TRIM_PASSES = 500;
const MIN_TRIM_CHARS = 64;   // strings shorter than this are left alone
const TRIM_MARK = " …[trimmed]";

export type TrimResult =
  | { ok: true; state: unknown; trimmed: string[] }
  | { ok: false; reason: string; estTokens: number; budget: number };

type Leaf = { path: string; holder: Record<string, unknown> | unknown[]; key: string | number; size: number; kind: "string" | "array" };

function leaves(node: unknown, path: string, holder: Leaf["holder"], key: string | number, out: Leaf[]): void {
  if (typeof node === "string") {
    if (node.length > MIN_TRIM_CHARS) out.push({ path, holder, key, size: node.length, kind: "string" });
  } else if (Array.isArray(node)) {
    if (node.length > 1) out.push({ path, holder, key, size: JSON.stringify(node).length, kind: "array" });
    node.forEach((v, i) => leaves(v, `${path}[${i}]`, node, i, out));
  } else if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) leaves(v, path ? `${path}.${k}` : k, node as Record<string, unknown>, k, out);
  }
}

export function trimState(state: unknown, questions: Questions, o: AskJevOptions): TrimResult {
  const qTok = Object.values(questions).map(estTokens);
  const budget = Math.min(o.stateTokenBudget - Math.max(...qTok), o.requestTokenBudget - qTok.reduce((a, b) => a + b, 0));
  const root: Record<string, unknown> = { state: structuredClone(state) };
  const trimmed: string[] = [];
  let size = estTokens(root.state);
  for (let pass = 0; pass < MAX_TRIM_PASSES; pass++) {
    if (size <= budget) return { ok: true, state: root.state, trimmed };
    const found: Leaf[] = [];
    leaves(root.state, "", root, "state", found);
    const big = found.sort((a, b) => b.size - a.size)[0];
    if (!big) break; // nothing left that can be cut
    const h = big.holder as Record<string | number, unknown>;
    const v = h[big.key];
    if (big.kind === "string") {
      const base = String(v).endsWith(TRIM_MARK) ? String(v).slice(0, -TRIM_MARK.length) : String(v);
      h[big.key] = base.slice(0, Math.floor(base.length * 0.75)) + TRIM_MARK;
    } else {
      const arr = v as unknown[];
      arr.length = arr.length - Math.ceil(arr.length / 4);
    }
    const label = big.path || "(state)";
    if (!trimmed.includes(label)) trimmed.push(label);
    const after = estTokens(root.state);
    if (after >= size) break; // no progress: stop rather than loop
    size = after;
  }
  return { ok: false, reason: "over budget: state can't be trimmed to fit; split it into smaller items", estTokens: size, budget };
}

export async function askJev(input: AskJevInput, o: AskJevOptions = ASK_JEV_DEFAULTS) {
  const problems = validate(input.questions);
  if (problems.length) return { ok: false as const, problems };
  const questions = input.questions as Questions;
  const items = (input.items ?? [input.state]).slice(0, o.maxItems);
  const client = new TypeSafeClient({ defaultModel: o.model, timeout: o.timeoutMs, retry: { maxRetries: o.maxRetries } });

  const rows: Array<Record<string, unknown>> = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(o.concurrency, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      const raw = items[i];
      if (SECRET_LIKE.test(JSON.stringify(raw ?? null))) { rows[i] = { item: i, skipped: "secret-like text" }; continue; }
      const fit = trimState(raw, questions, o);
      if (!fit.ok) { rows[i] = { item: i, error: fit.reason, est_tokens: fit.estTokens, budget: fit.budget }; continue; }
      try {
        const { answers, model } = await client.systemOne({ state: fit.state as NonNullable<EntryType>, questions });
        rows[i] = { item: i, model, answers, ...(fit.trimmed.length ? { trimmed: fit.trimmed } : {}) };
      } catch (err) {
        rows[i] = { item: i, error: err instanceof Error ? err.name : String(err) }; // kept, never read as an answer
      }
    }
  }));

  // Per-question summaries so the agent reads a screenful, not every row. Only the first 20 rows
  // come back inline, plus a count of the rest; persist all `rows` to a file if the agent needs them.
  const ok = rows.filter((r) => r.answers) as Array<{ answers: Record<string, any> }>;
  const summary = Object.fromEntries(Object.entries(questions).map(([id, q]) => {
    const as = ok.map((r) => r.answers[id]);
    if (q.type === "noul") return [id, { yes: as.filter((a) => a.noul > 0.5).length, mean_p: mean(as.map((a) => a.noul)) }];
    if (q.type === "choice") return [id, { counts: count(as.map((a) => a.choice)), low_confidence: as.filter((a) => a.confidence < 0.5).length }];
    if (q.type === "score") return [id, { mean_score: mean(as.map((a) => a.score)) }];
    return [id, {}];
  }));
  return { ok: true as const, items: items.length, failed: rows.filter((r) => r.error).length,
    skipped: rows.filter((r) => r.skipped).length, summary, rows: rows.slice(0, 20), more_rows: Math.max(0, rows.length - 20) };
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const count = (xs: string[]) => xs.reduce<Record<string, number>>((m, x) => ((m[x] = (m[x] ?? 0) + 1), m), {});
