# extpo

Two domain-specific agent backends — **trading** and **marketing** — over one shared kernel.

The bet these implement: the agent loop is commoditised, so the defensible layer is everything above it. Each service
supplies its own tools, skills, command policy and — the part that matters — a **verification gate** that decides
whether the agent's output is allowed to become a reply.

```
                        ┌──────────────────────────────────────────┐
   prompt ──▶ engine ──▶│ harness (Anthropic │ scripted)           │
                        │   └─ tool calls ──▶ policy ──▶ sandbox   │
                        └──────────────────────────────────────────┘
                                     │ proposed reply + artifacts
                                     ▼
                             domain verification
                          ┌──────────┴───────────┐
                       pass/warn               blocked
                          │                       │
                        reply          repair loop (findings fed back)
```

The two services share the kernel and share nothing else. They are separately runnable, separately deployable, and
have separate databases and workspaces.

## Running

Requires Node ≥ 22.6. One dependency (`@anthropic-ai/sdk`); everything else is Node built-ins — `node:sqlite` for
persistence, `node:http` for the API, `node:test` for the suite. No build step: Node runs the TypeScript directly.

```bash
npm install
npm run trading     # :8081
npm run marketing   # :8082
npm test            # 147 tests
npm run eval        # score the verifiers against the labelled corpora
npm run typecheck
```

Both services boot with a **scripted harness** and seeded demo data, so they run end to end with no API key. Set
`ANTHROPIC_API_KEY` to switch to the live model (`claude-opus-5`); set `HARNESS=scripted` to force the scripted one
back on.

```bash
curl localhost:8081/health
PID=$(curl -s localhost:8081/projects | jq -r .projects[0].id)
SID=$(curl -s -X POST localhost:8081/projects/$PID/sessions -d '{}' -H 'content-type: application/json' | jq -r .id)
curl -s -X POST localhost:8081/sessions/$SID/turns \
  -H 'content-type: application/json' -d '{"prompt":"reconcile the book"}' | jq
```

## The kernel (`kernel/`)

| File | Role |
|---|---|
| `engine.ts` | The turn loop: harness → tools → policy → ledger → verification → reply, plus the repair loop and durable approvals |
| `verify.ts` | Verification pipeline; `block` findings gate the reply, `warn` findings ride along |
| `sandbox.ts` | Per-project durable workspace; command execution with timeouts, path-escape refusal |
| `policy.ts` | Command policy — hard denials and approval gates that apply in every service |
| `store.ts` / `db.ts` | SQLite persistence: projects, sessions, entries, runs, tool ledger, artifacts, approvals, verifications, crons, audit |
| `cron.ts` | Five-field cron parser and next-firing calculation with timezone offsets |
| `harness/` | The swappable agent loop: interface, Anthropic adapter, deterministic scripted harness |
| `service.ts` | Assembles a service from a domain definition and mounts the shared HTTP routes |

Three properties the kernel enforces for both domains:

**Everything durable.** Every tool call, artifact, verification and approval is a row. Nothing an operator reads back
later lives in process memory.

**Approvals suspend the run.** A gated tool throws; the engine writes an approval row, parks the run as
`awaiting_approval` and returns. A later `POST /approvals/:id/decide` resumes it in a fresh process. This is why the
Anthropic adapter drives the tool loop directly rather than using the SDK tool runner — the lifecycle outlives the turn.

**Blocked output is repaired, not discarded.** When verification blocks, the findings go back to the harness as
feedback and it tries again, up to the repair budget. The engine test asserts this end to end.

## Trading (`services/trading/`)

Middle- and back-office work: reconciliation, position reporting, risk review, backtest support. It proposes; it never
executes.

**The governing rule: the agent never produces a number, it produces code that produces the number.**

| Verifier | What it does |
|---|---|
| `numeric-provenance` | Every figure in the reply must trace to a recorded tool result. Tolerates presentation rounding and ratio/percent restatement; exempts small counts, years, and numbers echoed from the prompt |
| `lookahead-bias` | Static analysis of backtest code: negative shift, backward fill, shuffled time-series split, forward indexing, whole-sample thresholds, ranking on forward returns |
| `reconciliation-tie-out` | Recomputes the break list from the database and blocks a "clean book" claim or a wrong break count the data contradicts |
| `risk-limits` | Recomputes post-trade gross exposure, concentration and symbol count against the book's configured limits |
| `no-execution-claim` | Blocks any reply claiming an order was placed — this system only proposes |

