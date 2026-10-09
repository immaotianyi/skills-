const STOP = new Set(['这个','那个','就是','真的','感觉','可以','还是','不是','但是','然后','因为','所以','已经','一个','一下','什么','怎么','有没有','比较','非常','有点','没有','我们','你们','他们','自己','时候','里面','现在','如果','而且','以及','对于','关于','这里','那里','很多','这种','这样','觉得','看到','使用','产品','小红书','真的','太','很','也','都','就','了','的','啊','呢','吗','吧','呀','我','你','他','她','它','是','不','有','在','和','与','及','或','还','又','被','把','给','上','下','中','里','到','去','来']);

const SIGNALS = {
  questions: ['吗','么','怎么','如何','有没有','可以','能不能','适合','哪里','哪款','求链接','多少钱','价格','怎么买','什么牌子'],
  complaints: ['踩雷','难用','失望','太贵','贵','过敏','刺痛','辣眼','搓泥','油腻','闷','不值','垃圾','翻车','漏','坏','掉色','卡粉','脱妆'],
  purchaseIntent: ['求链接','怎么买','哪里买','价格','多少钱','入手','购买','回购','种草','想买','链接'],
  positive: ['好用','推荐','喜欢','回购','值得','真香','满意','惊喜','不错'],
};

function tokenize(text) {
  const out = [];
  for (const m of String(text).matchAll(/[A-Za-z][A-Za-z0-9+._-]{2,}|[\u4e00-\u9fff]{2,8}/g)) {
    const t = m[0].toLowerCase();
    if (!STOP.has(t)) out.push(t);
  }
  return out;
}

function topTokens(comments, limit=18) {
  const counts = new Map();
  for (const c of comments) for (const t of tokenize(c.content)) counts.set(t, (counts.get(t) || 0) + 1);
  return [...counts.entries()].sort((a,b) => b[1] - a[1]).slice(0, limit).map(([term,count]) => ({term,count}));
}

function hasTerm(content, term, bucket) {
  if (!content.includes(term)) return false;
  if (bucket === 'complaints') {
    const negations = [`不${term}`, `不会${term}`, `没有${term}`, `没${term}`, `不太${term}`];
    if (negations.some(x => content.includes(x))) return false;
    if (term === '刺痛' && /不刺痛|没有刺痛/.test(content)) return false;
    if (term === '辣眼' && /不辣眼|不会辣眼|没有辣眼/.test(content)) return false;
    if (term === '搓泥' && /不搓泥|不会搓泥/.test(content)) return false;
    if (term === '贵' && /不贵|没那么贵/.test(content)) return false;
  }
  return true;
}

function signalBuckets(comments) {
  const result = {};
  for (const [name, terms] of Object.entries(SIGNALS)) {
    const matches = comments.filter(c => terms.some(t => hasTerm(c.content, t, name))).sort((a,b) => b.likes - a.likes);
    result[name] = { count: matches.length, rate: comments.length ? matches.length / comments.length : 0, examples: matches.slice(0,5) };
  }
  return result;
}

function engagement(n) {
  const s = n.stats;
  return s.likes + 1.5 * s.collects + 2 * s.comments + 0.5 * s.shares;
}

export function rankingSummary(h) {
  const rows = [];
  for (const q of h.queries || []) for (const r of q.results || []) rows.push({ keyword:q.keyword, capturedAt:q.capturedAt, ...r });
  const byKeyword = {};
  for (const row of rows) (byKeyword[row.keyword] ||= []).push(row);
  for (const k of Object.keys(byKeyword)) byKeyword[k].sort((a,b) => a.rankingPosition - b.rankingPosition);
  return { queryCount:(h.queries || []).length, resultCount:rows.length, byKeyword, top:[...rows].sort((a,b) => a.rankingPosition - b.rankingPosition).slice(0,50) };
}

