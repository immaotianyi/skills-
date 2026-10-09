# XHS Research Studio — Product Contract

## Product promise

Turn a bounded Xiaohongshu research question into a reusable, source-traceable research asset instead of a one-off spreadsheet.

The product has two layers:

1. **Harvest Skill** — obtains authorized/public Xiaohongshu evidence and emits Harvest v2 JSON.
2. **Research Studio** — stores snapshots, compares change, surfaces comment signals, tracks search visibility, clusters evidence, exports CSV and generates client-readable reports.

## Primary jobs to be done

### Agency analyst

“I need to deliver a competitor/category scan without spending half a day manually opening notes and copying comments.”

### Brand insight / strategy team

“I need to know what changed, how we rank for important search themes, what users repeatedly ask/complain about, and be able to click back to evidence.”

### Research / social-intelligence team

“I already sell analysis. I need a cleaner evidence-collection and normalization layer that can feed my existing workflow.”

## MVP definition of done

A user can:

1. create a project with client/category/keywords/competitors;
2. start from a brand-monitor / competitor-scan / product-opportunity template;
3. copy a Harvest plan into an Agent;
4. ingest one or more Harvest JSON snapshots;
5. inspect coverage and explicit data gaps;
6. see questions, complaints, purchase-intent and positive comment signals;
7. click a theme and inspect supporting comments and source notes;
8. see top notes and source URLs;
9. see keyword search rankings when Harvest includes `queries[].rankingPosition`;
10. compare two snapshots for new notes, engagement movers, emerging terms and rank changes;
11. export an evidence CSV;
12. copy a Markdown research report.

All twelve are implemented in the current MVP.

## Next product increments

Ordered by expected commercial value:

1. **Direct Agent handoff** — invoke Harvest from a project instead of copy/paste JSON.
2. **Scheduled monitoring** — run a saved project on a cadence and ingest a new snapshot automatically.
3. **Grounded LLM synthesis** — decision summaries that cite note/comment IDs and never replace raw evidence.
4. **Saved alert rules** — e.g. rank drops, new complaint cluster, fast-growing competitor note.
5. **Shareable client view** — read-only report link with optional agency branding.
6. **Team/workspace controls** — users, roles, projects and usage budgets.
7. **Billing** — pilot checkout, recurring plans and usage accounting.

## Current engineering validation

`smoke-test.mjs` checks an isolated end-to-end run: server start, project creation, v2 ingest, comment signals, negation handling, ranking analytics, evidence clusters, a second snapshot, rank changes/new entries, CSV export and Markdown report.

## Safety/product boundary

The product remains read-oriented and evidence-oriented. It does not implement CAPTCHA bypass, account-pool rotation, fingerprint spoofing, automated engagement, or other mechanisms whose purpose is to evade platform safety controls.
