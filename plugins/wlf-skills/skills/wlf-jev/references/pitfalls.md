# Jev pitfalls: what breaks in practice

Read this when results look wrong, or as a pre-ship review of a Jev
integration.

Sources (all accessed 2026-11-02 unless dated otherwise):
**[docs]** TypeSafe documentation, docs.typesafe.ai ·
**[jag]** the vendor's failure-mode page for jev-1.13 (last reviewed 2026-10-02; none for 1.14 as of 2026-11-02) ·
**[sdk]** `@typesafe-ai/sdk` 0.7.0 type declarations ·
**[vskill]** TypeSafe's own agent skill, github.com/typesafe-ai/skills (MIT, commit of 2026-10-23) ·
**[field]** anonymised practitioner runs on jev-1.13.0/1.14.0, October 2026, aggregates only ·
**[indep]** independent evaluations of jev-1.13.0, September–October 2026.

## Top ten

1. **Reading a failed call as "no".** A timeout is not a negative answer
   [docs].
2. **Treating `confidence` as P(correct).** It measures concentration; in
   field runs it didn't separate real from false hits [docs, field].
3. **Asking for the decision instead of the judgment.** One field run got
   the inverted answer on 7 of 10 items [field].
4. **Prose context in state.** Domain-heavy wording pushed answers toward
   yes [field].
5. **A generic catch-all option in a choice.** It beats the specific
   options [field].
6. **Riding `jev-latest` with tuned thresholds.** The alias moved to
   1.14.0 and absolute probabilities shifted [docs, field].
7. **One global threshold over many checks.** False alarms compound
   [field].
8. **Calibrating on agent-made labels.** In a blind review of 26
   disagreements, a human sided with Jev 10 times and with the agent's
   labels 11 times: the agent labels were no better than Jev [field].
9. **SDK default timeouts on a hot path.** 10 s per attempt plus retries,
   no total budget [sdk].
10. **Using a Jev check as a security boundary.** Text in the input can
    steer it; it's a filter [jag, field].

## Vendor-documented weak spots (jev-1.13)

| Failure mode | Symptom | Workaround |
|---|---|---|
| Literal reading | answers the words, not the intent | state the exact condition; boundary cases in criteria |
| Counting, maths, numeric formats | wrong tallies; hex or RGB judged poorly | arithmetic in code; turn numbers into named buckets |
| Reading a score as a measurement | fractional score treated as exact | use it as a position or threshold |
| Date comparison | ordering and windows unreliable | extract date parts (a choice with "not stated"); compare in code |
| Indirection | multi-hop or double-negative questions fail | ask directly; name the field |
| Large irrelevant state | accuracy falls with noise | filter in code, or with a relevance noul first |
| Adversarial content | injected or argumentative text moves answers | explicit criteria; test edge cases; never a boundary |
| Contradictory instructions and criteria | confused answers; inverted nouls worse | align criteria with the question; high = yes |
| Option order | leans toward the first option | shuffle and check stability |
| Generation | slow and poor | code finds candidates; a choice picks |

All rows from [jag]. There is no equivalent page for jev-1.14 yet, so
re-test these on 1.14 rather than assuming they still hold or are fixed.

## Design pitfalls

- **Box and choice always answer**, even when nothing fits. Pair them
  with a presence noul [docs, vskill]. A low-confidence independent
  finding: with no correct option on offer, Jev picked one confidently
  [indep].
- **Bare or positional labels** (`A`, `option_1`) mis-route and can bias
  [docs, indep].
- **A noul used as a degree scale.** 0.5 is "unsure", not "medium" [docs].
- **Compound questions.** An "and"/"or" muddles the probability [docs].
- **Score levels written as adjectives or relative steps.** Each level is
  judged alone [docs].
- **Saturated or over-broad checks.** A field effort score sat at the top
  level almost always; a "large context" noul fired on 67% of tasks. The
  fix was narrowing plus code corroboration [field].
- **Fuzzy content judgments** over-fire and resist rewording; prefer
  observable form [field].
- **Wrong unit size.** Some checks are noisy per paragraph and sane per
  section [field].
- **Splitting when evidence is missing** amplified a bias; add the context
  first [field].
- **State hygiene.** An empty list or an irrelevant field can sway other
  questions [docs].
- **Prompt gymnastics** [vskill]: criteria naming test items, a clause per
  failing case, thresholds fitted to cases, tests asserting exact
  probabilities, code silently overriding answers.

## Operational pitfalls

- `debug` logging writes request bodies, which may hold client data [sdk].
- `usage` token counts can be `null`; cost math must cope [sdk].
- Choice options are input tokens; 255 long descriptions cost tokens
  [docs].
- One bad image fails the whole request; images aren't resized [docs].
- Image or box requests without the images header get a 400 [docs].
- Raw HTTP requires `model`; only the SDK defaults it [docs].
- The long-context header is slower and less accurate; prefer splitting
  into items [docs].
- Identical calls can flip a label or straddle 0.5 near a threshold
  [docs, field].
- Old installs of the vendor skill (0.5.7) don't know about box, and a
  docs page it links (`migrating-to-v1`) now returns 404 [docs].
- Older notes elsewhere may still say aliases point to 1.13, list fixed
  public rate limits, or give a Node floor below 22. All are superseded as
  of 2026-11-02.

## Contested: never state these as settled

| Question | Positions (as of 2026-11-02) |
|---|---|
| Gate actions on `confidence`? | Vendor docs present confidence-gated routing; the vendor skill says confidence is "rarely the gate" [docs, vskill]. Decide per check from its cutoff table. |
| "Nothing fits" in a choice | Docs: an `other` option or a companion noul. Vendor skill: the companion noul usually works better as of 1.14 [docs, vskill]. Test both. |
| Fail-open vs fail-closed on outage | Depends on the use case: a field guard fails open and a field router blocks only at a hard floor [field]; the opposite published position pauses risky tool use while the check is down. The client chooses and records why. |
| Probability clamping | Independent reports: noul rounded to 0.01 and clamped to 0.01–0.98; a vendor example shows 0.99 on 1.13 [indep, docs]. |
| Score minimum levels | 2 per docs and SDK; 1 per the raw OpenAPI schema [docs, sdk]. Use ≥ 2. |
| Vendor speed and cost multiples | From the vendor's in-house workflows; independent results match frontier models on some tasks and trail on others [docs, indep]. |

## Pre-ship review

- [ ] Each question is one judgment, high = yes, pointing at a named field
- [ ] Facts in code or named fields; no prose context; no secrets in state
- [ ] Choice options described, pruned by code, null case tested both ways
- [ ] Score levels are situations, one dimension, not saturated
- [ ] Calibrated on human labels; n, interval and label source reported
- [ ] Per-check thresholds plus a review band; model pinned and logged
- [ ] Timeouts and retries explicit; failures surfaced as errors
- [ ] Fail mode chosen deliberately and written down
- [ ] Shadow or log-only first; promotion criteria agreed
