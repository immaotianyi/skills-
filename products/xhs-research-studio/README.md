# XHS Research Studio

A zero-dependency local product layer above `xiaohongshu-harvest`.

Harvest reads authorized/public Xiaohongshu evidence and emits structured JSON. Research Studio turns those snapshots into reusable research, monitoring, evidence and client deliverables.

## Run

Requires Node.js 20+.

```bash
node products/xhs-research-studio/server.mjs
# open http://127.0.0.1:5418
```

No npm install or database is required. Runtime data is written to `products/xhs-research-studio/data/` by default; override with `XHS_STUDIO_DATA=/path`.

## Container deployment

From the product directory:

```bash
cd products/xhs-research-studio
docker compose up --build
# open http://127.0.0.1:5418
```

The included container stores projects/snapshots in the persistent `xhs_studio_data` volume.

## Product capabilities

- Project model: client, category, keywords, competitors
- Built-in project templates: brand monitoring, competitor scan, product opportunity
- Harvest JSON ingestion + normalization (v1 compatible, Harvest v2 native)
- First-class notes + comments
- Snapshot history
- Snapshot diff: added/removed notes, engagement movers, emerging comment terms
- Search visibility from `queries[].rankingPosition`
- Search-rank diff: up/down changes, new entries, exits
- Auto-triage: rank drops, complaint growth, fast movers, new high-signal notes, non-normal capture state
- Comment signals: questions, complaints, purchase intent, positive feedback
- Evidence clusters: theme → supporting comments → source notes
- High-signal note ranking
- Source/evidence table
- Explicit gaps / login-required / risk-state display
- Copyable Harvest plan for the Agent
- Downloadable Evidence Pack JSON for downstream grounded analysis
- Client-ready Markdown report
- Print / Save-as-PDF client report
- CSV evidence export
- Built-in demo dataset
- Agent/script-friendly CLI

## API

- `GET /api/health`
- `GET /api/templates`
- `GET|POST /api/projects`
- `GET /api/projects/:id`
- `GET /api/projects/:id/plan`
- `POST /api/projects/:id/ingest`
- `GET /api/projects/:id/snapshots`
- `GET /api/projects/:id/snapshots/:snapshotId`
- `GET /api/projects/:id/diff?from=&to=`
- `GET /api/projects/:id/ranks`
- `GET /api/projects/:id/evidence?term=`
- `GET /api/projects/:id/export.csv`
- `GET /api/projects/:id/report?format=json`
- `POST /api/analyze`

## CLI

With the server running:

```bash
node products/xhs-research-studio/cli.mjs health
node products/xhs-research-studio/cli.mjs projects
node products/xhs-research-studio/cli.mjs create --name "Brand Monitor" --keywords "品牌词,品类词" --competitors "A,B,C"
node products/xhs-research-studio/cli.mjs plan PROJECT_ID
node products/xhs-research-studio/cli.mjs ingest PROJECT_ID harvest.json
node products/xhs-research-studio/cli.mjs diff PROJECT_ID
node products/xhs-research-studio/cli.mjs ranks PROJECT_ID
node products/xhs-research-studio/cli.mjs report PROJECT_ID
```

Set `XHS_STUDIO_URL` or pass `--base` to point the CLI at another Studio instance.

## Smoke test

```bash
node products/xhs-research-studio/smoke-test.mjs
```

The smoke test starts the product with an isolated temporary data directory and checks project creation, ingestion, comment signals, ranking analytics, evidence clusters, two-snapshot diff, CSV and Markdown report output.

## Product boundary

This product does not bypass Xiaohongshu login, CAPTCHA, rate limits, access controls or platform safety mechanisms. It accepts evidence produced by an authorized/read-only Harvest workflow and makes that evidence useful for research, monitoring and delivery.
