# QA evidence

Local smoke test executed before handoff:

- `node --check server.mjs` passed.
- `node --check public/app.js` passed.
- `GET /api/health` returned `ok: true`.
- Project creation succeeded.
- Demo Harvest ingest produced 3 notes / 8 comments.
- Complaint signal negation was corrected so `不刺痛` is not counted as a complaint.
- Second snapshot diff detected a new note and a +2000 weighted-engagement mover.
- CSV evidence export returned expected rows.
- Markdown report included coverage, signals, top notes, change summary and explicit data gaps.
