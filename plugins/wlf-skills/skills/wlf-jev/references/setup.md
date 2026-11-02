# Jev setup: environment, key, SDK, first call, raw HTTP

Read this when setting Jev up in a project, or when something about the
environment (Node version, key, SDK, headers, models) is in doubt.

**Every fact here moves fast.** All were read on 2026-11-02 from
docs.typesafe.ai **[docs]** and the `@typesafe-ai/sdk` 0.7.0 package and
its type declarations **[sdk]**. Re-verify before relying on them (the
re-check commands are at the end).

## TL;DR (as of 2026-11-02)

- `npm i @typesafe-ai/sdk` → 0.7.0, MIT, **Node ≥ 22** (zstd request
  compression needs ≥ 22.15) [sdk].
- Key in `TYPESAFE_API_KEY`, server side only [sdk].
- Models: `jev-1.14.0` and `jev-1.13.0`; `jev-latest` and `jev-preview`
  both point to `jev-1.14.0`. Pin a versioned id once tuned [docs].
- Price: $0.042 per million input tokens; output tokens are free [docs].
- Context: 64k tokens per request, 32k per state + question [docs].
- Rate limits are per organisation, shown in the console [docs].

## 1. Environment check

Run these and read the answers; don't assume.

```bash
node --version                      # need v22 or newer
npm ls @typesafe-ai/sdk             # installed? which version?
test -n "$TYPESAFE_API_KEY" && echo "key: set" || echo "key: missing"
```

Never print the key's value, not even partly. "set" or "missing" is all
anyone needs to see.

## 2. Key handling

- Keys are created in the TypeSafe developer console, which also has a
  playground and shows the organisation's rate limits [docs].
- The SDK reads `apiKey` from its options, else `TYPESAFE_API_KEY` [sdk].
- Put the key in the environment or in a git-ignored `.env` file. Check
  that `.env` is in `.gitignore` before writing to it. Node 22 can load it
  with `node --env-file=.env app.mjs` or `process.loadEnvFile()`.
- Ask the human to paste the key into the file or their shell, not into
  the chat. If they paste it into chat anyway, use it only to write the
  file and suggest rotating it.
- Never put the key in code, in `state`, in logs or in a browser bundle.
  The SDK refuses browser use unless `dangerouslyAllowBrowser` is set [sdk].
