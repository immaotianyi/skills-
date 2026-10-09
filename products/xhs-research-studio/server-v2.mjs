#!/usr/bin/env node
import http from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeHarvest, safeText } from './lib/normalize.mjs';
import { analyze, diffHarvest, evidenceClusters, rankingSummary, markdownReport } from './lib/analysis.mjs';
import { ensureData, getProjects, saveProjects, getProject, listSnapshots, loadSnapshot, saveSnapshot, makeId } from './lib/storage.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.XHS_STUDIO_DATA || path.join(__dirname, 'data');
const PUBLIC_DIR = path.join(__dirname, 'public');
const PORT = Number(process.env.PORT || 5418);
const HOST = process.env.HOST || '127.0.0.1';

const PROJECT_TEMPLATES = [
  {id:'brand-monitor',name:'品牌监控',description:'品牌 + 竞品 + 搜索词的周期性变化',keywords:['品牌词','品类核心词','品牌+避雷','品牌+平替'],competitors:['竞品A','竞品B','竞品C']},
  {id:'competitor-scan',name:'竞品扫描',description:'比较竞品内容、互动、评论问题和搜索可见度',keywords:['品类推荐','品类测评','品类避雷','品类平替'],competitors:['竞品A','竞品B','竞品C','竞品D']},
  {id:'product-opportunity',name:'产品机会',description:'从问题、抱怨和购买追问里找 unmet needs',keywords:['品类+不好用','品类+缺点','品类+有没有','品类+为什么','品类+求推荐'],competitors:[]},
];

