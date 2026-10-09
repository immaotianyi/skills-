# XHS Research Studio

A zero-dependency local MVP that turns **Xiaohongshu Harvest JSON** into reusable research assets.

It is the product layer above `xiaohongshu-harvest`: Harvest collects public-page evidence; Studio stores snapshots, compares change, mines comment signals, preserves sources, and generates client-ready Markdown reports.

## Run

Requires Node.js 20+.

```bash
node products/xhs-research-studio/server.mjs
# open http://127.0.0.1:5418
```

No database or npm install is required. Runtime data is written to `products/xhs-research-studio/data/` (override with `XHS_STUDIO_DATA=/path`).

## MVP capabilities

- Project model: client, category, keywords, competitors
- Harvest JSON ingestion + normalization (v1 compatible, v2 ready)
- First-class notes + comments
- Snapshot history
- Snapshot diff: added/removed notes, engagement movers, emerging comment terms
- Comment signals: questions, complaints, purchase intent, positive feedback
- High-signal note ranking
- Source/evidence table
- Explicit gaps / login-required / risk state display
- Copyable Harvest plan for the Agent
- Client-ready Markdown report
- CSV evidence export
- Demo dataset built into the UI

## API

- `GET /api/health`
- `GET|POST /api/projects`
- `GET /api/projects/:id`
- `GET /api/projects/:id/plan`
- `POST /api/projects/:id/ingest`
- `GET /api/projects/:id/snapshots`
- `GET /api/projects/:id/snapshots/:snapshotId`
- `GET /api/projects/:id/diff?from=&to=`
- `GET /api/projects/:id/export.csv`
- `GET /api/projects/:id/report?format=json`
- `POST /api/analyze` (stateless analysis)

## Product boundary

This app does **not** attempt to bypass Xiaohongshu login, CAPTCHA, rate limits, access controls or platform safety systems. It accepts data produced by an authorized/read-only Harvest workflow and makes that data useful for research, monitoring and client delivery.
