import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HostedStore } from '../lib/hosted-db.mjs';
import { getWorkspaceBranding, normalizeBranding, updateWorkspaceBranding } from '../lib/branding.mjs';

const password='Branding-Test-Password-123!';

test('workspace branding is text-only, color-bounded, role-gated, and persistent',async()=>{
  const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'xhs-branding-'));
  let store;
  try{
    store=new HostedStore(dataDir);
    const owner=store.register({email:'brand-owner@example.test',password,workspaceName:'Agency'});
    const viewer=store.register({email:'brand-viewer@example.test',password,workspaceName:'Viewer Home'});
    store.db.prepare('INSERT INTO memberships(workspace_id,user_id,role,created_at) VALUES(?,?,?,?)')
      .run(owner.workspace.id,viewer.user.id,'viewer',new Date().toISOString());

    assert.deepEqual(getWorkspaceBranding(store,owner.workspace.id),{agencyName:'',reportTitle:'',accentColor:'#171717',footerText:'',updatedAt:null});
    const saved=updateWorkspaceBranding(store,{actorUserId:owner.user.id,workspaceId:owner.workspace.id,input:{
      agencyName:'  North Star   Insights  ',
      reportTitle:'客户周报 <not-html>',
      accentColor:'#A1B2C3',
      footerText:'Prepared for client\nConfidential',
    }});
    assert.equal(saved.agencyName,'North Star Insights');
    assert.equal(saved.reportTitle,'客户周报 <not-html>');
    assert.equal(saved.accentColor,'#a1b2c3');
    assert.equal(saved.footerText,'Prepared for client Confidential');
    assert.ok(saved.updatedAt);

    assert.throws(()=>updateWorkspaceBranding(store,{actorUserId:viewer.user.id,workspaceId:owner.workspace.id,input:{agencyName:'Hijack'}}),error=>error?.code==='ROLE_FORBIDDEN'&&error?.statusCode===403);
    assert.equal(getWorkspaceBranding(store,owner.workspace.id).agencyName,'North Star Insights');

    const normalized=normalizeBranding({agencyName:'x'.repeat(200),accentColor:'red; background:url(javascript:1)',footerText:'\u0000ok'});
    assert.equal(normalized.agencyName.length,120);
    assert.equal(normalized.accentColor,'#171717');
    assert.equal(normalized.footerText,'ok');

    store.close();store=null;
    const reopened=new HostedStore(dataDir);
    try{assert.equal(getWorkspaceBranding(reopened,owner.workspace.id).agencyName,'North Star Insights')}
    finally{reopened.close()}
  }finally{
    try{store?.close()}catch{}
    await fs.rm(dataDir,{recursive:true,force:true});
  }
});
