import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const demo=JSON.parse(await fs.readFile(path.join(root,'public','demo-harvest.json'),'utf8'));
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const cookieOf=response=>(response.headers.get('set-cookie')||'').split(';')[0];

async function startHosted(){
  const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'xhs-api-key-http-'));
  const port=64000+Math.floor(Math.random()*1000),base=`http://127.0.0.1:${port}`,webhookSecret=crypto.randomBytes(32).toString('hex');
  const child=spawn(process.execPath,[path.join(root,'server-v3.mjs')],{cwd:root,stdio:['ignore','pipe','pipe'],env:{...process.env,PORT:String(port),HOST:'127.0.0.1',XHS_STUDIO_DATA:dataDir,XHS_STUDIO_HOSTED:'1',XHS_STUDIO_PUBLIC_URL:base,XHS_STUDIO_STRIPE_WEBHOOK_SECRET:webhookSecret,XHS_STUDIO_STRIPE_PRICE_PILOT:'price_api_pilot'}});
  let logs='';child.stdout.on('data',c=>{logs=(logs+c.toString()).slice(-12000)});child.stderr.on('data',c=>{logs=(logs+c.toString()).slice(-12000)});
  for(let i=0;i<150;i++){try{if((await fetch(`${base}/api/health`)).ok)return{dataDir,base,webhookSecret,child,logs:()=>logs}}catch{}if(child.exitCode!==null)break;await sleep(40)}
  throw new Error(`API key test server failed to start\n${logs}`);
}
async function stopHosted(ctx){if(ctx.child.exitCode===null){const done=new Promise(resolve=>ctx.child.once('exit',resolve));ctx.child.kill('SIGTERM');await Promise.race([done,sleep(2000)]);if(ctx.child.exitCode===null)ctx.child.kill('SIGKILL')}await fs.rm(ctx.dataDir,{recursive:true,force:true})}
async function api(ctx,url,{method='GET',body,cookie,workspaceId,bearer,status=200}={}){
  const headers={};if(cookie)headers.cookie=cookie;if(workspaceId)headers['x-xhs-workspace-id']=workspaceId;if(bearer)headers.authorization=`Bearer ${bearer}`;
  if(!['GET','HEAD'].includes(method))headers.origin=ctx.base;if(body!==undefined)headers['content-type']='application/json';
  const response=await fetch(`${ctx.base}${url}`,{method,headers,body:body===undefined?undefined:JSON.stringify(body)}),text=await response.text();let data;try{data=JSON.parse(text)}catch{data=text}
  assert.equal(response.status,status,`${method} ${url}: ${text}\n${ctx.logs()}`);return{response,data,text};
}
async function stripe(ctx,event){
  const raw=JSON.stringify(event),t=Math.floor(Date.now()/1000),sig=crypto.createHmac('sha256',ctx.webhookSecret).update(`${t}.${raw}`).digest('hex');
  const response=await fetch(`${ctx.base}/api/billing/webhook`,{method:'POST',headers:{'content-type':'application/json','stripe-signature':`t=${t},v1=${sig}`},body:raw});
  assert.equal(response.status,200,await response.text());
}

test('hosted API keys are one-time, scoped, revocable, workspace-bound and entitlement-gated',async()=>{
  const ctx=await startHosted();
  try{
    const password=`ApiKey-${crypto.randomBytes(12).toString('hex')}!`;
    const registration=await api(ctx,'/api/auth/register',{method:'POST',body:{email:'api-owner@example.test',password,workspaceName:'API Agency'},status:201});
    const cookie=cookieOf(registration.response),workspaceId=registration.data.workspace.id;
    const now=Math.floor(Date.now()/1000);
    await stripe(ctx,{id:'evt_api_active',type:'checkout.session.completed',created:now,data:{object:{object:'checkout.session',mode:'subscription',payment_status:'paid',client_reference_id:workspaceId,customer:'cus_api',subscription:'sub_api',metadata:{workspace_id:workspaceId,plan:'pilot'}}}});

    const project=(await api(ctx,'/api/projects',{method:'POST',cookie,workspaceId,body:{name:'API Research',keywords:['敏感肌防晒']},status:201})).data;
    await api(ctx,`/api/projects/${project.id}/ingest`,{method:'POST',cookie,workspaceId,body:demo,status:201});

    const dashboardOnly=(await api(ctx,`/api/workspaces/${workspaceId}/api-keys`,{method:'POST',cookie,workspaceId,body:{name:'Dashboard bot',scopes:['read:dashboard'],ttlSeconds:3600},status:201})).data.key;
    assert.match(dashboardOnly.token,/^xhs_sk_/u);
    const listing=(await api(ctx,`/api/workspaces/${workspaceId}/api-keys`,{cookie,workspaceId})).data;
    assert.equal(listing.scopes.includes('read:dashboard'),true);
    assert.equal(listing.scopes.includes('write:runs'),false,'unimplemented write scopes must not be advertised');
    assert.equal(JSON.stringify(listing).includes(dashboardOnly.token),false,'raw API key must never be returned by list endpoint');

    const dashboard=(await api(ctx,'/api/automation/dashboard',{bearer:dashboardOnly.token})).data;
    assert.equal(dashboard.apiKey.workspaceId,workspaceId);
    assert.equal(dashboard.dashboard.projects.some(row=>row.id===project.id),true);
    await api(ctx,`/api/automation/projects/${project.id}/report`,{bearer:dashboardOnly.token,status:403});

    const reader=(await api(ctx,`/api/workspaces/${workspaceId}/api-keys`,{method:'POST',cookie,workspaceId,body:{name:'Research reader',scopes:['read:dashboard','read:research']},status:201})).data.key;
    const report=(await api(ctx,`/api/automation/projects/${project.id}/report`,{bearer:reader.token})).data;
    assert.equal(report.project.id,project.id);
    assert.match(report.markdown,/API Research/u);

    await api(ctx,`/api/workspaces/${workspaceId}/api-keys/${dashboardOnly.id}`,{method:'DELETE',cookie,workspaceId,status:200});
    await api(ctx,'/api/automation/dashboard',{bearer:dashboardOnly.token,status:401});

    await stripe(ctx,{id:'evt_api_cancel',type:'customer.subscription.deleted',created:now+10,data:{object:{object:'subscription',id:'sub_api',customer:'cus_api',status:'canceled',metadata:{}}}});
    await api(ctx,'/api/automation/dashboard',{bearer:reader.token,status:402});
  }finally{await stopHosted(ctx)}
});
