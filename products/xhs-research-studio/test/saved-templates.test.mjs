import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HostedStore } from '../lib/hosted-db.mjs';
import { createSavedTemplate, deleteSavedTemplate, listSavedTemplates, normalizeSavedTemplate } from '../lib/saved-templates.mjs';

const password='Saved-Template-Password-123!';

test('saved project templates are workspace-scoped, normalized, role-gated, unique, and persistent',async()=>{
  const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'xhs-saved-templates-'));
  let store=new HostedStore(dataDir);
  try{
    const owner=store.register({email:'tpl-owner@example.test',password,workspaceName:'Agency'});
    const analyst=store.register({email:'tpl-analyst@example.test',password,workspaceName:'Analyst Home'});
    const viewer=store.register({email:'tpl-viewer@example.test',password,workspaceName:'Viewer Home'});
    const createdAt=new Date().toISOString();
    store.db.prepare('INSERT INTO memberships(workspace_id,user_id,role,created_at) VALUES(?,?,?,?)').run(owner.workspace.id,analyst.user.id,'analyst',createdAt);
    store.db.prepare('INSERT INTO memberships(workspace_id,user_id,role,created_at) VALUES(?,?,?,?)').run(owner.workspace.id,viewer.user.id,'viewer',createdAt);

    const created=createSavedTemplate(store,{actorUserId:analyst.user.id,workspaceId:owner.workspace.id,input:{
      name:'  防晒   竞品扫描  ',description:' 周报\n模板 ',category:' 防晒 ',keywords:['敏感肌防晒','敏感肌防晒','防晒避雷'],competitors:['A品牌','B品牌'],
    }});
    assert.equal(created.name,'防晒 竞品扫描');
    assert.deepEqual(created.keywords,['敏感肌防晒','防晒避雷']);
    assert.deepEqual(created.competitors,['A品牌','B品牌']);
    assert.equal(created.description,'周报 模板');

    const viewerList=listSavedTemplates(store,{actorUserId:viewer.user.id,workspaceId:owner.workspace.id});
    assert.equal(viewerList.length,1);
    assert.equal(viewerList[0].name,'防晒 竞品扫描');
    assert.deepEqual(viewerList[0].keywords,['敏感肌防晒','防晒避雷']);

    assert.throws(()=>createSavedTemplate(store,{actorUserId:viewer.user.id,workspaceId:owner.workspace.id,input:{name:'viewer write'}}),error=>error?.code==='ROLE_FORBIDDEN'&&error?.statusCode===403);
    assert.throws(()=>createSavedTemplate(store,{actorUserId:owner.user.id,workspaceId:owner.workspace.id,input:{name:'防晒 竞品扫描'}}),error=>error?.code==='TEMPLATE_NAME_EXISTS'&&error?.statusCode===409);

    store.close();store=null;
    store=new HostedStore(dataDir);
    assert.equal(listSavedTemplates(store,{actorUserId:owner.user.id,workspaceId:owner.workspace.id}).length,1);
    assert.deepEqual(deleteSavedTemplate(store,{actorUserId:analyst.user.id,workspaceId:owner.workspace.id,templateId:created.id}),{ok:true,id:created.id});
    assert.equal(listSavedTemplates(store,{actorUserId:owner.user.id,workspaceId:owner.workspace.id}).length,0);
    assert.throws(()=>deleteSavedTemplate(store,{actorUserId:analyst.user.id,workspaceId:owner.workspace.id,templateId:created.id}),error=>error?.code==='TEMPLATE_NOT_FOUND'&&error?.statusCode===404);
  }finally{
    try{store?.close()}catch{}
    await fs.rm(dataDir,{recursive:true,force:true});
  }
});

test('saved template normalizer bounds and strips unsafe control whitespace without retaining client data',()=>{
  const normalized=normalizeSavedTemplate({name:'x'.repeat(200),description:'\u0000 hello\nworld ',category:'护肤',keywords:Array.from({length:105},(_,i)=>`词${i}`),competitors:['A','A','B'],client:'must-not-persist'});
  assert.equal(normalized.name.length,120);
  assert.equal(normalized.description,'hello world');
  assert.equal(normalized.keywords.length,100);
  assert.deepEqual(normalized.competitors,['A','B']);
  assert.equal('client' in normalized,false);
});
