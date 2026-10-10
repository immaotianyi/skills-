#!/usr/bin/env node
import http from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeHarvest, safeText } from './lib/normalize.mjs';
import { analyze, diffHarvest, evidenceClusters, rankingSummary, markdownReport } from './lib/analysis.mjs';
import { HarvestValidationError, validateHarvestInput, validateNormalizedHarvest } from './lib/validation.mjs';
import { ensureData, getProjects, saveProjects, getProject, listSnapshots, loadSnapshot, saveSnapshot, makeId } from './lib/storage.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.XHS_STUDIO_DATA || path.join(__dirname, 'data');
const PUBLIC_DIR = path.resolve(__dirname, 'public');
const PORT = Number(process.env.PORT || 5418);
const HOST = process.env.HOST || '127.0.0.1';
const MAX_BODY_BYTES = Number(process.env.XHS_STUDIO_MAX_BODY || 15_000_000);
const VERSION = '0.3.0-hardening';

const PROJECT_TEMPLATES = [
  {id:'brand-monitor',name:'品牌监控',description:'品牌 + 竞品 + 搜索词的周期性变化',keywords:['品牌词','品类核心词','品牌+避雷','品牌+平替'],competitors:['竞品A','竞品B','竞品C']},
  {id:'competitor-scan',name:'竞品扫描',description:'比较竞品内容、互动、评论问题和搜索可见度',keywords:['品类推荐','品类测评','品类避雷','品类平替'],competitors:['竞品A','竞品B','竞品C','竞品D']},
  {id:'product-opportunity',name:'产品机会',description:'从问题、抱怨和购买追问里找 unmet needs',keywords:['品类+不好用','品类+缺点','品类+有没有','品类+为什么','品类+求推荐'],competitors:[]},
];

class HttpError extends Error {
  constructor(statusCode, message, details=[]) {
    super(message);
    this.statusCode = statusCode;
    this.details = details;
  }
}

function slug(v='') {
  return safeText(v).toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/gu,'-').replace(/^-|-$/g,'').slice(0,60) || 'project';
}

