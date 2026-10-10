# XHS Research Studio

A zero-dependency local product layer above `xiaohongshu-harvest`.

Harvest reads public or user-authorized Xiaohongshu evidence and emits structured JSON. Research Studio validates and normalizes those snapshots, preserves provenance and coverage limits, compares change, exposes analyst-triage signals, and produces reusable client deliverables.

## Run

Requires Node.js 22+ for the validated development/runtime path.

```bash
node products/xhs-research-studio/server.mjs
# open http://127.0.0.1:5418
```

No npm install or database is required. Runtime data is written to `products/xhs-research-studio/data/` by default; override with `XHS_STUDIO_DATA=/path`.

The default host is loopback-only. If you intentionally bind to another interface, add appropriate network/authentication controls outside the app.

## Container deployment

From the product directory:

```bash
cd products/xhs-research-studio
docker compose up --build
# open http://127.0.0.1:5418
```

The container runs as a non-root user. Compose binds the service to localhost, uses a read-only root filesystem, enables `no-new-privileges`, and stores projects/snapshots in the persistent `xhs_studio_data` volume.

## Product capabilities

- Project model: client, category, keywords, competitors
- Built-in templates: brand monitoring, competitor scan, product opportunity
- Harvest input validation + normalization (legacy-compatible input, strict Harvest v2 contract)
- First-class notes + comments
- Snapshot history with atomic JSON writes
- Serialized in-process project mutations to prevent lost updates under concurrent requests
- Backward-compatible in-memory analysis refresh for older snapshots
- Snapshot diff: added notes, previously observed/not-currently-observed notes, engagement movers, emerging comment terms
- Observed search visibility from `queries[].rankingPosition`
- Search-rank diff: up/down changes, new entries, exits
- Auto-triage: rank drops, complaint growth, fast movers, new high-signal notes, non-normal capture state
- Transparent rule-based comment signals: questions, complaints, purchase intent, positive feedback
- Lexical recurring-term evidence groups: term → supporting comments → source notes
- Transparent weighted engagement review score
- Evidence-quality warnings and coverage score
- Source/evidence table with capture method and confidence
- Explicit gaps / login-required / risk-state display
- Copyable Harvest plan for an Agent
- Downloadable server-generated Evidence Pack JSON
- Client-ready Markdown report
- Print / Save-as-PDF client report
- CSV evidence export
- Built-in non-live demo dataset
- Script-friendly CLI

## Interpretation rules

The product intentionally avoids stronger claims than the evidence supports:

- `rankingPosition` is an observed position for the captured keyword/time/session, not a universal platform rank.
- “Evidence clusters” are lexical recurring-term groups, not semantic embedding clusters or topic-model output.
- Comment signals are transparent lexicon/rule queues with local negation handling, not a trained sentiment classifier.
- The weighted engagement score is a review-priority heuristic, not a causal value/conversion model.
- A note absent from a later sample is “not observed in the current sample”, not automatically “deleted”.

See [`METHODOLOGY.md`](./METHODOLOGY.md) for methodology, references, safety constraints, and scientific-validation limits.

## API

- `GET /api/health`
- `GET /api/templates`
- `GET|POST /api/projects`
- `POST /api/validate`
- `POST /api/analyze`
- `GET /api/projects/:id`
- `GET /api/projects/:id/plan`
- `POST /api/projects/:id/ingest`
- `GET /api/projects/:id/snapshots`
- `GET /api/projects/:id/snapshots/:snapshotId`
- `GET /api/projects/:id/diff?from=&to=`
- `GET /api/projects/:id/ranks`
- `GET /api/projects/:id/evidence?term=`
- `GET /api/projects/:id/export.csv`
- `GET /api/projects/:id/evidence-pack`
- `GET /api/projects/:id/report?format=json`

Request bodies are size-bounded and malformed JSON/invalid Harvest structures return structured client errors rather than silent normalization or generic success.

## CLI

With the server running:

```bash
node products/xhs-research-studio/cli.mjs health
node products/xhs-research-studio/cli.mjs projects
node products/xhs-research-studio/cli.mjs validate harvest.json
node products/xhs-research-studio/cli.mjs analyze harvest.json
node products/xhs-research-studio/cli.mjs create --name "Brand Monitor" --keywords "品牌词,品类词" --competitors "A,B,C"
node products/xhs-research-studio/cli.mjs plan PROJECT_ID
node products/xhs-research-studio/cli.mjs ingest PROJECT_ID harvest.json
node products/xhs-research-studio/cli.mjs diff PROJECT_ID
node products/xhs-research-studio/cli.mjs ranks PROJECT_ID
node products/xhs-research-studio/cli.mjs evidence PROJECT_ID --term 辣眼
node products/xhs-research-studio/cli.mjs report PROJECT_ID --out report.md
node products/xhs-research-studio/cli.mjs pack PROJECT_ID --out evidence-pack.json
node products/xhs-research-studio/cli.mjs csv PROJECT_ID --out evidence.csv
```

Set `XHS_STUDIO_URL` or pass `--base` to point the CLI at another Studio instance.

## Quality gate

Run the same major checks used by CI:

```bash
node --check products/xhs-research-studio/server-v2.mjs
node --check products/xhs-research-studio/public/app.js
node --check products/xhs-research-studio/cli.mjs
node --check products/xhs-research-studio/browser-smoke.mjs
node --test products/xhs-research-studio/test/*.test.mjs
node products/xhs-research-studio/smoke-test.mjs
node products/xhs-research-studio/browser-smoke.mjs
```

The browser smoke uses a real headless Chrome/Chromium DevTools session: it opens the product, waits for templates, clicks the built-in demo, verifies notes/evidence groups render, opens the client report, and fails on browser runtime errors.

The GitHub Actions quality gate additionally builds the hardened Docker image, verifies the container is non-root, writes a project to the persistent data volume, restarts the container, and verifies the project is still present.

The automated suite covers unit/regression, malformed input, negation handling, safety states, URL sanitization, backward-compatible snapshot hydration, API end-to-end flow, CLI delivery/export flow, a 24-request concurrent project-create regression, exports, UI DOM/CSP contracts, Harvest Skill safety/provenance contracts, and a synthetic 500-note / 5,000-comment scale regression.

Automated test success is engineering evidence, not scientific validation of consumer-insight claims. A separately reviewed labeled corpus is required before claiming validated classifier accuracy; see `METHODOLOGY.md`.

## Product boundary

This product does not bypass Xiaohongshu login, CAPTCHA, rate limits, access controls or platform safety mechanisms. It accepts evidence produced by public or user-authorized read-only Harvest workflows and makes that evidence useful for research, monitoring and delivery.
