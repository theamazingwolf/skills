#!/usr/bin/env node
// calibrate.mjs — score Jev answers against human labels.
//
// Usage:
//   node calibrate.mjs <results.jsonl> [--json] [--question <id>]
//                      [--target 0.9] [--min-n 5]
//
// Input: one JSON object per line.
//   required  id, expected, answer
//   optional  question   group rows by check (one report per question id)
//             type       "noul" | "choice" | "score" | "box" (box rows are not scored)
//             confidence the vendor confidence (choice/score) or any 0–1 confidence
//             probability probability the model gave to `answer` (its top probability)
//             p_yes      raw Noul probability of yes (0–1); enables threshold sweep,
//                        AUROC and Brier; confidence/probability derive from it
//             score      fractional expected score (score type); enables MAE / bias
//             error      any non-empty value marks the row as a failed call
//             mock       true when produced by run-questions.mjs --mock
//   Numeric fields may be numbers or numeric strings; probabilities and
//   confidences outside [0, 1] stop the run with the offending line number.
//
// Prediction rules (keep them fixed between runs):
//   Noul yes iff p_yes > 0.5 · top probability max(p, 1-p) · confidence |2p-1|.
//   Noul labels true/false/yes/no/1/0/y/n (any case) normalise to "yes"/"no";
//   anything else on a noul row is an error. Choice and score labels are
//   compared trimmed and case-insensitively (a warning names merged spellings).
//
// Output: per question — n, accuracy with a 95% Wilson interval, majority
// baseline, macro-F1, confusion matrix, accuracy at cutoff for two candidate
// signals (confidence and top probability; which one to gate on is contested,
// so both are shown), ECE (10 equal-width bins over top probability), Noul
// threshold sweep, Score ordinal metrics, the most confident disagreements and
// suggestions. A suggestion only uses table rows with at least --min-n items;
// rows below that are marked "*" and the suggestion says when only they reach
// the target. Zero dependencies. Node >= 22. Exits 1 on bad input.

import { readFileSync, existsSync, statSync } from "node:fs";

const CUTOFFS = [0, 0.5, 0.6, 0.7, 0.8, 0.9, 0.95];
const SWEEP = [0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9];

function die(msg) {
  console.error(`calibrate: ${msg}`);
  process.exit(1);
}

// ---------- args ----------
const argv = process.argv.slice(2);
const opts = { json: false, question: null, target: 0.9, minN: 5, file: null };
const val = (i) => {
  const v = argv[i + 1];
  if (v === undefined || v.startsWith("--")) die(`${argv[i]} needs a value`);
  return v;
};
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--json") opts.json = true;
  else if (a === "--question") opts.question = val(i++);
  else if (a === "--target") opts.target = Number(val(i++));
  else if (a === "--min-n") opts.minN = Number(val(i++));
  else if (a === "-h" || a === "--help") {
    console.log("usage: node calibrate.mjs <results.jsonl> [--json] [--question <id>] [--target 0.9] [--min-n 5]");
    process.exit(0);
  } else if (a.startsWith("--")) die(`unknown flag ${a}`);
  else if (!opts.file) opts.file = a;
  else die(`unexpected argument ${a}`);
}
if (!opts.file) die("missing <results.jsonl> (see --help)");
if (!existsSync(opts.file) || !statSync(opts.file).isFile()) die(`no such file: ${opts.file}`);
if (!(opts.target > 0 && opts.target <= 1)) die("--target must be a number in (0, 1]");
if (!(Number.isInteger(opts.minN) && opts.minN >= 1)) die("--min-n must be a positive integer");

// ---------- read + validate ----------
const NOUL_YES = ["true", "yes", "1", "y"], NOUL_NO = ["false", "no", "0", "n"];
const TYPES = ["noul", "choice", "score", "box"];

function num(r, field, line, { unit = false } = {}) {
  const v = r[field];
  if (v === undefined || v === null || v === "") return null;
  const x = typeof v === "number" ? v : typeof v === "string" ? Number(v.trim()) : NaN;
  if (!Number.isFinite(x)) die(`line ${line}: "${field}" must be a number (got ${JSON.stringify(v)})`);
  if (unit && (x < 0 || x > 1)) die(`line ${line}: "${field}" must be in [0, 1] (got ${x})`);
  return x;
}

