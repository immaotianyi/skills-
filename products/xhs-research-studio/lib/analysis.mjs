const STOP = new Set([
  '这个','那个','就是','真的','感觉','可以','还是','不是','但是','然后','因为','所以','已经','一个','一下','什么','比较','非常','有点','没有','我们','你们','他们','自己','时候','里面','现在','如果','而且','以及','对于','关于','这里','那里','很多','这种','这样','觉得','看到','使用','产品','小红书','太','很','也','都','就','了','的','啊','呢','吗','吧','呀','我','你','他','她','它','是','不','有','在','和','与','及','或','还','又','被','把','给','上','下','中','里','到','去','来'
]);

const SIGNALS = Object.freeze({
  questions: ['怎么','如何','有没有','能不能','可以吗','适合吗','值得买吗','哪里买','哪里','哪款','求推荐','求链接','多少钱','价格多少','怎么买','什么牌子'],
  complaints: ['踩雷','难用','失望','太贵','贵','过敏','刺痛','辣眼','搓泥','油腻','闷','不值','垃圾','翻车','漏','坏','掉色','卡粉','脱妆','假滑','拔干','黏腻','刺激'],
  purchaseIntent: ['求链接','怎么买','哪里买','价格多少','多少钱','入手','购买','回购','种草','想买','准备买','链接'],
  positive: ['好用','推荐','喜欢','回购','值得','真香','满意','惊喜','不错','温和','清爽','服帖'],
});

const SIGNAL_TERMS = new Set(Object.values(SIGNALS).flat());
const NEGATION_RE = /(?:不|没|没有|不会|并不|并没有|无|别|未|不是|不太)$/u;
const SEGMENTER = typeof Intl?.Segmenter === 'function' ? new Intl.Segmenter('zh-CN', { granularity: 'word' }) : null;

export const ENGAGEMENT_MODEL = Object.freeze({
  name: 'transparent-weighted-engagement-v1',
  purpose: 'Prioritize notes for analyst review; not a causal business-value model.',
  weights: Object.freeze({ likes: 1, collects: 1.5, comments: 2, shares: 0.5 }),
});

export const ANALYSIS_METHODOLOGY = Object.freeze({
  tokenizer: SEGMENTER ? 'Intl.Segmenter zh-CN / ICU word segmentation' : 'Unicode regex fallback',
  termFrequency: 'comment document frequency; repeated occurrences inside one comment count once',
  signalModel: 'transparent lexicon rules with local negation suppression; not a trained sentiment model',
  evidenceClustering: 'lexical evidence grouping by recurring segmented term; not semantic embedding clustering',
  ranking: 'observed search-result position only; no claim about platform-wide rank',
  engagement: ENGAGEMENT_MODEL,
});

function normalizeText(text='') {
  return String(text ?? '').normalize('NFKC').trim();
}

function tokenAllowed(token) {
  if (!token || STOP.has(token)) return false;
  if (/^[A-Za-z][A-Za-z0-9+._-]{2,}$/u.test(token)) return true;
  if (/^[\u3400-\u9fff]+$/u.test(token)) return token.length >= 2 || SIGNAL_TERMS.has(token);
  return false;
}

export function tokenize(text) {
  const value = normalizeText(text).toLowerCase();
  const out = [];
  if (SEGMENTER) {
    for (const part of SEGMENTER.segment(value)) {
      if (!part.isWordLike) continue;
      const token = part.segment.trim();
      if (tokenAllowed(token)) out.push(token);
    }
    return out;
  }
  for (const m of value.matchAll(/[A-Za-z][A-Za-z0-9+._-]{2,}|[\u3400-\u9fff]{1,8}/gu)) {
    const token = m[0];
    if (tokenAllowed(token)) out.push(token);
  }
  return out;
}

function tokenCounts(comments) {
  const counts = new Map();
  for (const comment of comments || []) {
    const unique = new Set(tokenize(comment?.content));
    for (const token of unique) counts.set(token, (counts.get(token) || 0) + 1);
  }
  return counts;
}

export function topTokens(comments, limit=18) {
  return [...tokenCounts(comments).entries()]
    .sort((a,b) => b[1] - a[1] || a[0].localeCompare(b[0], 'zh-CN'))
    .slice(0, Math.max(0, limit))
    .map(([term,count]) => ({ term, count }));
}

function hasUnnegatedTerm(content, term) {
  let from = 0;
  while (from <= content.length - term.length) {
    const index = content.indexOf(term, from);
    if (index < 0) return false;
    const prefix = content.slice(Math.max(0, index - 5), index);
    if (!NEGATION_RE.test(prefix)) return true;
    from = index + term.length;
  }
  return false;
}

