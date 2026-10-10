# XHS Research Studio — Product Contract

## Product promise

Turn a bounded Xiaohongshu research question into a reusable, source-traceable research asset instead of a one-off spreadsheet, while keeping collection gaps, interpretation limits, source evidence, and collection-run state visible.

The product has two layers:

1. **Harvest Skill / authorized executor** — obtains public or user-authorized Xiaohongshu evidence and emits Harvest v2 JSON without bypassing platform safety controls.
2. **Research Studio** — plans and tracks bounded collection runs, validates and stores snapshots, schedules recurring monitoring, compares observed change, surfaces auditable comment signals, tracks observed search visibility, groups lexical evidence, exports client deliverables, and keeps conclusions traceable to source evidence.

## Primary jobs to be done

### Agency analyst

“I need to deliver a competitor/category scan without spending half a day manually opening notes and copying comments, and I need to show where each conclusion came from.”

### Brand insight / strategy team

“I need to know what changed, how we were observed for important search themes, what users repeatedly ask or complain about, and which source evidence supports the finding.”

### Research / social-intelligence team

“I already sell analysis. I need a cleaner evidence-collection, normalization, provenance, monitoring, and export layer that can feed my existing workflow.”

## Functional contract

A user can:

1. create a project with client/category/keywords/competitors;
2. start from a brand-monitor / competitor-scan / product-opportunity template;
3. copy a bounded Harvest plan or launch a bounded run through an explicitly configured executor adapter;
4. see persistent run state (`queued`, `running`, `manual_action_required`, `completed`, `failed`, `cancelled`), budgets, gaps, risk state and resulting snapshot;
5. cancel a still-executing run before its snapshot commit point, or resume a manual/failed run;
6. create persistent monitoring schedules with a minimum one-hour cadence and overlap protection;
7. safely fall back to manual handoff when no executor is configured or a platform safety/access state requires intervention;
8. validate and ingest one or more Harvest snapshots;
9. inspect coverage, explicit gaps, capture risk state, source method and confidence;
10. see auditable rule-based questions, complaints, purchase-intent and positive-feedback queues;
11. click a recurring lexical term and inspect supporting comments and source notes;
12. see high-signal notes and source URLs;
13. see keyword search positions when Harvest includes `queries[].rankingPosition`;
14. compare two snapshots for new notes, previously-observed/not-currently-observed notes, engagement movers, emerging terms and observed rank changes;
15. export evidence CSV and a structured Evidence Pack;
16. generate a client-readable Markdown/printable report;
17. execute core workflows, runs and schedules through the CLI;
18. run locally or through a hardened non-root container with persistent storage.

## Execution/safety contract

Automatic collection is an adapter boundary, not a promise that Research Studio contains its own unrestricted scraper.

- The server launches only an operator-configured executable with fixed operator-configured arguments and `shell:false`.
- Project/client text is passed through a JSON stdin protocol, not interpolated into a shell command.
- Per-run note/comment/runtime budgets are bounded by the Studio before execution.
- Executor stdout is size-bounded and runtime is time-bounded.
- `CAPTCHA`, `LOGIN_REQUIRED`, `ACCESS_DENIED`, `BLOCKED`, `THROTTLED`, or `meta.loginRequired=true` force `manual_action_required` instead of auto-continuation.
- Missing executor configuration produces `manual_action_required`; it never fabricates a successful snapshot.
- A project may have at most one launching/active run in a Studio process. Concurrent launch requests must not create orphan queued runs.
- Cancellation is allowed while execution is still safely abortable. Once snapshot commit begins, cancellation is rejected rather than persisting `cancelled` alongside a committed snapshot.
- On restart, an interrupted `running` state is failed closed because the old child-process result can no longer be trusted.
- A due schedule advances its next claim before execution and never starts an overlapping run for the same project.

## Interpretation contract

The product must not silently overstate its methods:

- Search rank means observed captured-page position only.
- Recurring-term evidence groups are lexical, not semantic embedding clusters.
- Comment signal queues are rule-based and auditable, not a trained sentiment model.
- Weighted engagement is a triage heuristic, not causal business value.
- Sample absence is not evidence of deletion.
- Quality scores are evidence-hygiene triage indicators, not statistical confidence intervals.

