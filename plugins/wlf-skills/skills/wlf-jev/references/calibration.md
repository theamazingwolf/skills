# Calibrating Jev checks with a human

Read this when a question is designed and you need to know whether it
agrees with people, and where to set its thresholds.

Sources (all accessed 2026-11-02 unless dated otherwise):
**[docs]** TypeSafe documentation and cookbooks, docs.typesafe.ai ·
**[field]** anonymised practitioner runs on jev-1.13.0/1.14.0, October 2026, aggregates only ·
**[indep]** independent evaluation guidance (Vals AI, 2026-10-06; beri.net, 2026-09-20).

## TL;DR

- **No labels, no threshold.** Thresholds come from items a human judged,
  never from the vendor's `confidence` alone [docs, field].
- **Confidence measures concentration, not correctness** [docs]. In field
  runs it lifted accuracy only from 30% to 41% at ≥ 0.8, and it failed to
  separate real from false hits on a code sweep, even where ranking (AUROC)
  was strong [field].
- **Per-check thresholds** from an accuracy-at-coverage table and the cost
  of each error [field].
- **Pin the model** and re-run the suite on any model or alias change.
  1.13 → 1.14 kept the ranking but moved probabilities across thresholds
  [field].
- **Say how sure you are.** Report n, the interval, and whether the labels
  came from a human.

## The loop

1. **Agree the target.** Ask the human what the check is for, what a
   wrong "yes" costs and what a wrong "no" costs. That sets the accuracy
   or precision bar.
2. **Build the labelled set together** (below). The human judges; you
   don't.
3. **Run** the questions over the set:
   `node scripts/run-questions.mjs --client-root <project> --spec <project>/jev/spec.json --data <project>/jev/items.jsonl --out <project>/jev/results.jsonl`
   (keep client data in the client project, never in the skill folder)
   (add `--mock` to rehearse offline; mock numbers mean nothing).
4. **Score**: `node scripts/calibrate.mjs results.jsonl`
   (`--target 0.9` sets the bar; `--json` for machine output).
5. **Read the disagreements first**, most confident first, with the human.
   Decide for each: the label was wrong, the state was missing something,
   or the question was worded badly.
6. **Change one thing** (state, wording, options, levels), bump the spec
   version, rerun. Stop when agreement clears the bar on items you didn't
   tune on, or when rewording stops helping (then redesign or decompose).
7. **Pick thresholds**, freeze the question, and record the calibration
   report beside the code.

## 1. The labelled set

- **Size.** The skill's floor for a first pass is 10–30 items judged by
  the human; that is enough to catch a bad question, not to set a
  production threshold. For thresholds you can defend, field and
  independent guidance is 50–300 items per check, and ECE only starts to
  mean something after about 50 [field, indep].
- **Source.** Human-made or human-approved labels only. Agent-made labels
  are unreliable: in a blind review of 26 disagreements, a human sided
  with Jev 10 times and with the agent's labels 11 times [field].
- **Blind review.** When reviewing disagreements, don't show which answer
  was Jev's. Report results per label source.
- **Coverage.** Include typical cases, hard cases, and cases where the
  answer is "no" or "nothing fits".
- **Hold-out.** Tune on part of the set; measure on the rest. One field
  sweep tuned on 31 items and measured on 267 [field].
- **Scarce positives.** Take clean items and inject exactly one known
  defect each; measure the catch rate on the variants and the false-fire
  rate on the originals. For code checks, replay known before/after fix
  pairs [field].

File format for `run-questions.mjs`, one line per item:
`{"id": "t01", "state": {...}, "expected": {"<question_id>": <label>}}`.
Noul labels may be yes/no or true/false; score labels are level indexes
(0 = first level); choice labels are the option names.

## 2. Metrics (what calibrate.mjs prints)

| Metric | Meaning | Use |
|---|---|---|
| Accuracy + 95% interval | share of exact matches, Wilson interval | headline; the interval is wide on small sets |
| Majority baseline | accuracy of always giving the commonest label | a check must beat it |
| Macro-F1 | mean per-class F1 over labelled classes | imbalanced labels |
| Confusion matrix | rows = human, columns = Jev | which classes bleed into which |
| Accuracy at cutoff | for each cutoff, the share kept (coverage) and their accuracy; printed for `confidence` and, for choice/score, for top probability (two candidate signals) | threshold choice |
| ECE | 10 equal-width bins over top probability; weighted gap between accuracy and mean probability | is the probability honest? |
| Noul sweep, AUROC, Brier | precision, catch rate and false-alarm rate per p(yes) threshold; ranking quality; squared error | guards and flags |
| Score within-one, MAE, signed error | ordinal closeness; distance of the expected score; bias (+ = Jev rates higher) | rubrics; a field run found +0.76 bias [field] |