export function classifyComment(comment) {
  const content = normalizeText(comment?.content);
  const result = {};
  for (const [bucket, terms] of Object.entries(SIGNALS)) {
    const matched = [];
    for (const term of terms) {
      const found = bucket === 'questions'
        ? content.includes(term)
        : hasUnnegatedTerm(content, term);
      if (found) matched.push(term);
    }
    if (bucket === 'questions' && /[?？]/u.test(content) && !matched.length) matched.push('question-mark');
    result[bucket] = [...new Set(matched)];
  }
  return result;
}

function signalBuckets(comments) {
  const result = {};
  for (const name of Object.keys(SIGNALS)) {
    const matches = [];
    const termCounts = new Map();
    for (const comment of comments || []) {
      const matchedTerms = classifyComment(comment)[name];
      if (!matchedTerms.length) continue;
      for (const term of matchedTerms) termCounts.set(term, (termCounts.get(term) || 0) + 1);
      matches.push({ ...comment, matchedTerms });
    }
    matches.sort((a,b) => (b.likes || 0) - (a.likes || 0));
    result[name] = {
      count: matches.length,
      rate: comments?.length ? matches.length / comments.length : 0,
      matchedTerms: [...termCounts.entries()].sort((a,b) => b[1]-a[1]).map(([term,count]) => ({term,count})),
      examples: matches.slice(0,5),
    };
  }
  return result;
}

export function engagementScore(note) {
  const stats = note?.stats || {};
  const w = ENGAGEMENT_MODEL.weights;
  return (stats.likes || 0) * w.likes
    + (stats.collects || 0) * w.collects
    + (stats.comments || 0) * w.comments
    + (stats.shares || 0) * w.shares;
}

