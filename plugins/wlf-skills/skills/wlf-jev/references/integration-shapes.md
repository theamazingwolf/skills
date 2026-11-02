# Jev integration shapes: agent tool, in-app classifier, guard check, batch run

Read this when you are writing the code that calls Jev in a client's
project. Each shape has a typed starter in the skill's `assets/templates/`
folder (`ask-jev-tool.ts`, `classifier.ts`, `guard-check.ts`,
`batch-run.ts`); copy one into the client repo and adapt it.

Sources (all accessed 2026-11-02 unless dated otherwise):
**[docs]** TypeSafe documentation, docs.typesafe.ai ·
**[sdk]** `@typesafe-ai/sdk` 0.7.0 type declarations (npm) ·
**[vskill]** TypeSafe's own agent skill, github.com/typesafe-ai/skills (MIT, commit of 2026-10-23) ·
**[field]** design decisions from anonymised practitioner components and runs, jev-1.13.0/1.14.0, October 2026.

## TL;DR

- Every shape is: **facts in code → one batched Jev call → code decision →
  trace**. Code owns control flow, rules and side effects [docs].
- **A failed call is an error, never an answer.** A timeout is not "no"
  [docs]. Then apply a failure policy you chose on purpose (below).
- **Set timeouts explicitly.** SDK defaults are 10 s per attempt, 2
  retries and no total budget, so one call can run past 30 s before it
  rejects [sdk].
- **Trace** the served `model`, the answers, the questions/policy version,
  latency and input tokens on every call. Pin a versioned model [docs].
- **Ship in shadow or log-only mode first**, then promote after
  calibration [field].

## Shared client discipline

- **Server side only.** The SDK refuses browser use unless
  `dangerouslyAllowBrowser` is set; don't set it [sdk].
- **No debug logging over client data.** `TYPESAFE_LOG_LEVEL=debug` logs
  request bodies; credential headers are redacted, bodies aren't [sdk].
- **Per-call options**: `timeout`, `retry`, `headers`, `signal`.
  `.withResponse()` returns the `requestId` for vendor support [sdk].
- **Errors** reject the promise: `BadRequestError` 400,
  `AuthenticationError` 401, `PermissionDeniedError` 403,
  `NotFoundError` 404, `UnprocessableEntityError` 422, `RateLimitError`
  429 (with `retryAfterMs`), `InternalServerError` 5xx (529 overload
  included), `APIConnectionError`, `APITimeoutError` (a kind of connection
  error), `APIUserAbortError`. Every `APIError` carries `status`, `body`
  and `requestId` [sdk].
- **What leaves the building.** Everything in `state`, `instructions` and
  `criteria` is sent to TypeSafe. Detect and withhold secret-like text
  [field]. The vendor says it doesn't train on customer requests; zero
  data retention is enterprise-only (vendor, 2026-11-02) [docs]. Get the
  client's data-policy approval before sending their data.
- **One source of truth.** Keep questions, criteria and thresholds in one
  versioned module and record the version in traces [vskill].
- **Usage can be null.** `usage.input_tokens` may be `null`; guard cost
  math [sdk].

## Failure policy: fail-open vs fail-closed (CONTESTED)

There is no settled answer; it depends on what the check protects, and
the client must choose per integration and write the reason down.

- A field guard over agent shell commands **fails open**: on error,
  timeout or missing key it allows the action and traces why, because
  stalling the agent costs more than a missed advisory flag [field].
- The opposite published position is to **pause** (fail-closed) a
  tool-risk gate while its classifier is down, so nothing risky runs
  unchecked.
- A field router **falls back** to a safe default for ordinary work but
  **blocks** when no option satisfies a hard floor [field].

Working rule, not a law: advisory, log-only and routing-with-a-safe-default
checks lean open; hard gates on irreversible or outward actions lean
closed. The `guard-check.ts` starter makes `failMode` a required
parameter with no default, plus a `failModeReason` that lands in traces.

## Timeouts and retries

| Shape | Starting values (tune them) | Why |
|---|---|---|
| Hot-path hook / guard | 2–3 s, 0 retries | a field guard used 2.5 s and no retry [field] |
| In-app request path | ~3 s, 0–1 retries | user-facing latency; fall back on failure |
| Agent tool | ~20 s, 0 retries | the agent can re-ask [field] |
| Batch | ~60 s, several retries with backoff | throughput over latency [field] |

The SDK retries 408, 429 and 5xx plus connection errors and timeouts,
backing off from 500 ms to 5 s with jitter and honouring `Retry-After` up
to 60 s; the timeout applies **per attempt** [sdk]. Worst case ≈
(retries + 1) × timeout + backoff. Use an `AbortSignal` when you need a
hard total budget.

## Shape 1: ask-Jev agent tool

