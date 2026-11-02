# Jev patterns: the four primitives, reading answers, composing them

Read this when you are choosing a primitive, decomposing a request into
questions, or reading answers in code.

Sources (all accessed 2026-11-02 unless dated otherwise):
**[docs]** TypeSafe documentation, docs.typesafe.ai ·
**[sdk]** `@typesafe-ai/sdk` 0.7.0 type declarations (npm) ·
**[vskill]** TypeSafe's own agent skill, github.com/typesafe-ai/skills (MIT, commit of 2026-10-23) ·
**[field]** anonymised practitioner runs on jev-1.13.0/1.14.0, October 2026, aggregates only ·
**[indep]** independent evaluations of jev-1.13.0 (Vals AI, 2026-10-06; beri.net, 2026-09-20).

## TL;DR

- Choose by the shape of the answer your code needs. An `if` needs a
  **noul**; a `switch` over known, unordered options needs a **choice**; a
  position on described, ordered levels needs a **score**; "where in this
  image" needs a **box** (opt-in, prototype-grade) [docs].
- Every question in a request sees the same `state` and is answered
  independently and in parallel. No answer is context for another [docs].
- Answers are always typed and always inside your options. Typed is not the
  same as right [docs].
- Jev makes judgments. Your code makes decisions [docs, vskill].

## The primitives (as of 2026-11-02)

| Type | Asks | You send | You get back | Limits |
|---|---|---|---|---|
| `noul` | Is this true? | `instructions`; optional `criteria: {true, false}` | `noul`: P(yes), 0–1. **No `confidence` field** | — |
| `choice` | Which one? | `instructions`; `criteria: {label: description or null}` | `choice` (always one of your labels), `probabilities` (sum to 1), `confidence` | 1–255 options |
| `score` | Which level? | `instructions`; `criteria: [level0, level1, …]`, low to high | `score` (Σ level × probability, can be fractional), `legend`, `probabilities` by level, `confidence` | up to 10 levels; minimum **contested** (below) |
| `box` | Where in the image? | `instructions` only | `box {top, bottom, left, right}` as 0–1 fractions from the top-left; `confidence` (`number` or `null`) | needs the images opt-in header and jev-1.14 |

All from [docs] and [sdk]. Notes:

- **Score minimum is contested.** The docs and the SDK require at least two
  levels; the raw OpenAPI schema accepts one [docs, sdk]. Use two or more:
  the SDK rejects fewer before sending.
- **Box is not production-ready.** It needs the header
  `TypeSafe-Danger-Zone-Images: true`, runs on jev-1.14.0 only, and the SDK
  comments still say to use `jev-preview` for it (which currently resolves
  to 1.14.0) [docs, sdk]. Images must be PNG or JPEG stills, at most 16 MiB,
  280–1568 px per side; they are never resized, and one bad image fails the
  whole request [docs].
- **Question IDs are not sent to the model.** Put the whole meaning in
  `instructions`. Choice labels and their descriptions *are* sent [docs].
- Instructions and criteria can be strings, objects or arrays; field names
  inside objects are yours [docs].
- In TypeScript, the builders `noul`, `choice`, `score` and `box` return
  plain `{type, instructions, criteria}` objects, and the answer types are
  inferred from them: `answers.topic.choice` is typed as your label union
  [sdk].

## Which primitive? (decision flow)

1. Is the input an image and the question "where"? → **box**, and pair it
   with a presence noul. Otherwise continue.
2. Can more than one label be true at once? → **one noul per label**.
3. Does code branch on yes/no? → **noul**.
4. Are the outcomes ordered (severity, fit, quality, urgency) and can you
   describe each level as a situation? → **score**.
5. Are the outcomes a fixed set of unordered categories? → **choice**.
6. Is the answer a number, count, date comparison, lookup or generated
   text? → **not Jev**. Do it in code; at most, let a choice pick among
   candidates code found [docs].

## Reading answers

- **Noul.** The probability is both the answer and its uncertainty: near
  0.5 means the state doesn't settle the question. It is not a degree
  scale; use a score for degree. If you want a confidence-style number,
  the vendor proxy is `|2p − 1|` [docs].
