# Xiaohongshu Evidence Connector — Paid Technical Pilot

A 7-day paid technical pilot for AI products, social-intelligence platforms, market-research teams, and agencies that already need Xiaohongshu / RedNote evidence but do not want to maintain another fragile page-reading layer themselves.

## Positioning

This is a **read-oriented evidence connector**, not a replacement for your analytics, strategy, or social-management product.

It turns publicly available Xiaohongshu pages into a consistent structured schema using a browser-first collection workflow with OCR fallback when information exists only inside image/video frames.

## Supported task surfaces

### `get_note(url)`
Returns a structured note record including, when visible:
- title / body / content type
- publish and update time
- IP location
- topics / tags / @ mentions
- author statement
- engagement counts
- author identity fields
- image URLs / dimensions
- video metadata
- first available comment evidence

### `get_comments(note)`
Returns available comment records including:
- comment ID
- text
- like count
- user
- author-reply marker
- parent / sub-comment relationship when available
- cursor / `hasMore` state where exposed

### `get_creator(profile)`
Returns available public creator fields including:
- nickname
- RedNote ID
- bio
- IP location
- follower / following / interaction statistics
- visible profile tags

### `get_creator_notes(profile)`
Collects visible note cards from creator tabs and normalizes them by note ID.

### `search_xhs(keyword)`
Collects visible search/feed cards and normalizes:
- note ID
- title
- content type
- cover
- likes
- author
- token needed to open the detail page when available

### `extract_media_text(note)`
Uses screenshot + OCR fallback for text embedded only in images or video frames.

## Reliability model

The connector does not silently pretend missing data is complete.

Every run records important collection gaps, for example:
- login required
- pagination unavailable
- comment `hasMore` not fully traversed
- expired page token
- OCR required
- page unavailable

Notes are deduplicated by `noteId`; comments are deduplicated by `comment.id`.

## Canonical output shape

```json
{
  "source": {
    "platform": "xiaohongshu",
    "capturedAt": "ISO8601",
    "entry": "search|profile|note|shortlink",
    "keyword": ""
  },
  "notes": [{
    "noteId": "",
    "title": "",
    "desc": "",
    "type": "video|normal",
    "publishTime": 0,
    "lastUpdateTime": 0,
    "ipLocation": "",
    "tags": [],
    "atUsers": [],
    "authorStatement": "",
    "author": {"userId": "", "nickname": "", "profileUrl": ""},
    "stats": {"likes": 0, "collects": 0, "comments": 0, "shares": 0},
    "media": {"images": [], "videoUrl": "blob(mse)", "ocrTexts": []},
    "comments": []
  }],
  "authors": [],
  "meta": {
    "collected": 0,
    "deduped": 0,
    "gaps": [],
    "loginRequired": false
  }
}
```

## What the pilot tests

The technical pilot answers one question:

> Does this evidence layer save enough engineering or analyst time in one real Xiaohongshu workflow to justify integrating or using it again?

Suitable benchmarks include:
- social-listening evidence collection
- custom consumer-research corpus creation
- competitor / keyword research
- AI research-agent grounding
- source verification behind analyst conclusions
- media-text extraction for image-heavy posts

## 7-day scope

**US$149 flat** or **¥999** for China-based teams.

One agreed real use case:
- up to 10 search themes / keywords
- one brand/category/research brief
- structured note/comment/creator corpus
- source references and capture metadata where available
- OCR text where relevant
- explicit gaps and limitations
- Excel / JSON delivery

No long-term commitment is required for the pilot.

## Boundaries

- Public research workflow only.
- No platform-wide completeness claim.
- No CAPTCHA bypass, login bypass, access-control bypass, or anti-detection promise.
- Availability depends on the public evidence accessible for the agreed scope.
- Important gaps are reported rather than hidden.

## Start

Reply to the outreach email with:

**pilot + use case**

You will receive the exact test scope, required inputs, delivery format, and payment details before work begins.
