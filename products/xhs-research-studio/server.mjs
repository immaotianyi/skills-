#!/usr/bin/env node
import http from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.XHS_STUDIO_DATA || path.join(__dirname, 'data');
const PUBLIC_DIR = path.join(__dirname, 'public');
const PORT = Number(process.env.PORT || 5418);
const HOST = process.env.HOST || '127.0.0.1';

const STOP = new Set(['这个','那个','就是','真的','感觉','可以','还是','不是','但是','然后','因为','所以','已经','一个','一下','什么','怎么','有没有','比较','非常','有点','没有','我们','你们','他们','自己','时候','里面','现在','如果','而且','以及','对于','关于','这里','那里','很多','这种','这样','觉得','看到','使用','产品','小红书','真的','太','很','也','都','就','了','的','啊','呢','吗','吧','呀','我','你','他','她','它','是','不','有','在','和','与','及','或','还','又','被','把','给','上','下','中','里','到','去','来']);

function id(prefix='id') { return `${prefix}_${Date.now().toString(36)}_${crypto.randomBytes(3).toString('hex')}`; }
function now() { return new Date().toISOString(); }
function num(v) { const n = Number(String(v ?? 0).replace(/[,万wW]/g, '')); if (!Number.isFinite(n)) return 0; const s=String(v??''); return /万|[wW]/.test(s) ? Math.round(n*10000) : Math.round(n); }
function safeText(v='') { return String(v ?? '').trim(); }
function slug(v='') { return safeText(v).toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g,'-').replace(/^-|-$/g,'').slice(0,60) || 'project'; }

async function ensure() {
  await fs.mkdir(DATA_DIR, { recursive:true });
  await fs.mkdir(path.join(DATA_DIR,'snapshots'), { recursive:true });
  const p = path.join(DATA_DIR,'projects.json');
  try { await fs.access(p); } catch { await fs.writeFile(p, '[]\n'); }
}
async function readJson(file, fallback=null) { try { return JSON.parse(await fs.readFile(file,'utf8')); } catch { return fallback; } }
async function writeJson(file, data) { await fs.mkdir(path.dirname(file),{recursive:true}); await fs.writeFile(file, JSON.stringify(data,null,2)+'\n'); }
async function getProjects() { await ensure(); return await readJson(path.join(DATA_DIR,'projects.json'), []); }
async function saveProjects(projects) { await writeJson(path.join(DATA_DIR,'projects.json'), projects); }
async function getProject(projectId) { return (await getProjects()).find(p=>p.id===projectId) || null; }

function normalizeComment(c, noteId='') {
  return {
    id: safeText(c.id || c.commentId), noteId: safeText(c.noteId || noteId), parentCommentId: safeText(c.parentCommentId || c.parentId),
    content: safeText(c.content), likes: num(c.likes ?? c.likeCount), isAuthor: Boolean(c.isAuthor ?? c.is_author),
    user: typeof c.user === 'object' ? safeText(c.user.nickname || c.user.userId) : safeText(c.user || c.userInfo?.nickname),
    publishedAt: c.publishedAt ?? c.createTime ?? null, sourceUrl: safeText(c.sourceUrl)
  };
}
function normalizeNote(n, source={}) {
  const stats=n.stats || n.interactInfo || {};
  const noteId=safeText(n.noteId || n.id);
  return {
    noteId, title:safeText(n.title || n.displayTitle), desc:safeText(n.desc || n.description), type:safeText(n.type || 'normal'),
    publishTime:n.publishTime ?? n.time ?? null, lastUpdateTime:n.lastUpdateTime ?? null, ipLocation:safeText(n.ipLocation),
    tags:(n.tags || n.tagList || []).map(t=>typeof t==='string'?t:safeText(t.name)).filter(Boolean),
    author:{ userId:safeText(n.author?.userId || n.user?.userId), nickname:safeText(n.author?.nickname || n.user?.nickname || n.user?.nickName), profileUrl:safeText(n.author?.profileUrl)},
    stats:{ likes:num(stats.likes ?? stats.likedCount), collects:num(stats.collects ?? stats.collectedCount), comments:num(stats.comments ?? stats.commentCount), shares:num(stats.shares ?? stats.shareCount)},
    media:n.media || {images:n.images || [],ocrTexts:n.ocrTexts || []},
    comments:(n.comments || []).map(c=>normalizeComment(c,noteId)), sourceUrl:safeText(n.sourceUrl || n.url),
    captureMethod:safeText(n.captureMethod || source.captureMethod || 'initial_state'), confidence:n.confidence ?? 1
  };
}
function normalizeHarvest(raw={}) {
  const source={platform:'xiaohongshu', capturedAt:raw.source?.capturedAt || raw.capturedAt || now(), entry:raw.source?.entry || 'unknown', keyword:raw.source?.keyword || '', sourceUrl:raw.source?.sourceUrl || raw.source?.url || '', captureMethod:raw.source?.captureMethod || ''};
  const notes=(raw.notes || []).map(n=>normalizeNote(n,source));
  const nested=notes.flatMap(n=>n.comments);
  const top=(raw.comments || []).map(c=>normalizeComment(c,c.noteId));
  const comments=[...nested,...top].filter(c=>c.id || c.content);
  const seen=new Set();
  const dedupComments=comments.filter(c=>{const k=c.id || `${c.noteId}:${c.user}:${c.content}`; if(seen.has(k)) return false; seen.add(k); return true;});
  return {source, notes, comments:dedupComments, authors:raw.authors || [], queries:raw.queries || [], meta:{collected:raw.meta?.collected ?? notes.length, deduped:raw.meta?.deduped ?? notes.length, gaps:raw.meta?.gaps || [], loginRequired:Boolean(raw.meta?.loginRequired), riskState:raw.meta?.riskState || 'NORMAL'}};
}

