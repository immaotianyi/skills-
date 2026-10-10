#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root=path.dirname(fileURLToPath(import.meta.url));
const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'xhs-hosted-smoke-'));
const port=55428;
const base=`http://127.0.0.1:${port}`;
const signingSecret=crypto.randomBytes(32).toString('hex');
const testPassword=`Smoke-${crypto.randomBytes(12).toString('hex')}!`;
const fixture=path.join(root,'public','demo-harvest.json');
const harvestExecutor=path.join(root,'test','fixtures','mock-harvest-executor.mjs');
const synthesisExecutor=path.join(root,'test','fixtures','mock-synthesis-executor.mjs');
const child=spawn(process.execPath,[path.join(root,'server-v3.mjs')],{cwd:root,stdio:['ignore','pipe','pipe'],env:{...process.env,PORT:String(port),HOST:'127.0.0.1',XHS_STUDIO_DATA:dataDir,XHS_STUDIO_HOSTED:'1',XHS_STUDIO_PUBLIC_URL:base,XHS_STUDIO_STRIPE_WEBHOOK_SECRET:signingSecret,XHS_STUDIO_STRIPE_PRICE_PILOT:'price_test_pilot',XHS_STUDIO_HARVEST_EXECUTOR:process.execPath,XHS_STUDIO_HARVEST_EXECUTOR_ARGS:JSON.stringify([harvestExecutor]),XHS_EXECUTOR_FIXTURE_PATH:fixture,XHS_EXECUTOR_MODE:'success',XHS_STUDIO_SYNTHESIS_EXECUTOR:process.execPath,XHS_STUDIO_SYNTHESIS_EXECUTOR_ARGS:JSON.stringify([synthesisExecutor])}});
let logs='',exitInfo=null;
child.stdout.on('data',c=>{logs+=c.toString('utf8')});
child.stderr.on('data',c=>{logs+=c.toString('utf8')});
child.on('exit',(code,signal)=>{exitInfo={code,signal}});
const assert=(condition,message)=>{if(!condition)throw new Error(message)};
const cookieOf=response=>(response.headers.get('set-cookie')||'').split(';')[0];
function diagnostics(){return `serverExit=${JSON.stringify(exitInfo)}\n--- server logs ---\n${logs.slice(-12000)}`}
async function call(url,{method='GET',body,cookie,workspaceId,status=200,raw,headers={}}={}){
  const h={...headers};if(cookie)h.cookie=cookie;if(workspaceId)h['x-xhs-workspace-id']=workspaceId;
  if(!['GET','HEAD'].includes(method)&&url!=='/api/billing/webhook')h.origin=base;
  let payload;if(raw!==undefined){payload=raw;h['content-type']='application/json'}else if(body!==undefined){payload=JSON.stringify(body);h['content-type']='application/json'}
  let response;
  try{response=await fetch(`${base}${url}`,{method,headers:h,body:payload})}
  catch(error){throw new Error(`${method} ${url}: network failure: ${error?.cause?.code||error.message}\n${diagnostics()}`,{cause:error})}
  const text=await response.text();let data=text;try{data=JSON.parse(text)}catch{}
  if(response.status!==status)throw new Error(`${method} ${url}: expected ${status}, got ${response.status}: ${text}\n${diagnostics()}`);return{response,data,text};
}
async function waitHealth(){for(let i=0;i<100;i++){try{if((await fetch(`${base}/api/health`)).ok)return}catch{}if(exitInfo)break;await new Promise(r=>setTimeout(r,80))}throw new Error(`hosted server not healthy\n${diagnostics()}`)}
async function waitRun(projectId,cookie,workspaceId){for(let i=0;i<120;i++){const data=(await call(`/api/projects/${projectId}/runs`,{cookie,workspaceId})).data;const run=data.runs?.at(-1)||data.runs?.[0];if(run&&['completed','failed','manual_action_required','cancelled'].includes(run.state))return run;await new Promise(r=>setTimeout(r,80))}throw new Error(`run timeout\n${diagnostics()}`)}