function label(v, type, field, line) {
  if (v === null || v === undefined || (typeof v === "string" && !v.trim())) return null;
  if (typeof v === "object") die(`line ${line}: "${field}" must be a string, number or boolean`);
  const s = String(v).trim();
  if (type === "noul" || typeof v === "boolean") {
    const l = s.toLowerCase();
    if (NOUL_YES.includes(l)) return "yes";
    if (NOUL_NO.includes(l)) return "no";
    if (type === "noul") die(`line ${line}: noul "${field}" must be yes/no or true/false (got ${JSON.stringify(v)})`);
  }
  return s;
}

const rows = [];
readFileSync(opts.file, "utf8").split("\n").forEach((text, i) => {
  if (!text.trim()) return;
  const line = i + 1;
  let r;
  try { r = JSON.parse(text); } catch { die(`line ${line}: not valid JSON`); }
  if (r === null || typeof r !== "object" || Array.isArray(r)) die(`line ${line}: expected a JSON object`);
  if (r.id === undefined || r.id === null) die(`line ${line}: missing "id"`);
  if (r.type !== undefined && !TYPES.includes(r.type)) die(`line ${line}: "type" must be one of ${TYPES.join(", ")}`);
  r._line = line;
  rows.push(r);
});
if (!rows.length) die("input has no rows");

// ---------- helpers ----------
const r3 = (x) => (x === null || x === undefined ? null : Math.round(x * 1000) / 1000);
const pct = (x) => (x === null || x === undefined ? "  n/a" : `${(x * 100).toFixed(1).padStart(5)}%`);

function wilson(k, n, z = 1.96) {
  if (!n) return [null, null];
  const p = k / n, d = 1 + (z * z) / n;
  const c = (p + (z * z) / (2 * n)) / d;
  const h = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return [Math.max(0, c - h), Math.min(1, c + h)];
}

function auroc(pos, neg) {
  if (!pos.length || !neg.length) return null;
  let wins = 0;
  for (const p of pos) for (const n of neg) wins += p > n ? 1 : p === n ? 0.5 : 0;
  return wins / (pos.length * neg.length);
}

// Accuracy at cutoff over one signal (conf or top).
function cutoffTable(items, key) {
  const has = items.filter((x) => x[key] !== null);
  if (!has.length) return null;
  return CUTOFFS.map((t) => {
    const kept = has.filter((x) => x[key] >= t);
    const k = kept.filter((x) => x.ok).length;
    return { cutoff: t, kept: kept.length, coverage: kept.length / has.length,
      accuracy: kept.length ? k / kept.length : null, below_min_n: kept.length < opts.minN };
  });
}

// Pick the first row (lowest cutoff) that reaches the target with enough items.
// When only rows below --min-n reach it, say so instead of claiming nothing does.
function suggest(table, sizeKey, metricKey, valueKey) {
  const reaching = table.filter((r) => r[metricKey] !== null && r[metricKey] >= opts.target);
  const pick = reaching.find((r) => r[sizeKey] >= opts.minN);
  if (pick) return { value: pick[valueKey], row: pick, status: "ok" };
  if (reaching.length) {
    const best = reaching.reduce((m, r) => (r[sizeKey] > m[sizeKey] ? r : m));
    return { value: null, row: best, status: "too_few",
      note: `reaches the target only on ${best[sizeKey]} item(s), below --min-n ${opts.minN}: label more examples before trusting a threshold` };
  }
  return { value: null, row: null, status: "none",
    note: "no row reaches the target: rework the question or state, or send everything to review" };
}

