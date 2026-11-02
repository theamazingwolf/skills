# Freshness manifest: Jev facts that go stale

Read this before relying on any number in this skill, when a model or SDK
version changes, or when the client asks "is this still true?".

Every fast-moving fact the skill uses, with its value as read on
**2026-11-02**, where it came from, and what should trigger a re-check.

## Headline (as of 2026-11-02)

- SDK `@typesafe-ai/sdk` 0.7.0, Node ≥ 22.
- `jev-latest` and `jev-preview` both point to `jev-1.14.0`.
- $0.042 per million input tokens; output free.
- 64k tokens per request, 32k per state + question; 262k with the
  long-context header.
- Rate limits per organisation.
- Images and box are opt-in and not production-ready.
- A failure-mode page exists for jev-1.13 only.

## How to re-verify

```bash
npm view @typesafe-ai/sdk version engines
curl -s https://docs.typesafe.ai/llms.txt    # then fetch the .md pages below
```

With a key: `GET https://api.typesafe.ai/v1/models`. If TypeSafe's own
agent skill is installed and current, it defers to the same live docs.

## Facts, sources, triggers

| Fact | Value as of 2026-11-02 | Source | Re-check when |
|---|---|---|---|
| SDK version, Node floor | 0.7.0; Node ≥ 22 (zstd ≥ 22.15) | npm; docs `/sdk/javascript/changelog.md` | `npm outdated` shows a bump |
| SDK retry and timeout defaults | 2 retries; 500→5,000 ms; 408/429/5xx; Retry-After ≤ 60 s; 10 s per attempt, no total budget | SDK type declarations | any SDK bump |
| SDK env vars | `TYPESAFE_API_KEY`, `_BASE_URL`, `_DEFAULT_MODEL` (= `jev-latest`), `_LOG_LEVEL` (= `warn`) | SDK type declarations | any SDK bump |
| SDK error classes | 400/401/403/404/422/429/5xx + connection, timeout, abort | SDK type declarations | any SDK bump |
| Box confidence nullable | `number \| null` | SDK type declarations | any SDK bump |
| Models and aliases | 1.14.0, 1.13.0; latest → 1.14.0; preview → 1.14.0 | docs `/models.md` | monthly; vendor release post; a new value in responses' `model` |
| Deprecation notice | intended 60 days (1.13), 30 days (1.14) | vendor blog post on jev-1.14 (2026-10-14) | next release announcement |
| Price | $0.042 / M input; output free | docs `/models.md` | monthly; billing change |
| Context limits | 64k / 32k; 262k with header | docs `/models.md` | new model version |
| Rate limits | per org, tok/s and req/s, in console | docs `/models.md` | 429s in traces; plan change |
| Choice and score limits | choice 1–255; score ≤ 10, minimum 2 (docs, SDK) vs 1 (OpenAPI), contested | docs `/primitives/choice.md`, `/primitives/score.md`; OpenAPI 0.2.0 | API version bump |
| Request rules, status codes | 32 MiB, 64 nesting, finite numbers; 400/401/413/415/422/429/529 | docs `/api/errors.md` | API version bump |
| Opt-in headers | `TypeSafe-Danger-Zone-Images`, `TypeSafe-Danger-Zone-Long-Context` | docs `/models.md`, `/primitives/box.md` | a feature leaves "danger zone" |
| Image limits | PNG/JPEG, ≤ 16 MiB, 280–1568 px per side; box on 1.14 only | docs `/images.md` | new model version |
| Box guidance | SDK says use `jev-preview`; no recommended threshold | docs `/sdk/javascript.md`, `/primitives/box.md` | SDK bump; box leaves preview |
| Failure-mode page | jev-1.13 only, reviewed 2026-10-02 | docs `/model-jaggedness/jev-1.13.md` | a 1.14+ page appears in `llms.txt` |
| Null-case guidance (contested) | vendor skill prefers a companion noul as of 1.14 | github.com/typesafe-ai/skills (commit 2026-10-23) | skill repo commit; new model |
| Vendor skill install | MIT; plugin `typesafe@typesafe-ai` | docs `/agent-skill.md` | repo commit |
| Data handling | not trained on customer data; zero retention enterprise-only | docs `/models.md`, `/legal.md` | legal page change; before any client data |
| Latency | vendor ~100 ms; independent ~0.1 s; field p50 ~0.15 s | docs; Vals AI (2026-10-06); field runs (2026-10) | new model; trace drift |
| Field thresholds and metrics | measured on jev-1.13.0, A/B on 1.14.0 (2026-10-15) | anonymised field runs | any model or alias change: re-run your suite |
| Independent eval figures | jev-1.13.0, September–October 2026 | Vals AI; beri.net | new model version |
| Repeat stability | labels can flip; noul spread ~0.01; ≥ 0.60 rule → 99.2% repeat agreement | docs consistency cookbooks (sampled 2026-09-11) | new model |
| Probability clamping (contested) | reported 0.01 rounding and 0.98 clamp; vendor example shows 0.99 | independent reports; docs `/primitives/noul.md` | designing thresholds near 0 or 1 |
| Usage nullable | input/output tokens may be `null` | SDK type declarations | any SDK bump |
| Endpoint, auth | `POST /v1/systemone`, Bearer; `GET /v1/models` lists aliases | docs `/api/system-one.md` | API version bump |
| OpenRouter transport | models listed; contract, pricing, limits **unknown** | openrouter.ai/typesafe | before recommending it |

## Sources and licences

- TypeSafe documentation (docs.typesafe.ai) was read for facts; no text is
  reproduced.
- `@typesafe-ai/sdk` is MIT-licensed; its public type declarations were
  read to check call shapes. No SDK code is copied into this skill.
- TypeSafe's agent skill (github.com/typesafe-ai/skills) is MIT,
  © 2026 TypeSafe AI; its guidance is cited and paraphrased.
- Field figures come from anonymised practitioner runs and appear only as
  aggregates.