let failure=null;
try{
  await waitHealth();
  assert((await call('/api/health')).data.hosted===true,'hosted mode not active');
  const ownerReg=await call('/api/auth/register',{method:'POST',body:{email:'owner-smoke@example.test',password:testPassword,workspaceName:'Smoke Agency'},status:201});
  const ownerCookie=cookieOf(ownerReg.response),workspaceId=ownerReg.data.workspace.id;assert(ownerCookie,'owner cookie missing');
  await call('/api/projects',{method:'POST',cookie:ownerCookie,workspaceId,body:{name:'Blocked before entitlement'},status:402});

  const event={id:'evt_smoke_checkout',type:'checkout.session.completed',data:{object:{object:'checkout.session',mode:'subscription',payment_status:'paid',client_reference_id:workspaceId,customer:'cus_test',subscription:'sub_test',metadata:{workspace_id:workspaceId,plan:'pilot'}}}};
  const raw=JSON.stringify(event),t=Math.floor(Date.now()/1000),sig=crypto.createHmac('sha256',signingSecret).update(`${t}.${raw}`).digest('hex');
  await call('/api/billing/webhook',{method:'POST',raw,headers:{'stripe-signature':`t=${t},v1=${sig}`}});
  const me=(await call('/api/me',{cookie:ownerCookie})).data;assert(me.workspaces.find(w=>w.id===workspaceId)?.entitlement?.status==='active','entitlement not active');

  const project=(await call('/api/projects',{method:'POST',cookie:ownerCookie,workspaceId,body:{name:'Hosted Smoke Research',category:'防晒',keywords:['敏感肌防晒']},status:201})).data;
  const analystReg=await call('/api/auth/register',{method:'POST',body:{email:'analyst-smoke@example.test',password:testPassword,workspaceName:'Analyst'},status:201});
  const analystCookie=cookieOf(analystReg.response);
  const invitation=(await call(`/api/workspaces/${workspaceId}/invitations`,{method:'POST',cookie:ownerCookie,workspaceId,body:{email:'analyst-smoke@example.test',role:'analyst'},status:201})).data.invitation;
  const token=new URL(invitation.url).searchParams.get('invite');assert(token,'invite token missing');
  await call('/api/invitations/accept',{method:'POST',cookie:analystCookie,body:{token}});
  assert((await call('/api/projects',{cookie:analystCookie,workspaceId})).data.projects.some(p=>p.id===project.id),'invited analyst cannot see project');

  await call(`/api/projects/${project.id}/runs`,{method:'POST',cookie:analystCookie,workspaceId,body:{budget:{maxNotes:20,maxComments:100,maxSeconds:30}},status:202});
  const run=await waitRun(project.id,analystCookie,workspaceId);assert(run.state==='completed',`run failed: ${JSON.stringify(run)}`);
  const usage=(await call(`/api/workspaces/${workspaceId}/usage`,{cookie:ownerCookie,workspaceId})).data.usage;assert(usage.runs>=1&&usage.notes>=3,'usage not recorded');

  const synthesis=(await call(`/api/projects/${project.id}/synthesis`,{method:'POST',cookie:analystCookie,workspaceId,body:{}})).data.synthesis;
  assert(synthesis.grounding?.validated===true&&synthesis.claims.every(c=>c.evidenceIds.length),'synthesis not grounded');
  const share=(await call(`/api/workspaces/${workspaceId}/shares`,{method:'POST',cookie:analystCookie,workspaceId,body:{projectId:project.id},status:201})).data.share;
  const publicReport=await fetch(share.url);assert(publicReport.status===200&&(await publicReport.text()).includes('Hosted Smoke Research'),'share failed');

  const members=(await call(`/api/workspaces/${workspaceId}/members`,{cookie:ownerCookie,workspaceId})).data.members,analyst=members.find(m=>m.email==='analyst-smoke@example.test');
  await call(`/api/workspaces/${workspaceId}/members/${analyst.id}`,{method:'PATCH',cookie:ownerCookie,workspaceId,body:{role:'viewer'}});
  await call(`/api/projects/${project.id}/synthesis`,{method:'POST',cookie:analystCookie,workspaceId,body:{},status:403});
  console.log(JSON.stringify({ok:true,workspaceId,projectId:project.id,runId:run.id,snapshotId:run.snapshotId,usage,synthesisClaims:synthesis.claims.length,shareId:share.id},null,2));
}catch(error){
  failure=error;
  console.error(error.stack||error);
  console.error(diagnostics());
}finally{
  if(!exitInfo)child.kill('SIGTERM');
  if(!exitInfo)await new Promise(resolve=>{const timer=setTimeout(resolve,2500);child.once('exit',()=>{clearTimeout(timer);resolve()})});
  await fs.rm(dataDir,{recursive:true,force:true});
}
if(failure)throw failure;