// ---------- per-question analysis ----------
function analyse(qid, all) {
  const type = all.find((r) => r.type)?.type ?? null;
  const out = { question: qid, type, rows: all.length, errors: 0, unlabelled: 0, warnings: [] };
  if (type === "box") { out.n = 0; out.warnings.push("box answers are regions, not labels: review them visually; this script does not score them."); return out; }
  const items = [];
  const spellings = new Map();
  const key = (s) => { const k = s.toLowerCase(); if (!spellings.has(k)) spellings.set(k, new Set()); spellings.get(k).add(s); return k; };
  for (const r of all) {
    if (r.error) { out.errors++; continue; }
    const pYes = num(r, "p_yes", r._line, { unit: true });
    const prob = num(r, "probability", r._line, { unit: true });
    const confIn = num(r, "confidence", r._line, { unit: true });
    const score = num(r, "score", r._line);
    const expRaw = label(r.expected, type, "expected", r._line);
    if (expRaw === null) { out.unlabelled++; continue; }
    let ansRaw = label(r.answer, type, "answer", r._line);
    if (ansRaw === null && pYes !== null) ansRaw = pYes > 0.5 ? "yes" : "no";
    if (ansRaw === null) { out.errors++; continue; }
    const exp = key(expRaw), ans = key(ansRaw);
    const top = prob !== null ? prob : pYes !== null ? Math.max(pYes, 1 - pYes) : null;
    const conf = confIn !== null ? confIn
      : pYes !== null ? Math.abs(2 * pYes - 1)
      : type === "noul" && top !== null ? Math.abs(2 * top - 1) : null;
    items.push({ id: r.id, exp, ans, ok: exp === ans, top, conf, pYes, score });
  }
  for (const [, set] of spellings) if (set.size > 1) out.warnings.push(`labels differing only in case were merged: ${[...set].map((s) => JSON.stringify(s)).join(", ")}`);
  const n = items.length;
  out.n = n;
  if (all.some((r) => r.mock)) out.warnings.push("MOCK rows present: these metrics describe fake answers, not Jev.");
  if (!n) { out.warnings.push("no scorable rows"); return out; }
  if (n < 30) out.warnings.push(`only ${n} labelled rows: treat every number as a rough indication, not a measurement.`);

  const correct = items.filter((x) => x.ok).length;
  out.accuracy = correct / n;
  out.accuracy_ci95 = wilson(correct, n);

  const expCounts = {};
  for (const x of items) expCounts[x.exp] = (expCounts[x.exp] ?? 0) + 1;
  const [majority, majN] = Object.entries(expCounts).sort((a, b) => b[1] - a[1])[0];
  out.baseline = { majority_label: majority, accuracy: majN / n };
  if (out.accuracy <= out.baseline.accuracy) out.warnings.push("accuracy does not beat always answering the majority label.");

  // confusion + macro-F1 (over classes present in the labels)
  const classes = [...new Set([...items.map((x) => x.exp), ...items.map((x) => x.ans)])].sort();
  const matrix = Object.fromEntries(classes.map((c) => [c, Object.fromEntries(classes.map((d) => [d, 0]))]));
  for (const x of items) matrix[x.exp][x.ans]++;
  out.classes = classes;
  out.confusion = matrix;
  const perClass = {};
  for (const c of Object.keys(expCounts)) {
    const tp = matrix[c][c];
    const fp = classes.reduce((s, e) => s + (e !== c ? matrix[e][c] : 0), 0);
    const fn = classes.reduce((s, a) => s + (a !== c ? matrix[c][a] : 0), 0);
    const p = tp + fp ? tp / (tp + fp) : 0, rc = tp + fn ? tp / (tp + fn) : 0;
    perClass[c] = { precision: p, recall: rc, f1: p + rc ? (2 * p * rc) / (p + rc) : 0, support: expCounts[c] };
  }
  out.per_class = perClass;
  out.macro_f1 = Object.values(perClass).reduce((s, v) => s + v.f1, 0) / Object.keys(perClass).length;

  // accuracy at cutoff: two candidate signals
  out.at_cutoff = cutoffTable(items, "conf");
  if (out.at_cutoff) out.suggested_cutoff = suggest(out.at_cutoff, "kept", "accuracy", "cutoff");
  else out.warnings.push("no confidence values: confidence cutoff table skipped.");
  if (type !== "noul") {
    out.at_top_probability = cutoffTable(items, "top");
    if (out.at_top_probability) out.suggested_top_probability = suggest(out.at_top_probability, "kept", "accuracy", "cutoff");
  }

  // ECE over top probability
  const withTop = items.filter((x) => x.top !== null);
  if (withTop.length) {
    const bins = Array.from({ length: 10 }, () => ({ n: 0, acc: 0, p: 0 }));
    for (const x of withTop) {
      const b = bins[Math.min(9, Math.floor(x.top * 10))];
      b.n++; b.acc += x.ok ? 1 : 0; b.p += x.top;
    }
    out.ece = bins.reduce((s, b) => s + (b.n ? (b.n / withTop.length) * Math.abs(b.acc / b.n - b.p / b.n) : 0), 0);
    out.reliability = bins.map((b, i) => ({ bin: `${i / 10}-${(i + 1) / 10}`, n: b.n,
      accuracy: b.n ? b.acc / b.n : null, mean_probability: b.n ? b.p / b.n : null })).filter((b) => b.n);
    if (withTop.length < 50) out.warnings.push(`ECE from ${withTop.length} rows: needs about 50+ labels before it means much.`);
  } else out.warnings.push("no probability values: ECE skipped.");

  // Noul extras from raw p_yes
  const nouls = items.filter((x) => x.pYes !== null);
  if (nouls.length) {
    const pos = nouls.filter((x) => x.exp === "yes").map((x) => x.pYes);
    const neg = nouls.filter((x) => x.exp === "no").map((x) => x.pYes);
    out.auroc = auroc(pos, neg);
    out.brier = nouls.reduce((s, x) => s + (x.pYes - (x.exp === "yes" ? 1 : 0)) ** 2, 0) / nouls.length;
    out.yes_threshold_sweep = SWEEP.map((t) => {
      const flagged = nouls.filter((x) => x.pYes >= t);
      const tp = flagged.filter((x) => x.exp === "yes").length;
      return { threshold: t, flagged: flagged.length,
        precision: flagged.length ? tp / flagged.length : null,
        catch_rate: pos.length ? tp / pos.length : null,
        false_alarm_rate: neg.length ? (flagged.length - tp) / neg.length : null,
        below_min_n: flagged.length < opts.minN };
    });
    out.suggested_yes_threshold = suggest(out.yes_threshold_sweep, "flagged", "precision", "threshold");
  }

  // Score ordinal metrics
  const ord = items.filter((x) => Number.isFinite(Number(x.exp)) && Number.isFinite(Number(x.ans)));
  if (type === "score" || (ord.length === n && items.some((x) => x.score !== null))) {
    out.score_within_one = ord.length ? ord.filter((x) => Math.abs(Number(x.ans) - Number(x.exp)) <= 1).length / ord.length : null;
    const sc = ord.filter((x) => x.score !== null);
    if (sc.length) {
      out.score_mae = sc.reduce((s, x) => s + Math.abs(x.score - Number(x.exp)), 0) / sc.length;
      out.score_mean_signed_error = sc.reduce((s, x) => s + (x.score - Number(x.exp)), 0) / sc.length;
    }
  }

  out.confident_disagreements = items.filter((x) => !x.ok)
    .sort((a, b) => (b.conf ?? -1) - (a.conf ?? -1)).slice(0, 10)
    .map((x) => ({ id: x.id, expected: x.exp, answer: x.ans, confidence: r3(x.conf) }));
  return out;
}

