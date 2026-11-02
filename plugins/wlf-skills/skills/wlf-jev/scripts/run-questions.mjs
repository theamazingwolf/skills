#!/usr/bin/env node
// run-questions.mjs — run a Jev question spec over a labelled dataset and
// write one result row per (item, question), ready for calibrate.mjs.
//
// Usage:
//   node run-questions.mjs --spec <spec.json> --data <items.jsonl> --out <results.jsonl>
//        [--mock] [--estimate] [--client-root <dir>] [--env-file <path>]
//        [--model <id>] [--concurrency 4] [--timeout-ms 10000] [--retries 2]
//        [--limit N] [--price-per-m 0.042] [--force]
//
// Modes:
//   (default)   live: calls TypeSafe through @typesafe-ai/sdk resolved from the
//               client project (--client-root, else $CLIENT_ROOT, else cwd).
//               Needs TYPESAFE_API_KEY in the environment (or --env-file). The key
//               is never printed.
//   --mock      deterministic fake answers: no key, no network, no SDK. Answers
//               lean toward the expected label so every metric path is exercised.
//               Rows carry mock:true and calibrate.mjs flags them. Never report
//               mock metrics as Jev's accuracy.
//   --estimate  no calls: prints item count, estimated input tokens (chars/4,
//               a heuristic, not the vendor tokenizer), limit warnings and cost.
//
// Spec (JSON):
//   { "name": "support-triage", "version": "3",        // version goes into every row
//     "model": "jev-1.14.0",                           // pin a versioned id once tuned
//     "headers": { },                                  // e.g. the images opt-in header
//     "state_fields": ["subject", "body"],             // optional: keep only these keys
//     "notes": "...",                                  // optional, ignored: design notes
//     "questions": { "<id>": { "type": "noul"|"choice"|"score"|"box",
//                              "instructions": ..., "criteria": ... } } }
//   Questions use the API's own shape (what the SDK builders noul/choice/score/box
//   produce): noul criteria {true?, false?}; choice criteria {label: description|null};
//   score criteria [level0, level1, ...] low to high; box has no criteria.
// Dataset (JSONL): { "id": "...", "state": {...} | "text", "expected": { "<qid>": label },
//                    "image": "relative/path.png" (optional; box/image questions only) }
//
// Zero dependencies (live mode imports the client's SDK). Node >= 22.

import { readFileSync, existsSync, createWriteStream, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve, isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";

const PRICE_PER_M_DEFAULT = 0.042; // USD per million input tokens, vendor models page, accessed 2026-11-02
const LIMIT_REQUEST = 64000, LIMIT_QUESTION = 32000; // default context limits, accessed 2026-11-02
const IMAGES_HEADER = "TypeSafe-Danger-Zone-Images";

function die(msg) { console.error(`run-questions: ${msg}`); process.exit(1); }
const warn = (msg) => console.error(`run-questions: warning: ${msg}`);

const major = Number(process.versions.node.split(".")[0]);
if (major < 22) die(`Node >= 22 required (found ${process.versions.node}); the SDK 0.7.0 needs it too`);

// ---------- args ----------
const argv = process.argv.slice(2);
const o = { mock: false, estimate: false, force: false, concurrency: 4, timeoutMs: 10000, retries: 2,
  limit: Infinity, pricePerM: PRICE_PER_M_DEFAULT };
const take = (i) => { const v = argv[i + 1]; if (v === undefined || v.startsWith("--")) die(`${argv[i]} needs a value`); return v; };
const numArg = (i) => { const v = take(i); const x = Number(v); if (v.trim() === "" || !Number.isFinite(x)) die(`${argv[i]} must be a number (got ${JSON.stringify(v)})`); return x; };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  switch (a) {
    case "--spec": o.spec = take(i); i++; break;
    case "--data": o.data = take(i); i++; break;
    case "--out": o.out = take(i); i++; break;
    case "--client-root": o.clientRoot = take(i); i++; break;
    case "--env-file": o.envFile = take(i); i++; break;
    case "--model": o.model = take(i); i++; break;
    case "--concurrency": o.concurrency = numArg(i); i++; break;
    case "--timeout-ms": o.timeoutMs = numArg(i); i++; break;
    case "--retries": o.retries = numArg(i); i++; break;
    case "--limit": o.limit = numArg(i); i++; break;
    case "--price-per-m": o.pricePerM = numArg(i); i++; break;
    case "--mock": o.mock = true; break;
    case "--estimate": o.estimate = true; break;
    case "--force": o.force = true; break;
    case "-h": case "--help":
      console.log(readFileSync(new URL(import.meta.url), "utf8").split("\n").slice(1, 34).map((l) => l.replace(/^\/\/ ?/, "")).join("\n"));
      process.exit(0);
    default: die(`unknown argument ${a} (see --help)`);
  }
}
if (!o.spec || !o.data) die("--spec and --data are required");
if (!o.estimate && !o.out) die("--out is required (except with --estimate)");
if (!(Number.isInteger(o.concurrency) && o.concurrency >= 1 && o.concurrency <= 16)) die("--concurrency must be 1–16");
if (!(o.timeoutMs > 0)) die("--timeout-ms must be positive");
if (!(Number.isInteger(o.retries) && o.retries >= 0)) die("--retries must be a non-negative integer");
if (o.limit !== Infinity && !(Number.isInteger(o.limit) && o.limit >= 1)) die("--limit must be a positive integer");
if (!(o.pricePerM >= 0)) die("--price-per-m must be a non-negative number");

