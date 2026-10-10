const CAPTURE_METHODS = new Set(['initial_state','rendered_dom','ocr','mixed','unknown']);
const ENTRIES = new Set(['search','profile','note','shortlink','topic','feed','mixed','unknown']);
const RISK_STATES = new Set(['NORMAL','THROTTLED','LOGIN_REQUIRED','CAPTCHA','ACCESS_DENIED','BLOCKED']);
const DEFAULT_CONFIDENCE = Object.freeze({
  initial_state: 0.98,
  rendered_dom: 0.90,
  ocr: 0.72,
  mixed: 0.85,
  unknown: 0.50,
});

export function safeText(v='') {
  return String(v ?? '').trim();
}

export function safeHttpUrl(v='') {
  const raw = safeText(v);
  if (!raw) return '';
  try {
    const url = new URL(raw);
    if (!['http:','https:'].includes(url.protocol)) return '';
    return url.href;
  } catch {
    return '';
  }
}

export function num(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? Math.max(0, Math.round(v)) : 0;
  const raw = safeText(v).replace(/,/g, '').replace(/[+＋]\s*$/u, '');
  if (!raw) return 0;
  const m = raw.match(/-?\d+(?:\.\d+)?/);
  if (!m) return 0;
  let multiplier = 1;
  if (/亿/u.test(raw)) multiplier = 100_000_000;
  else if (/万|[wW]/u.test(raw)) multiplier = 10_000;
  else if (/[kK]/u.test(raw)) multiplier = 1_000;
  else if (/[mM]/u.test(raw)) multiplier = 1_000_000;
  const n = Number(m[0]) * multiplier;
  return Number.isFinite(n) ? Math.max(0, Math.round(n)) : 0;
}

function normalizeDateTime(v, fallback='') {
  if (typeof v === 'string' && v.trim() && Number.isFinite(Date.parse(v))) return new Date(v).toISOString();
  if (fallback && Number.isFinite(Date.parse(fallback))) return new Date(fallback).toISOString();
  return new Date().toISOString();
}

function normalizeCaptureMethod(v) {
  const method = safeText(v || 'unknown');
  return CAPTURE_METHODS.has(method) ? method : 'unknown';
}

function normalizeEntry(v) {
  const entry = safeText(v || 'unknown');
  return ENTRIES.has(entry) ? entry : 'unknown';
}

function normalizeRiskState(v, loginRequired=false) {
  const state = safeText(v || (loginRequired ? 'LOGIN_REQUIRED' : 'NORMAL'));
  if (!RISK_STATES.has(state)) return loginRequired ? 'LOGIN_REQUIRED' : 'NORMAL';
  if (loginRequired && state === 'NORMAL') return 'LOGIN_REQUIRED';
  return state;
}

function normalizeConfidence(v, captureMethod) {
  const n = Number(v);
  if (Number.isFinite(n)) return Math.min(1, Math.max(0, n));
  return DEFAULT_CONFIDENCE[captureMethod] ?? DEFAULT_CONFIDENCE.unknown;
}

function uniqStrings(values=[]) {
  return [...new Set(values.map(safeText).filter(Boolean))];
}

function normalizeComment(c={}, noteId='', noteSourceUrl='') {
  const user = typeof c.user === 'object' && c.user !== null
    ? safeText(c.user.nickname || c.user.nickName || c.user.userId)
    : safeText(c.user || c.userInfo?.nickname || c.userInfo?.nickName || c.userInfo?.userId);
  return {
    id: safeText(c.id || c.commentId),
    noteId: safeText(c.noteId || noteId),
    parentCommentId: safeText(c.parentCommentId || c.parentId),
    content: safeText(c.content),
    likes: num(c.likes ?? c.likeCount),
    isAuthor: Boolean(c.isAuthor ?? c.is_author ?? (Array.isArray(c.showTags) && c.showTags.includes('is_author'))),
    user,
    publishedAt: c.publishedAt ?? c.createTime ?? null,
    sourceUrl: safeHttpUrl(c.sourceUrl || noteSourceUrl),
  };
}

function normalizeAuthor(author={}) {
  if (typeof author === 'string') {
    return { userId:'', nickname:safeText(author), profileUrl:'' };
  }
  const value = author && typeof author === 'object' ? author : {};
  return {
    userId: safeText(value.userId || value.id),
    nickname: safeText(value.nickname || value.nickName || value.name),
    profileUrl: safeHttpUrl(value.profileUrl || value.url),
  };
}

function normalizeNote(n={}, source={}) {
  const stats = n.stats || n.interactInfo || {};
  const noteId = safeText(n.noteId || n.id);
  const sourceUrl = safeHttpUrl(n.sourceUrl || n.url);
  const captureMethod = normalizeCaptureMethod(n.captureMethod || source.captureMethod || 'unknown');
  const tags = (Array.isArray(n.tags) ? n.tags : Array.isArray(n.tagList) ? n.tagList : [])
    .map(t => typeof t === 'string' ? t : safeText(t?.name || t?.title))
    .filter(Boolean);
  const rawComments = Array.isArray(n.comments) ? n.comments : [];
  const author = normalizeAuthor(n.author || n.user || {});
  return {
    noteId,
    title: safeText(n.title || n.displayTitle),
    desc: safeText(n.desc || n.description),
    type: safeText(n.type || 'normal'),
    publishTime: n.publishTime ?? n.time ?? null,
    lastUpdateTime: n.lastUpdateTime ?? null,
    ipLocation: safeText(n.ipLocation),
    tags: uniqStrings(tags),
    atUsers: Array.isArray(n.atUsers) ? n.atUsers : Array.isArray(n.atUserList) ? n.atUserList : [],
    authorStatement: safeText(n.authorStatement || n.noteStatement),
    author,
    stats: {
      likes: num(stats.likes ?? stats.likedCount ?? stats.likeCount),
      collects: num(stats.collects ?? stats.collectedCount ?? stats.collectCount),
      comments: num(stats.comments ?? stats.commentCount),
      shares: num(stats.shares ?? stats.shareCount),
    },
    media: n.media && typeof n.media === 'object'
      ? n.media
      : { images: Array.isArray(n.images) ? n.images : [], ocrTexts: Array.isArray(n.ocrTexts) ? n.ocrTexts : [] },
    comments: rawComments.map(c => normalizeComment(c, noteId, sourceUrl)),
    sourceUrl,
    captureMethod,
    confidence: normalizeConfidence(n.confidence, captureMethod),
  };
}

