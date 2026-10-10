import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const cookieOf=response=>(response.headers.get('set-cookie')||'').split(';')[0];

async function startHosted(){
  const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'xhs-dashboard-http-'));
  const port=62000+Math.floor(Math.random()*2000),base=`http://127.0.0.1:${port}`,webhookSecret=crypto.randomBytes(32).toString('hex');
  const child=spawn(process.execPath,[path.join(root,'server-v3.mjs')],{
    cwd:root,stdio:['ignore','pipe','pipe'],
    env:{...process.env,PORT:String(port),HOST:'127.0.0.1',XHS_STUDIO_DATA:dataDir,XHS_STUDIO_HOSTED:'1',XHS_STUDIO_PUBLIC_URL:base,XHS_STUDIO_STRIPE_WEBHOOK_SECRET:webhookSecret,XHS_STUDIO_STRIPE_PRICE_PILOT:'price_dash_pilot'},
  });
  let logs='';child.stdout.on('data',c=>{logs=(logs+c.toString()).slice(-12000)});child.stderr.on('data',c=>{logs=(logs+c.toString()).slice(-12000)});
  for(let i=0;i<150;i++){
    try{if((await fetch(`${base}/api/health`)).ok)return {dataDir,base,webhookSecret,child,logs:()=>logs}}catch{}
    if(child.exitCode!==null)break;await sleep(40);
  }
  throw new Error(`dashboard test server failed to start\n${logs}`);
}

async function stopHosted(ctx){
  if(ctx.child.exitCode===null){const done=new Promise(resolve=>ctx.child.once('exit',resolve));ctx.child.kill('SIGTERM');await Promise.race([done,sleep(2000)]);if(ctx.child.exitCode===null)ctx.child.kill('SIGKILL')}
  await fs.rm(ctx.dataDir,{recursive:true,force:true});
}

async function api(ctx,url,{method='GET',body,cookie,workspaceId,status=200,headers={}}={}){
  const h={...headers};if(cookie)h.cookie=cookie;if(workspaceId)h['x-xhs-workspace-id']=workspaceId;
  if(!['GET','HEAD'].includes(method)&&url!=='/api/billing/webhook')h.origin=ctx.base;
  const response=await fetch(`${ctx.base}${url}`,{method,headers:body===undefined?h:{...h,'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
  const text=await response.text();let data;try{data=JSON.parse(text)}catch{data=text}
  assert.equal(response.status,status,`${method} ${url}: ${text}\n${ctx.logs()}`);
  return {response,data};
}

async function activate(ctx,workspaceId){
  const event={id:`evt_dash_${crypto.randomBytes(5).toString('hex')}`,type:'checkout.session.completed',created:Math.floor(Date.now()/1000),data:{object:{object:'checkout.session',mode:'subscription',payment_status:'paid',client_reference_id:workspaceId,customer:`cus_${workspaceId}`,subscription:`sub_${workspaceId}`,metadata:{workspace_id:workspaceId,plan:'pilot'}}}};
  const raw=JSON.stringify(event),t=Math.floor(Date.now()/1000),sig=crypto.createHmac('sha256',ctx.webhookSecret).update(`${t}.${raw}`).digest('hex');
  const response=await fetch(`${ctx.base}/api/billing/webhook`,{method:'POST',headers:{'content-type':'application/json','stripe-signature':`t=${t},v1=${sig}`},body:raw});
  assert.equal(response.status,200,await response.text());
}

async function waitRun(ctx,projectId,cookie,workspaceId){
  for(let i=0;i<120;i++){
    const {data}=await api(ctx,`/api/projects/${projectId}/runs`,{cookie,workspaceId});
    const run=data.runs?.at(-1);
    if(run&&['completed','failed','manual_action_required','cancelled'].includes(run.state))return run;
    await sleep(50);
  }
  throw new Error('run did not terminate');
}

test('hosted dashboard persists deterministic alert acknowledgement and keeps viewer read-only',async()=>{
  const ctx=await startHosted();
  try{
    const password=`Dashboard-${crypto.randomBytes(12).toString('hex')}!`;
    const ownerReg=await api(ctx,'/api/auth/register',{method:'POST',body:{email:'dashboard-owner@example.test',password,workspaceName:'Agency Ops'},status:201});
    const ownerCookie=cookieOf(ownerReg.response),workspaceId=ownerReg.data.workspace.id;
    await activate(ctx,workspaceId);
    const project=(await api(ctx,'/api/projects',{method:'POST',cookie:ownerCookie,workspaceId,body:{name:'Dashboard Project',keywords:['防晒']},status:201})).data;

    await api(ctx,`/api/projects/${project.id}/runs`,{method:'POST',cookie:ownerCookie,workspaceId,body:{budget:{maxNotes:10,maxComments:20,maxSeconds:30}},status:202});
    const run=await waitRun(ctx,project.id,ownerCookie,workspaceId);
    assert.equal(run.state,'manual_action_required');

    const first=(await api(ctx,`/api/workspaces/${workspaceId}/dashboard`,{cookie:ownerCookie,workspaceId})).data;
    assert.equal(first.summary.projects,1);
    const alert=first.alerts.find(item=>item.type==='manual-action-required'&&item.runId===run.id);
    assert.ok(alert,'manual-action alert must appear in team dashboard');
    assert.equal(alert.acknowledgement.acknowledged,false);
    assert.match(alert.source.run,new RegExp(`/api/projects/${project.id}/runs/${run.id}`,'u'));

    await api(ctx,`/api/workspaces/${workspaceId}/alerts/${alert.id}/ack`,{method:'POST',cookie:ownerCookie,workspaceId,body:{note:'Assigned to analyst'},status:200});
    const second=(await api(ctx,`/api/workspaces/${workspaceId}/dashboard`,{cookie:ownerCookie,workspaceId})).data;
    const acknowledged=second.alerts.find(item=>item.id===alert.id);
    assert.equal(acknowledged.acknowledgement.acknowledged,true);
    assert.equal(acknowledged.acknowledgement.note,'Assigned to analyst');

    const viewerReg=await api(ctx,'/api/auth/register',{method:'POST',body:{email:'dashboard-viewer@example.test',password,workspaceName:'Viewer Own'},status:201});
    const viewerCookie=cookieOf(viewerReg.response);
    const invitation=(await api(ctx,`/api/workspaces/${workspaceId}/invitations`,{method:'POST',cookie:ownerCookie,workspaceId,body:{email:'dashboard-viewer@example.test',role:'viewer'},status:201})).data.invitation;
    const token=new URL(invitation.url).searchParams.get('invite');
    await api(ctx,'/api/invitations/accept',{method:'POST',cookie:viewerCookie,body:{token},status:200});
    const viewerDashboard=(await api(ctx,`/api/workspaces/${workspaceId}/dashboard`,{cookie:viewerCookie,workspaceId})).data;
    assert.equal(viewerDashboard.alerts.find(item=>item.id===alert.id).acknowledgement.acknowledged,true);
    await api(ctx,`/api/workspaces/${workspaceId}/alerts/${alert.id}/ack`,{method:'POST',cookie:viewerCookie,workspaceId,body:{note:'should fail'},status:403});

    await api(ctx,`/api/workspaces/${workspaceId}/alerts/${alert.id}/ack`,{method:'DELETE',cookie:ownerCookie,workspaceId,status:200});
    const third=(await api(ctx,`/api/workspaces/${workspaceId}/dashboard`,{cookie:ownerCookie,workspaceId})).data;
    assert.equal(third.alerts.find(item=>item.id===alert.id).acknowledgement.acknowledged,false);
  }finally{await stopHosted(ctx)}
});