function csvCell(v) {
  const s=String(v ?? '');
  return /[\",\n]/u.test(s) ? `\"${s.replace(/\"/g,'\"\"')}\"` : s;
}

function evidenceCsv(h) {
  const rows=[['noteId','title','author','likes','collects','comments','shares','captureMethod','confidence','sourceUrl']];
  for (const n of h.notes || []) rows.push([n.noteId,n.title,n.author?.nickname,n.stats?.likes,n.stats?.collects,n.stats?.comments,n.stats?.shares,n.captureMethod,n.confidence,n.sourceUrl]);
  return rows.map(r=>r.map(csvCell).join(',')).join('\n')+'\n';
}

function evidencePack(project, snapshot) {
  const analysis = snapshot.analysis || analyze(snapshot.harvest);
  const h = snapshot.harvest;
  return {
    schemaVersion:'xhs-evidence-pack/1.1',
    generatedAt:new Date().toISOString(),
    project,
    snapshot:{id:snapshot.id,capturedAt:snapshot.createdAt},
    coverage:analysis.coverage,
    quality:analysis.quality,
    methodology:analysis.methodology,
    signals:analysis.signals,
    topNotes:analysis.topNotes.slice(0,20),
    rankings:analysis.rankings,
    evidenceClusters:analysis.evidenceClusters,
    gaps:analysis.coverage.gaps,
    sources:(h.notes || []).map(n=>({noteId:n.noteId,title:n.title,sourceUrl:n.sourceUrl,captureMethod:n.captureMethod,confidence:n.confidence})),
  };
}

function projectPlan(project) {
  const kws=(project.keywords||[]).map(k=>`- Search keyword: ${k} (record observed rankingPosition, noteId, source URL; sample 30–80 unless information saturation is reached earlier)`);
  const comps=(project.competitors||[]).map(k=>`- Competitor: ${k} (search brand name + key negative/compare terms; capture high-signal comments)`);
  return [
    `# Harvest plan: ${project.name}`,'',
    'Goal: produce one normalized Xiaohongshu Harvest v2 JSON snapshot for XHS Research Studio.','',
    '## Search work',...kws,'','## Competitor work',...comps,'',
    '## Required fields',
    '- source.capturedAt / entry / keyword / sourceUrl / captureMethod',
    '- each note: noteId, title, desc, author, stats, sourceUrl, captureMethod, confidence',
    '- comments as first-class objects when available',
    '- queries[] with keyword + rankingPosition when search is used',
    '- meta.gaps + loginRequired + riskState + stoppedBecause','',
    '## Stop rules',
    '- Use only public or user-authorized read-only paths.',
    '- Do not bypass CAPTCHA, login/access controls, rate limits, or safety systems.',
    '- Stop when additional samples no longer add meaningful new themes or the agreed sample budget is reached.',
    '- Record coverage gaps explicitly; do not convert inaccessible data into zero/absence claims.',
  ].join('\n');
}

function cleanList(v, limit=100) {
  if (!Array.isArray(v)) return [];
  return [...new Set(v.map(safeText).filter(Boolean))].slice(0,limit);
}

async function bodyJson(req) {
  const chunks=[];
  let bytes=0;
  for await (const c of req) {
    bytes += c.length;
    if (bytes > MAX_BODY_BYTES) throw new HttpError(413, `Request body exceeds ${MAX_BODY_BYTES} bytes.`);
    chunks.push(c);
  }
  if (!chunks.length) return {};
  const s=Buffer.concat(chunks).toString('utf8');
  try {
    return JSON.parse(s);
  } catch (err) {
    throw new HttpError(400, `Invalid JSON: ${err.message}`);
  }
}

function baseHeaders(type) {
  return {
    'content-type':type,
    'x-content-type-options':'nosniff',
    'referrer-policy':'no-referrer',
    'cross-origin-resource-policy':'same-origin',
  };
}

function send(res,status,data,type='application/json; charset=utf-8',extra={}) {
  const headers={...baseHeaders(type),'cache-control':'no-store',...extra};
  res.writeHead(status, headers);
  res.end(type.startsWith('application/json') ? JSON.stringify(data,null,2) : data);
}

function notFound(res) { send(res,404,{error:'not found'}); }

function sendError(res, err) {
  const status = Number(err?.statusCode) || (err instanceof HarvestValidationError ? err.statusCode : 500) || 500;
  const safeStatus = status >= 400 && status <= 599 ? status : 500;
  const body = { error: err?.message || String(err) };
  if (Array.isArray(err?.details) && err.details.length) body.details = err.details;
  send(res,safeStatus,body);
}

async function requireSnapshot(projectId, snapshotId) {
  const snapshot = await loadSnapshot(DATA_DIR, projectId, snapshotId);
  if (!snapshot) throw new HttpError(404,'snapshot not found');
  return snapshot;
}

async function latestSnapshot(projectId, requested='') {
  const snaps = await listSnapshots(DATA_DIR,projectId);
  const sid = requested || snaps.at(-1)?.id;
  if (!sid) throw new HttpError(400,'no snapshot');
  return {snaps,sid,snapshot:await requireSnapshot(projectId,sid)};
}

async function api(req,res,url) {
  const parts=url.pathname.split('/').filter(Boolean);
  if (url.pathname==='/api/health' && req.method==='GET') {
    return send(res,200,{ok:true,product:'XHS Research Studio',version:VERSION,time:new Date().toISOString(),dataDir:DATA_DIR});
  }
  if (url.pathname==='/api/templates' && req.method==='GET') return send(res,200,{templates:PROJECT_TEMPLATES});
  if (url.pathname==='/api/projects' && req.method==='GET') return send(res,200,{projects:await getProjects(DATA_DIR)});
  if (url.pathname==='/api/projects' && req.method==='POST') {
    const b=await bodyJson(req);
    const name=safeText(b.name);
    if (!name) throw new HttpError(400,'Project name is required.');
    if (name.length>120) throw new HttpError(400,'Project name must be 120 characters or fewer.');
    const projects=await getProjects(DATA_DIR);
    const p={
      id:makeId('prj'), slug:slug(name), name,
      client:safeText(b.client).slice(0,120), category:safeText(b.category).slice(0,120),
      keywords:cleanList(b.keywords), competitors:cleanList(b.competitors),
      createdAt:new Date().toISOString(), updatedAt:new Date().toISOString(),
    };
    projects.push(p);
    await saveProjects(DATA_DIR,projects);
    return send(res,201,p);
  }
  if (url.pathname==='/api/validate' && req.method==='POST') {
    const raw=await bodyJson(req);
    const input=validateHarvestInput(raw);
    if (!input.ok) return send(res,422,input);
    const normalized=normalizeHarvest(raw);
    const normalizedValidation=validateNormalizedHarvest(normalized);
    return send(res,200,{ok:normalizedValidation.ok,input,normalized:normalizedValidation,summary:{notes:normalized.notes.length,comments:normalized.comments.length,queries:normalized.queries.length,riskState:normalized.meta.riskState}});
  }
  if (url.pathname==='/api/analyze' && req.method==='POST') {
    const raw=await bodyJson(req);
    const inputValidation=validateHarvestInput(raw);
    if (!inputValidation.ok) throw new HarvestValidationError('Invalid Harvest payload.',inputValidation.errors,400);
    const h=normalizeHarvest(raw);
    return send(res,200,{harvest:h,validation:{warnings:inputValidation.warnings},analysis:analyze(h)});
  }

  if (parts[0]==='api' && parts[1]==='projects' && parts[2]) {
    const project=await getProject(DATA_DIR,parts[2]);
    if (!project) return send(res,404,{error:'project not found'});
    if (parts.length===3 && req.method==='GET') return send(res,200,{project,snapshots:await listSnapshots(DATA_DIR,project.id)});
    if (parts[3]==='plan' && req.method==='GET') return send(res,200,{projectId:project.id,plan:projectPlan(project)});
    if (parts[3]==='ingest' && req.method==='POST') {
      const raw=await bodyJson(req);
      const inputValidation=validateHarvestInput(raw);
      if (!inputValidation.ok) throw new HarvestValidationError('Invalid Harvest payload.',inputValidation.errors,400);
      const snap=await saveSnapshot(DATA_DIR,project.id,raw);
      snap.validation.inputWarnings = inputValidation.warnings;
      const projects=await getProjects(DATA_DIR);
      const i=projects.findIndex(p=>p.id===project.id);
      projects[i]={...projects[i],updatedAt:new Date().toISOString(),lastSnapshotAt:snap.createdAt};
      await saveProjects(DATA_DIR,projects);
      return send(res,201,snap);
    }
    if (parts[3]==='snapshots' && parts.length===4 && req.method==='GET') return send(res,200,{snapshots:await listSnapshots(DATA_DIR,project.id)});
    if (parts[3]==='snapshots' && parts[4] && req.method==='GET') return send(res,200,await requireSnapshot(project.id,parts[4]));
    if (parts[3]==='evidence' && req.method==='GET') {
      const {sid,snapshot}=await latestSnapshot(project.id,url.searchParams.get('snapshot')||'');
      const term=safeText(url.searchParams.get('term'));
      const clusters=snapshot.analysis?.evidenceClusters || evidenceClusters(snapshot.harvest);
      return send(res,200,{snapshotId:sid,term,clusters:term?clusters.filter(x=>x.term===term):clusters});
    }
    if (parts[3]==='ranks' && req.method==='GET') {
      const {sid,snapshot}=await latestSnapshot(project.id,url.searchParams.get('snapshot')||'');
      return send(res,200,{projectId:project.id,snapshotId:sid,rankings:snapshot.analysis?.rankings||rankingSummary(snapshot.harvest)});
    }
    if (parts[3]==='diff' && req.method==='GET') {
      const snaps=await listSnapshots(DATA_DIR,project.id);
      const fromId=url.searchParams.get('from')||snaps.at(-2)?.id;
      const toId=url.searchParams.get('to')||snaps.at(-1)?.id;
      if(!fromId||!toId) throw new HttpError(400,'need at least two snapshots');
      const a=await requireSnapshot(project.id,fromId);
      const b=await requireSnapshot(project.id,toId);
      return send(res,200,{project,fromId,toId,diff:diffHarvest(a.harvest,b.harvest)});
    }
    if (parts[3]==='export.csv' && req.method==='GET') {
      const {snapshot}=await latestSnapshot(project.id,url.searchParams.get('snapshot')||'');
      return send(res,200,evidenceCsv(snapshot.harvest),'text/csv; charset=utf-8',{'content-disposition':`attachment; filename="${project.slug||'xhs'}-evidence.csv"`});
    }
    if (parts[3]==='evidence-pack' && req.method==='GET') {
      const {snapshot}=await latestSnapshot(project.id,url.searchParams.get('snapshot')||'');
      return send(res,200,evidencePack(project,snapshot),'application/json; charset=utf-8',{'content-disposition':`attachment; filename="${project.slug||'xhs'}-evidence-pack.json"`});
    }
    if (parts[3]==='report' && req.method==='GET') {
      const {snaps,sid,snapshot}=await latestSnapshot(project.id,url.searchParams.get('snapshot')||'');
      const idx=snaps.findIndex(x=>x.id===sid);
      const prev=idx>0?await requireSnapshot(project.id,snaps[idx-1].id):null;
      const md=markdownReport(project,snapshot,prev);
      if(url.searchParams.get('format')==='json') return send(res,200,{project,snapshot,previous:prev,markdown:md});
      return send(res,200,md,'text/markdown; charset=utf-8');
    }
  }
  return notFound(res);
}

async function serveStatic(req,res,url) {
  let rel;
  try {
    rel=decodeURIComponent(url.pathname==='/'?'index.html':url.pathname.slice(1));
  } catch {
    return notFound(res);
  }
  const file=path.resolve(PUBLIC_DIR,rel);
  if(file!==PUBLIC_DIR && !file.startsWith(PUBLIC_DIR+path.sep)) return notFound(res);
  try {
    const data=await fs.readFile(file);
    const ext=path.extname(file);
    const types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json; charset=utf-8'};
    const type=types[ext]||'application/octet-stream';
    const headers={
      ...baseHeaders(type),
      'cache-control': ext==='.html'?'no-store':'public, max-age=300',
      'content-security-policy':"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    };
    res.writeHead(200,headers);
    res.end(data);
  } catch (err) {
    if (err?.code==='ENOENT' || err?.code==='EISDIR') return notFound(res);
    throw err;
  }
}

await ensureData(DATA_DIR);
const server=http.createServer(async(req,res)=>{
  try {
    const url=new URL(req.url,`http://${req.headers.host||'localhost'}`);
    if(url.pathname.startsWith('/api/')) await api(req,res,url);
    else await serveStatic(req,res,url);
  } catch(err) {
    console.error(err);
    sendError(res,err);
  }
});
server.listen(PORT,HOST,()=>console.log(`XHS Research Studio ${VERSION} running at http://${HOST}:${PORT}`));
