// batch-run.ts — run a fixed question set over a dataset (TypeSafe Jev, @typesafe-ai/sdk 0.7.x, Node >= 22).
//
// For offline screening or for scoring a labelled suite. Writes one row per
// (item, question) in the format the skill's scripts/calibrate.mjs reads, so the
// same run doubles as a calibration pass when items carry `expected` labels.
//
//   npx tsx batch-run.ts items.jsonl results.jsonl
//
// Failed items are kept as error rows (counted, never dropped, never read as "no").
// Everything placed in `state` is sent to TypeSafe.

import { createWriteStream, existsSync, readFileSync } from "node:fs";
import { TypeSafeClient, noul, choice, type ContentValue, type Questions } from "@typesafe-ai/sdk";

// ---- run parameters: explicit, logged with the results ---------------------------
export const RUN = {
  questionsVersion: "docs-routing@1",
  model: process.env.JEV_MODEL ?? "jev-1.14.0", // override to A/B a new version on an unchanged suite
  concurrency: 6,            // bounded; stay under your organisation's rate limit
  timeoutMs: 60000,          // per attempt; batch can afford a generous one
  retry: { maxRetries: 4, backoffInitialMs: 500, backoffMaxMs: 10000 }, // SDK retries 408/429/5xx and honours Retry-After
  pricePerMillionInput: 0.042, // USD, vendor models page accessed 2026-11-02; output tokens free; re-verify
};

// Example questions (document routing). Replace with your own.
export const QUESTIONS = {
  is_invoice: noul("Is `doc.text` an invoice or a bill asking for payment?"),
  department: choice("Which team should handle `doc.text`?", {
    finance: "Payments, invoices, expenses, tax",
    legal: "Contracts, terms, disputes, compliance notices",
    people: "Hiring, contracts of employment, leave, benefits",
    operations: "Suppliers, deliveries, facilities, IT",
  }),
} satisfies Questions;

type Item = { id: string; state: { [key: string]: ContentValue }; expected?: Record<string, unknown> };

async function main(inPath: string, outPath: string) {
  if (existsSync(outPath)) throw new Error(`refusing to overwrite ${outPath}`);
  const items: Item[] = readFileSync(inPath, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
  const client = new TypeSafeClient({ defaultModel: RUN.model, timeout: RUN.timeoutMs, retry: RUN.retry });
  const out = createWriteStream(outPath, { flags: "wx" });
  let next = 0, failed = 0, tokens = 0, unreported = 0;
  const served = new Set<string>();

  await Promise.all(Array.from({ length: Math.min(RUN.concurrency, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++];
      if (!item) break;
      const started = Date.now();
      try {
        const { answers, model, usage } = await client.systemOne({ state: item.state, questions: QUESTIONS });
        served.add(model);
        if (usage.input_tokens === null) unreported++; else tokens += usage.input_tokens; // usage can be null
        const meta = { model, spec_version: RUN.questionsVersion, latency_ms: Date.now() - started };
        const p = answers.is_invoice.noul;
        write(out, { id: item.id, question: "is_invoice", type: "noul", expected: item.expected?.is_invoice ?? null,
          answer: p > 0.5 ? "yes" : "no", p_yes: p, probability: Math.max(p, 1 - p), confidence: Math.abs(2 * p - 1), ...meta });
        const d = answers.department;
        write(out, { id: item.id, question: "department", type: "choice", expected: item.expected?.department ?? null,
          answer: d.choice, probability: d.probabilities[d.choice], confidence: d.confidence, probabilities: d.probabilities, ...meta });
      } catch (err) {
        failed++;
        const error = err instanceof Error ? err.name : String(err);
        for (const q of Object.keys(QUESTIONS)) write(out, { id: item.id, question: q, answer: null, error, spec_version: RUN.questionsVersion });
      }
    }
  }));
  await new Promise<void>((r) => out.end(r));
  console.error(JSON.stringify({ items: items.length, failed, served_models: [...served], input_tokens: tokens,
    tokens_unreported: unreported, cost_usd: (tokens * RUN.pricePerMillionInput) / 1e6, ...RUN }, null, 2));
}

function write(out: NodeJS.WritableStream, row: Record<string, unknown>) { out.write(JSON.stringify(row) + "\n"); }

const [, , inPath, outPath] = process.argv;
if (inPath && outPath) main(inPath, outPath).catch((e) => { console.error(e); process.exit(1); });