export function rankingSummary(h) {
  const rows = [];
  const seen = new Set();
  for (const query of h?.queries || []) {
    for (const result of query.results || []) {
      const key = `${query.keyword}::${result.noteId || result.title || ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push({ keyword:query.keyword, capturedAt:query.capturedAt, ...result });
    }
  }
  const byKeyword = {};
  for (const row of rows) (byKeyword[row.keyword] ||= []).push(row);
  for (const keyword of Object.keys(byKeyword)) byKeyword[keyword].sort((a,b) => a.rankingPosition - b.rankingPosition);
  return {
    queryCount: (h?.queries || []).length,
    resultCount: rows.length,
    byKeyword,
    top: [...rows].sort((a,b) => a.rankingPosition - b.rankingPosition).slice(0,50),
    interpretation: 'Ranks are positions observed in the captured result pages for the recorded keyword and time only.',
  };
}

export function evidenceClusters(h, limit=12) {
  const comments = h?.comments || [];
  const noteMap = new Map((h?.notes || []).map(note => [note.noteId, note]));
  const ranked = topTokens(comments, Math.max(limit * 4, 24));
  const recurring = ranked.filter(x => x.count >= 2);
  const candidates = (recurring.length ? recurring : ranked).slice(0, limit);
  return candidates.map(({term,count}) => {
    const matchedComments = comments
      .filter(comment => tokenize(comment.content).includes(term))
      .sort((a,b) => (b.likes || 0) - (a.likes || 0))
      .slice(0,8);
    const notes = [];
    const seen = new Set();
    for (const comment of matchedComments) {
      const note = noteMap.get(comment.noteId);
      if (!note || seen.has(note.noteId)) continue;
      seen.add(note.noteId);
      notes.push({ noteId:note.noteId, title:note.title, author:note.author, sourceUrl:note.sourceUrl, stats:note.stats });
    }
    return {
      term,
      count,
      method: 'lexical-comment-frequency',
      comments: matchedComments,
      notes: notes.slice(0,6),
    };
  });
}

export function rankingDiff(a,b) {
  const key = x => `${x.keyword}::${x.noteId || x.title || ''}`;
  const rows = harvest => {
    const out = [];
    for (const query of harvest?.queries || []) {
      for (const result of query.results || []) out.push({ keyword:query.keyword, ...result });
    }
    return out;
  };
  const A = new Map(rows(a).map(x => [key(x),x]));
  const B = new Map(rows(b).map(x => [key(x),x]));
  const changed = [], entered = [], exited = [];
  for (const [k,x] of B) {
    const previous = A.get(k);
    if (!previous) entered.push(x);
    else if (previous.rankingPosition !== x.rankingPosition) {
      changed.push({ ...x, before:previous.rankingPosition, after:x.rankingPosition, delta:previous.rankingPosition - x.rankingPosition });
    }
  }
  for (const [k,x] of A) if (!B.has(k)) exited.push(x);
  changed.sort((x,y) => Math.abs(y.delta) - Math.abs(x.delta));
  entered.sort((x,y) => x.rankingPosition - y.rankingPosition);
  exited.sort((x,y) => x.rankingPosition - y.rankingPosition);
  return { changed, entered, exited };
}

function qualityAssessment(h) {
  const notes = h?.notes || [];
  const comments = h?.comments || [];
  const warnings = [];
  const sourceMissing = notes.filter(n => !n.sourceUrl).length;
  const unknownCapture = notes.filter(n => n.captureMethod === 'unknown').length;
  const lowConfidence = notes.filter(n => Number(n.confidence) < 0.7).length;
  const commentSourceMissing = comments.filter(c => !c.sourceUrl).length;
  if (h?.meta?.riskState && h.meta.riskState !== 'NORMAL') warnings.push(`capture risk state is ${h.meta.riskState}`);
  if (h?.meta?.gaps?.length) warnings.push(`${h.meta.gaps.length} explicit coverage gap(s)`);
  if (sourceMissing) warnings.push(`${sourceMissing}/${notes.length} notes lack source URLs`);
  if (unknownCapture) warnings.push(`${unknownCapture}/${notes.length} notes use unknown capture method`);
  if (lowConfidence) warnings.push(`${lowConfidence}/${notes.length} notes have confidence below 0.7`);
  if (commentSourceMissing && comments.length) warnings.push(`${commentSourceMissing}/${comments.length} comments lack source URLs`);
  if (!comments.length) warnings.push('no first-class comments available');
  let score = 100;
  if (h?.meta?.riskState && h.meta.riskState !== 'NORMAL') score -= 35;
  score -= Math.min(20, (h?.meta?.gaps?.length || 0) * 5);
  if (notes.length) score -= Math.round((sourceMissing / notes.length) * 20);
  if (notes.length) score -= Math.round((unknownCapture / notes.length) * 10);
  if (comments.length) score -= Math.round((commentSourceMissing / comments.length) * 10);
  if (!comments.length) score -= 10;
  score = Math.max(0, Math.min(100, score));
  const status = h?.meta?.riskState && ['CAPTCHA','ACCESS_DENIED','BLOCKED'].includes(h.meta.riskState)
    ? 'blocked'
    : score >= 85 ? 'good' : score >= 65 ? 'caution' : 'weak';
  return { score, status, warnings, sourceMissing, unknownCapture, lowConfidence, commentSourceMissing };
}

export function analyze(h) {
  const notes = h?.notes || [];
  const comments = h?.comments || [];
  const totals = notes.reduce((acc,n) => ({
    likes: acc.likes + (n.stats?.likes || 0),
    collects: acc.collects + (n.stats?.collects || 0),
    comments: acc.comments + (n.stats?.comments || 0),
    shares: acc.shares + (n.stats?.shares || 0),
  }), {likes:0,collects:0,comments:0,shares:0});
  const authors = new Map();
  for (const note of notes) {
    const key = note.author?.nickname || note.author?.userId || 'unknown';
    authors.set(key, (authors.get(key) || 0) + 1);
  }
  const tags = new Map();
  for (const note of notes) for (const tag of note.tags || []) tags.set(tag, (tags.get(tag) || 0) + 1);
  const topNotes = [...notes]
    .sort((a,b) => engagementScore(b) - engagementScore(a))
    .slice(0,20)
    .map(note => ({...note, engagementScore:Math.round(engagementScore(note))}));
  return {
    generatedAt: new Date().toISOString(),
    methodology: ANALYSIS_METHODOLOGY,
    quality: qualityAssessment(h),
    coverage: {
      notes: notes.length,
      comments: comments.length,
      authors: authors.size,
      gaps: h?.meta?.gaps || [],
      loginRequired: Boolean(h?.meta?.loginRequired),
      riskState: h?.meta?.riskState || 'NORMAL',
    },
    engagement: {
      model: ENGAGEMENT_MODEL,
      totals,
      averages: Object.fromEntries(Object.entries(totals).map(([k,v]) => [k, notes.length ? Math.round(v / notes.length) : 0])),
    },
    topNotes,
    topCommentTerms: topTokens(comments),
    signals: signalBuckets(comments),
    authorTop: [...authors.entries()].sort((a,b)=>b[1]-a[1]).slice(0,10).map(([author,noteCount]) => ({author,noteCount})),
    topTags: [...tags.entries()].sort((a,b)=>b[1]-a[1]).slice(0,15).map(([tag,count]) => ({tag,count})),
    rankings: rankingSummary(h),
    evidenceClusters: evidenceClusters(h),
  };
}

function buildAlerts(diff) {
  const alerts = [];
  const complaintDelta = diff.after.signals.complaints.count - diff.before.signals.complaints.count;
  if (complaintDelta >= 2) alerts.push({
    level: complaintDelta >= 5 ? 'high' : 'medium',
    type: 'complaint-growth',
    title: `Complaint signals increased by ${complaintDelta}`,
    detail: `${diff.before.signals.complaints.count} → ${diff.after.signals.complaints.count}`,
  });
  for (const rank of diff.rankings.changed.filter(x => x.delta <= -3).slice(0,6)) alerts.push({
    level: Math.abs(rank.delta) >= 5 ? 'high' : 'medium',
    type: 'rank-drop',
    title: `Search rank dropped: ${rank.keyword}`,
    detail: `${rank.title || rank.noteId} #${rank.before} → #${rank.after}`,
  });
  for (const mover of diff.topMovers.filter(x => x.score >= 1000).slice(0,5)) alerts.push({
    level: 'medium', type: 'fast-mover', title: 'Fast-moving note', detail: `${mover.title || mover.noteId} +${mover.score} weighted engagement`,
  });
  for (const note of diff.addedNotes.filter(n => engagementScore(n) >= 1000).slice(0,5)) alerts.push({
    level: 'medium', type: 'new-high-signal-note', title: 'New high-signal note', detail: `${note.title || note.noteId} · score ${Math.round(engagementScore(note))}`,
  });
  if (diff.after.coverage.riskState !== 'NORMAL') alerts.unshift({
    level: 'high', type: 'capture-risk', title: `Capture state: ${diff.after.coverage.riskState}`, detail: 'Resolve coverage/access state before interpreting trend changes.',
  });
  return alerts;
}

