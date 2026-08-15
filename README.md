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
npm test            # 102 tests
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
GET    /audit
```

Trading adds `/books/*`, `/instruments`, `/bars`. Marketing adds `/platforms/*`, `/brands/*`, `/channels/*`.

## Tests

```
test/kernel.test.ts               cron, policy, skills, sandbox, store, verification pipeline
test/engine.test.ts               repair loop, approval suspend/resume, denial, policy denial, artifacts, failures
test/trading-verifiers.test.ts    all five trading verifiers, passing and failing
test/marketing-verifiers.test.ts  all six marketing verifiers, plus platform helpers
test/api.test.ts                  both services booted on ephemeral ports, exercised over HTTP
```

## Known limits

- **The local sandbox is not a security boundary.** Commands run as the host user in a per-project directory. The
  command policy and path-escape checks stop accidents, not a determined attacker. A real deployment needs a container
  or microVM behind the same `Sandbox` interface.
- **The Anthropic adapter is unexercised.** Every test runs against the scripted or programmable harness because the
  environment has no API key. The adapter's shape follows the current Messages API (adaptive thinking, `output_config`
  effort, `fallbacks: "default"`, refusal handling) but has not been run against the live endpoint.
- **Single-process.** Runs execute inline on the request. `store.claimQueuedRun()` and `engine.drainOnce()` exist for a
  background worker, but no worker process is wired up.
- **`node:sqlite` is experimental** and needs the `--experimental-sqlite` flag. The store interface is small enough to
  repoint at Postgres when concurrency demands it.
- **Domain data is seeded, not integrated.** There are no live market-data or social-platform connectors; both services
  read from their own tables, which is what makes the verifiers deterministic and testable.