These statements are part of the product contract, not optional disclaimers.

## Commercial release gate

A build is not “commercially ready” merely because the UI starts or a demo works. A release candidate must satisfy all of the following:

### Core function

- Harvest v2 normalization and validation are internally consistent with the published schema.
- Notes, comments, authors, queries/rank observations, provenance, risk state and explicit gaps survive the full ingest → storage → analysis → export chain.
- A configured test executor can complete `plan → run → Harvest v2 → validated snapshot` through the public API.
- No-executor and platform-hard-stop paths land in explicit manual-action state without creating a fake snapshot.
- Recurring schedules survive restart, avoid overlap, and produce new snapshots when execution succeeds.
- Historical snapshots created by older versions remain readable or are explicitly migrated.
- Snapshot comparison does not turn sampling absence into deletion claims.

### Reliability

- Syntax checks pass.
- Unit/regression/security/compatibility tests pass.
- API end-to-end smoke passes.
- A real-browser smoke test covers both the research/report path and the run/schedule safety path.
- malformed, empty, duplicate and boundary inputs have deterministic behavior.
- concurrent launch requests cannot create a second orphan run for the same project.
- cancellation cannot race a persisted snapshot into a contradictory terminal state.
- storage writes are atomic and corrupt storage is surfaced rather than silently reset.
- critical export paths are verified.
- no known P0/P1 defects remain.

### Deployment

- Docker image builds.
- Runtime is non-root.
- Compose defaults to localhost exposure and no-new-privileges.
- The root filesystem can remain read-only while the dedicated data volume is writable.
- Persistent data remains available after a container restart.
- health endpoint works without exposing internal filesystem paths.
- Container validation proves both no-executor fail-safe behavior and a configured test-executor run that persists a snapshot.

### Evidence quality

- source URLs use safe HTTP(S) provenance only;
- non-normal collection states remain visible;
- CAPTCHA/ACCESS_DENIED/BLOCKED are treated as hard evidence-quality blockers;
- important client-facing findings remain traceable to note/comment/source evidence;
- data gaps are reported rather than converted into zero/absence claims.

### Scale floor

The automated regression suite exercises at least 500 notes and 5,000 comments in a single analysis/diff workload under a deliberately generous CI time budget. This is an engineering floor, not a statement about maximum supported scale.

### Method validity

The current signal layer may be commercially useful as auditable analyst triage, but must not be marketed as a scientifically validated sentiment classifier until a separately reviewed labeled evaluation corpus meets the validation requirements in `METHODOLOGY.md`.

## Validation evidence expected at release

A release record should include:

- release/main commit SHA;
- exact automated test commands;
- passed/failed test counts;
- API end-to-end result;
- real-browser run/report result;
- Docker build result;
- non-root/read-only runtime evidence;
- persistence-after-restart result;
- configured container executor → snapshot result;
- scale-test workload and measured runtime;
- example normalized input/output and client export;
- known limitations and residual risks.

If any required item is unverified, the product should be described as a release candidate rather than complete.

## Next product increments after the controlled-run release

Ordered by expected commercial value:

1. **Grounded LLM synthesis** — decision summaries that cite note/comment IDs, expose counter-evidence, and never replace raw evidence.
2. **Saved alert rules and digests** — configurable observed-rank drops, complaint growth, new high-signal evidence and capture degradation notifications.
3. **Shareable client view** — read-only report links with optional agency branding.
4. **Team/workspace controls** — users, roles, projects, audit log and usage budgets.
5. **Durable hosted storage / multi-instance coordination** — database/object storage and distributed run locks rather than local JSON/process locks.
6. **Billing** — pilot checkout, recurring plans, invoices/cancellation and entitlement/usage accounting.

These increments should not be used to postpone fixing release-blocking correctness, evidence, or safety problems in the current local product.

## Safety/product boundary

The product remains read-oriented and evidence-oriented. It does not implement CAPTCHA bypass, account-pool rotation, fingerprint spoofing, automated engagement, access-control bypass, or automated continuation after platform safety systems block a session.
