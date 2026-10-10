import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HostedStore } from '../lib/hosted-db.mjs';
import { handleHostedMembersApi } from '../lib/hosted-members-http.mjs';

const password='Branding-HTTP-Password-123!';
const env={XHS_STUDIO_PUBLIC_URL:'https://studio.example.test'};

async function invoke(store,{method='GET',pathName,token,body,origin='https://studio.example.test'}={}){
  let sent=null;
  const req={method,headers:{authorization:`Bearer ${token}`,...(!['GET','HEAD'].includes(method)?{origin}: {})}};
  const handled=await handleHostedMembersApi({
    req,res:{},url:new URL(`https://studio.example.test${pathName}`),store,
    readJson:async()=>body||{},env,
    send(_res,status,payload,type='application/json; charset=utf-8',headers={}){sent={status,payload,type,headers};return true},
  });
  return {handled,sent};
}

test('branding HTTP lets members read but only owner/admin write',async()=>{
  const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'xhs-branding-http-'));
  const store=new HostedStore(dataDir);
  try{
    const owner=store.register({email:'http-owner@example.test',password,workspaceName:'Agency'});
    const viewer=store.register({email:'http-viewer@example.test',password,workspaceName:'Viewer'});
    store.db.prepare('INSERT INTO memberships(workspace_id,user_id,role,created_at) VALUES(?,?,?,?)')
      .run(owner.workspace.id,viewer.user.id,'viewer',new Date().toISOString());
    const ownerSession=store.createSession(owner.user.id),viewerSession=store.createSession(viewer.user.id);
    const endpoint=`/api/workspaces/${owner.workspace.id}/branding`;

    const initial=await invoke(store,{pathName:endpoint,token:viewerSession.token});
    assert.equal(initial.handled,true);
    assert.equal(initial.sent.status,200);
    assert.equal(initial.sent.payload.branding.accentColor,'#171717');

    await assert.rejects(
      ()=>invoke(store,{method:'PATCH',pathName:endpoint,token:viewerSession.token,body:{agencyName:'Hijack'}}),
      error=>error?.code==='ROLE_FORBIDDEN'&&error?.statusCode===403,
    );

    const updated=await invoke(store,{method:'PATCH',pathName:endpoint,token:ownerSession.token,body:{
      agencyName:'North Star',reportTitle:'Client Intelligence',accentColor:'#00AACC',footerText:'Confidential',
    }});
    assert.equal(updated.sent.status,200);
    assert.deepEqual({...updated.sent.payload.branding,updatedAt:undefined},{agencyName:'North Star',reportTitle:'Client Intelligence',accentColor:'#00aacc',footerText:'Confidential',updatedAt:undefined});

    const viewerRead=await invoke(store,{pathName:endpoint,token:viewerSession.token});
    assert.equal(viewerRead.sent.payload.branding.agencyName,'North Star');
    assert.equal(viewerRead.sent.payload.branding.accentColor,'#00aacc');

    await assert.rejects(
      ()=>invoke(store,{method:'PATCH',pathName:endpoint,token:ownerSession.token,origin:'https://evil.example.test',body:{agencyName:'Cross Origin'}}),
      error=>error?.code==='ORIGIN_FORBIDDEN'&&error?.statusCode===403,
    );
    assert.equal((await invoke(store,{pathName:endpoint,token:ownerSession.token})).sent.payload.branding.agencyName,'North Star');
  }finally{
    store.close();
    await fs.rm(dataDir,{recursive:true,force:true});
  }
});