function tokenize(text) {
  const out=[];
  for (const m of String(text).matchAll(/[A-Za-z][A-Za-z0-9+._-]{2,}|[\u4e00-\u9fff]{2,8}/g)) {
    const t=m[0].toLowerCase(); if (!STOP.has(t)) out.push(t);
  }
  return out;
}
function topTokens(comments, limit=18) {
  const counts=new Map();
  for (const c of comments) for (const t of tokenize(c.content)) counts.set(t,(counts.get(t)||0)+1);
  return [...counts.entries()].sort((a,b)=>b[1]-a[1]).slice(0,limit).map(([term,count])=>({term,count}));
}
const SIGNALS={
  questions:['吗','么','怎么','如何','有没有','可以','能不能','适合','哪里','哪款','求链接','多少钱','价格','怎么买','什么牌子'],
  complaints:['踩雷','难用','失望','太贵','贵','过敏','刺痛','辣眼','搓泥','油腻','闷','不值','垃圾','翻车','漏','坏','掉色','卡粉','脱妆'],
  purchaseIntent:['求链接','怎么买','哪里买','价格','多少钱','入手','购买','回购','种草','想买','链接'],
  positive:['好用','推荐','喜欢','回购','值得','真香','满意','惊喜','不错']
};
function hasTerm(content, term, bucket) {
  if (!content.includes(term)) return false;
  if (bucket === 'complaints') {
    const negations=[`不${term}`,`不会${term}`,`没有${term}`,`没${term}`,`不太${term}`];
    if (negations.some(x=>content.includes(x))) return false;
    if (term==='刺痛' && /不刺痛|没有刺痛/.test(content)) return false;
    if (term==='辣眼' && /不辣眼|不会辣眼|没有辣眼/.test(content)) return false;
    if (term==='搓泥' && /不搓泥|不会搓泥/.test(content)) return false;
    if (term==='贵' && /不贵|没那么贵/.test(content)) return false;
  }
  return true;
}
function signalBuckets(comments) {
  const result={};
  for (const [name,terms] of Object.entries(SIGNALS)) {
    const matches=[];
    for (const c of comments) if (terms.some(t=>hasTerm(c.content,t,name))) matches.push(c);
    result[name]={count:matches.length, rate:comments.length?matches.length/comments.length:0, examples:matches.sort((a,b)=>b.likes-a.likes).slice(0,5)};
  }
  return result;
}
function engagement(n){const s=n.stats; return s.likes + 1.5*s.collects + 2*s.comments + .5*s.shares;}
function analyze(h) {
  const notes=h.notes, comments=h.comments;
  const totals=notes.reduce((a,n)=>({likes:a.likes+n.stats.likes,collects:a.collects+n.stats.collects,comments:a.comments+n.stats.comments,shares:a.shares+n.stats.shares}),{likes:0,collects:0,comments:0,shares:0});
  const authors=new Map();
  for (const n of notes){const k=n.author.nickname||n.author.userId||'unknown'; authors.set(k,(authors.get(k)||0)+1);}
  const authorTop=[...authors.entries()].sort((a,b)=>b[1]-a[1]).slice(0,10).map(([author,noteCount])=>({author,noteCount}));
  const topNotes=[...notes].sort((a,b)=>engagement(b)-engagement(a)).slice(0,20).map(n=>({...n,engagementScore:Math.round(engagement(n))}));
  const tags=new Map(); for(const n of notes) for(const t of n.tags) tags.set(t,(tags.get(t)||0)+1);
  return {
    generatedAt:now(), coverage:{notes:notes.length, comments:comments.length, authors:authors.size, gaps:h.meta.gaps, loginRequired:h.meta.loginRequired, riskState:h.meta.riskState},
    engagement:{totals, averages:Object.fromEntries(Object.entries(totals).map(([k,v])=>[k,notes.length?Math.round(v/notes.length):0]))},
    topNotes, topCommentTerms:topTokens(comments), signals:signalBuckets(comments), authorTop,
    topTags:[...tags.entries()].sort((a,b)=>b[1]-a[1]).slice(0,15).map(([tag,count])=>({tag,count}))
  };
}
function diffHarvest(a,b){
  const A=new Map(a.notes.map(n=>[n.noteId,n])), B=new Map(b.notes.map(n=>[n.noteId,n]));
  const added=[...B.values()].filter(n=>!A.has(n.noteId));
  const removed=[...A.values()].filter(n=>!B.has(n.noteId));
  const movers=[];
  for(const [id,n] of B){const prev=A.get(id); if(!prev) continue; const delta={likes:n.stats.likes-prev.stats.likes,collects:n.stats.collects-prev.stats.collects,comments:n.stats.comments-prev.stats.comments,shares:n.stats.shares-prev.stats.shares}; const score=delta.likes+1.5*delta.collects+2*delta.comments+.5*delta.shares; if(score!==0) movers.push({noteId:id,title:n.title,author:n.author,sourceUrl:n.sourceUrl,delta,score:Math.round(score)});}
  movers.sort((x,y)=>y.score-x.score);
  const ta=new Map(topTokens(a.comments,100).map(x=>[x.term,x.count])), tb=new Map(topTokens(b.comments,100).map(x=>[x.term,x.count]));
  const themeDelta=[...new Set([...ta.keys(),...tb.keys()])].map(term=>({term,before:ta.get(term)||0,after:tb.get(term)||0,delta:(tb.get(term)||0)-(ta.get(term)||0)})).filter(x=>x.delta!==0).sort((x,y)=>Math.abs(y.delta)-Math.abs(x.delta)).slice(0,25);
  return {from:a.source.capturedAt,to:b.source.capturedAt,addedNotes:added,removedNotes:removed,topMovers:movers.slice(0,20),themeDelta,before:analyze(a),after:analyze(b)};
}
function markdownReport(project,snapshot,previous=null){
  const a=snapshot.analysis || analyze(snapshot.harvest); const d=previous?diffHarvest(previous.harvest,snapshot.harvest):null;
  const lines=[`# ${project.name} — Xiaohongshu Research Snapshot`,``,`Captured: ${snapshot.createdAt}`,``,`## Coverage`,`- Notes: ${a.coverage.notes}` ,`- Comments: ${a.coverage.comments}` ,`- Unique authors: ${a.coverage.authors}`,`- Risk state: ${a.coverage.riskState}`,``, `## Top recurring comment terms`];
  for(const x of a.topCommentTerms.slice(0,12)) lines.push(`- ${x.term}: ${x.count}`);
  lines.push('', '## Audience signals',`- Questions: ${a.signals.questions.count}`,`- Complaints: ${a.signals.complaints.count}`,`- Purchase intent: ${a.signals.purchaseIntent.count}`,`- Positive: ${a.signals.positive.count}`,'','## Top notes');
  for(const n of a.topNotes.slice(0,10)) lines.push(`- ${n.title || n.noteId} — ${n.author.nickname || 'unknown'} — score ${n.engagementScore}${n.sourceUrl?` — ${n.sourceUrl}`:''}`);
  if(d){lines.push('','## Change since previous snapshot',`- Added notes: ${d.addedNotes.length}`,`- Removed/unavailable notes: ${d.removedNotes.length}`,'','### Fastest movers'); for(const m of d.topMovers.slice(0,8)) lines.push(`- ${m.title || m.noteId}: +${m.score} weighted engagement`); lines.push('','### Emerging terms'); for(const t of d.themeDelta.filter(x=>x.delta>0).slice(0,10)) lines.push(`- ${t.term}: +${t.delta}`);}
  if(a.coverage.gaps?.length){lines.push('','## Data gaps'); for(const g of a.coverage.gaps) lines.push(`- ${typeof g==='string'?g:JSON.stringify(g)}`);}
  return lines.join('\n')+'\n';
}