function normalizeQuery(q={}, fallbackCapturedAt='') {
  const keyword = safeText(q.keyword);
  const seen = new Set();
  const results = [];
  for (const [i, r] of (Array.isArray(q.results) ? q.results : []).entries()) {
    if (!r || typeof r !== 'object') continue;
    const noteId = safeText(r.noteId || r.id);
    const title = safeText(r.title || r.displayTitle);
    if (!noteId && !title) continue;
    const rawRank = Number(r.rankingPosition ?? r.rank ?? i + 1);
    const rankingPosition = Number.isInteger(rawRank) && rawRank > 0 ? rawRank : i + 1;
    const author = safeText(r.author?.nickname || r.author || r.user?.nickname || r.user?.nickName);
    const key = noteId || `${title}::${author}`;
    if (seen.has(key)) continue;
    seen.add(key);
    results.push({
      noteId,
      rankingPosition,
      sourceUrl: safeHttpUrl(r.sourceUrl || r.url),
      title,
      author,
    });
  }
  results.sort((a,b) => a.rankingPosition - b.rankingPosition);
  return { keyword, capturedAt: normalizeDateTime(q.capturedAt, fallbackCapturedAt), results };
}

function deriveAuthors(rawAuthors, notes) {
  if (Array.isArray(rawAuthors) && rawAuthors.length) return rawAuthors.map(normalizeAuthor);
  const seen = new Set();
  const authors = [];
  for (const n of notes) {
    const a = n.author || {};
    const key = a.userId || a.nickname;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    authors.push(a);
  }
  return authors;
}

export function normalizeHarvest(raw={}) {
  const input = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const inputSchemaVersion = safeText(input.schemaVersion || 'legacy/unknown');
  const capturedAt = normalizeDateTime(input.source?.capturedAt || input.capturedAt);
  const loginRequired = Boolean(input.meta?.loginRequired);
  const source = {
    platform: 'xiaohongshu',
    capturedAt,
    entry: normalizeEntry(input.source?.entry),
    keyword: safeText(input.source?.keyword),
    sourceUrl: safeHttpUrl(input.source?.sourceUrl || input.source?.url),
    captureMethod: normalizeCaptureMethod(input.source?.captureMethod),
  };

  const rawNotes = Array.isArray(input.notes) ? input.notes : [];
  const normalizedNotes = rawNotes.filter(n => n && typeof n === 'object').map(n => normalizeNote(n, source));
  const seenNotes = new Set();
  const notes = normalizedNotes.filter(n => {
    const key = n.noteId || `${n.author.nickname}:${n.title}:${n.sourceUrl}`;
    if (!key) return true;
    if (seenNotes.has(key)) return false;
    seenNotes.add(key);
    return true;
  });

  const noteSources = new Map(notes.map(n => [n.noteId,n.sourceUrl]));
  const nested = notes.flatMap(n => n.comments);
  const top = (Array.isArray(input.comments) ? input.comments : [])
    .filter(c => c && typeof c === 'object')
    .map(c => normalizeComment(c, c.noteId, noteSources.get(safeText(c.noteId)) || ''));
  const allComments = [...nested, ...top].filter(c => c.id || c.content);
  const seenComments = new Set();
  const comments = allComments.filter(c => {
    const key = c.id || `${c.noteId}:${c.user}:${c.content}`;
    if (seenComments.has(key)) return false;
    seenComments.add(key);
    return true;
  });

  const queries = (Array.isArray(input.queries) ? input.queries : [])
    .filter(q => q && typeof q === 'object')
    .map(q => normalizeQuery(q, capturedAt))
    .filter(q => q.keyword);

  const gaps = Array.isArray(input.meta?.gaps) ? input.meta.gaps : [];
  const riskState = normalizeRiskState(input.meta?.riskState, loginRequired);
  const reportedCollected = Number.isInteger(input.meta?.collected) && input.meta.collected >= 0 ? input.meta.collected : null;
  const reportedDeduped = Number.isInteger(input.meta?.deduped) && input.meta.deduped >= 0 ? input.meta.deduped : null;

  return {
    schemaVersion: '2.0',
    source,
    notes,
    comments,
    authors: deriveAuthors(input.authors, notes),
    queries,
    meta: {
      inputSchemaVersion,
      collected: reportedCollected ?? rawNotes.length,
      deduped: notes.length,
      reportedCollected,
      reportedDeduped,
      gaps,
      loginRequired: loginRequired || riskState === 'LOGIN_REQUIRED',
      riskState,
      sampleBudget: Number.isInteger(input.meta?.sampleBudget) && input.meta.sampleBudget >= 0 ? input.meta.sampleBudget : null,
      stoppedBecause: safeText(input.meta?.stoppedBecause),
    },
  };
}