- **Choice.** `confidence = (p_max − 1/n) / (1 − 1/n)`; only the top
  probability counts. Alternatives worth testing: the top probability
  itself (threshold per question) and the top-to-second ratio [docs].
- **Score.** The same `score` can come from very different distributions,
  and a two-peaked answer can average out to the middle. Read
  `probabilities` too. Confidence is distance-aware [docs]. Don't treat
  the fractional score as a measured quantity; use it as a position or
  threshold [docs].
- **Box.** It always returns a box, even when the target isn't there. The
  vendor has no recommended confidence threshold yet [docs].
- **All types.** `confidence` describes how concentrated the distribution
  is. It is **not** the probability of being right [docs]. Calibrate it.

## Composition

| Pattern | How | Source |
|---|---|---|
| Speculative fan-out | Put every question that might be needed for this state in one request; code reads only what it needs. | [docs, vskill] |
| Multi-label | One noul per label. A choice forces the probability to split between labels that are both true. | [vskill] |
| Composite scoring | One score (or noul) per factor; normalise each score as `score / (levels − 1)`; weight in code. | [docs] |
| Truth table | Jev supplies the inputs; code maps each combination (including "noul in the review band") to an action. | [docs, vskill] |
| Presence + locate/pick | Pair a box or choice with a noul asking whether anything fits; ignore the box/choice when the noul is low. | [docs, vskill] |
| Hierarchy / big taxonomy | Chain choices level by level across requests, keeping the top few paths, because answers can't see each other. | [docs] |
| Select, don't generate | Code finds candidates (regex, parser); a choice picks one; code normalises it. | [docs] |
| Screen → confirm | Jev flags cheaply; an agent or human reads only the flagged items. | [field] |
| Learned combiner | Use the probabilities as features for a small model fitted on labels. | [indep] |

Send a **second request** only when code needs one answer to build the next
state or option list, when a field measurably misleads another question,
or when question sets need separate versioning [vskill].

## Decomposing a request into questions

- **"Tag these with any of A, B, C"** → three nouls, one per tag.
- **"Route this to one of N teams"** → one choice with described options,
  plus (optionally) a presence noul "does any team fit?".
- **"Grade this against our rubric"** → one score per rubric criterion
  whose levels you can describe as situations; one noul per pass/fail
  criterion. Combine in code with weights you can defend. If a criterion
  needs evidence the state doesn't contain, add that evidence before you
  split; splitting a rating whose evidence is missing made the bias worse
  in a field run [field].
- **"Is this phishing / risky / spam?"** → several narrow, observable
  signals rather than one verdict. In an independent study, one broad
  question scored 62.6% while five narrow signals plus a fitted logistic
  regression scored 95.0% [indep].
- **"Should we escalate?"** → don't ask that. Ask the judgments behind it
  ("does the customer sound frustrated?", "is money being lost?") and let
  code decide [docs, field].

## The confidence plan (write it down with the design)

For every question, state before you calibrate:

1. **What code does with the answer** (branch, route, rank, flag).
2. **The read rule**: noul yes if p > 0.5 (or a tuned threshold); choice
   argmax; score modal level or expected score.
3. **The uncertainty signal you will test**: noul p itself or `|2p−1|`;
   choice `confidence`, top probability or top-to-second ratio; score
   `confidence` plus a look at `probabilities`.
4. **The review band**: what happens to unsure items (a human, a stronger
   model, a default). Vendor starting points for a noul are yes at 0.7,
   no at 0.3, review between [docs]; they are starting points only.
5. **The cost of each error type**, which decides how high the bar is.

## Request budget (as of 2026-11-02)

- No limit on the number of questions per request [docs].
- Default context on jev-1.13.0 and jev-1.14.0: state plus all questions
  ≤ 64k tokens; state plus any one question ≤ 32k tokens [docs].
- The header `TypeSafe-Danger-Zone-Long-Context: true` raises both to
  262k tokens at the same per-token price, but it is slower and less
  accurate; split the work instead when you can [docs].
- Over-length requests fail with HTTP 400 `max_tokens_exceeded` [docs].
