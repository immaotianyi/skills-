# XHS Research Studio — Product Contract

## Product promise

Turn a bounded Xiaohongshu research question into a reusable, source-traceable research asset instead of a one-off spreadsheet, while keeping collection gaps, interpretation limits, and source evidence visible.

The product has two layers:

1. **Harvest Skill** — obtains public or user-authorized Xiaohongshu evidence and emits Harvest v2 JSON without bypassing platform safety controls.
2. **Research Studio** — validates and stores snapshots, compares observed change, surfaces auditable comment signals, tracks observed search visibility, groups lexical evidence, exports client deliverables, and keeps conclusions traceable to source evidence.

## Primary jobs to be done

### Agency analyst

“I need to deliver a competitor/category scan without spending half a day manually opening notes and copying comments, and I need to show where each conclusion came from.”

### Brand insight / strategy team

“I need to know what changed, how we were observed for important search themes, what users repeatedly ask or complain about, and which source evidence supports the finding.”

### Research / social-intelligence team

“I already sell analysis. I need a cleaner evidence-collection, normalization, provenance, and export layer that can feed my existing workflow.”

## Functional contract

A user can:

1. create a project with client/category/keywords/competitors;
2. start from a brand-monitor / competitor-scan / product-opportunity template;
3. copy a bounded Harvest plan into an Agent;
4. validate and ingest one or more Harvest snapshots;
5. inspect coverage, explicit gaps, capture risk state, source method and confidence;
6. see auditable rule-based questions, complaints, purchase-intent and positive-feedback queues;
7. click a recurring lexical term and inspect supporting comments and source notes;
8. see high-signal notes and source URLs;
9. see keyword search positions when Harvest includes `queries[].rankingPosition`;
10. compare two snapshots for new notes, previously-observed/not-currently-observed notes, engagement movers, emerging terms and observed rank changes;
11. export evidence CSV and a structured Evidence Pack;
12. generate a client-readable Markdown/printable report;
13. execute core workflows through the CLI;
14. run locally or through a hardened non-root container with persistent storage.

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
- Historical snapshots created by older versions remain readable or are explicitly migrated.
- Snapshot comparison does not turn sampling absence into deletion claims.

### Reliability

- Syntax checks pass.
- Unit/regression/security/compatibility tests pass.
- API end-to-end smoke passes.
- malformed, empty, duplicate and boundary inputs have deterministic behavior.
- storage writes are atomic and corrupt storage is surfaced rather than silently reset.
- critical export paths are verified.
- no known P0/P1 defects remain.

### Deployment

- Docker image builds.
- Runtime is non-root.
- Compose defaults to localhost exposure and no-new-privileges.
- Persistent data remains available after a container restart.
- health endpoint works without exposing internal filesystem paths.

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
- Docker build result;
- non-root runtime evidence;
- persistence-after-restart result;
- scale-test workload and measured runtime;
- example normalized input/output and client export;
- known limitations and residual risks.

If any required item is unverified, the product should be described as a release candidate rather than complete.

## Next product increments after the hardened local release

Ordered by expected commercial value:

1. **Direct Agent handoff** — invoke Harvest from a project instead of copy/paste JSON.
2. **Scheduled monitoring** — run a saved project on a cadence and ingest a new snapshot automatically.
3. **Grounded LLM synthesis** — decision summaries that cite note/comment IDs and never replace raw evidence.
4. **Saved alert rules** — e.g. observed rank drops, new complaint group, fast-growing competitor note.
5. **Shareable client view** — read-only report link with optional agency branding.
6. **Team/workspace controls** — users, roles, projects and usage budgets.
7. **Billing** — pilot checkout, recurring plans and usage accounting.

These increments should not be used to postpone fixing release-blocking correctness, evidence, or safety problems in the current local product.

## Safety/product boundary

The product remains read-oriented and evidence-oriented. It does not implement CAPTCHA bypass, account-pool rotation, fingerprint spoofing, automated engagement, access-control bypass, or automated continuation after platform safety systems block a session.
