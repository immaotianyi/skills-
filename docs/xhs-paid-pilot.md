# Xiaohongshu Research Data Pilot

A 7-day paid pilot for agencies and brand teams that already spend analyst time on Xiaohongshu / RedNote competitor research, keyword scans, comment review, and client reporting.

## What this is

A browser-native research layer that turns **public Xiaohongshu pages** into structured, source-traceable data.

It can structure:

- Notes: title, body, type, publish/update time, IP location, tags, mentions, author statement
- Engagement: likes, collects, comments, shares
- Comments: text, likes, user, author-reply flag, parent/sub-comment structure when available
- Creators: nickname, RedNote ID, bio, follower/following/engagement stats when visible
- Search/feed result cards: title, type, author, likes, cover, note ID
- Media text: OCR fallback for text that exists only inside images/video frames
- Source gaps: explicit reporting when login, pagination or page availability limits the capture

The system is designed for **public research use**. It does not bypass CAPTCHAs, login restrictions, access controls or platform safety mechanisms.

## 7-day agency pilot

**US$149 flat** (or **¥999** for China-based teams)

Use one real client/category, not a synthetic demo.

Pilot scope:

- 1 live client or category
- up to 5 competitors
- up to 10 agreed search themes / keywords
- structured Excel/JSON delivery
- relevant note + comment corpus within the agreed sample
- recurring audience questions / objections / complaint themes
- high-signal post candidates
- traceable source URLs / evidence where available
- explicit data gaps and collection limitations

## What the pilot is testing

Not whether Xiaohongshu data exists.

The question is whether this workflow removes enough repetitive manual work from:

1. competitor/category scans,
2. keyword and search research,
3. comment mining,
4. evidence gathering,
5. weekly/monthly client reporting,

to be worth using again.

## Example structured record

```json
{
  "source": {
    "platform": "xiaohongshu",
    "entry": "search|profile|note|shortlink",
    "capturedAt": "ISO8601"
  },
  "notes": [{
    "noteId": "...",
    "title": "...",
    "desc": "...",
    "type": "normal|video",
    "author": {"userId": "...", "nickname": "..."},
    "stats": {"likes": 0, "collects": 0, "comments": 0, "shares": 0},
    "tags": [],
    "comments": [{"id": "...", "content": "...", "likes": 0, "isAuthor": false}],
    "media": {"images": [], "ocrTexts": []}
  }],
  "meta": {
    "collected": 0,
    "deduped": 0,
    "gaps": [],
    "loginRequired": false
  }
}
```

## Good pilot briefs

- “What are the recurring complaints and purchase questions around sensitive-skin sunscreen?”
- “Track the visible Xiaohongshu content landscape for five competing hotel brands.”
- “Build a source-backed corpus for the top search themes around a new beauty category.”
- “Reduce the manual collection behind our weekly competitor report.”

## To start

Reply to the outreach email with:

**pilot + your category/client type**

You will receive the exact scope, inputs required, delivery format and payment details before work begins.