export function evidenceClusters(h, limit=12) {
  const noteMap = new Map(h.notes.map(n => [n.noteId, n]));
  return topTokens(h.comments, limit).map(({term,count}) => {
    const comments = h.comments.filter(c => c.content.includes(term)).sort((a,b) => b.likes - a.likes).slice(0,8);
    const notes = [];
    const seen = new Set();
    for (const c of comments) {
      const n = noteMap.get(c.noteId);
      if (n && !seen.has(n.noteId)) {
        seen.add(n.noteId);
        notes.push({ noteId:n.noteId, title:n.title, author:n.author, sourceUrl:n.sourceUrl, stats:n.stats });
      }
    }
    return { term, count, comments, notes:notes.slice(0,6) };
  });
}

export function rankingDiff(a,b) {
  const key = x => `${x.keyword}::${x.noteId}`;
  const rows = h => {
    const out = [];
    for (const q of h.queries || []) for (const r of q.results || []) out.push({ keyword:q.keyword, ...r });
    return out;
  };
  const A = new Map(rows(a).map(x => [key(x),x]));
  const B = new Map(rows(b).map(x => [key(x),x]));
  const changed = [], entered = [], exited = [];
  for (const [k,x] of B) {
    const prev = A.get(k);
    if (!prev) entered.push(x);
    else if (prev.rankingPosition !== x.rankingPosition) changed.push({ ...x, before:prev.rankingPosition, after:x.rankingPosition, delta:prev.rankingPosition - x.rankingPosition });
  }
  for (const [k,x] of A) if (!B.has(k)) exited.push(x);
  changed.sort((x,y) => Math.abs(y.delta) - Math.abs(x.delta));
  entered.sort((x,y) => x.rankingPosition - y.rankingPosition);
  return { changed, entered, exited };
}

export function analyze(h) {
  const notes = h.notes, comments = h.comments;
  const totals = notes.reduce((a,n) => ({ likes:a.likes+n.stats.likes, collects:a.collects+n.stats.collects, comments:a.comments+n.stats.comments, shares:a.shares+n.stats.shares }), {likes:0,collects:0,comments:0,shares:0});
  const authors = new Map();
  for (const n of notes) {
    const k = n.author.nickname || n.author.userId || 'unknown';
    authors.set(k, (authors.get(k) || 0) + 1);
  }
  const tags = new Map();
  for (const n of notes) for (const t of n.tags) tags.set(t, (tags.get(t) || 0) + 1);
  const topNotes = [...notes].sort((a,b) => engagement(b) - engagement(a)).slice(0,20).map(n => ({...n, engagementScore:Math.round(engagement(n))}));
  return {
    generatedAt:new Date().toISOString(),
    coverage:{ notes:notes.length, comments:comments.length, authors:authors.size, gaps:h.meta.gaps, loginRequired:h.meta.loginRequired, riskState:h.meta.riskState },
    engagement:{ totals, averages:Object.fromEntries(Object.entries(totals).map(([k,v]) => [k, notes.length ? Math.round(v/notes.length) : 0])) },
    topNotes,
    topCommentTerms:topTokens(comments),
    signals:signalBuckets(comments),
    authorTop:[...authors.entries()].sort((a,b)=>b[1]-a[1]).slice(0,10).map(([author,noteCount]) => ({author,noteCount})),
    topTags:[...tags.entries()].sort((a,b)=>b[1]-a[1]).slice(0,15).map(([tag,count]) => ({tag,count})),
    rankings:rankingSummary(h),
    evidenceClusters:evidenceClusters(h),
  };
}

