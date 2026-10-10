#!/usr/bin/env node
import http from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeHarvest, safeText } from './lib/normalize.mjs';
import { analyze, diffHarvest, evidenceClusters, rankingSummary, markdownReport } from './lib/analysis.mjs';
import { HarvestValidationError, validateHarvestInput, validateNormalizedHarvest } from './lib/validation.mjs';
import { ensureData, getProjects, mutateProjects, getProject, listSnapshots, loadSnapshot, saveSnapshot, makeId } from './lib/storage.mjs';
import { buildEvidencePack, verifyEvidencePack } from './lib/evidence-pack.mjs';
import { RunService } from './lib/run-service.mjs';
import { handleProjectRunApi } from './lib/run-http.mjs';
import { HostedStore, hostedModeEnabled } from './lib/hosted-db.mjs';
import { createHostedRunPolicy } from './lib/hosted-policy.mjs';
import { handleHostedApi, handlePublicShare, requireHostedSession, resolveWorkspace, requireProjectWorkspace, workspaceProjects } from './lib/hosted-http.mjs';
import { handleHostedMembersApi } from './lib/hosted-members-http.mjs';
import { buildGroundedSynthesisInput, synthesizeGrounded } from './lib/synthesis.mjs';

const __dirname=path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR=process.env.XHS_STUDIO_DATA||path.join(__dirname,'data');
const PUBLIC_DIR=path.resolve(__dirname,'public');
const PORT=Number(process.env.PORT||5418);
const HOST=process.env.HOST||'127.0.0.1';
const configuredBodyLimit=Number(process.env.XHS_STUDIO_MAX_BODY||15_000_000);
const MAX_BODY_BYTES=Number.isFinite(configuredBodyLimit)&&configuredBodyLimit>0?configuredBodyLimit:15_000_000;
const VERSION='0.4.0-hosted-beta';
const HOSTED=hostedModeEnabled();

const PROJECT_TEMPLATES=[
  {id:'brand-monitor',name:'品牌监控',description:'品牌 + 竞品 + 搜索词的周期性变化',keywords:['品牌词','品类核心词','品牌+避雷','品牌+平替'],competitors:['竞品A','竞品B','竞品C']},
  {id:'competitor-scan',name:'竞品扫描',description:'比较竞品内容、互动、评论问题和搜索可见度',keywords:['品类推荐','品类测评','品类避雷','品类平替'],competitors:['竞品A','竞品B','竞品C','竞品D']},
  {id:'product-opportunity',name:'产品机会',description:'从问题、抱怨和购买追问里找 unmet needs',keywords:['品类+不好用','品类+缺点','品类+有没有','品类+为什么','品类+求推荐'],competitors:[]},
];