async function listSnapshots(projectId){
  const dir=path.join(DATA_DIR,'snapshots',projectId); try { const files=(await fs.readdir(dir)).filter(x=>x.endsWith('.json')).sort(); const out=[]; for(const f of files){const s=await readJson(path.join(dir,f)); if(s) out.push({id:s.id,createdAt:s.createdAt,source:s.harvest?.source,analysis:s.analysis});} return out; } catch { return []; }
}
async function loadSnapshot(projectId,snapshotId){ return await readJson(path.join(DATA_DIR,'snapshots',projectId,`${snapshotId}.json`)); }
async function saveSnapshot(projectId,raw){ const harvest=normalizeHarvest(raw); const snapshot={id:id('snap'),projectId,createdAt:harvest.source.capturedAt || now(),harvest}; snapshot.analysis=analyze(harvest); await writeJson(path.join(DATA_DIR,'snapshots',projectId,`${snapshot.id}.json`),snapshot); return snapshot; }

function csvCell(v){const s=String(v??''); return /[\",\n]/.test(s)?`\"${s.replace(/\"/g,'\"\"')}\"`:s;}
function evidenceCsv(h){const rows=[['noteId','title','author','likes','collects','comments','shares','captureMethod','sourceUrl']]; for(const n of h.notes) rows.push([n.noteId,n.title,n.author.nickname,n.stats.likes,n.stats.collects,n.stats.comments,n.stats.shares,n.captureMethod,n.sourceUrl]); return rows.map(r=>r.map(csvCell).join(',')).join('\n')+'\n';}

function projectPlan(project){
  const kws=(project.keywords||[]).map(k=>`- Search keyword: ${k} (collect result rank, noteId, source URL; sample 30–80 unless saturation is reached earlier)`);
  const comps=(project.competitors||[]).map(k=>`- Competitor: ${k} (search brand name + key negative/compare terms; capture high-signal comments)`);
  return [`# Harvest plan: ${project.name}`,'','Goal: produce one normalized Xiaohongshu Harvest v2 JSON snapshot for XHS Research Studio.','','## Search work',...kws,'','## Competitor work',...comps,'','## Required fields','- source.capturedAt / entry / keyword / sourceUrl','- each note: noteId, title, desc, author, stats, sourceUrl, captureMethod','- comments as first-class objects when available','- queries[] with keyword + rankingPosition when search is used','- meta.gaps + loginRequired + riskState','','## Stop rules','- Public/read-only paths first.','- Do not bypass CAPTCHA/access controls.','- Stop when additional samples no longer add meaningful new themes or the agreed sample budget is reached.','- Record any coverage gaps explicitly.'].join('\n');
}

async function bodyJson(req){ const chunks=[]; for await(const c of req) chunks.push(c); if(!chunks.length) return {}; const s=Buffer.concat(chunks).toString('utf8'); if(s.length>15_000_000) throw new Error('body too large'); return JSON.parse(s); }
function send(res,status,data,type='application/json; charset=utf-8'){ res.writeHead(status,{'content-type':type,'cache-control':'no-store'}); res.end(type.startsWith('application/json')?JSON.stringify(data,null,2):data); }
function notFound(res){send(res,404,{error:'not found'});}

async function api(req,res,url){
  const parts=url.pathname.split('/').filter(Boolean);
  if(url.pathname==='/api/health') return send(res,200,{ok:true,product:'XHS Research Studio',time:now()});
  if(url.pathname==='/api/projects' && req.method==='GET') return send(res,200,{projects:await getProjects()});
  if(url.pathname==='/api/projects' && req.method==='POST'){
    const b=await bodyJson(req); const projects=await getProjects(); const p={id:id('prj'),slug:slug(b.name),name:safeText(b.name||'Untitled project'),client:safeText(b.client),category:safeText(b.category),keywords:Array.isArray(b.keywords)?b.keywords.map(safeText).filter(Boolean):[],competitors:Array.isArray(b.competitors)?b.competitors.map(safeText).filter(Boolean):[],createdAt:now(),updatedAt:now()}; projects.push(p); await saveProjects(projects); return send(res,201,p);
  }
  if(url.pathname==='/api/analyze' && req.method==='POST'){const h=normalizeHarvest(await bodyJson(req)); return send(res,200,{harvest:h,analysis:analyze(h)});}
  if(parts[0]==='api' && parts[1]==='projects' && parts[2]){
    const project=await getProject(parts[2]); if(!project) return send(res,404,{error:'project not found'});
    if(parts.length===3 && req.method==='GET'){const snapshots=await listSnapshots(project.id); return send(res,200,{project,snapshots});}
    if(parts[3]==='plan' && req.method==='GET') return send(res,200,{projectId:project.id,plan:projectPlan(project)});
    if(parts[3]==='ingest' && req.method==='POST'){const snap=await saveSnapshot(project.id,await bodyJson(req)); const projects=await getProjects(); const i=projects.findIndex(p=>p.id===project.id); projects[i]={...projects[i],updatedAt:now(),lastSnapshotAt:snap.createdAt}; await saveProjects(projects); return send(res,201,snap);}
    if(parts[3]==='snapshots' && parts.length===4 && req.method==='GET') return send(res,200,{snapshots:await listSnapshots(project.id)});
    if(parts[3]==='snapshots' && parts[4] && req.method==='GET'){const s=await loadSnapshot(project.id,parts[4]); return s?send(res,200,s):send(res,404,{error:'snapshot not found'});}
    if(parts[3]==='diff' && req.method==='GET'){const snaps=await listSnapshots(project.id); const fromId=url.searchParams.get('from') || snaps.at(-2)?.id; const toId=url.searchParams.get('to') || snaps.at(-1)?.id; if(!fromId||!toId) return send(res,400,{error:'need at least two snapshots'}); const a=await loadSnapshot(project.id,fromId), b=await loadSnapshot(project.id,toId); return send(res,200,{project,diff:diffHarvest(a.harvest,b.harvest)});}
    if(parts[3]==='export.csv' && req.method==='GET'){const snaps=await listSnapshots(project.id); const sid=url.searchParams.get('snapshot')||snaps.at(-1)?.id; if(!sid) return send(res,400,{error:'no snapshot'}); const s=await loadSnapshot(project.id,sid); return send(res,200,evidenceCsv(s.harvest),'text/csv; charset=utf-8');}
    if(parts[3]==='report' && req.method==='GET'){const snaps=await listSnapshots(project.id); const sid=url.searchParams.get('snapshot')||snaps.at(-1)?.id; if(!sid) return send(res,400,{error:'no snapshot'}); const s=await loadSnapshot(project.id,sid); const idx=snaps.findIndex(x=>x.id===sid); const prev=idx>0?await loadSnapshot(project.id,snaps[idx-1].id):null; const md=markdownReport(project,s,prev); if(url.searchParams.get('format')==='json') return send(res,200,{project,snapshot:s,previous:prev,markdown:md}); return send(res,200,md,'text/markdown; charset=utf-8');}
  }
  return notFound(res);
}

async function serveStatic(req,res,url){
  let rel=url.pathname==='/'?'index.html':url.pathname.slice(1); rel=path.normalize(rel).replace(/^\.\.(\/|\\)/,''); const file=path.join(PUBLIC_DIR,rel); if(!file.startsWith(PUBLIC_DIR)) return notFound(res);
  try{const data=await fs.readFile(file); const ext=path.extname(file); const types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json; charset=utf-8'}; res.writeHead(200,{'content-type':types[ext]||'application/octet-stream'}); res.end(data);}catch{notFound(res);}
}

await ensure();
const server=http.createServer(async(req,res)=>{try{const url=new URL(req.url,`http://${req.headers.host||'localhost'}`); if(url.pathname.startsWith('/api/')) await api(req,res,url); else await serveStatic(req,res,url);}catch(err){send(res,500,{error:err.message||String(err)});}});
server.listen(PORT,HOST,()=>console.log(`XHS Research Studio running at http://${HOST}:${PORT}`));