export function diffHarvest(a,b) {
  const A = new Map((a?.notes || []).map(n => [n.noteId,n]));
  const B = new Map((b?.notes || []).map(n => [n.noteId,n]));
  const addedNotes = [...B.values()].filter(n => !A.has(n.noteId));
  const notObservedNotes = [...A.values()].filter(n => !B.has(n.noteId));
  const topMovers = [];
  for (const [id,note] of B) {
    const previous = A.get(id);
    if (!previous) continue;
    const delta = {
      likes:(note.stats?.likes || 0)-(previous.stats?.likes || 0),
      collects:(note.stats?.collects || 0)-(previous.stats?.collects || 0),
      comments:(note.stats?.comments || 0)-(previous.stats?.comments || 0),
      shares:(note.stats?.shares || 0)-(previous.stats?.shares || 0),
    };
    const score = delta.likes * ENGAGEMENT_MODEL.weights.likes
      + delta.collects * ENGAGEMENT_MODEL.weights.collects
      + delta.comments * ENGAGEMENT_MODEL.weights.comments
      + delta.shares * ENGAGEMENT_MODEL.weights.shares;
    if (score !== 0) topMovers.push({ noteId:id, title:note.title, author:note.author, sourceUrl:note.sourceUrl, delta, score:Math.round(score) });
  }
  topMovers.sort((x,y) => y.score - x.score);
  const ta = tokenCounts(a?.comments || []);
  const tb = tokenCounts(b?.comments || []);
  const themeDelta = [...new Set([...ta.keys(),...tb.keys()])]
    .map(term => ({term,before:ta.get(term)||0,after:tb.get(term)||0,delta:(tb.get(term)||0)-(ta.get(term)||0)}))
    .filter(x => x.delta !== 0)
    .sort((x,y) => Math.abs(y.delta)-Math.abs(x.delta) || x.term.localeCompare(y.term,'zh-CN'))
    .slice(0,25);
  const before = analyze(a);
  const after = analyze(b);
  const diff = {
    from: a?.source?.capturedAt,
    to: b?.source?.capturedAt,
    addedNotes,
    notObservedNotes,
    removedNotes: notObservedNotes,
    topMovers: topMovers.slice(0,20),
    themeDelta,
    rankings: rankingDiff(a,b),
    before,
    after,
  };
  diff.alerts = buildAlerts(diff);
  return diff;
}

