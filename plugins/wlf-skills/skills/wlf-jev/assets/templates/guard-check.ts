// guard-check.ts — agent guard / review check starter (TypeSafe Jev, @typesafe-ai/sdk 0.7.x, Node >= 22).
//
// Screens an agent action (a shell command, tool call or outgoing message) before
// it runs. Order: human override -> code facts -> one Jev call (one Noul per risk)
// -> per-check code decision -> one trace line.
//
// This is a filter, not a security boundary: text inside the action can steer the
// answer. Real walls are credential and permission scoping. Start every check in
// "log" mode and promote to "block" one at a time after a replay over labelled
// history (scripts/calibrate.mjs in the skill).
//
// FAIL MODE IS DELIBERATELY REQUIRED. Whether an outage lets actions through
// (open) or stops them (closed) is a contested design choice that depends on what
// the guard protects. There is no default: the caller must pick one and say why.
//
// Everything placed in `state` is sent to TypeSafe. Secret-like text is withheld.

import { TypeSafeClient, noul, type NoulQuestion } from "@typesafe-ai/sdk";

export type CheckMode = "log" | "flag" | "block";

export interface GuardCheck {
  question: NoulQuestion;  // one risk, phrased so that high means "yes, risky"
  mode: CheckMode;
  threshold: number;       // UNCALIBRATED until chosen from a replay; vendor starting point for a yes is 0.7
  severity: number;        // ranks simultaneous hits; higher wins
}

export interface GuardConfig {
  policyVersion: string;
  model: string;           // a pinned, versioned id; re-run the replay before changing it
  failMode: "open" | "closed";
  failModeReason: string;  // recorded in every failure trace so reviewers see the decision
  timeoutMs: number;       // per attempt; hot-path hooks need a tight budget
  maxRetries: number;      // 0 is usual for a hook: each retry adds another timeout to the worst case
  checks: Record<string, GuardCheck>;
}

export interface Action { kind: string; text: string; cwd?: string; override?: { by: string; reason: string } }

export interface Verdict {
  outcome: "allow" | "flag" | "block";
  decidedBy: "override" | "facts" | "jev" | "fail-open" | "fail-closed";
  hits: string[];
  message?: string;        // steer toward a safer route rather than inviting a re-try in another form
  trace: Record<string, unknown>;
}

// Example checks. Replace with the risks your client actually cares about, and put
// the human-approved exceptions into the `false` criteria.
export const EXAMPLE_CHECKS: Record<string, GuardCheck> = {
  destroys_work: {
    question: noul("Would running `action.text` delete or overwrite files or data that are not easily recreated?", {
      false: "The action only reads, or only touches build output, caches or temporary files.",
    }),
    mode: "log", threshold: 0.8, severity: 3,
  },
  acts_outward: {
    question: noul("Does `action.text` send something to people or systems outside this workspace, such as a message, a deploy or a publish?"),
    mode: "log", threshold: 0.8, severity: 2,
  },
};

const SECRET_LIKE = /(sk-[A-Za-z0-9]{16,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----|ghp_[A-Za-z0-9]{20,})/;

export function createGuard(cfg: GuardConfig) {
  if (cfg.failMode !== "open" && cfg.failMode !== "closed") throw new Error("guard: failMode must be chosen explicitly");
  const client = new TypeSafeClient({ defaultModel: cfg.model }); // TYPESAFE_API_KEY from the environment
  const questions = Object.fromEntries(Object.entries(cfg.checks).map(([id, c]) => [id, c.question]));

  return async function check(action: Action, facts: Record<string, string | number | boolean> = {}): Promise<Verdict> {
    const trace: Record<string, unknown> = { policy: cfg.policyVersion, kind: action.kind };

    // 1. Human override: runs the action and is marked as not a precedent.
    if (action.override) return { outcome: "allow", decidedBy: "override", hits: [], trace: { ...trace, override: action.override, precedent: false } };

    // 2. Code facts settle what they can. Their verdicts win over Jev.
    if (SECRET_LIKE.test(action.text)) {
      return { outcome: "block", decidedBy: "facts", hits: ["secret_like_text"], trace: { ...trace, withheld: true },
        message: "This action contains what looks like a credential. Use the secret store or an environment variable instead." };
    }

    // 3. One Jev call, every check in parallel over the same state.
    const started = Date.now();
    try {
      const { answers, model, usage } = await client.systemOne(
        { state: { action: { kind: action.kind, text: action.text, cwd: action.cwd ?? null }, facts }, questions },
        { timeout: cfg.timeoutMs, retry: { maxRetries: cfg.maxRetries } },
      );
      const scores = Object.fromEntries(Object.entries(answers).map(([id, a]) => [id, a.noul]));
      Object.assign(trace, { model, scores, latency_ms: Date.now() - started, input_tokens: usage.input_tokens });

      // 4. Per-check decision; the most severe acting hit wins.
      const hits = Object.entries(cfg.checks)
        .filter(([id, c]) => (scores[id] ?? 0) >= c.threshold)
        .sort((a, b) => b[1].severity - a[1].severity);
      const acting = hits.filter(([, c]) => c.mode !== "log");
      const blocker = acting.find(([, c]) => c.mode === "block"); // most severe *block* check, not just the most severe hit
      const outcome = blocker ? "block" : acting.length ? "flag" : "allow";
      const verdict: Verdict = { outcome, decidedBy: "jev", hits: hits.map(([id]) => id),
        trace: { ...trace, logged_only: hits.filter(([, c]) => c.mode === "log").map(([id]) => id) } };
      if (blocker) verdict.message = `Blocked by ${blocker[0]}. Ask a human, or take a narrower, reversible step.`;
      return verdict;
    } catch (err) {
      // 5. A failure is an error, never an answer. Apply the chosen fail mode and say so.
      Object.assign(trace, { error: err instanceof Error ? err.name : String(err), latency_ms: Date.now() - started, fail_mode_reason: cfg.failModeReason });
      return cfg.failMode === "open"
        ? { outcome: "allow", decidedBy: "fail-open", hits: [], trace }
        : { outcome: "block", decidedBy: "fail-closed", hits: [], trace, message: "The safety check is unavailable, so this action is paused. Retry later or ask a human." };
    }
  };
}

// Usage:
// const guard = createGuard({ policyVersion: "guard@1", model: "jev-1.14.0", failMode: "open",
//   failModeReason: "advisory, log-only checks; stalling the agent costs more than a missed flag",
//   timeoutMs: 2500, maxRetries: 0, checks: EXAMPLE_CHECKS });
// const v = await guard({ kind: "shell", text: "rm -rf ./data" }, { inside_repo: true });
