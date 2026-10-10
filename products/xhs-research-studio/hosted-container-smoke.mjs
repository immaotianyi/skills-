#!/usr/bin/env node
import { promises as fs } from 'node:fs';
import crypto from 'node:crypto';

const phase=process.argv[2]||'';
const base=String(process.env.XHS_HOSTED_SMOKE_BASE||'http://127.0.0.1:55420').replace(/\/$/u,'');
const stateFile=String(process.env.XHS_HOSTED_SMOKE_STATE||'/tmp/xhs-hosted-container-state.json');
const webhookSecret=String(process.env.XHS_HOSTED_SMOKE_WEBHOOK_SECRET||'');
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));

function assert(condition,message){if(!condition)throw new Error(message)}
function cookieOf(response){return (response.headers.get('set-cookie')||'').split(';')[0]}
async function request(path,{method='GET',body,cookie,workspaceId,status=200,raw,headers={}}={}){
  const requestHeaders={...headers};
  if(cookie)requestHeaders.cookie=cookie;
  if(workspaceId)requestHeaders['x-xhs-workspace-id']=workspaceId;
  if(!['GET','HEAD'].includes(method)&&path!=='/api/billing/webhook')requestHeaders.origin=base;
  let payload;
  if(raw!==undefined){payload=raw;requestHeaders['content-type']='application/json'}
  else if(body!==undefined){payload=JSON.stringify(body);requestHeaders['content-type']='application/json'}
  const response=await fetch(`${base}${path}`,{method,headers:requestHeaders,body:payload});
  const text=await response.text();let data=text;try{data=text?JSON.parse(text):null}catch{}
  if(response.status!==status)throw new Error(`${method} ${path}: expected ${status}, got ${response.status}: ${text}`);
  return {response,data,text};
}
async function waitHealth(){for(let i=0;i<120;i++){try{const response=await fetch(`${base}/api/health`);if(response.ok){const body=await response.json();if(body.hosted===true)return body}}catch{}await sleep(100)}throw new Error('hosted container did not become healthy')}
async function waitRun(projectId,cookie,workspaceId){for(let i=0;i<150;i++){const {data}=await request(`/api/projects/${projectId}/runs`,{cookie,workspaceId});const run=data.runs?.at(-1)||data.runs?.[0];if(run&&['completed','failed','manual_action_required','cancelled'].includes(run.state))return run;await sleep(100)}throw new Error('container run did not reach terminal state')}

await waitHealth();
if(phase==='seed'){
  if(!webhookSecret)throw new Error('XHS_HOSTED_SMOKE_WEBHOOK_SECRET is required for seed phase');
  const suffix=crypto.randomBytes(8).toString('hex');
  const email=`container-${suffix}@example.test`;
  const password=`Container-${crypto.randomBytes(18).toString('base64url')}!`;
  const registered=await request('/api/auth/register',{method:'POST',body:{email,password,workspaceName:'Container Hosted Workspace'},status:201});
  const cookie=cookieOf(registered.response),workspaceId=registered.data.workspace.id;
  assert(cookie&&workspaceId,'registration did not return session/workspace');

  const event={id:`evt_container_${suffix}`,type:'checkout.session.completed',data:{object:{object:'checkout.session',mode:'subscription',payment_status:'paid',client_reference_id:workspaceId,customer:`cus_${suffix}`,subscription:`sub_${suffix}`,metadata:{workspace_id:workspaceId,plan:'pilot'}}}};
  const raw=JSON.stringify(event),timestamp=Math.floor(Date.now()/1000),signature=crypto.createHmac('sha256',webhookSecret).update(`${timestamp}.${raw}`).digest('hex');
  await request('/api/billing/webhook',{method:'POST',raw,headers:{'stripe-signature':`t=${timestamp},v1=${signature}`}});

  const project=(await request('/api/projects',{method:'POST',cookie,workspaceId,body:{name:'Hosted Container Persistence',category:'防晒',keywords:['敏感肌防晒']},status:201})).data;
  await request(`/api/projects/${project.id}/runs`,{method:'POST',cookie,workspaceId,body:{budget:{maxNotes:20,maxComments:100,maxSeconds:30}},status:202});
  const run=await waitRun(project.id,cookie,workspaceId);
  assert(run.state==='completed'&&run.snapshotId,`container Harvest run did not complete: ${JSON.stringify(run)}`);
  const usage=(await request(`/api/workspaces/${workspaceId}/usage`,{cookie,workspaceId})).data.usage;
  assert(usage.runs>=1&&usage.notes>=3&&usage.comments>=1,'usage was not recorded before restart');
  const snapshots=(await request(`/api/projects/${project.id}/snapshots`,{cookie,workspaceId})).data.snapshots;
  assert(Array.isArray(snapshots)&&snapshots.some(snapshot=>snapshot.id===run.snapshotId),'snapshot missing before restart');
  const share=(await request(`/api/workspaces/${workspaceId}/shares`,{method:'POST',cookie,workspaceId,body:{projectId:project.id},status:201})).data.share;
  const state={email,password,workspaceId,projectId:project.id,snapshotId:run.snapshotId,shareUrl:share.url,minimumUsage:{runs:usage.runs,notes:usage.notes,comments:usage.comments}};
  await fs.writeFile(stateFile,JSON.stringify(state,null,2),'utf8');
  console.log(JSON.stringify({ok:true,phase,workspaceId,projectId:project.id,snapshotId:run.snapshotId,usage},null,2));
}else if(phase==='verify'){
  const state=JSON.parse(await fs.readFile(stateFile,'utf8'));
  const login=await request('/api/auth/login',{method:'POST',body:{email:state.email,password:state.password}});
  const cookie=cookieOf(login.response);assert(cookie,'login after restart did not return session');
  const me=(await request('/api/me',{cookie})).data;
  const workspace=me.workspaces.find(item=>item.id===state.workspaceId);
  assert(workspace,'workspace missing after container restart');
  assert(workspace.entitlement?.status==='active'&&workspace.entitlement?.plan==='pilot','entitlement missing after container restart');
  const projects=(await request('/api/projects',{cookie,workspaceId:state.workspaceId})).data.projects;
  assert(projects.some(project=>project.id===state.projectId),'project missing after container restart');
  const snapshots=(await request(`/api/projects/${state.projectId}/snapshots`,{cookie,workspaceId:state.workspaceId})).data.snapshots;
  assert(snapshots.some(snapshot=>snapshot.id===state.snapshotId),'snapshot missing after container restart');
  const usage=(await request(`/api/workspaces/${state.workspaceId}/usage`,{cookie,workspaceId:state.workspaceId})).data.usage;
  assert(usage.runs>=state.minimumUsage.runs&&usage.notes>=state.minimumUsage.notes&&usage.comments>=state.minimumUsage.comments,'usage regressed after restart');
  const share=await fetch(state.shareUrl);assert(share.status===200&&(await share.text()).includes('Hosted Container Persistence'),'read-only share did not survive container restart');
  console.log(JSON.stringify({ok:true,phase,workspaceId:state.workspaceId,projectId:state.projectId,snapshotId:state.snapshotId,usage,sharePersisted:true},null,2));
}else{
  throw new Error('Usage: node hosted-container-smoke.mjs <seed|verify>');
}