// ---------- group + run ----------
const groups = new Map();
for (const r of rows) {
  const q = r.question ?? "(all)";
  if (opts.question && q !== opts.question) continue;
  if (!groups.has(q)) groups.set(q, []);
  groups.get(q).push(r);
}
if (!groups.size) die(opts.question ? `no rows for question "${opts.question}"` : "no rows");
const reports = [...groups.entries()].map(([q, rs]) => analyse(q, rs));

if (opts.json) {
  console.log(JSON.stringify({ file: opts.file, target: opts.target, min_n: opts.minN, reports }, (k, v) =>
    typeof v === "number" ? r3(v) : v, 2));
  process.exit(0);
}

const star = (row, sizeKey) => (row[sizeKey] < opts.minN ? "*" : " ");
function printCutoffs(title, table) {
  console.log(`\n${title}:`);
  console.log("  cutoff   kept  coverage  accuracy");
  for (const c of table) console.log(`  ${c.cutoff.toFixed(2).padStart(6)} ${String(c.kept).padStart(5)}${star(c, "kept")}   ${pct(c.coverage)}    ${pct(c.accuracy)}`);
}
function printSuggestion(title, s, fmt) {
  const t = pct(opts.target).trim();
  if (s.status === "ok") console.log(`${title} (target ${t}): ${fmt(s.row)}`);
  else console.log(`${title} (target ${t}): none with enough items. ${s.note}`);
}