function slug(v='') { return safeText(v).toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g,'-').replace(/^-|-$/g,'').slice(0,60) || 'project'; }
function csvCell(v) { const s=String(v ?? ''); return /[\",\n]/.test(s) ? `\"${s.replace(/\"/g,'\"\"')}\"` : s; }
function evidenceCsv(h) {
  const rows=[['noteId','title','author','likes','collects','comments','shares','captureMethod','sourceUrl']];
  for (const n of h.notes) rows.push([n.noteId,n.title,n.author.nickname,n.stats.likes,n.stats.collects,n.stats.comments,n.stats.shares,n.captureMethod,n.sourceUrl]);
  return rows.map(r=>r.map(csvCell).join(',')).join('\n')+'\n';
}
function projectPlan(project) {
  const kws=(project.keywords||[]).map(k=>`- Search keyword: ${k} (collect result rank, noteId, source URL; sample 30–80 unless saturation is reached earlier)`);
  const comps=(project.competitors||[]).map(k=>`- Competitor: ${k} (search brand name + key negative/compare terms; capture high-signal comments)`);
  return [
    `# Harvest plan: ${project.name}`,'',
    'Goal: produce one normalized Xiaohongshu Harvest v2 JSON snapshot for XHS Research Studio.','',
    '## Search work',...kws,'','## Competitor work',...comps,'',
    '## Required fields',
    '- source.capturedAt / entry / keyword / sourceUrl',
    '- each note: noteId, title, desc, author, stats, sourceUrl, captureMethod',
    '- comments as first-class objects when available',
    '- queries[] with keyword + rankingPosition when search is used',
    '- meta.gaps + loginRequired + riskState','',
    '## Stop rules',
    '- Public/read-only paths first.',
    '- Do not bypass CAPTCHA/access controls.',
    '- Stop when additional samples no longer add meaningful new themes or the agreed sample budget is reached.',
    '- Record any coverage gaps explicitly.',
  ].join('\n');
}

async function bodyJson(req) {
  const chunks=[];
  for await (const c of req) chunks.push(c);
  if (!chunks.length) return {};
  const s=Buffer.concat(chunks).toString('utf8');
  if (s.length > 15_000_000) throw new Error('body too large');
  return JSON.parse(s);
}
function send(res,status,data,type='application/json; charset=utf-8') {
  res.writeHead(status, {'content-type':type,'cache-control':'no-store'});
  res.end(type.startsWith('application/json') ? JSON.stringify(data,null,2) : data);
}
function notFound(res) { send(res,404,{error:'not found'}); }

async function api(req,res,url) {
  const parts=url.pathname.split('/').filter(Boolean);
  if (url.pathname==='/api/health') return send(res,200,{ok:true,product:'XHS Research Studio',version:'0.2.0-mvp',time:new Date().toISOString()});
  if (url.pathname==='/api/templates' && req.method==='GET') return send(res,200,{templates:PROJECT_TEMPLATES});
  if (url.pathname==='/api/projects' && req.method==='GET') return send(res,200,{projects:await getProjects(DATA_DIR)});
  if (url.pathname==='/api/projects' && req.method==='POST') {
    const b=await bodyJson(req);
    const projects=await getProjects(DATA_DIR);
    const p={
      id:makeId('prj'), slug:slug(b.name), name:safeText(b.name||'Untitled project'),
      client:safeText(b.client), category:safeText(b.category),
      keywords:Array.isArray(b.keywords)?b.keywords.map(safeText).filter(Boolean):[],
      competitors:Array.isArray(b.competitors)?b.competitors.map(safeText).filter(Boolean):[],
      createdAt:new Date().toISOString(), updatedAt:new Date().toISOString(),
    };
    projects.push(p); await saveProjects(DATA_DIR,projects); return send(res,201,p);
  }
  if (url.pathname==='/api/analyze' && req.method==='POST') {
    const h=normalizeHarvest(await bodyJson(req)); return send(res,200,{harvest:h,analysis:analyze(h)});
  }

  if (parts[0]==='api' && parts[1]==='projects' && parts[2]) {
    const project=await getProject(DATA_DIR,parts[2]);
    if (!project) return send(res,404,{error:'project not found'});
    if (parts.length===3 && req.method==='GET') return send(res,200,{project,snapshots:await listSnapshots(DATA_DIR,project.id)});
    if (parts[3]==='plan' && req.method==='GET') return send(res,200,{projectId:project.id,plan:projectPlan(project)});
    if (parts[3]==='ingest' && req.method==='POST') {
      const snap=await saveSnapshot(DATA_DIR,project.id,await bodyJson(req));
      const projects=await getProjects(DATA_DIR); const i=projects.findIndex(p=>p.id===project.id);
      projects[i]={...projects[i],updatedAt:new Date().toISOString(),lastSnapshotAt:snap.createdAt}; await saveProjects(DATA_DIR,projects);
      return send(res,201,snap);
    }
    if (parts[3]==='snapshots' && parts.length===4 && req.method==='GET') return send(res,200,{snapshots:await listSnapshots(DATA_DIR,project.id)});
    if (parts[3]==='snapshots' && parts[4] && req.method==='GET') {
      const s=await loadSnapshot(DATA_DIR,project.id,parts[4]); return s?send(res,200,s):send(res,404,{error:'snapshot not found'});
    }
    if (parts[3]==='evidence' && req.method==='GET') {
      const snaps=await listSnapshots(DATA_DIR,project.id); const sid=url.searchParams.get('snapshot')||snaps.at(-1)?.id;
      if(!sid) return send(res,400,{error:'no snapshot'});
      const s=await loadSnapshot(DATA_DIR,project.id,sid); const term=safeText(url.searchParams.get('term'));
      const clusters=s.analysis?.evidenceClusters || evidenceClusters(s.harvest);
      return send(res,200,{term,clusters:term?clusters.filter(x=>x.term===term):clusters});
    }
    if (parts[3]==='ranks' && req.method==='GET') {
      const snaps=await listSnapshots(DATA_DIR,project.id); const sid=url.searchParams.get('snapshot')||snaps.at(-1)?.id;
      if(!sid) return send(res,400,{error:'no snapshot'});
      const s=await loadSnapshot(DATA_DIR,project.id,sid);
      return send(res,200,{projectId:project.id,snapshotId:sid,rankings:s.analysis?.rankings||rankingSummary(s.harvest)});
    }
    if (parts[3]==='diff' && req.method==='GET') {
      const snaps=await listSnapshots(DATA_DIR,project.id);
      const fromId=url.searchParams.get('from')||snaps.at(-2)?.id; const toId=url.searchParams.get('to')||snaps.at(-1)?.id;
      if(!fromId||!toId) return send(res,400,{error:'need at least two snapshots'});
      const a=await loadSnapshot(DATA_DIR,project.id,fromId), b=await loadSnapshot(DATA_DIR,project.id,toId);
      return send(res,200,{project,diff:diffHarvest(a.harvest,b.harvest)});
    }
    if (parts[3]==='export.csv' && req.method==='GET') {
      const snaps=await listSnapshots(DATA_DIR,project.id); const sid=url.searchParams.get('snapshot')||snaps.at(-1)?.id;
      if(!sid) return send(res,400,{error:'no snapshot'}); const s=await loadSnapshot(DATA_DIR,project.id,sid);
      return send(res,200,evidenceCsv(s.harvest),'text/csv; charset=utf-8');
    }
    if (parts[3]==='report' && req.method==='GET') {
      const snaps=await listSnapshots(DATA_DIR,project.id); const sid=url.searchParams.get('snapshot')||snaps.at(-1)?.id;
      if(!sid) return send(res,400,{error:'no snapshot'}); const s=await loadSnapshot(DATA_DIR,project.id,sid);
      const idx=snaps.findIndex(x=>x.id===sid); const prev=idx>0?await loadSnapshot(DATA_DIR,project.id,snaps[idx-1].id):null;
      const md=markdownReport(project,s,prev);
      if(url.searchParams.get('format')==='json') return send(res,200,{project,snapshot:s,previous:prev,markdown:md});
      return send(res,200,md,'text/markdown; charset=utf-8');
    }
  }
  return notFound(res);
}

async function serveStatic(req,res,url) {
  let rel=url.pathname==='/'?'index.html':url.pathname.slice(1);
  rel=path.normalize(rel).replace(/^\.\.(\/|\\)/,'');
  const file=path.join(PUBLIC_DIR,rel);
  if(!file.startsWith(PUBLIC_DIR)) return notFound(res);
  try {
    const data=await fs.readFile(file); const ext=path.extname(file);
    const types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json; charset=utf-8'};
    res.writeHead(200,{'content-type':types[ext]||'application/octet-stream'}); res.end(data);
  } catch { notFound(res); }
}

await ensureData(DATA_DIR);
const server=http.createServer(async(req,res)=>{
  try {
    const url=new URL(req.url,`http://${req.headers.host||'localhost'}`);
    if(url.pathname.startsWith('/api/')) await api(req,res,url); else await serveStatic(req,res,url);
  } catch(err) { send(res,500,{error:err.message||String(err)}); }
});
server.listen(PORT,HOST,()=>console.log(`XHS Research Studio v0.2 running at http://${HOST}:${PORT}`));
