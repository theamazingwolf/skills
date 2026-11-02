// classifier.ts — in-app classifier / router starter (TypeSafe Jev, @typesafe-ai/sdk 0.7.x, Node >= 22).
//
// Shape: facts in code -> one batched Jev call -> code decision -> trace.
// Jev judges the input; your code picks the action. Hard rules stay in code and
// Jev can never clear them. Roll out shadow -> fill -> act.
//
// Replace the example questions (support-ticket triage) with your own, and replace
// every threshold marked UNCALIBRATED with one chosen from your labelled set
// (scripts/calibrate.mjs in the skill). Keep questions and thresholds in this one
// module and bump QUESTIONS_VERSION on any edit.
//
// Everything placed in `state` is sent to TypeSafe. Don't put secrets or data the
// client hasn't approved for a third-party processor in it.

import { TypeSafeClient, APIError, APIConnectionError, choice, noul, score } from "@typesafe-ai/sdk";

// ---- 1. Questions: one reviewable, versioned module --------------------------------
export const QUESTIONS_VERSION = "triage@1";
export const MODEL = "jev-1.14.0"; // pin a versioned id once thresholds are tuned; re-calibrate on any change

export const QUESTIONS = {
  wants_human: noul("Does the customer in `message.body` ask to speak with a person?", {
    false: "The customer only describes a problem or asks a question and never asks for a person, a call or an agent.",
  }),
  topic: choice("What is `message.body` mainly about?", {
    billing: "Charges, invoices, refunds, payment methods",
    technical: "Something in the product is broken, slow or erroring",
    account: "Login, password, access, team members, settings",
      other: "A request that isn't billing, a product fault or account access, such as a feature idea",
  }),
  // The "nothing fits" case is CONTESTED: an `other` option (above) or a companion noul like this one.
  // The vendor's own skill says the companion noul usually works better as of jev-1.14; the docs offer
  // both. Keep both while calibrating, then delete the loser. Keep `other` specific, never "anything else".
  topic_fits: noul("Is `message.body` about billing, a product fault, or account access?"),
  urgency: score("How urgent is the situation described in `message.body`?", [
    "A question or suggestion; nothing is blocked",
    "Inconvenient, but a workaround exists",
    "Work is blocked for this customer with no workaround",
    "Money is being lost, data is at risk, or many users are blocked",
  ]),
} as const;

// ---- 2. Thresholds and policy: explicit parameters, not hidden defaults ------------
export interface ClassifierOptions {
  mode: "shadow" | "fill" | "act"; // shadow: trace Jev's pick, never act on it · fill: act only where no current choice exists · act: decide
  timeoutMs: number;               // per attempt; the SDK has no total budget, so keep this tight on a hot path
  maxRetries: number;              // 0–1 on a request path; each retry adds another timeout to the worst-case wait
  topicMinProbability: number;     // UNCALIBRATED: below this, treat the topic as unknown
  humanYes: number;                // UNCALIBRATED: p(yes) at or above this counts as asking for a person
  urgentFrom: number;              // UNCALIBRATED: expected-score at or above this counts as urgent
  topicFitsYes: number;            // UNCALIBRATED: below this p(yes), no queue fits and the fallback is used
  fallbackQueue: Queue;            // used when Jev fails or is unsure; a failure is an error, never an answer
}

export const DEFAULTS: ClassifierOptions = {
  mode: "shadow", timeoutMs: 3000, maxRetries: 1,
  topicMinProbability: 0.6, humanYes: 0.7, urgentFrom: 2, topicFitsYes: 0.5, fallbackQueue: "general",
};

export type Queue = "billing" | "technical" | "account" | "general" | "priority" | "human";

export interface Ticket { id: string; subject: string; body: string; plan: string; legalHold: boolean }

export interface Decision {
  queue: Queue;
  decidedBy: "rule" | "jev" | "fallback" | "current"; // current = the existing choice was kept
  trace: Record<string, unknown>;
}

const client = new TypeSafeClient({ defaultModel: MODEL }); // key from TYPESAFE_API_KEY, server side only

export async function classify(t: Ticket, current: Queue | null, opts: ClassifierOptions = DEFAULTS): Promise<Decision> {
  const trace: Record<string, unknown> = { ticket: t.id, version: QUESTIONS_VERSION, mode: opts.mode };

  // Hard rule in code: Jev can add caution but never clears this.
  if (t.legalHold) return { queue: "human", decidedBy: "rule", trace: { ...trace, rule: "legal_hold" } };

  const started = Date.now();
  try {
    const { answers, model, usage } = await client.systemOne(
      {
        // Facts go in named fields; only what a person would look at to answer.
        state: { message: { subject: t.subject, body: t.body }, customer_plan: t.plan },
        questions: QUESTIONS,
      },
      { timeout: opts.timeoutMs, retry: { maxRetries: opts.maxRetries } },
    );
    Object.assign(trace, {
      model, latency_ms: Date.now() - started, input_tokens: usage.input_tokens,
      wants_human: answers.wants_human.noul,
      topic: answers.topic.choice, topic_p: answers.topic.probabilities[answers.topic.choice], topic_fits: answers.topic_fits.noul,
      urgency: answers.urgency.score, urgency_probs: answers.urgency.probabilities,
    });

    // Code decision: a small truth table over judgments.
    let queue: Queue;
    if (answers.wants_human.noul >= opts.humanYes) queue = "human";
    else if (answers.urgency.score >= opts.urgentFrom) queue = "priority";
    else if (answers.topic_fits.noul < opts.topicFitsYes || answers.topic.choice === "other" ||
      answers.topic.probabilities[answers.topic.choice] < opts.topicMinProbability) queue = opts.fallbackQueue;
    else queue = answers.topic.choice;

    return applyMode(queue, current, opts, "jev", trace);
  } catch (err) {
    // Surface the failure; never read it as "no". Then apply the fallback deliberately.
    trace.error = err instanceof APIError ? `${err.name} ${err.status} (request ${err.requestId ?? "n/a"})`
      : err instanceof APIConnectionError ? err.name : String(err);
    trace.latency_ms = Date.now() - started;
    return applyMode(opts.fallbackQueue, current, opts, "fallback", trace);
  }
}

function applyMode(proposed: Queue, current: Queue | null, opts: ClassifierOptions, by: Decision["decidedBy"], trace: Record<string, unknown>): Decision {
  trace.proposed = proposed;
  trace.proposed_by = by;
  // shadow: Jev's pick is traced only; keep the existing choice, or the fallback when there is none.
  if (opts.mode === "shadow") return current
    ? { queue: current, decidedBy: "current", trace: { ...trace, shadow: true } }
    : { queue: opts.fallbackQueue, decidedBy: "fallback", trace: { ...trace, shadow: true } };
  // fill: act only where nothing was chosen yet.
  if (opts.mode === "fill" && current) return { queue: current, decidedBy: "current", trace };
  return { queue: proposed, decidedBy: by, trace };
}