// ---------- load spec + data ----------
const readJson = (p, what) => {
  if (!existsSync(p)) die(`${what} not found: ${p}`);
  let v;
  try { v = JSON.parse(readFileSync(p, "utf8")); } catch (e) { die(`${what} is not valid JSON: ${e.message}`); }
  if (v === null || typeof v !== "object" || Array.isArray(v)) die(`${what} must be a JSON object`);
  return v;
};
const spec = readJson(o.spec, "spec");
const model = o.model ?? spec.model ?? null;
const headers = spec.headers ?? {};
const version = `${spec.name ?? "spec"}@${spec.version ?? "unversioned"}`;
const questions = spec.questions;
if (!questions || typeof questions !== "object" || Array.isArray(questions) || !Object.keys(questions).length) die("spec.questions must be a non-empty object");
if (typeof headers !== "object" || headers === null || Array.isArray(headers)) die("spec.headers must be an object of strings");
if (spec.state_fields !== undefined && !(Array.isArray(spec.state_fields) && spec.state_fields.every((k) => typeof k === "string"))) die("spec.state_fields must be an array of strings");

for (const [id, q] of Object.entries(questions)) {
  const where = `question "${id}"`;
  if (!/^[a-z][a-z0-9_]*$/.test(id)) warn(`${where}: prefer snake_case ids (ids are for your code; they are not sent to the model)`);
  if (!q || typeof q !== "object") die(`${where}: must be an object`);
  if (q.type === "noul") {
    if (!q.instructions && !(q.criteria && (q.criteria.true || q.criteria.false))) die(`${where}: noul needs instructions or a described outcome`);
  } else if (q.type === "choice") {
    const n = q.criteria && typeof q.criteria === "object" && !Array.isArray(q.criteria) ? Object.keys(q.criteria).length : 0;
    if (n < 1 || n > 255) die(`${where}: choice criteria must be an object with 1–255 labels (got ${n})`);
    if (n === 1) warn(`${where}: a one-option choice always picks it; is a noul what you meant?`);
    if (Object.keys(q.criteria).some((k) => /^(option_?\d+|[A-Z])$/.test(k))) warn(`${where}: positional option names give the model nothing; use descriptive labels`);
  } else if (q.type === "score") {
    if (!Array.isArray(q.criteria) || q.criteria.length < 2 || q.criteria.length > 10) die(`${where}: score criteria must be an array of 2–10 levels, low to high`);
  } else if (q.type === "box") {
    if (q.criteria !== undefined) die(`${where}: box takes no criteria`);
    if (headers[IMAGES_HEADER] !== "true" && !o.mock && !o.estimate) die(`${where}: box needs spec.headers["${IMAGES_HEADER}"] = "true" (opt-in, not production-ready)`);
  } else die(`${where}: type must be noul, choice, score or box`);
}