Tools: `execute`, `write_file`, `read_file`, `list_instruments`, `market_data`, `positions`, `custodian_positions`,
`reconcile`, `risk_limits`, `propose_trade` (gated). Skills: point-in-time backtest, position reconciliation,
pre-market brief.

## Marketing (`services/marketing/`)

Content operations: drafting, competitor audits, performance reporting.

| Verifier | What it does |
|---|---|
| `platform-constraints` | Per-platform length (X counts links as a flat 23), hashtag caps, link rules, media requirements |
| `brand-voice` | The brand's stored profile: banned and required phrases, emoji policy, reading-grade ceiling |
| `disclosure` | Sponsored posts need `#ad`/`#sponsored`, and it warns when the disclosure is buried past the fold |
| `utm-hygiene` | Every link needs lowercase `utm_source`/`utm_medium`/`utm_campaign`, no duplicates, no whitespace |
| `claim-substantiation` | Blocks guarantees and health claims; warns on uncited superlatives and comparative statistics |
| `duplicate-content` | Jaccard similarity against the channel's own publishing history |

Tools: `execute`, `write_file`, `read_file`, `brand_voice`, `platform_spec`, `channels`, `analytics`,
`competitor_scan`, `draft_post`, `schedule_post` (gated). Skills: repurpose long-form, competitor audit, performance
report.

## Measuring the gate

A verifier that blocks correct output is worse than no verifier. Two mechanisms measure that.

**Offline — `npm run eval`.** Labelled corpora in `evals/*.json`: `should_pass` cases are correct replies that must
survive the gate, `should_block` cases are the failure modes it exists to catch. The runner scores precision, recall
and — the number that matters — the **false-positive rate**, then exits non-zero on any regression.

```
trading  —  23/23 correct  (8ms)
  recall 100.0%   precision 100.0%   false-positive rate 0.0%
  verifier                blocks  warns  false-blocks
  lookahead-bias               5      0             0
  numeric-provenance           2      0             0
  reconciliation-tie-out       2      2             0
  risk-limits                  2      0             0
  no-execution-claim           1      0             0
```

This paid for itself on its first run: the corpus case `provenance/iso-date-in-reply` exposed the number tokenizer
reading `2026-08-15` as **negative fifteen**, which would have blocked any reply containing a date. Fixed in
`withoutDates()`; the case is now a permanent regression guard.

Adding a case is a JSON entry, so a bug found in production becomes a test in a minute.

**Online — `GET /metrics`.** The same signal from real traffic, aggregated out of the rows the engine already writes:

```json
{
  "runs": { "ok": 128, "blocked": 4, "failed": 1, "awaiting_approval": 2 },
  "completionRate": 0.948,
  "repair": { "attempted": 31, "succeeded": 27, "rate": 0.871 },
  "blockedAfterBudget": 4,
  "latencyMs": { "p50": 2140, "p95": 8830, "max": 14200 },
  "topCodes": [{ "code": "numeric-provenance/unsourced_number", "count": 22 }]
}
```

`repair.rate` says whether the findings are actionable — a low rate means the messages are unclear, not that the model
is bad. `blockedAfterBudget` is the count of runs that never produced usable output; it's the one to alert on. Pass
`?hours=24` to window it.

## Auth and the worker

**Every route except `GET /health` needs an API key.** Keys are stored only as a SHA-256 hash, compared in constant
time, and revocable.

```bash
curl -H "Authorization: Bearer extpo_..." localhost:8081/projects
```

On first boot with no keys, the service mints an admin key and prints it once:

```
[trading] no API keys existed; minted an admin key (shown once): extpo_5b2b8a27...
```

Access is scoped by owner. A key sees only its own projects, and everything hanging off them — sessions, runs,
artifacts, approvals. **A project belonging to someone else reads as 404, never 403**, so the API never confirms that
another owner's id exists. Admin keys see everything and are the only ones that can reach `/audit`, `/metrics`,
`/keys`, or create a project on another owner's behalf.

