# Xiaohongshu Research Pilot — Deliverable Template

> This is a **delivery template**, not a fabricated customer result. Real pilot outputs are populated only from the evidence collected for the agreed brief.

## 1. Brief

**Client / category:** `[agreed scope]`  
**Research question:** `[question]`  
**Competitors / comparison targets:** `[up to 5]`  
**Search themes:** `[up to 10]`  
**Capture period:** `[start → end]`

## 2. Coverage statement

- Notes collected: `[N]`
- Comments collected: `[N]`
- Creators represented: `[N]`
- Search themes run: `[N]`
- OCR-required media items: `[N]`
- Deduplicated records: `[N]`

### Important gaps

`[login restrictions / pagination limits / unavailable pages / incomplete comment traversal / other explicit limitations]`

The output does **not** claim platform-wide completeness.

## 3. Evidence corpus

Delivered as Excel / JSON with fields such as:

| Object | Example fields |
|---|---|
| Note | noteId, title, desc, type, publishTime, lastUpdateTime, ipLocation, tags, author, likes, collects, comments, shares |
| Comment | id, noteId, parentCommentId when available, content, likes, user, isAuthor |
| Creator | userId, redId, nickname, bio, ipLocation, follower/following/interaction stats when visible |
| Media | image URL/dimensions, video metadata, OCR text |
| Capture metadata | source URL / entry type / capturedAt / gaps |

## 4. Recurring audience themes

Populated only when supported by collected evidence.

| Theme | What people are asking / saying | Evidence count | Representative source records |
|---|---|---:|---|
| `[theme]` | `[summary]` | `[N]` | `[IDs / source references]` |

## 5. High-signal content candidates

| Note | Why it is high-signal for this brief | Visible engagement | Evidence / source |
|---|---|---:|---|
| `[note]` | `[reason]` | `[metrics]` | `[source]` |

“High-signal” is brief-specific and does not imply platform-wide ranking.

## 6. Questions / objections / complaints

| Consumer language cluster | Frequency in collected evidence | Notes |
|---|---:|---|
| `[cluster]` | `[N]` | `[context]` |

## 7. Optional analyst layer

When requested, the structured evidence can be summarized into:
- competitor differences
- repeated purchase questions
- recurring complaints
- content / keyword opportunities
- hypotheses that deserve deeper research

Every claim should remain traceable to the collected corpus, and conflicting evidence should be preserved rather than hidden.

## 8. Recommended next step

At the end of the 7-day pilot, decide one of three outcomes:

1. **Stop** — not enough time saved or evidence value.
2. **Repeat** — another bounded paid research brief.
3. **Integrate / monitor** — define a recurring connector or monitoring scope.

The pilot succeeds only if the customer believes the workflow is worth paying for again; delivery completion by itself is not treated as product-market validation.