class HttpError extends Error{constructor(statusCode,message,details=[]){super(message);this.statusCode=statusCode;this.details=details}}
function slug(v=''){return safeText(v).toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/gu,'-').replace(/^-|-$/g,'').slice(0,60)||'project'}
function csvCell(v){const s=String(v??'');return /[",\n]/u.test(s)?`"${s.replace(/"/g,'""')}"`:s}
function evidenceCsv(h){const rows=[['noteId','title','author','likes','collects','comments','shares','captureMethod','confidence','sourceUrl']];for(const n of h.notes||[])rows.push([n.noteId,n.title,n.author?.nickname,n.stats?.likes,n.stats?.collects,n.stats?.comments,n.stats?.shares,n.captureMethod,n.confidence,n.sourceUrl]);return rows.map(r=>r.map(csvCell).join(',')).join('\n')+'\n'}
function legacyEvidencePack(project,snapshot){const analysis=snapshot.analysis||analyze(snapshot.harvest),h=snapshot.harvest;return{schemaVersion:'xhs-evidence-pack/1.1',generatedAt:new Date().toISOString(),project,snapshot:{id:snapshot.id,capturedAt:snapshot.createdAt},coverage:analysis.coverage,quality:analysis.quality,methodology:analysis.methodology,signals:analysis.signals,topNotes:analysis.topNotes.slice(0,20),rankings:analysis.rankings,evidenceClusters:analysis.evidenceClusters,gaps:analysis.coverage.gaps,sources:(h.notes||[]).map(n=>({noteId:n.noteId,title:n.title,sourceUrl:n.sourceUrl,captureMethod:n.captureMethod,confidence:n.confidence}))}}
function packIntegrityOptions(){const key=String(process.env.XHS_STUDIO_PACK_INTEGRITY_KEY||'');if(key&&Buffer.byteLength(key,'utf8')<32)throw new Error('XHS_STUDIO_PACK_INTEGRITY_KEY must be at least 32 UTF-8 bytes');return key?{key,keyId:String(process.env.XHS_STUDIO_PACK_INTEGRITY_KEY_ID||'pack-v1')}: {}}
function requestedPackVersion(url){const version=safeText(url.searchParams.get('version')||'1.1');if(version==='1.1'||version==='1.2')return version;throw new HttpError(400,`Unsupported Evidence Pack version: ${version}`)}
function requiresAuthenticatedPack(url){return ['1','true','yes'].includes(safeText(url.searchParams.get('requireAuthenticated')).toLowerCase())}
function projectPlan(project){const kws=(project.keywords||[]).map(k=>`- Search keyword: ${k} (record observed rankingPosition, noteId, source URL; sample 30–80 unless information saturation is reached earlier)`),comps=(project.competitors||[]).map(k=>`- Competitor: ${k} (search brand name + key negative/compare terms; capture high-signal comments)`);return[`# Harvest plan: ${project.name}`,'','Goal: produce one normalized Xiaohongshu Harvest v2 JSON snapshot for XHS Research Studio.','','## Search work',...kws,'','## Competitor work',...comps,'','## Required fields','- source.capturedAt / entry / keyword / sourceUrl / captureMethod','- each note: noteId, title, desc, author, stats, sourceUrl, captureMethod, confidence','- comments as first-class objects when available','- queries[] with keyword + rankingPosition when search is used','- meta.gaps + loginRequired + riskState + stoppedBecause','','## Stop rules','- Use only public or user-authorized read-only paths.','- Do not bypass CAPTCHA, login/access controls, rate limits, or safety systems.','- Stop when additional samples no longer add meaningful new themes or the agreed sample budget is reached.','- Record coverage gaps explicitly; do not convert inaccessible data into zero/absence claims.'].join('\n')}
function cleanList(v,limit=100){if(!Array.isArray(v))return[];return[...new Set(v.map(safeText).filter(Boolean))].slice(0,limit)}
async function bodyRaw(req){const chunks=[];let bytes=0;for await(const c of req){bytes+=c.length;if(bytes>MAX_BODY_BYTES)throw new HttpError(413,`Request body exceeds ${MAX_BODY_BYTES} bytes.`);chunks.push(c)}return Buffer.concat(chunks)}
async function bodyJson(req){const raw=await bodyRaw(req);if(!raw.length)return{};try{return JSON.parse(raw.toString('utf8'))}catch(err){throw new HttpError(400,`Invalid JSON: ${err.message}`)}}
function baseHeaders(type){return{'content-type':type,'x-content-type-options':'nosniff','referrer-policy':'no-referrer','cross-origin-resource-policy':'same-origin'}}
function send(res,status,data,type='application/json; charset=utf-8',extra={}){const headers={...baseHeaders(type),'cache-control':'no-store',...extra};res.writeHead(status,headers);res.end(type.startsWith('application/json')?JSON.stringify(data,null,2):data)}
function notFound(res){send(res,404,{error:'not found'})}
function sendError(res,err){const status=Number(err?.statusCode)||(err instanceof HarvestValidationError?err.statusCode:500)||500,safeStatus=status>=400&&status<=599?status:500,body={error:safeStatus>=500?'internal server error':(err?.message||String(err))};if(safeStatus<500&&err?.code)body.code=err.code;if(safeStatus<500&&Array.isArray(err?.details)&&err.details.length)body.details=err.details;send(res,safeStatus,body)}
async function requireSnapshot(projectId,snapshotId){const snapshot=await loadSnapshot(DATA_DIR,projectId,snapshotId);if(!snapshot)throw new HttpError(404,'snapshot not found');return snapshot}
async function latestSnapshot(projectId,requested=''){const snaps=await listSnapshots(DATA_DIR,projectId),sid=requested||snaps.at(-1)?.id;if(!sid)throw new HttpError(400,'no snapshot');return{snaps,sid,snapshot:await requireSnapshot(projectId,sid)}}

let hostedStore=null;
let runService=null;
function hostedContext(req,{roles=['owner','admin','analyst','viewer']}={}){const session=requireHostedSession(req,hostedStore);return resolveWorkspace(req,hostedStore,session,{roles})}
function projectWriteRequest(req,parts){if(req.method==='GET'||req.method==='HEAD')return false;if(['ingest','runs','schedules','synthesis'].includes(parts[3]))return true;return false}
function sanitizeProjectForShare(project){const{workspaceId,createdBy,...safe}=project||{};return safe}
async function loadSharedReport(share){const project=await getProject(DATA_DIR,share.projectId);if(!project||project.workspaceId!==share.workspaceId)return null;const{snaps,sid,snapshot}=await latestSnapshot(project.id),idx=snaps.findIndex(x=>x.id===sid),prev=idx>0?await requireSnapshot(project.id,snaps[idx-1].id):null;return{project:sanitizeProjectForShare(project),snapshot:{id:snapshot.id,createdAt:snapshot.createdAt,analysis:snapshot.analysis},markdown:markdownReport(project,snapshot,prev)}}

async function api(req,res,url){
  const parts=url.pathname.split('/').filter(Boolean);
  if(url.pathname==='/api/health'&&req.method==='GET')return send(res,200,{ok:true,product:'XHS Research Studio',version:VERSION,hosted:HOSTED,time:new Date().toISOString()});
  if(HOSTED&&await handleHostedMembersApi({req,res,url,store:hostedStore,readJson:bodyJson,send,env:process.env}))return;
  if(HOSTED&&await handleHostedApi({req,res,url,store:hostedStore,readJson:bodyJson,readRaw:bodyRaw,send,getProject:id=>getProject(DATA_DIR,id),getProjects:()=>getProjects(DATA_DIR),env:process.env}))return;

  if(url.pathname==='/api/run-system'&&req.method==='GET'){
    const status=runService.status();if(!HOSTED)return send(res,200,status);
    const ctx=hostedContext(req),projects=workspaceProjects(await getProjects(DATA_DIR),ctx.workspace.id),allowed=new Set(projects.map(p=>p.id));
    return send(res,200,{executorConfigured:status.executorConfigured,schedulerTickMs:status.schedulerTickMs,policyConfigured:status.policyConfigured,activeProjectCount:status.activeProjects.filter(id=>allowed.has(id)).length});
  }
  if(url.pathname==='/api/templates'&&req.method==='GET'){if(HOSTED)requireHostedSession(req,hostedStore);return send(res,200,{templates:PROJECT_TEMPLATES})}
  if(url.pathname==='/api/projects'&&req.method==='GET'){
    const projects=await getProjects(DATA_DIR);if(!HOSTED)return send(res,200,{projects});const ctx=hostedContext(req);return send(res,200,{workspace:ctx.workspace,projects:workspaceProjects(projects,ctx.workspace.id)});
  }
  if(url.pathname==='/api/projects'&&req.method==='POST'){
    const ctx=HOSTED?hostedContext(req,{roles:['owner','admin','analyst']}):null,b=await bodyJson(req),name=safeText(b.name);
    if(!name)throw new HttpError(400,'Project name is required.');if(name.length>120)throw new HttpError(400,'Project name must be 120 characters or fewer.');
    const p={id:makeId('prj'),slug:slug(name),name,client:safeText(b.client).slice(0,120),category:safeText(b.category).slice(0,120),keywords:cleanList(b.keywords),competitors:cleanList(b.competitors),createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()};
    if(ctx){p.workspaceId=ctx.workspace.id;p.createdBy=ctx.session.user.id}
    await mutateProjects(DATA_DIR,projects=>{if(ctx){const count=projects.filter(item=>item.workspaceId===ctx.workspace.id).length;hostedStore.assertProjectCreation(ctx.workspace.id,count)}projects.push(p);return p});
    if(ctx)hostedStore.audit({workspaceId:ctx.workspace.id,userId:ctx.session.user.id,action:'project.create',targetType:'project',targetId:p.id,metadata:{name:p.name}});return send(res,201,p);
  }
  if(url.pathname==='/api/validate'&&req.method==='POST'){
    if(HOSTED)requireHostedSession(req,hostedStore);const raw=await bodyJson(req),input=validateHarvestInput(raw);if(!input.ok)return send(res,422,input);const normalized=normalizeHarvest(raw),normalizedValidation=validateNormalizedHarvest(normalized);return send(res,200,{ok:normalizedValidation.ok,input,normalized:normalizedValidation,summary:{notes:normalized.notes.length,comments:normalized.comments.length,queries:normalized.queries.length,riskState:normalized.meta.riskState}});
  }
  if(url.pathname==='/api/analyze'&&req.method==='POST'){
    if(HOSTED)requireHostedSession(req,hostedStore);const raw=await bodyJson(req),inputValidation=validateHarvestInput(raw);if(!inputValidation.ok)throw new HarvestValidationError('Invalid Harvest payload.',inputValidation.errors,400);const h=normalizeHarvest(raw);return send(res,200,{harvest:h,validation:{warnings:inputValidation.warnings},analysis:analyze(h)});
  }

  if(parts[0]==='api'&&parts[1]==='projects'&&parts[2]){
    const project=await getProject(DATA_DIR,parts[2]);if(!project)return send(res,404,{error:'project not found'});
    const ctx=HOSTED?requireProjectWorkspace(req,hostedStore,project,{write:projectWriteRequest(req,parts)}):null;
    if(parts.length===3&&req.method==='GET')return send(res,200,{project,snapshots:await listSnapshots(DATA_DIR,project.id)});
    if(await handleProjectRunApi({req,res,parts,project,runService,readJson:bodyJson,send}))return;
    if(parts[3]==='plan'&&req.method==='GET')return send(res,200,{projectId:project.id,plan:projectPlan(project)});
    if(parts[3]==='ingest'&&req.method==='POST'){
      const raw=await bodyJson(req),inputValidation=validateHarvestInput(raw);if(!inputValidation.ok)throw new HarvestValidationError('Invalid Harvest payload.',inputValidation.errors,400);
      const snap=await saveSnapshot(DATA_DIR,project.id,raw);snap.validation.inputWarnings=inputValidation.warnings;
      await mutateProjects(DATA_DIR,projects=>{const i=projects.findIndex(p=>p.id===project.id);if(i<0)throw new HttpError(404,'project not found');projects[i]={...projects[i],updatedAt:new Date().toISOString(),lastSnapshotAt:snap.createdAt};return projects[i]});
      if(ctx)hostedStore.audit({workspaceId:ctx.workspace.id,userId:ctx.session.user.id,action:'snapshot.ingest.manual',targetType:'snapshot',targetId:snap.id,metadata:{projectId:project.id}});return send(res,201,snap);
    }
    if(parts[3]==='snapshots'&&parts.length===4&&req.method==='GET')return send(res,200,{snapshots:await listSnapshots(DATA_DIR,project.id)});
    if(parts[3]==='snapshots'&&parts[4]&&req.method==='GET')return send(res,200,await requireSnapshot(project.id,parts[4]));
    if(parts[3]==='evidence'&&req.method==='GET'){const{sid,snapshot}=await latestSnapshot(project.id,url.searchParams.get('snapshot')||''),term=safeText(url.searchParams.get('term')),clusters=snapshot.analysis?.evidenceClusters||evidenceClusters(snapshot.harvest);return send(res,200,{snapshotId:sid,term,clusters:term?clusters.filter(x=>x.term===term):clusters})}
    if(parts[3]==='ranks'&&req.method==='GET'){const{sid,snapshot}=await latestSnapshot(project.id,url.searchParams.get('snapshot')||'');return send(res,200,{projectId:project.id,snapshotId:sid,rankings:snapshot.analysis?.rankings||rankingSummary(snapshot.harvest)})}
    if(parts[3]==='diff'&&req.method==='GET'){const snaps=await listSnapshots(DATA_DIR,project.id),fromId=url.searchParams.get('from')||snaps.at(-2)?.id,toId=url.searchParams.get('to')||snaps.at(-1)?.id;if(!fromId||!toId)throw new HttpError(400,'need at least two snapshots');const a=await requireSnapshot(project.id,fromId),b=await requireSnapshot(project.id,toId);return send(res,200,{project,fromId,toId,diff:diffHarvest(a.harvest,b.harvest)})}
    if(parts[3]==='export.csv'&&req.method==='GET'){const{snapshot}=await latestSnapshot(project.id,url.searchParams.get('snapshot')||'');return send(res,200,evidenceCsv(snapshot.harvest),'text/csv; charset=utf-8',{'content-disposition':`attachment; filename="${project.slug||'xhs'}-evidence.csv"`})}
    if(parts[3]==='evidence-pack'&&req.method==='GET'){
      const{snapshot}=await latestSnapshot(project.id,url.searchParams.get('snapshot')||''),version=requestedPackVersion(url),requireAuthenticated=requiresAuthenticatedPack(url);
      if(version==='1.1'){if(requireAuthenticated)throw new HttpError(409,'Authenticated Evidence Pack requires version 1.2; refusing to downgrade to v1.1.');return send(res,200,legacyEvidencePack(project,snapshot),'application/json; charset=utf-8',{'content-disposition':`attachment; filename="${project.slug||'xhs'}-evidence-pack-v1.1.json"`,'x-xhs-evidence-pack-version':'1.1','x-xhs-evidence-pack-authenticated':'false'})}
      const options=packIntegrityOptions(),pack=buildEvidencePack(project,snapshot,options),verification=verifyEvidencePack(pack,options);if(!verification.ok)throw new Error(`Generated Evidence Pack failed self-verification: ${JSON.stringify(verification.errors)}`);if(requireAuthenticated&&(snapshot.integrityStatus?.authenticated!==true||verification.authenticated!==true))throw new HttpError(409,'Authenticated Evidence Pack requires both an authenticated source snapshot and a configured Pack HMAC key.');return send(res,200,pack,'application/json; charset=utf-8',{'content-disposition':`attachment; filename="${project.slug||'xhs'}-evidence-pack-v1.2.json"`,'x-xhs-evidence-pack-version':'1.2','x-xhs-evidence-pack-authenticated':String(verification.authenticated===true)});
    }
    if(parts[3]==='synthesis'&&req.method==='POST'){
      const body=await bodyJson(req),{snapshot}=await latestSnapshot(project.id,safeText(body.snapshotId||'')),input=buildGroundedSynthesisInput(project,snapshot),synthesis=await synthesizeGrounded(input,{env:process.env});
      if(ctx)hostedStore.audit({workspaceId:ctx.workspace.id,userId:ctx.session.user.id,action:'synthesis.generate',targetType:'snapshot',targetId:snapshot.id,metadata:{projectId:project.id,provider:synthesis.provider?.name||'unknown',claims:synthesis.claims.length}});
      return send(res,200,{projectId:project.id,snapshotId:snapshot.id,synthesis});
    }
    if(parts[3]==='report'&&req.method==='GET'){const{snaps,sid,snapshot}=await latestSnapshot(project.id,url.searchParams.get('snapshot')||''),idx=snaps.findIndex(x=>x.id===sid),prev=idx>0?await requireSnapshot(project.id,snaps[idx-1].id):null,md=markdownReport(project,snapshot,prev);if(url.searchParams.get('format')==='json')return send(res,200,{project,snapshot,previous:prev,markdown:md});return send(res,200,md,'text/markdown; charset=utf-8')}
  }
  return notFound(res);
}

async function serveStatic(req,res,url){let rel;try{rel=decodeURIComponent(url.pathname==='/'?'index.html':url.pathname.slice(1))}catch{return notFound(res)}const file=path.resolve(PUBLIC_DIR,rel);if(file!==PUBLIC_DIR&&!file.startsWith(PUBLIC_DIR+path.sep))return notFound(res);try{const data=await fs.readFile(file),ext=path.extname(file),types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json; charset=utf-8'},type=types[ext]||'application/octet-stream',headers={...baseHeaders(type),'cache-control':ext==='.html'?'no-store':'public, max-age=300','content-security-policy':"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"};res.writeHead(200,headers);res.end(data)}catch(err){if(err?.code==='ENOENT'||err?.code==='EISDIR')return notFound(res);throw err}}

await ensureData(DATA_DIR);
hostedStore=HOSTED?new HostedStore(DATA_DIR):null;
runService=new RunService(DATA_DIR,{policy:hostedStore?createHostedRunPolicy(hostedStore):null});
await runService.start();
const server=http.createServer(async(req,res)=>{try{const url=new URL(req.url,`http://${req.headers.host||'localhost'}`);if(HOSTED&&await handlePublicShare({req,res,url,store:hostedStore,send,loadSharedReport}))return;if(url.pathname.startsWith('/api/'))await api(req,res,url);else await serveStatic(req,res,url)}catch(err){console.error(err);sendError(res,err)}});
server.listen(PORT,HOST,()=>console.log(`XHS Research Studio ${VERSION} running at http://${HOST}:${PORT}${HOSTED?' [hosted]':''}`));

let shuttingDown=false;
async function shutdown(signal){if(shuttingDown)return;shuttingDown=true;console.log(`XHS Research Studio received ${signal}; stopping new requests, scheduler, and active executors.`);const hardExit=setTimeout(()=>process.exit(1),5_000);hardExit.unref();server.close();server.closeIdleConnections?.();const result=await runService.stop({timeoutMs:4_000});if(!result.settled)console.error(`Run shutdown timed out with ${result.active} active task(s).`);try{hostedStore?.close()}catch{}clearTimeout(hardExit);process.exit(result.settled?0:1)}
process.once('SIGTERM',()=>{void shutdown('SIGTERM')});
process.once('SIGINT',()=>{void shutdown('SIGINT')});
