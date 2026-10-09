# XHS Research Studio — Product Contract

## Product promise

Turn a bounded Xiaohongshu research question into a reusable, source-traceable research asset instead of a one-off spreadsheet.

The product has two layers:

1. **Harvest Skill** — obtains authorized/public Xiaohongshu evidence and emits Harvest v2 JSON.
2. **Research Studio** — stores snapshots, compares change, surfaces comment signals, ranks evidence, exports CSV and generates client-readable reports.

## Primary jobs to be done

### Agency analyst

“I need to deliver a competitor/category scan without spending half a day manually opening notes and copying comments.”

### Brand insight / strategy team

“I need to know what changed, what users repeatedly ask/complain about, and be able to click back to evidence.”

### Research / social-intelligence team

“I already sell analysis. I need a cleaner evidence-collection and normalization layer that can feed my existing workflow.”

## MVP definition of done

A user can:

1. create a project with client/category/keywords/competitors;
2. copy a Harvest plan into an Agent;
3. ingest one or more Harvest JSON snapshots;
4. inspect coverage and explicit data gaps;
5. see questions, complaints, purchase-intent and positive comment signals;
6. see top notes and source URLs;
7. compare two snapshots for new notes, engagement movers and emerging terms;
8. export an evidence CSV;
9. copy a Markdown research report.

All nine are implemented in the current MVP.

## Not yet implemented

These are the next product increments, ordered by expected commercial value:

1. **Direct Agent handoff** — one-click invocation of the Harvest Skill instead of copy/paste JSON.
2. **Scheduled monitoring** — run a saved project on a cadence and ingest the new snapshot automatically.
3. **Search-rank analytics** — visualize `queries[].rankingPosition` by keyword and competitor across snapshots.
4. **Evidence clusters** — click a theme to see only the comments/notes supporting it.
5. **LLM synthesis** — grounded summaries that cite note/comment IDs and never overwrite raw evidence.
6. **Project templates** — brand monitor, competitor scan, product-opportunity study, creator research.
7. **Shareable client view** — read-only report link with optional agency branding.
8. **Team/workspace controls** — users, roles, projects, usage budgets.
9. **Billing** — pilot checkout, recurring plans, usage accounting.

## Safety/product boundary

The product should remain read-oriented and evidence-oriented. It should not implement CAPTCHA bypass, account-pool rotation, fingerprint spoofing, automated engagement, or other mechanisms whose purpose is to evade platform safety controls.