if (!existsSync(o.data)) die(`dataset not found: ${o.data}`);
const dataDir = dirname(resolve(o.data));
const items = [];
readFileSync(o.data, "utf8").split("\n").forEach((line, i) => {
  if (!line.trim()) return;
  let r;
  try { r = JSON.parse(line); } catch { die(`dataset line ${i + 1}: not valid JSON`); }
  if (r === null || typeof r !== "object" || Array.isArray(r)) die(`dataset line ${i + 1}: expected a JSON object`);
  if (r.id === undefined || r.id === null) die(`dataset line ${i + 1}: missing "id"`);
  if (r.state === undefined || r.state === null) die(`dataset line ${i + 1}: missing "state"`);
  if (r.expected !== undefined && r.expected !== null && (typeof r.expected !== "object" || Array.isArray(r.expected))) die(`dataset line ${i + 1}: "expected" must be an object keyed by question id`);
  items.push(r);
});
if (!items.length) die("dataset has no rows");
const work = items.slice(0, o.limit);

// Labels that can't match any answer would silently count as disagreements: say so up front.
const NOUL_LABELS = ["true", "false", "yes", "no", "1", "0", "y", "n"];
for (const [id, q] of Object.entries(questions)) {
  let bad = 0, sample = null, unknownKeys = 0;
  for (const it of work) {
    const exp = it.expected?.[id];
    if (exp === undefined || exp === null) continue;
    const ok = q.type === "noul" ? NOUL_LABELS.includes(String(exp).trim().toLowerCase())
      : q.type === "choice" ? Object.keys(q.criteria).some((l) => l.toLowerCase() === String(exp).trim().toLowerCase())
      : q.type === "score" ? Number.isInteger(Number(exp)) && Number(exp) >= 0 && Number(exp) < q.criteria.length
      : true;
    if (!ok) { bad++; sample ??= exp; }
  }
  if (bad) warn(`question "${id}": ${bad} expected label(s) don't fit its ${q.type} (e.g. ${JSON.stringify(sample)}); fix the labels before calibrating (calibrate.mjs rejects or mis-scores them)`);
  for (const it of work) if (it.expected) for (const k of Object.keys(it.expected)) if (!(k in questions)) unknownKeys++;
  if (unknownKeys && id === Object.keys(questions)[0]) warn(`${unknownKeys} expected label(s) name question ids not in the spec; they are ignored`);
}

function buildState(item) {
  let s = item.state;
  if (Array.isArray(spec.state_fields) && s && typeof s === "object" && !Array.isArray(s)) {
    s = Object.fromEntries(spec.state_fields.filter((k) => k in s).map((k) => [k, s[k]]));
  }
  return s;
}

// ---------- estimate ----------
const est = (x) => Math.ceil(JSON.stringify(x).length / 4);
const qTokens = Object.fromEntries(Object.entries(questions).map(([k, q]) => [k, est(q)]));
const allQ = Object.values(qTokens).reduce((a, b) => a + b, 0), maxQ = Math.max(...Object.values(qTokens));
let totalTokens = 0, overLimit = 0;
for (const it of work) {
  const s = est(buildState(it));
  totalTokens += s + allQ;
  if (s + allQ > LIMIT_REQUEST || s + maxQ > LIMIT_QUESTION) overLimit++;
}
if (overLimit) warn(`${overLimit} item(s) look over the default context limits (64k per request / 32k per state+question, chars/4 estimate); trim state or split the questions`);
if (o.estimate) {
  console.log(JSON.stringify({ spec: version, items: work.length, questions: Object.keys(questions).length,
    est_input_tokens: totalTokens, est_cost_usd: +(totalTokens * o.pricePerM / 1e6).toFixed(6),
    price_per_million_input_usd: o.pricePerM, price_basis: "vendor models page, accessed 2026-11-02; output tokens free; re-verify",
    items_over_limit: overLimit, token_estimate: "chars/4 heuristic, not the vendor tokenizer" }, null, 2));
  process.exit(0);
}

// ---------- output (refuse overwrite) ----------
if (existsSync(o.out) && !o.force) die(`refusing to overwrite ${o.out} (pass --force)`);
if (existsSync(o.out) && statSync(o.out).isDirectory()) die(`--out is a directory: ${o.out}`);
{ const d = dirname(resolve(o.out)); if (!existsSync(d) || !statSync(d).isDirectory()) die(`output directory does not exist: ${d}`); }
const outStream = createWriteStream(o.out, { flags: o.force ? "w" : "wx" });
outStream.on("error", (e) => die(`cannot write ${o.out}: ${e.message}`));