export function diffHarvest(a,b) {
  const A = new Map(a.notes.map(n => [n.noteId,n]));
  const B = new Map(b.notes.map(n => [n.noteId,n]));
  const addedNotes = [...B.values()].filter(n => !A.has(n.noteId));
  const removedNotes = [...A.values()].filter(n => !B.has(n.noteId));
  const topMovers = [];
  for (const [id,n] of B) {
    const prev = A.get(id); if (!prev) continue;
    const delta = { likes:n.stats.likes-prev.stats.likes, collects:n.stats.collects-prev.stats.collects, comments:n.stats.comments-prev.stats.comments, shares:n.stats.shares-prev.stats.shares };
    const score = delta.likes + 1.5*delta.collects + 2*delta.comments + .5*delta.shares;
    if (score !== 0) topMovers.push({ noteId:id, title:n.title, author:n.author, sourceUrl:n.sourceUrl, delta, score:Math.round(score) });
  }
  topMovers.sort((x,y)=>y.score-x.score);
  const ta = new Map(topTokens(a.comments,100).map(x=>[x.term,x.count]));
  const tb = new Map(topTokens(b.comments,100).map(x=>[x.term,x.count]));
  const themeDelta = [...new Set([...ta.keys(),...tb.keys()])]
    .map(term => ({term,before:ta.get(term)||0,after:tb.get(term)||0,delta:(tb.get(term)||0)-(ta.get(term)||0)}))
    .filter(x=>x.delta!==0).sort((x,y)=>Math.abs(y.delta)-Math.abs(x.delta)).slice(0,25);
  return { from:a.source.capturedAt, to:b.source.capturedAt, addedNotes, removedNotes, topMovers:topMovers.slice(0,20), themeDelta, rankings:rankingDiff(a,b), before:analyze(a), after:analyze(b) };
}

export function markdownReport(project, snapshot, previous=null) {
  const a = snapshot.analysis || analyze(snapshot.harvest);
  const d = previous ? diffHarvest(previous.harvest, snapshot.harvest) : null;
  const lines = [
    `# ${project.name} — Xiaohongshu Research Snapshot`, '',
    `Captured: ${snapshot.createdAt}`, '',
    '## Coverage',
    `- Notes: ${a.coverage.notes}`,
    `- Comments: ${a.coverage.comments}`,
    `- Unique authors: ${a.coverage.authors}`,
    `- Risk state: ${a.coverage.riskState}`, '',
    '## Top recurring comment terms',
  ];
  for (const x of a.topCommentTerms.slice(0,12)) lines.push(`- ${x.term}: ${x.count}`);
  lines.push('', '## Audience signals', `- Questions: ${a.signals.questions.count}`, `- Complaints: ${a.signals.complaints.count}`, `- Purchase intent: ${a.signals.purchaseIntent.count}`, `- Positive: ${a.signals.positive.count}`, '', '## Top notes');
  for (const n of a.topNotes.slice(0,10)) lines.push(`- ${n.title || n.noteId} — ${n.author.nickname || 'unknown'} — score ${n.engagementScore}${n.sourceUrl ? ` — ${n.sourceUrl}` : ''}`);
  if (a.rankings.resultCount) {
    lines.push('', '## Search visibility');
    for (const [kw, rows] of Object.entries(a.rankings.byKeyword)) lines.push(`- ${kw}: ${rows.slice(0,5).map(r=>`#${r.rankingPosition} ${r.title||r.noteId}`).join(' / ')}`);
  }
  if (d) {
    lines.push('', '## Change since previous snapshot', `- Added notes: ${d.addedNotes.length}`, `- Removed/unavailable notes: ${d.removedNotes.length}`, '', '### Fastest movers');
    for (const m of d.topMovers.slice(0,8)) lines.push(`- ${m.title || m.noteId}: ${m.score>=0?'+':''}${m.score} weighted engagement`);
    lines.push('', '### Emerging terms');
    for (const t of d.themeDelta.filter(x=>x.delta>0).slice(0,10)) lines.push(`- ${t.term}: +${t.delta}`);
    if (d.rankings.changed.length || d.rankings.entered.length) {
      lines.push('', '### Search rank changes');
      for (const r of d.rankings.changed.slice(0,10)) lines.push(`- ${r.keyword} · ${r.title||r.noteId}: #${r.before} → #${r.after} (${r.delta>0?'↑':'↓'}${Math.abs(r.delta)})`);
      for (const r of d.rankings.entered.slice(0,6)) lines.push(`- ${r.keyword} · ${r.title||r.noteId}: entered at #${r.rankingPosition}`);
    }
  }
  if (a.coverage.gaps?.length) {
    lines.push('', '## Data gaps');
    for (const g of a.coverage.gaps) lines.push(`- ${typeof g === 'string' ? g : JSON.stringify(g)}`);
  }
  return lines.join('\n') + '\n';
}