The agent writes its own questions and runs them over a state, a list of
items, or files it has read. Good for cheap screening over many items.

- **Validate before sending**: snake_case ids, real instructions that
  point at backticked fields, choice 2–255 options, score 2–10 levels
  [field].
- **Budget the state**: trim to the smaller of (32k − largest question)
  and (64k − all questions), cutting the biggest string or array anywhere
  in the state (nested fields included), and report what was cut. If a
  pass makes no progress, return a per-item "over budget" error; never
  loop or send an oversize request. The chars/4 token estimate is a heuristic, not the
  vendor tokenizer [field, docs].
- **Bounded concurrency** (around 8), per-item errors kept, secret-like
  items skipped and reported [field].
- **Return a screenful**: per-question summaries (noul yes-count and mean,
  choice counts and low-confidence count, score mean), the first rows
  inline and a count of the rest; persist the full rows to a file when
  the agent needs them [field].
- **Tell the agent**: one narrow judgment per question; facts in named
  fields; answers are a screen, read flagged items before acting [field].

## Shape 2: in-app classifier / router

Route tickets, requests, documents or tasks.

- **Jev judges; code chooses.** Ask "what kind of task is this?", then
  pick the handler or model in code from availability and quota [field].
- **Facts in named state fields**, never prose [field].
- **Hard rules stay in code.** Jev may add caution, never clear a rule
  (a legal hold always goes to a human) [field].
- **Corroborate fuzzy flags with code.** A "needs large context" noul
  alone fired on 67% of tasks; requiring a code-side estimate as well cut
  that sharply [field].
- **Roll out** shadow (trace Jev's pick beside the current one) → fill
  (act only where nothing was chosen) → act. Review shadow disagreements
  before promoting [field].
- **Confidence gating is CONTESTED.** The vendor docs present
  confidence-gated routing with a floor and risk-scaled thresholds; the
  vendor's own skill says confidence is "rarely the gate" [docs, vskill].
  Don't gate on it until calibration shows it separates right from wrong
  for this check.

## Shape 3: agent guard / review check

Screen agent actions (commands, tool calls, outgoing messages) for risk.

1. **Override first.** A human override runs the action and is traced as
   not a precedent.
2. **Code facts** settle what they can (paths, flags, branch state,
   secret patterns). Their verdicts win over Jev.
3. **One Jev call**, one noul per risk; the `false` criteria carry the
   exceptions humans approved.
4. **Per-check decision.** Each check has a mode (log / flag / block) and
   its own threshold. A field policy blocked at ≥ 0.8 on four checks and
   flagged at ≥ 0.5 on two; ties go to the most severe [field].
5. **Trace**: answers, served model, policy version, latency, tokens,
   and who decided (override, facts, Jev, fail mode) [field].

- Default every check to **log-only**; promote one at a time after a
  replay over labelled history [field].
- It's **a filter, not a security boundary**: text in the action can
  steer it. Real walls are credential and permission scoping [field, docs].
- Block messages should point at a safer route, not invite the same
  action in another form [field].
- Moving jev-1.13 → 1.14 kept the ranking but moved some items across 0.5;
  re-run the replay before switching versions [field].
- **Review variant** (Jev double-checking other reviewers): in a field run
  its flags were right about two-thirds of the time and caught about half
  the misratings. Good as a cheap review queue, not as a gate [field].

## Shape 4: batch run

Process a corpus, or score a labelled suite for calibration.

- Bounded concurrency (around 6); retry 429, 5xx/529 and network errors
  with capped backoff and jitter, honouring `retry-after`; generous
  timeout (~60 s) [field].
- **Failed items stay as error rows**, counted, never dropped [field].
- Record the served model and tokens per item; write results, metrics and
  a disagreement list sorted by confidence [field].
- **A/B a new model** by overriding the model on an unchanged suite
  [field].
- **Cost** = input tokens × price; output is free (vendor, 2026-11-02:
  $0.042 per million input tokens) [docs]. Field batches cost cents: 236
  items for about $0.007–0.015 [field].
- **Screen → confirm.** A 23-check sweep over code chunks was too noisy
  on its own; feeding its flags to a reviewer agent that read only the
  flagged chunks worked [field].

## Latency planning (dated)

- Vendor: most calls complete in about 100 ms [docs].
- Independent (jev-1.13.0, October 2026): about 0.1 s whether 1 or 32
  judgments per request.
- Field (jev-1.13.0, October 2026): p50 ≈ 0.15–0.16 s, p95 ≈ 0.21–0.22 s
  for multi-question requests; a live router hook took 228 ms [field].
- Budget for the tail and for retries, not the median.
- The vendor's headline speed and cost multiples versus frontier models
  come from its own in-house workflows and are **contested**: independent
  results match frontier models on some tasks and trail on others.