Prediction rules (keep them fixed): noul yes iff p > 0.5, top probability
max(p, 1−p), confidence |2p − 1| (the vendor proxy) [docs]; choice
argmax; score modal level, with the fractional score kept as the expected
value. Field tools disagreed at exactly 0.5 (> versus ≥); pick one rule and
keep it [field].

Also worth measuring when stakes justify it:

- **Perturbation stability**: shuffled options (first-option bias), bare vs
  described options, negated phrasing, padded state [docs, field].
- **Repeat stability**: identical calls can flip near a threshold. Vendor
  cookbooks saw choice labels flip and noul spreads around 0.01 (sampled
  2026-09-11); a field run got the same score level on 95% of items across
  two runs [docs, field].
- **Fitted calibration** (temperature or Platt scaling on 50–300 labels,
  fitted on half, scored on the other half) [indep].

## 3. Choosing thresholds

1. **Start from vendor defaults** for a noul: yes ≥ 0.7, no ≤ 0.3, review
   between. Don't fit thresholds to a handful of cases [docs].
2. **Read the cutoff table** and take the lowest cutoff whose accuracy
   clears the bar for this action. Irreversible or outward actions get
   higher bars than read-only ones [docs]. `calibrate.mjs` suggests one at
   `--target`; treat it as a suggestion for the human to accept. Rows with
   fewer than `--min-n` items (default 5) are starred and never drive a
   suggestion; when only such rows reach the target, the script says so
   ("label more examples") rather than suggesting a threshold.
3. **Try other signals.** For a choice, the top probability or the
   top-to-second ratio may separate better than `confidence`; for a score,
   look for two-peaked distributions [docs].
4. **Per check, never one global cut.** False alarms compound across a
   checklist: in one replay, 34% of unrelated chunks raised at least one
   alarm at 0.5 versus 1% at 0.9 [field].
5. **Consider ranking instead of cutting.** Some true positives scored
   0.23–0.34 yet ranked above nearly all negatives; sending the top N to a
   reviewer can beat any fixed cut [field].
6. **Keep a review band** routed to a human or a stronger model. In a
   vendor choice cookbook, requiring top probability ≥ 0.60 (else
   "uncertain" → review) raised run-to-run agreement to 99.2% with 74.2%
   still automated; that measures repeatability, not accuracy [docs].

Field example: a 0.3 / 0.5 / 0.7 sweep over 736 replayed shell commands
traded catch rate for false blocks (catch 64 / 61 / 61%, false block
29 / 19 / 11%). The shipped policy blocked at ≥ 0.8 on four checks and
flagged at ≥ 0.5 on two, with code facts settling known cases first
[field].

**Gating on `confidence` is CONTESTED**: the vendor docs show
confidence-gated routing; the vendor's own skill says confidence is
rarely the gate. Let this check's cutoff table decide.

**Probability clamping is CONTESTED**: independent reports say noul
probabilities are rounded to 0.01 and clamped to 0.01–0.98, but a vendor
example shows 0.99 on jev-1.13. Don't design thresholds that depend on
values above 0.98.

## 4. Reporting honestly

Every calibration report states:

- n per check, the label source, and whether the set was held out;
- accuracy with its interval, the baseline, and macro-F1;
- the chosen threshold, its coverage, and the review-band share;
- the model version that was served, and the spec version;
- the caveat when n < 30 ("indicative only"), when labels weren't from a
  human ("unvalidated"), or when rows were mock ("not Jev").

Never round a small set into a confident claim. "8 of 10 agreed, interval
roughly 49–94%" is the honest sentence.

## 5. Pin, monitor, retune

- Pin a versioned model id (not `jev-latest`) once thresholds are tuned,
  and log the served `model` on every response [docs].
- Aliases move without code changes. As of 2026-11-02 `jev-latest` and
  `jev-preview` both point to `jev-1.14.0` [docs].
- Retune on: a model or alias change; any question or criteria edit; a
  shift in the input mix; a rising review-band share or false-alarm rate.
- Regression A/B: run the same suite back to back with a model override;
  compare AUROC, catch and false-alarm rates at shipped thresholds, and
  count the decisions that would change [field].
- The vendor says it intends 60 days' notice before retiring jev-1.13.0
  and 30 days for jev-1.14.0 (vendor blog, 2026-10-14).
