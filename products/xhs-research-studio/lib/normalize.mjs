export function safeText(v='') { return String(v ?? '').trim(); }

export function num(v) {
  const raw = String(v ?? 0);
  const n = Number(raw.replace(/[,万wW]/g, ''));
  if (!Number.isFinite(n)) return 0;
  return /万|[wW]/.test(raw) ? Math.round(n * 10000) : Math.round(n);
}

function normalizeComment(c, noteId='') {
  return {
    id: safeText(c.id || c.commentId),
    noteId: safeText(c.noteId || noteId),
    parentCommentId: safeText(c.parentCommentId || c.parentId),
    content: safeText(c.content),
    likes: num(c.likes ?? c.likeCount),
    isAuthor: Boolean(c.isAuthor ?? c.is_author),
    user: typeof c.user === 'object'
      ? safeText(c.user.nickname || c.user.userId)
      : safeText(c.user || c.userInfo?.nickname),
    publishedAt: c.publishedAt ?? c.createTime ?? null,
    sourceUrl: safeText(c.sourceUrl),
  };
}

function normalizeNote(n, source={}) {
  const stats = n.stats || n.interactInfo || {};
  const noteId = safeText(n.noteId || n.id);
  return {
    noteId,
    title: safeText(n.title || n.displayTitle),
    desc: safeText(n.desc || n.description),
    type: safeText(n.type || 'normal'),
    publishTime: n.publishTime ?? n.time ?? null,
    lastUpdateTime: n.lastUpdateTime ?? null,
    ipLocation: safeText(n.ipLocation),
    tags: (n.tags || n.tagList || []).map(t => typeof t === 'string' ? t : safeText(t.name)).filter(Boolean),
    author: {
      userId: safeText(n.author?.userId || n.user?.userId),
      nickname: safeText(n.author?.nickname || n.user?.nickname || n.user?.nickName),
      profileUrl: safeText(n.author?.profileUrl),
    },
    stats: {
      likes: num(stats.likes ?? stats.likedCount),
      collects: num(stats.collects ?? stats.collectedCount),
      comments: num(stats.comments ?? stats.commentCount),
      shares: num(stats.shares ?? stats.shareCount),
    },
    media: n.media || { images: n.images || [], ocrTexts: n.ocrTexts || [] },
    comments: (n.comments || []).map(c => normalizeComment(c, noteId)),
    sourceUrl: safeText(n.sourceUrl || n.url),
    captureMethod: safeText(n.captureMethod || source.captureMethod || 'initial_state'),
    confidence: n.confidence ?? 1,
  };
}

function normalizeQuery(q, fallbackCapturedAt='') {
  return {
    keyword: safeText(q.keyword),
    capturedAt: q.capturedAt || fallbackCapturedAt || new Date().toISOString(),
    results: (q.results || []).map((r, i) => ({
      noteId: safeText(r.noteId || r.id),
      rankingPosition: Number(r.rankingPosition || r.rank || i + 1),
      sourceUrl: safeText(r.sourceUrl || r.url),
      title: safeText(r.title || r.displayTitle),
      author: safeText(r.author?.nickname || r.author || r.user?.nickname || r.user?.nickName),
    })).filter(r => r.noteId || r.title),
  };
}

export function normalizeHarvest(raw={}) {
  const capturedAt = raw.source?.capturedAt || raw.capturedAt || new Date().toISOString();
  const source = {
    platform: 'xiaohongshu',
    capturedAt,
    entry: raw.source?.entry || 'unknown',
    keyword: safeText(raw.source?.keyword),
    sourceUrl: safeText(raw.source?.sourceUrl || raw.source?.url),
    captureMethod: safeText(raw.source?.captureMethod),
  };

  const notes = (raw.notes || []).map(n => normalizeNote(n, source));
  const nested = notes.flatMap(n => n.comments);
  const top = (raw.comments || []).map(c => normalizeComment(c, c.noteId));
  const allComments = [...nested, ...top].filter(c => c.id || c.content);
  const seen = new Set();
  const comments = allComments.filter(c => {
    const key = c.id || `${c.noteId}:${c.user}:${c.content}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const queries = (raw.queries || []).map(q => normalizeQuery(q, capturedAt)).filter(q => q.keyword);

  return {
    schemaVersion: raw.schemaVersion || '1-compatible',
    source,
    notes,
    comments,
    authors: raw.authors || [],
    queries,
    meta: {
      collected: raw.meta?.collected ?? notes.length,
      deduped: raw.meta?.deduped ?? notes.length,
      gaps: raw.meta?.gaps || [],
      loginRequired: Boolean(raw.meta?.loginRequired),
      riskState: raw.meta?.riskState || 'NORMAL',
      sampleBudget: raw.meta?.sampleBudget ?? null,
      stoppedBecause: safeText(raw.meta?.stoppedBecause),
    },
  };
}