export function markdownReport(project, snapshot, previous=null) {
  const analysis = snapshot.analysis || analyze(snapshot.harvest);
  const diff = previous ? diffHarvest(previous.harvest, snapshot.harvest) : null;
  const lines = [
    `# ${project.name} — Xiaohongshu Research Snapshot`, '',
    `Captured: ${snapshot.createdAt}`, '',
    '## Coverage',
    `- Notes: ${analysis.coverage.notes}`,
    `- Comments: ${analysis.coverage.comments}`,
    `- Unique authors: ${analysis.coverage.authors}`,
    `- Risk state: ${analysis.coverage.riskState}`,
    `- Evidence quality: ${analysis.quality.status} (${analysis.quality.score}/100)`, '',
  ];
  if (analysis.quality.warnings.length) {
    lines.push('### Evidence-quality warnings');
    for (const warning of analysis.quality.warnings) lines.push(`- ${warning}`);
    lines.push('');
  }
  lines.push('## Top recurring comment terms');
  for (const item of analysis.topCommentTerms.slice(0,12)) lines.push(`- ${item.term}: ${item.count} comments`);
  lines.push('', '## Audience signals',
    `- Questions: ${analysis.signals.questions.count}`,
    `- Complaints: ${analysis.signals.complaints.count}`,
    `- Purchase intent: ${analysis.signals.purchaseIntent.count}`,
    `- Positive: ${analysis.signals.positive.count}`, '',
    '## Top notes');
  for (const note of analysis.topNotes.slice(0,10)) {
    lines.push(`- ${note.title || note.noteId} — ${note.author?.nickname || 'unknown'} — review score ${note.engagementScore}${note.sourceUrl ? ` — ${note.sourceUrl}` : ''}`);
  }
  if (analysis.rankings.resultCount) {
    lines.push('', '## Search visibility');
    for (const [keyword, rows] of Object.entries(analysis.rankings.byKeyword)) {
      lines.push(`- ${keyword}: ${rows.slice(0,5).map(r=>`#${r.rankingPosition} ${r.title||r.noteId}`).join(' / ')}`);
    }
    lines.push('', '> Search ranks are captured-page observations for the recorded keyword/time, not a claim about universal platform rank.');
  }
  if (diff) {
    lines.push('', '## Change since previous snapshot',
      `- Added notes in current sample: ${diff.addedNotes.length}`,
      `- Previously observed notes not present in current sample: ${diff.notObservedNotes.length}`, '',
      '### Fastest movers');
    for (const mover of diff.topMovers.slice(0,8)) lines.push(`- ${mover.title || mover.noteId}: ${mover.score>=0?'+':''}${mover.score} review-score delta`);
    lines.push('', '### Emerging terms');
    for (const term of diff.themeDelta.filter(x=>x.delta>0).slice(0,10)) lines.push(`- ${term.term}: +${term.delta} comments`);
    if (diff.rankings.changed.length || diff.rankings.entered.length) {
      lines.push('', '### Search rank changes');
      for (const rank of diff.rankings.changed.slice(0,10)) lines.push(`- ${rank.keyword} · ${rank.title||rank.noteId}: #${rank.before} → #${rank.after} (${rank.delta>0?'↑':'↓'}${Math.abs(rank.delta)})`);
      for (const rank of diff.rankings.entered.slice(0,6)) lines.push(`- ${rank.keyword} · ${rank.title||rank.noteId}: observed at #${rank.rankingPosition}`);
    }
  }
  if (analysis.coverage.gaps?.length) {
    lines.push('', '## Data gaps');
    for (const gap of analysis.coverage.gaps) lines.push(`- ${typeof gap === 'string' ? gap : JSON.stringify(gap)}`);
  }
  lines.push('', '## Methodology / interpretation limits',
    '- Comment signals use transparent lexicon rules with local negation handling; they are not a trained sentiment classifier.',
    '- Evidence clusters are lexical recurring-term groups produced from Chinese word segmentation; they are not semantic embedding clusters.',
    `- Note review score weights: likes × ${ENGAGEMENT_MODEL.weights.likes}, collects × ${ENGAGEMENT_MODEL.weights.collects}, comments × ${ENGAGEMENT_MODEL.weights.comments}, shares × ${ENGAGEMENT_MODEL.weights.shares}. It is a triage heuristic, not a causal value estimate.`,
    '- Important conclusions should be verified against linked source notes/comments and explicit coverage gaps.');
  return lines.join('\n') + '\n';
}