for (const r of reports) {
  console.log(`\n== ${r.question}${r.type ? ` (${r.type})` : ""} ==`);
  console.log(`rows ${r.rows} · scored ${r.n ?? 0} · failed calls ${r.errors} · unlabelled ${r.unlabelled}`);
  for (const w of r.warnings) console.log(`! ${w}`);
  if (!r.n) continue;
  console.log(`accuracy ${pct(r.accuracy)}  (95% CI ${pct(r.accuracy_ci95[0])} – ${pct(r.accuracy_ci95[1])})`);
  console.log(`baseline ${pct(r.baseline.accuracy)}  (always "${r.baseline.majority_label}")`);
  console.log(`macro-F1 ${r.macro_f1.toFixed(3)}`);
  const w = Math.max(8, ...r.classes.map((c) => c.length)) + 1;
  console.log(`\nconfusion (rows = human label, cols = Jev):`);
  console.log("".padEnd(w) + r.classes.map((c) => c.padStart(w)).join(""));
  for (const e of r.classes) console.log(e.padEnd(w) + r.classes.map((a) => String(r.confusion[e][a]).padStart(w)).join(""));
  if (r.at_cutoff) printCutoffs("accuracy at confidence cutoff (candidate signal 1)", r.at_cutoff);
  if (r.at_top_probability) printCutoffs("accuracy at top-probability cutoff (candidate signal 2)", r.at_top_probability);
  if (r.ece !== undefined) console.log(`\nECE ${r.ece.toFixed(3)} (10 bins over top probability)`);
  if (r.yes_threshold_sweep) {
    console.log(`\nNoul yes-threshold sweep:  AUROC ${r.auroc === null ? "n/a" : r.auroc.toFixed(3)} · Brier ${r.brier.toFixed(3)}`);
    console.log("  p_yes>=  flagged  precision  catch   false-alarm");
    for (const s of r.yes_threshold_sweep)
      console.log(`  ${s.threshold.toFixed(2).padStart(6)} ${String(s.flagged).padStart(7)}${star(s, "flagged")}   ${pct(s.precision)}  ${pct(s.catch_rate)}  ${pct(s.false_alarm_rate)}`);
  }
  if (r.score_within_one !== undefined) {
    console.log(`\nscore: within-one ${pct(r.score_within_one)}` +
      (r.score_mae !== undefined ? ` · MAE ${r.score_mae.toFixed(3)} · mean signed error ${r.score_mean_signed_error >= 0 ? "+" : ""}${r.score_mean_signed_error.toFixed(3)} (+ = Jev rates higher)` : ""));
  }
  if (r.confident_disagreements.length) {
    console.log(`\nmost confident disagreements (read these first):`);
    for (const d of r.confident_disagreements) console.log(`  ${String(d.id).padEnd(14)} human=${d.expected}  jev=${d.answer}  conf=${d.confidence ?? "n/a"}`);
  }
  console.log(`\n* = fewer than --min-n ${opts.minN} items; such rows never drive a suggestion.`);
  const cut = (row) => `${row.cutoff} → coverage ${pct(row.coverage).trim()}, accuracy ${pct(row.accuracy).trim()}; route the rest to review`;
  if (r.suggested_cutoff) printSuggestion("suggested confidence cutoff", r.suggested_cutoff, cut);
  if (r.suggested_top_probability) printSuggestion("suggested top-probability cutoff", r.suggested_top_probability, cut);
  if (r.suggested_cutoff && r.suggested_top_probability) console.log("(two candidates: whether to gate on confidence at all is contested; pick the signal whose table separates better)");
  if (r.suggested_yes_threshold) printSuggestion("suggested Noul yes-threshold (precision)", r.suggested_yes_threshold,
    (row) => `p_yes ≥ ${row.threshold} (precision ${pct(row.precision).trim()}, catch ${pct(row.catch_rate).trim()}, false alarms ${pct(row.false_alarm_rate).trim()})`);
}
console.log("");