- Don't run `TYPESAFE_LOG_LEVEL=debug` over sensitive data: it logs
  request bodies (credential headers are redacted, bodies aren't) [sdk].
- Data: the vendor says Jev isn't trained on customer requests or
  responses; zero data retention is enterprise-only. Get the client's
  data-policy approval before sending their data [docs].

## 3. Install

```bash
npm i @typesafe-ai/sdk
```

The package is ESM and CommonJS, ships its own types, and needs Node 22.
On older Node, upgrade or use raw HTTP (section 6).

## 4. First smoke call

```ts
import { TypeSafeClient, noul } from "@typesafe-ai/sdk";

const client = new TypeSafeClient({ defaultModel: "jev-1.14.0", timeout: 5000, retry: { maxRetries: 1 } });
const { answers, model, usage } = await client.systemOne({
  state: { message: "I was charged twice this month." },
  questions: { billing: noul("Is `message` about a charge or payment?") },
});
console.log(model, answers.billing.noul, usage.input_tokens);
```

Expect a versioned model id, a probability near 1, and a small token
count. A 401 means the key is wrong or missing; a 422 names the invalid
field; a connection error means network or base URL [sdk, docs].

## 5. SDK reference (0.7.0)

- **Config precedence**: explicit options, then environment, then
  defaults. `TYPESAFE_API_KEY` (required), `TYPESAFE_BASE_URL` (default
  `https://api.typesafe.ai`), `TYPESAFE_DEFAULT_MODEL` (default
  `jev-latest`), `TYPESAFE_LOG_LEVEL` (default `warn`) [sdk].
- **Call**: `client.systemOne({ state, questions, model?, assets? },
  { timeout?, retry?, headers?, signal? })` resolves to
  `{ model, answers, usage }` [sdk].
- **Builders**: `noul(instructions, criteria?)`, `choice(instructions,
  {label: description})`, `score(instructions, [level0, …])`,
  `box(instructions?)`; `image(bytes)` and the `withAssets` template tag
  for images [sdk].
- **Retry defaults**: 2 retries; backoff 500 ms doubling to 5,000 ms with
  0.25 jitter; retries HTTP 408, 429 and 500–599 plus connection errors
  and timeouts; honours `Retry-After` up to 60,000 ms [sdk].
- **Timeout**: 10,000 ms **per attempt**, no total budget. Override per
  call on hot paths, or pass an `AbortSignal` [sdk].
- **Errors** (rejections, not throws): `BadRequestError` 400,
  `AuthenticationError` 401, `PermissionDeniedError` 403, `NotFoundError`
  404, `UnprocessableEntityError` 422, `RateLimitError` 429
  (`retryAfterMs`), `InternalServerError` 5xx, `APIConnectionError`,
  `APITimeoutError`, `APIUserAbortError`. `APIError`s carry `status`,
  `body`, `requestId` [sdk].
- **Request id**: `await client.systemOne(...).withResponse()` returns
  `{ data, response, requestId }` [sdk].
- **Usage**: `input_tokens` and `output_tokens` can be `null` [sdk].
- **Compression**: bodies ≥ 1 KiB are zstd-compressed on Node ≥ 22.15;
  `compression: false` turns it off [sdk].
- **History**: 0.7.0 (2026-10-14) requires Node 22 and stopped exporting
  request payload types; 0.6.0 made score criteria an ordered array;
  0.5.7 (2026-09-11) was the first public release [docs].

## 6. Raw HTTP fallback (no SDK, or Node < 22)

- `POST https://api.typesafe.ai/v1/systemone` with
  `Authorization: Bearer <key>` and a JSON body
  `{ "model": "...", "state": ..., "questions": {...} }` [docs].
- Over raw HTTP **`model` is required**; only the SDK fills a default [docs].
- Questions use the same shape the builders produce:
  `{"type": "noul", "instructions": "...", "criteria": {"false": "..."}}`,
  `{"type": "choice", "instructions": "...", "criteria": {"label": "description"}}`,
  `{"type": "score", "instructions": "...", "criteria": ["level 0", "level 1"]}`.
- Response: `{ "model": "<versioned id that answered>", "answers": {...},
  "usage": { "input_tokens": n, "output_tokens": n } }` [docs].
- `GET /v1/models` lists aliases; versioned ids are accepted even when not
  listed [docs].
- Body rules: ≤ 32 MiB (413 above), UTF-8 JSON without BOM, ≤ 64 levels of
  nesting, finite numbers, optional gzip or zstd (one layer) [docs].
- Status codes: 400 (including `max_tokens_exceeded`), 401, 413, 415, 422
  (with field detail), 429, 529 (overloaded). Retry 429 and 529 with
  exponential backoff yourself [docs].

Fallback self-review: model set explicitly · key read from the
environment, never logged · timeout set on the HTTP client · 429/529
retried with backoff and a cap · failures surfaced as errors, never as
answers.

## 7. Models and opt-in headers (as of 2026-11-02)

| Id / alias | Points to | Notes |
|---|---|---|
| `jev-1.14.0` | — | released 2026-10-14; the only model with box |
| `jev-1.13.0` | — | vendor intends 60 days' notice before retirement |
| `jev-latest` | `jev-1.14.0` | "most recent stable"; the SDK default |
| `jev-preview` | `jev-1.14.0` | no separate preview build right now |

- No per-customer fine-tuning: all shaping is state, instructions and
  criteria [docs].
- A published failure-mode page exists for jev-1.13 only (last reviewed
  2026-10-02); none for 1.14 yet [docs].
- `TypeSafe-Danger-Zone-Long-Context: true` raises both context limits to
  262k tokens at the same price; slower and less accurate [docs].
- `TypeSafe-Danger-Zone-Images: true` is required for any image or box
  question (400 without it). Images work on 1.13 and 1.14; box needs 1.14.
  PNG/JPEG stills, ≤ 16 MiB, 280–1568 px per side, never resized; one bad
  image fails the request. The vendor labels images and box not
  production-ready [docs].

## 8. Price, latency, limits (dated)

- $0.042 per million input tokens, output free, long context same price
  (vendor, 2026-11-02). A six-question guard call cost about $0.00005 in
  field use (October 2026).
- Latency: vendor "about 100 ms"; independent ~0.1 s for 1–32 judgments;
  field p50 ~0.15 s, p95 ~0.22 s (jev-1.13.0, October 2026).
- Rate limits: per organisation, in tokens/s and requests/s, shown in the
  console. Older fixed public numbers are superseded [docs].
- Quick cost estimate: tokens ≈ characters / 4 (a heuristic, not the
  vendor tokenizer); cost ≈ items × tokens per request × 0.042 / 1e6.
  `node scripts/run-questions.mjs --spec … --data … --estimate` does this.

## 9. Other transports

- **TypeSafe's agent skill** (MIT): `claude plugin marketplace add
  typesafe-ai/skills` then `claude plugin install typesafe@typesafe-ai`,
  or `npx skills add typesafe-ai/skills --skill typesafe-ai`. It defers
  API truth to the live docs. Old installs (0.5.7) don't know about box
  [docs].
- **OpenRouter** lists TypeSafe models (`typesafe/jev-1.13`, `jev-1.14`,
  `jev-latest`, `jev-router`), but its request contract, pricing and
  limits were **not verified** as of 2026-11-02. Treat it as unknown.

## Re-checking these facts

```bash
npm view @typesafe-ai/sdk version engines
curl -s https://docs.typesafe.ai/llms.txt     # index of the live docs as markdown
```

With a key, `GET /v1/models` shows the current aliases. Compare the
`model` field on real responses with what you pinned.