// ---------- mock ----------
function rng(seed) { // FNV-1a hash -> mulberry32 stream
  let h = 2166136261;
  for (const c of seed) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); }
  return () => {
    h = (h + 0x6d2b79f5) | 0;
    let t = Math.imul(h ^ (h >>> 15), 1 | h);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const yes = (v) => ["true", "yes", "1", "y"].includes(String(v).toLowerCase());
function spread(n, target, r) {
  const top = 0.5 + 0.45 * r();
  const w = Array.from({ length: n }, (_, i) => (i === target ? 0 : 0.1 + r()));
  const sw = w.reduce((a, b) => a + b, 0) || 1;
  return w.map((x, i) => (i === target ? top : ((1 - top) * x) / sw));
}
function mockAnswer(item, id, q) {
  const r = rng(`${item.id}|${id}|${version}`);
  const exp = item.expected?.[id];
  const lean = exp !== undefined && exp !== null && r() < 0.75;
  if (q.type === "noul") {
    const wantYes = lean ? yes(exp) : r() < 0.5;
    const p = wantYes ? 0.55 + 0.44 * r() : 0.01 + 0.44 * r();
    return { type: "noul", noul: +p.toFixed(2) };
  }
  if (q.type === "choice") {
    const labels = Object.keys(q.criteria);
    let t = lean ? labels.indexOf(String(exp)) : -1;
    if (t < 0) t = Math.floor(r() * labels.length);
    const p = spread(labels.length, t, r);
    const n = labels.length, pmax = Math.max(...p);
    return { type: "choice", choice: labels[t], confidence: n > 1 ? (pmax - 1 / n) / (1 - 1 / n) : 1,
      probabilities: Object.fromEntries(labels.map((l, i) => [l, +p[i].toFixed(4)])) };
  }
  if (q.type === "score") {
    const n = q.criteria.length;
    let t = lean && Number.isInteger(Number(exp)) && Number(exp) >= 0 && Number(exp) < n ? Number(exp) : Math.floor(r() * n);
    const p = spread(n, t, r), pmax = Math.max(...p);
    return { type: "score", score: p.reduce((s, x, i) => s + i * x, 0), confidence: (pmax - 1 / n) / (1 - 1 / n),
      probabilities: Object.fromEntries(p.map((x, i) => [String(i), +x.toFixed(4)])) };
  }
  const top = r() * 0.6, left = r() * 0.6;
  return { type: "box", box: { top, bottom: top + 0.1 + r() * 0.3, left, right: left + 0.1 + r() * 0.3 }, confidence: r() };
}

// ---------- live client ----------
let sdk = null, client = null;
if (!o.mock) {
  if (o.envFile) {
    try { process.loadEnvFile(o.envFile); } catch (e) { die(`could not load --env-file: ${e.message}`); }
  }
  if (!process.env.TYPESAFE_API_KEY?.trim()) die("TYPESAFE_API_KEY is not set (set it in the environment or pass --env-file; never paste it into chat or code). Use --mock to run offline.");
  const root = resolve(o.clientRoot ?? process.env.CLIENT_ROOT ?? process.cwd());
  if (!existsSync(root) || !statSync(root).isDirectory()) die(`client root is not a directory: ${root}`);
  let entry;
  try {
    const req = createRequire(join(root, "noop.js"));
    const pkgPath = req.resolve("@typesafe-ai/sdk/package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    const rel = pkg.exports?.["."]?.import?.default ?? pkg.module ?? pkg.main;
    entry = join(dirname(pkgPath), rel);
    console.error(`run-questions: using @typesafe-ai/sdk ${pkg.version} from ${root}`);
  } catch {
    die(`@typesafe-ai/sdk not found from ${root}. Install it there (npm i @typesafe-ai/sdk), point --client-root at the project, or use --mock`);
  }
  sdk = await import(pathToFileURL(entry).href);
  client = new sdk.TypeSafeClient({ timeout: o.timeoutMs, retry: { maxRetries: o.retries }, ...(model ? { defaultModel: model } : {}) });
}

async function stateFor(item) {
  const s = buildState(item);
  if (!item.image || o.mock) return s;
  const p = isAbsolute(item.image) ? item.image : join(dataDir, item.image);
  if (!existsSync(p)) throw new Error(`image not found: ${item.image}`);
  const img = sdk.image(readFileSync(p));
  return s && typeof s === "object" && !Array.isArray(s) ? { ...s, image: img } : { text: s, image: img };
}

// ---------- normalise one answer into a calibrate row ----------
function rowFor(item, id, q, a, meta) {
  const base = { id: item.id, question: id, type: q.type, expected: item.expected?.[id] ?? null, ...meta };
  if (a.type === "noul") {
    const p = a.noul;
    return { ...base, answer: p > 0.5 ? "yes" : "no", p_yes: p, probability: Math.max(p, 1 - p), confidence: Math.abs(2 * p - 1) };
  }
  if (a.type === "choice") {
    return { ...base, answer: a.choice, probability: a.probabilities?.[a.choice] ?? null, confidence: a.confidence, probabilities: a.probabilities };
  }
  if (a.type === "score") {
    const entries = Object.entries(a.probabilities ?? {}).map(([k, v]) => [Number(k), v]);
    const [mode, pm] = entries.reduce((m, e) => (e[1] > m[1] ? e : m), [null, -1]);
    return { ...base, answer: mode, score: a.score, probability: pm >= 0 ? pm : null, confidence: a.confidence, probabilities: a.probabilities };
  }
  return { ...base, answer: null, box: a.box, confidence: a.confidence ?? null };
}

// ---------- run ----------
const lat = [];
let done = 0, failed = 0, inTok = 0, inTokNull = 0;
const servedModels = new Set();

async function runItem(item) {
  const t0 = performance.now();
  try {
    let res;
    if (o.mock) {
      res = { model: "mock", usage: { input_tokens: null, output_tokens: null },
        answers: Object.fromEntries(Object.entries(questions).map(([id, q]) => [id, mockAnswer(item, id, q)])) };
    } else {
      const req = { state: await stateFor(item), questions, ...(model ? { model } : {}) };
      res = await client.systemOne(req, { timeout: o.timeoutMs, retry: { maxRetries: o.retries }, headers });
    }
    const ms = Math.round(performance.now() - t0);
    lat.push(ms);
    servedModels.add(res.model);
    if (res.usage?.input_tokens == null) inTokNull++; else inTok += res.usage.input_tokens;
    const meta = { model: res.model, spec_version: version, latency_ms: ms, ...(o.mock ? { mock: true } : {}) };
    const built = Object.entries(questions).map(([id, q]) => {
      const a = res.answers?.[id];
      if (!a || a.type !== q.type) throw new Error(`response has no ${q.type} answer for "${id}"`);
      return JSON.stringify(rowFor(item, id, q, a, meta)) + "\n";
    });
    for (const line of built) outStream.write(line); // all rows or none for this item
  } catch (e) {
    failed++;
    const err = `${e?.name ?? "Error"}${e?.status ? ` ${e.status}` : ""}: ${e?.message ?? String(e)}`;
    for (const [id, q] of Object.entries(questions)) {
      outStream.write(JSON.stringify({ id: item.id, question: id, type: q.type, expected: item.expected?.[id] ?? null,
        answer: null, error: err, spec_version: version, ...(e?.requestId ? { request_id: e.requestId } : {}) }) + "\n");
    }
  }
  done++;
  if (done % 25 === 0) console.error(`run-questions: ${done}/${work.length}`);
}

let next = 0;
await Promise.all(Array.from({ length: Math.min(o.concurrency, work.length) }, async () => {
  while (next < work.length) await runItem(work[next++]);
}));
await new Promise((r) => outStream.end(r));

lat.sort((a, b) => a - b);
const q = (p) => (lat.length ? lat[Math.min(lat.length - 1, Math.floor(p * lat.length))] : null);
console.error(JSON.stringify({ mode: o.mock ? "mock" : "live", spec: version, items: work.length, failed,
  served_models: [...servedModels], latency_ms: { p50: q(0.5), p95: q(0.95) },
  input_tokens: o.mock ? null : inTok, input_tokens_unreported: o.mock ? null : inTokNull,
  cost_usd: o.mock ? null : +(inTok * o.pricePerM / 1e6).toFixed(6), out: o.out }, null, 2));
if (failed) console.error(`run-questions: ${failed} item(s) failed; they are error rows in ${o.out}, not answers`);
