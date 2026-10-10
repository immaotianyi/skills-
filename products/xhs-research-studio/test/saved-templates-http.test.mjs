import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HostedStore } from '../lib/hosted-db.mjs';
import { handleHostedMembersApi } from '../lib/hosted-members-http.mjs';

const password='Saved-Template-HTTP-Password-123!';
const env={XHS_STUDIO_PUBLIC_URL:'https://studio.example.test'};

async function invoke(store,{method='GET',pathName,token,body,origin='https://studio.example.test'}={}){
  let sent=null;
  const req={method,headers:{authorization:`Bearer ${token}`,...(!['GET','HEAD'].includes(method)?{origin}:{})}};
  const handled=await handleHostedMembersApi({
    req,res:{},url:new URL(`https://studio.example.test${pathName}`),store,env,
    readJson:async()=>body||{},
    send(_res,status,payload,type='application/json; charset=utf-8',headers={}){sent={status,payload,type,headers};return true},
  });
  return {handled,sent};
}

test('saved-template HTTP lets viewers read while analysts create/delete and enforces same-origin',async()=>{
  const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'xhs-template-http-'));
  const store=new HostedStore(dataDir);
  try{
    const owner=store.register({email:'tpl-http-owner@example.test',password,workspaceName:'Agency'});
    const analyst=store.register({email:'tpl-http-analyst@example.test',password,workspaceName:'Analyst'});
    const viewer=store.register({email:'tpl-http-viewer@example.test',password,workspaceName:'Viewer'});
    const createdAt=new Date().toISOString();
    store.db.prepare('INSERT INTO memberships(workspace_id,user_id,role,created_at) VALUES(?,?,?,?)').run(owner.workspace.id,analyst.user.id,'analyst',createdAt);
    store.db.prepare('INSERT INTO memberships(workspace_id,user_id,role,created_at) VALUES(?,?,?,?)').run(owner.workspace.id,viewer.user.id,'viewer',createdAt);
    const analystSession=store.createSession(analyst.user.id),viewerSession=store.createSession(viewer.user.id);
    const endpoint=`/api/workspaces/${owner.workspace.id}/templates`;

    const created=await invoke(store,{method:'POST',pathName:endpoint,token:analystSession.token,body:{name:'竞品周报',category:'防晒',keywords:['敏感肌防晒'],competitors:['A品牌']}});
    assert.equal(created.sent.status,201);
    assert.equal(created.sent.payload.template.name,'竞品周报');
    const templateId=created.sent.payload.template.id;

    const viewerList=await invoke(store,{pathName:endpoint,token:viewerSession.token});
    assert.equal(viewerList.sent.status,200);
    assert.equal(viewerList.sent.payload.templates.length,1);
    assert.equal(viewerList.sent.payload.templates[0].id,templateId);

    await assert.rejects(
      ()=>invoke(store,{method:'POST',pathName:endpoint,token:viewerSession.token,body:{name:'viewer write'}}),
      error=>error?.code==='ROLE_FORBIDDEN'&&error?.statusCode===403,
    );
    await assert.rejects(
      ()=>invoke(store,{method:'POST',pathName:endpoint,token:analystSession.token,origin:'https://evil.example.test',body:{name:'cross-origin'}}),
      error=>error?.code==='ORIGIN_FORBIDDEN'&&error?.statusCode===403,
    );

    const removed=await invoke(store,{method:'DELETE',pathName:`${endpoint}/${templateId}`,token:analystSession.token});
    assert.equal(removed.sent.status,200);
    assert.equal(removed.sent.payload.ok,true);
    assert.equal((await invoke(store,{pathName:endpoint,token:viewerSession.token})).sent.payload.templates.length,0);
  }finally{
    store.close();
    await fs.rm(dataDir,{recursive:true,force:true});
  }
});
