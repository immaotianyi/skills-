import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HostedStore } from '../lib/hosted-db.mjs';

async function withStore(fn){
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'xhs-hosted-db-'));
  const store=new HostedStore(dir);
  try{return await fn(store,dir)}finally{store.close();await fs.rm(dir,{recursive:true,force:true})}
}

test('hosted registration stores hashed credentials and resolves hashed sessions',()=>withStore(async(store,dir)=>{
  const created=store.register({email:'Owner@Example.com',password:'correct horse battery staple',workspaceName:'Acme'});
  assert.equal(created.user.email,'owner@example.com');
  assert.equal(created.workspace.role,'owner');
  assert.equal(store.authenticate('owner@example.com','wrong password'),null);
  const user=store.authenticate('OWNER@example.com','correct horse battery staple');
  assert.equal(user.id,created.user.id);
  const session=store.createSession(user.id,{ttlSeconds:3600});
  assert.ok(session.token.length>20);
  assert.equal(store.resolveSession(session.token).user.email,'owner@example.com');
  store.revokeSession(session.token);
  assert.equal(store.resolveSession(session.token),null);
  const bytes=await fs.readFile(path.join(dir,'hosted.sqlite'));
  assert.equal(bytes.includes(Buffer.from('correct horse battery staple')),false,'plaintext password must not be persisted');
  assert.equal(bytes.includes(Buffer.from(session.token)),false,'raw session token must not be persisted');
}));

test('workspace entitlement gates project creation and atomically enforces monthly run plan',()=>withStore(async(store)=>{
  const {user,workspace}=store.register({email:'billing@example.com',password:'long enough password 123'});
  assert.throws(()=>store.assertProjectCreation(workspace.id,0),error=>error.code==='ENTITLEMENT_REQUIRED'&&error.statusCode===402);
  const entitlement=store.setEntitlement(workspace.id,{plan:'pilot',status:'active',maxProjects:2,maxRunsMonth:2,maxNotesRun:50,maxCommentsRun:500});
  assert.equal(entitlement.plan,'pilot');
  store.assertProjectCreation(workspace.id,0);
  assert.throws(()=>store.assertProjectCreation(workspace.id,2),error=>error.code==='PROJECT_LIMIT');
  assert.throws(()=>store.reserveRun(workspace.id,{maxNotes:51,maxComments:100}),error=>error.code==='RUN_BUDGET_PLAN_LIMIT');
  store.reserveRun(workspace.id,{maxNotes:50,maxComments:500});
  store.reserveRun(workspace.id,{maxNotes:20,maxComments:100});
  assert.equal(store.usage(workspace.id).runs,2);
  assert.throws(()=>store.reserveRun(workspace.id,{maxNotes:1,maxComments:0}),error=>error.code==='MONTHLY_RUN_LIMIT');
  const usage=store.recordRunUsage(workspace.id,{notes:17,comments:230});
  assert.equal(usage.notes,17);
  assert.equal(usage.comments,230);
  assert.equal(store.membership(user.id,workspace.id).role,'owner');
}));

test('share links are opaque, expiring/revocable, and audit events remain attributable',()=>withStore(async(store,dir)=>{
  const {user,workspace}=store.register({email:'share@example.com',password:'another sufficiently long password'});
  store.setEntitlement(workspace.id,{plan:'pilot',status:'active',maxProjects:2,maxRunsMonth:5,maxNotesRun:80,maxCommentsRun:1000});
  const share=store.createShare({workspaceId:workspace.id,projectId:'prj_demo',userId:user.id,ttlSeconds:3600});
  assert.equal(store.resolveShare(share.token).projectId,'prj_demo');
  const bytes=await fs.readFile(path.join(dir,'hosted.sqlite'));
  assert.equal(bytes.includes(Buffer.from(share.token)),false,'raw share token must not be persisted');
  store.revokeShare(workspace.id,share.id,user.id);
  assert.equal(store.resolveShare(share.token),null);
  const actions=store.auditLog(workspace.id).map(x=>x.action);
  assert.ok(actions.includes('auth.register'));
  assert.ok(actions.includes('share.create'));
  assert.ok(actions.includes('share.revoke'));
}));

test('billing provider event ids are idempotent',()=>withStore(async(store)=>{
  assert.equal(store.recordBillingEvent('evt_1','checkout.session.completed','abc'),true);
  assert.equal(store.recordBillingEvent('evt_1','checkout.session.completed','abc'),false);
}));
