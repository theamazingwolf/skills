---
name: wlf-jev
description: >-
  Design, code, calibrate and run TypeSafe Jev questions in a client's
  codebase. Picks the primitive (noul yes/no probability, choice one-of-N,
  score on ordered rubric levels, box image region), writes the wording,
  options, levels and state, calibrates against a small human-labelled set
  (agreement, confusion matrix, accuracy at confidence cutoff, ECE,
  thresholds), and wires it in as an ask-Jev agent tool, in-app classifier,
  agent guard check or batch run. Ships calibration and question-runner
  scripts with an offline mock mode, TypeScript starters and a visual
  explainer. Use when someone says "classify X with Jev", "add a Jev
  check", "write a Jev question", "use TypeSafe", "route these with Jev",
  "is my Jev question scoring right", or wants a cheap typed judgment
  inside code. NOT for looking up TypeSafe API facts, pricing or docs on
  their own (use the vendor typesafe-ai skill or the live docs), and NOT
  for generating text.
capabilities: [file-access, web-access]
cluster: orchestration
---

# WLF Jev

Jev (TypeSafe's typed-judgment model) answers narrow questions about one
`state` with a typed, probability-carrying answer. This skill turns a
person's intent into Jev questions, code that calls them, and a
calibration report that says how far to trust them. **In:** what the
client wants judged, optionally a rubric or policy, and a human willing to
label 10–30 examples. **Out:** a question spec, working TypeScript in
their repo, and a calibration report. **The trust rule:** Jev makes
judgments and code makes decisions, and no threshold ships without
agreement measured against human labels, reported with its sample size.

## Setup

- **`${CLIENT_ROOT}`** is the client project the code goes into. Resolve
  it: an explicit path in the ask, then a `CLIENT_ROOT` environment
  variable, then the workspace you were invoked in if it is clearly that
  project. If not, ask. Never guess.
- **Runtime:** Node ≥ 22 (SDK 0.7.0 requires it, as of 2026-11-02).
- **SDK:** `@typesafe-ai/sdk`, installed in `${CLIENT_ROOT}`.
- **Key:** `TYPESAFE_API_KEY` in the environment or a git-ignored `.env`.
  Check that it is set; never print, log or commit its value.
- **Scripts** run from this skill's folder and take the client's files as
  arguments: `scripts/run-questions.mjs`, `scripts/calibrate.mjs`
  (zero-dependency Node; `--help` on each).
- **Data leaves the building.** Whatever goes into `state`, `instructions`
  or `criteria` is sent to TypeSafe. Keep secrets out, and confirm the
  client is fine with a third-party processor seeing the data.

## Procedure

Work out which mode the ask needs. Most real requests run 3 → 4 → 5, with
1 first if the project has never called Jev.

| # | Mode | When | Read at this step, not before |
|---|---|---|---|
| 1 | Set up | first use in a project; errors about key, Node or SDK | [references/setup.md](references/setup.md) |
| 2 | Explain | a human wants to see how Jev works | open `assets/jev-patterns.html` |
| 3 | Design a question | "classify / check / score / route X" | [references/patterns.md](references/patterns.md), then [references/question-design.md](references/question-design.md) |
| 4 | Calibrate | a question exists; "is it right?"; before any threshold ships | [references/calibration.md](references/calibration.md) |
| 5 | Integrate | write the calling code | [references/integration-shapes.md](references/integration-shapes.md) |
| 6 | Run at scale | a dataset or corpus to process | [references/integration-shapes.md](references/integration-shapes.md) (batch) |
| — | Something looks wrong; pre-ship review | any time | [references/pitfalls.md](references/pitfalls.md) |
| — | "Is this number still true?" | before quoting a price, limit or model | [references/freshness-manifest.md](references/freshness-manifest.md) |

### 1. Set up

Check Node, the SDK and the key, in that order, and report what you found.
Install the SDK if it's missing. Help the human put the key in the
environment or `.env` (check `.gitignore` first) without echoing it. Then
make one smoke call with a trivial noul and show the served model id and
the answer. No key yet? Continue in mock mode (Degradation) and say so.

### 2. Explain

Open `assets/jev-patterns.html` in a browser for the human (it is
self-contained and works offline). It shows what goes in and comes out of
each primitive, examples across domains, and a "which primitive?" flow.
Then answer their questions from the references, not from memory.

### 3. Design a question

From the intent, plus any rubric or policy the human pastes:

1. **Find the judgments behind the decision.** If the ask is "should we
   escalate?", the questions are the observable judgments that decision
   rests on; the decision itself becomes a code truth table.
2. **Choose the primitive per judgment** and **decompose**: several
   labels that can co-occur → one noul each; a rubric → one score per
   criterion you can describe in levels, one noul per pass/fail line.
3. **Write each question**: one judgment, high means yes, pointing at a
   named state field; options described and pruned by code; levels as
   situations.
4. **Design the state**: named fields, only what a person would need,
   facts as fields not prose.
5. **Write the confidence plan**: what code does with each answer, the
   read rule, the uncertainty signal to test, the review band, the cost
   of each error.
6. **Save the spec** as JSON in the client repo (format in
   `scripts/run-questions.mjs --help`), versioned.

Show the human the spec and the plan before writing integration code. The
null-case choice for options ("other" vs a companion noul) is contested;
build both and let calibration pick.

### 4. Calibrate

Agree with the human what a wrong yes and a wrong no each cost. Have them
judge 10–30 real examples (you assemble the items; they give the labels).
Then:

```
node scripts/run-questions.mjs --client-root "${CLIENT_ROOT}" \
  --spec "${CLIENT_ROOT}/jev/spec.json" --data "${CLIENT_ROOT}/jev/items.jsonl" \
  --out "${CLIENT_ROOT}/jev/results.jsonl"
node scripts/calibrate.mjs "${CLIENT_ROOT}/jev/results.jsonl" [--target 0.9]
```

Walk the most confident disagreements with the human, change one thing at
a time, bump the spec version, rerun. Pick thresholds from the
accuracy-at-cutoff table, keep a review band, pin the model version.
Report n, the interval, the label source and the served model. Whether to
gate on `confidence` at all is contested; let this check's numbers decide.
With fewer than 30 labels, call the result indicative. With 50–300 it
starts to support a production threshold.

### 5. Integrate

Pick the shape with the client, copy its starter from `assets/templates/`
into `${CLIENT_ROOT}`, and adapt it:

| Shape | Starter | Use for |
|---|---|---|
| Ask-Jev agent tool | `ask-jev-tool.ts` | an agent screening many items with its own questions |
| In-app classifier / router | `classifier.ts` | routing tickets, requests, documents, tasks |
| Agent guard / review check | `guard-check.ts` | screening an agent's actions before they run |
| Batch run | `batch-run.ts` | a corpus, or a labelled suite |

Every starter keeps timeouts, retries and thresholds as explicit
parameters. **Fail-open versus fail-closed is contested.** The guard
starter requires the client to choose and record why. Don't pick it for
them silently; lay out the trade-off and let them decide. Ship in shadow
or log-only mode first. Type-check the result in their project.

### 6. Run at scale

Estimate before running:
`node scripts/run-questions.mjs --spec … --data … --estimate` gives the
item count, estimated tokens (chars/4 heuristic), items over the context
limits, and cost at $0.042 per million input tokens (as of 2026-11-02;
output free). Plan latency from the tail (field p95 ≈ 0.22 s per call,
October 2026), not the median, and keep concurrency under the
organisation's rate limit. Failed items stay as error rows. Report the
served model, failures, tokens and actual cost.

## Boundaries

- **API facts on their own** ("what's Jev's rate limit?", "which models
  exist?"): the vendor `typesafe-ai` skill, or the live docs at
  docs.typesafe.ai, owns API truth. This skill owns design, integration
  and calibration craft, and re-checks its own facts via the freshness
  manifest.
- **Generating text, extracting values, counting, dates, lookups:** not
  Jev's job. Do it in code or with a general LLM; at most a choice picks
  among candidates code found.
- **Security boundaries:** a Jev check is a filter that input text can
  steer. Hard walls are credential and permission scoping, outside this
  skill.
- **Production use of box or images:** the vendor labels them not
  production-ready (2026-11-02). Prototype only, and say so.
- **Researching TypeSafe as a vendor** (market, comparisons): a research
  task, not this skill.

## Degradation

- **Vendor `typesafe-ai` skill absent or stale:** fetch the live docs
  (`https://docs.typesafe.ai/llms.txt`, then the page you need) when web
  access is available. Otherwise use the references here and mark any
  quoted fact "as of 2026-11-02, not re-verified".
- **No web access:** the references carry everything needed to design,
  integrate and calibrate. Quote volatile facts with their dates.
- **Node < 22 or no SDK:** call the HTTP endpoint directly per
  [references/setup.md](references/setup.md) (raw HTTP section, with its
  self-review checklist). `model` becomes mandatory.
- **No key:** run `run-questions.mjs --mock` for offline design, spec
  validation, pipeline tests and cost estimates. Mock answers are
  deterministic fakes. Any metric computed on them is labelled
  `MOCK — not Jev`, and nothing ships on mock numbers.
- **No human labels:** you may still design, integrate and run, but every
  threshold is a vendor starting point, and the report says
  `calibration: unvalidated — no human labels`. Never substitute your own
  labels for the human's: agent-made labels proved unreliable in field
  review.
- **No durable file access** (chat-only surfaces): deliver the spec, code
  and calibration report as files the human saves into their repo, or
  into a connected drive. A design that evaporates with the chat was a
  conversation, not a deliverable. If nothing durable is reachable, say
  the work wasn't persisted.
