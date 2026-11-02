# Jev question design: wording, options, levels, state

Read this when you are writing a question, or fixing one that disagrees
with the human labels.

Sources (all accessed 2026-11-02 unless dated otherwise):
**[docs]** TypeSafe documentation, docs.typesafe.ai ·
**[jag]** the vendor's published failure-mode page for jev-1.13 (last reviewed 2026-10-02; no 1.14 page exists as of 2026-11-02) ·
**[vskill]** TypeSafe's own agent skill, github.com/typesafe-ai/skills (MIT, commit of 2026-10-23) ·
**[field]** anonymised practitioner runs on jev-1.13.0, October 2026, aggregates only ·
**[indep]** independent evaluations of jev-1.13.0, September–October 2026.

## TL;DR

- **Ask for a judgment, not a decision.** "Does the customer sound
  frustrated?" is a judgment; "should we escalate?" is a decision and
  belongs in code. One field run that asked the decision directly got the
  opposite of what was intended on 7 of 10 items [docs, field].
- **One snap judgment per question**, answerable at a glance by a
  knowledgeable person. No "and"/"or". High means yes [docs, vskill].
- **Fix the state before the wording.** If a smart person shown only this
  state couldn't answer, change the state [docs].
- **Describe situations, not degrees**, for score levels and noul criteria
  [docs].
- **Test, don't trust.** Agent-written questions need validating on items
  you didn't tune on [vskill].

## Writing `instructions`

1. Name the subject and point at the field with a backticked path:
   "Does `ticket.body` ask for a refund?" [docs].
2. Be literal. Jev answers the words, not your intent [jag]. State the
   exact condition and move boundary cases into `criteria`. If you catch
   yourself explaining what you "really meant", that explanation is the
   missing half of the question.
3. No double negatives, no multi-hop references ("the person mentioned in
   the second email's signature"), no presuppositions ("the next step")
   [jag].
4. Arithmetic, counting, date comparison, exact lookups and policy rules
   stay in code. Ask Jev only for the semantic part [jag].
5. Skip preambles, role-play and output-format instructions. A question is
   not an LLM prompt [vskill].

## Noul

- One condition. A compound condition becomes two nouls joined in code.
- Phrase it so that high means yes. Inverted criteria, where `true`
  describes a "no", perform worse [docs, jag].
- `criteria` are optional; try the question with and without them. When
  you use them, write `false` as a concrete situation ("the parcel arrived
  on the promised date"), not a negation ("not late") [docs].
- 0.5 means unsure, not medium. Degree belongs in a score.

## Choice

- **Descriptive labels.** Positional names (`A`, `option_1`) give the
  model nothing and can bias it [docs]. Labels and their descriptions are
  both sent to the model.
- **One line per option that separates it from its neighbours.** When two
  options keep being confused, give each an object description with the
  same fields (`covers`, `not_for`, `examples`) [docs]. A low-confidence
  independent finding: bare labels mis-routed hard cases at high
  confidence, and one-line descriptions fixed most of them [indep].
- **The full list, pruned by code.** Give every eligible option (up to
  255) rather than a guessed shortlist, but remove ineligible and generic
  "always fits" options first. In a field run, a generic option won 5 of
  10 items and crowded out the real ones [docs, field].
- **Order.** jev-1.13 leans toward the first option. Re-run with shuffled
  options to check stability [jag].
- **Several true at once?** Use one noul per label instead [vskill].
- **The "nothing fits" case is CONTESTED and model-version dependent.**
  - The docs: add an `other` / `none of the above` option when the list
    may not cover every input, or ask a companion noul [docs].
  - The vendor skill (2026-10-23): as of jev-1.14, the companion noul
    ("does any option fit?") usually works better than "none of the
    above" [vskill].
  - Working position: build both variants and pick per check by
    measuring them on labelled items. Don't state either as settled.

## Score

- Each level is judged on its own. The model never sees level numbers or
  neighbours, so "worse than the previous level" means nothing [docs].
- Describe a concrete, observable situation per level ("a workaround
  exists"), never an adjective ("moderately severe") [docs].
- One dimension per score. "Punctual and skilled" is two scores.
- Give a rare, actionable extreme its own level [docs].
- Use as many levels as you can describe distinctly, and no more [docs].
- Examples inside levels steer only when they look like your real inputs.
  A higher confidence after an edit does not prove the edit helped [docs].
- **Saturation check.** If nearly every item lands on one level, the
  levels aren't separating anything. A field effort score sat at the
  maximum almost always and was replaced by a noul plus code [field].

## State construction

- **Shape.** A JSON object with descriptive keys for anything with more
  than one part. Point each question at the field it needs [docs].
- **What goes in.** What a person would look at to answer: who said what,
  the whole thread, names rather than opaque IDs, only the item in
  question [docs].
- **What stays out.** Irrelevant fields lower accuracy; a field added for
  one question can sway another; an empty list can read as a signal
  [docs, jag].
- **Facts go in named fields or stay in code, never in prose.** In a field
  run, a prose note full of security vocabulary pushed a check toward
  "yes" (9 hits rose to 13); short neutral context plus code-side facts
  fixed it [field].
- **Missing context comes before splitting.** Adding the reviewer's
  evidence to state cut a severity bias from +0.63 to +0.07 levels, while
  splitting the rating into factors made it worse [field].
- **Untrusted text.** State isn't treated as hostile. Injected or
  argumentative text can move answers, so any check over untrusted text is
  a filter, not a boundary [jag].
- **Language.** English works best; other languages work at lower
  accuracy [docs].
- **Everything in `state` is sent to TypeSafe.** Withhold secrets and any
  data the client hasn't approved for a third-party processor.

## Granularity

- Narrow questions combined in code beat one broad verdict **when each
  part is answerable from the state** [docs, indep].
- Pick the unit per check. Some checks fired on 40–51 of 62 paragraphs
  when asked per paragraph and behaved at section level [field].
- Observable form beats fuzzy content. Exact phrasings and structures were
  caught on 58 of 65 injected examples, while "could apply to anyone"
  judgments over-fired and resisted rewording [field].
- Describe the class of situation, not the instance you happened to see,
  so the check stays general.

## Comparing wordings

- Send each variant as its own question in the same request over the same
  state. It's cheap and runs in parallel [vskill].
- Read individual answers, not only the aggregate, and keep the payloads.
- Stop if you see "prompt gymnastics" [vskill]: criteria that name test
  items, a clause added per failing case, thresholds fitted to particular
  cases, tests asserting exact probabilities, or code that silently
  overrides answers.

## Worked shapes (illustrative wording, uncalibrated)

- **Support triage.** Noul "Does the customer in `message.body` ask to
  speak with a person?"; choice over described queues; score of urgency
  with four situation levels.
- **Content moderation.** One noul per policy clause ("Does `post.text`
  threaten a specific person?"), with the clause's approved exceptions in
  `false`.
- **Agent safety check.** One noul per risk over `action.text` ("Would
  this delete data that can't easily be recreated?"); code facts first.
- **Lead scoring.** One score per buying signal (budget stated, timeline,
  authority), each level a situation; weighted in code.
- **Document routing.** Choice over departments with `covers` / `not_for`
  descriptions, plus a presence noul.
- **Hiring rubric.** One score per rubric criterion, evidence quoted in
  state, never one "is this a good candidate?" verdict.