`POST /projects` infers the owner from the presenting key; passing a different `owner` requires an admin key.

Set `requireAuth: false` when constructing a service to turn this off for a local-only run.

**The worker** fires due crons and drains queued runs on an interval (`WORKER_INTERVAL_MS`, default 15s). Cycles never
overlap — a concurrent call joins the one in flight rather than racing it, so a single process never claims the same
run twice. A cron that throws does not stop the drain.

Long turns can skip the request entirely:

```bash
curl -X POST .../turns -d '{"prompt":"reconcile the book","async":true}'
# → {"runId":"run_...","status":"queued"}
```

Enqueueing nudges the worker, so a queued run starts immediately rather than waiting out the interval. Poll
`GET /runs/:id` for the outcome.

## Shared HTTP surface

Both services expose the same core API, plus their own domain routes.

```
GET    /health                            capabilities: tools, verifiers, skills
GET    /routes
POST   /projects                          {name, owner, settings?}
GET    /projects | /projects/:id
PATCH  /projects/:id/settings
POST   /projects/:id/sessions
POST   /sessions/:id/turns                {prompt} → {status, reply, findings, artifacts, approvals}
GET    /sessions/:id/entries | /sessions/:id/runs
GET    /runs/:id                          run + tool ledger + verifications + approvals
POST   /approvals/:id/decide              {runId, approved, decidedBy} → resumes the run
GET    /projects/:id/artifacts | /artifacts/content?path=
POST   /projects/:id/deployments | /projects/:id/crons
POST   /keys                              admin only — mint a key, shown once
GET    /keys | DELETE /keys/:id           admin only
GET    /audit | /metrics                  admin only
```

Trading adds `/books/*`, `/instruments`, `/bars`. Marketing adds `/platforms/*`, `/brands/*`, `/channels/*`.

## Tests

```
test/kernel.test.ts               cron, policy, skills, sandbox, store, verification pipeline
test/engine.test.ts               repair loop, approval suspend/resume, denial, policy denial, artifacts, failures
test/trading-verifiers.test.ts    all five trading verifiers, passing and failing
test/marketing-verifiers.test.ts  all six marketing verifiers, plus platform helpers
test/auth.test.ts                 key lifecycle, per-owner scoping, admin routes, hash hygiene
test/worker.test.ts               draining, cron firing, non-overlapping cycles, graceful stop
test/eval.test.ts                 eval scoring, and both corpora held at 100%
test/metrics.test.ts              aggregation over real runs, empty-store edges
test/api.test.ts                  both services booted on ephemeral ports, exercised over HTTP
```

## Known limits

- **The local sandbox is not a security boundary.** Commands run as the host user in a per-project directory. The
  command policy and path-escape checks stop accidents, not a determined attacker. Auth now keeps strangers off the
  API, but anyone who holds a key can still run code as the host user — a container or microVM behind the same
  `Sandbox` interface is required before untrusted users.
- **The Anthropic adapter is unexercised.** Every test runs against the scripted or programmable harness because the
  environment has no API key. The adapter's shape follows the current Messages API (adaptive thinking, `output_config`
  effort, `fallbacks: "default"`, refusal handling) but has not been run against the live endpoint.
- **Single-process.** The worker runs in the same process as the API. `claimQueuedRun()` takes a row-level claim so a
  second worker would not double-run a job, but that is untested across processes — treat multi-instance as unproven
  until it runs against Postgres.
- **`node:sqlite` is experimental** and needs the `--experimental-sqlite` flag. The store interface is small enough to
  repoint at Postgres when concurrency demands it.
- **Domain data is seeded, not integrated.** There are no live market-data or social-platform connectors; both services
  read from their own tables, which is what makes the verifiers deterministic and testable.
- **The corpora are hand-written, not harvested.** 44 cases covering every verifier, but the `should_pass` examples are
  my guesses at how a model phrases things. Real replies will produce false positives these cases do not anticipate;
  each one found should become a new case.
- **No live-model eval mode.** `npm run eval` judges verifiers against fixed output, which needs no API key and is the
  right default. Scoring the *model* — running prompts end to end and measuring pass@1 — is the obvious next addition
  and needs a key.
