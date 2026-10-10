import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HostedStore } from '../lib/hosted-db.mjs';
import {
  createWorkspaceInvitation,
  acceptWorkspaceInvitation,
  listWorkspaceMembers,
  listWorkspaceInvitations,
  revokeWorkspaceInvitation,
} from '../lib/hosted-members.mjs';

async function tempStore(prefix){
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),prefix));
  return {dir,store:new HostedStore(dir)};
}

test('workspace invitation token is hashed, email-bound, single-use, and role-limited',async()=>{
  const {dir,store}=await tempStore('xhs-hosted-members-');
  try{
    const owner=store.register({email:'owner@example.com',password:'correct horse battery staple',workspaceName:'Agency'});
    const analyst=store.register({email:'analyst@example.com',password:'another correct battery staple',workspaceName:'Personal'});
    const invite=createWorkspaceInvitation(store,{
      actorUserId:owner.user.id,
      workspaceId:owner.workspace.id,
      email:analyst.user.email,
      role:'analyst',
      ttlSeconds:3600,
    });
    assert.ok(invite.token.length>20);
    const persisted=store.db.prepare('SELECT token_hash FROM workspace_invitations WHERE id=?').get(invite.id);
    assert.notEqual(persisted.token_hash,invite.token,'raw invitation token must never be persisted');
    assert.equal(listWorkspaceInvitations(store,owner.user.id,owner.workspace.id)[0].state,'pending');

    assert.throws(()=>acceptWorkspaceInvitation(store,{
      userId:owner.user.id,
      userEmail:owner.user.email,
      token:invite.token,
    }),error=>error?.code==='INVITE_EMAIL_MISMATCH'&&error?.statusCode===403);

    const accepted=acceptWorkspaceInvitation(store,{
      userId:analyst.user.id,
      userEmail:analyst.user.email,
      token:invite.token,
    });
    assert.equal(accepted.workspaceId,owner.workspace.id);
    assert.equal(accepted.role,'analyst');
    assert.equal(store.membership(analyst.user.id,owner.workspace.id).role,'analyst');
    assert.equal(listWorkspaceInvitations(store,owner.user.id,owner.workspace.id)[0].state,'accepted');
    assert.throws(()=>acceptWorkspaceInvitation(store,{userId:analyst.user.id,userEmail:analyst.user.email,token:invite.token}),error=>error?.code==='INVITE_NOT_AVAILABLE');

    const members=listWorkspaceMembers(store,owner.user.id,owner.workspace.id);
    assert.equal(members.length,2);
    assert.equal(members.find(member=>member.id===analyst.user.id).role,'analyst');
    store.setMemberRole(owner.user.id,owner.workspace.id,analyst.user.id,'viewer');
    assert.equal(store.membership(analyst.user.id,owner.workspace.id).role,'viewer');

    assert.throws(()=>createWorkspaceInvitation(store,{actorUserId:owner.user.id,workspaceId:owner.workspace.id,email:'third@example.com',role:'owner'}),error=>error?.code==='INVALID_INVITE_ROLE');
  }finally{
    store.close();
    await fs.rm(dir,{recursive:true,force:true});
  }
});

test('pending invitation can be revoked and cannot be accepted afterwards',async()=>{
  const {dir,store}=await tempStore('xhs-hosted-members-revoke-');
  try{
    const owner=store.register({email:'owner2@example.com',password:'correct horse battery staple',workspaceName:'Agency'});
    const guest=store.register({email:'guest@example.com',password:'another correct battery staple',workspaceName:'Guest'});
    const invite=createWorkspaceInvitation(store,{actorUserId:owner.user.id,workspaceId:owner.workspace.id,email:guest.user.email,role:'viewer'});
    assert.deepEqual(revokeWorkspaceInvitation(store,{actorUserId:owner.user.id,workspaceId:owner.workspace.id,invitationId:invite.id}),{ok:true});
    assert.equal(listWorkspaceInvitations(store,owner.user.id,owner.workspace.id)[0].state,'revoked');
    assert.throws(()=>acceptWorkspaceInvitation(store,{userId:guest.user.id,userEmail:guest.user.email,token:invite.token}),error=>error?.code==='INVITE_NOT_AVAILABLE');
  }finally{
    store.close();
    await fs.rm(dir,{recursive:true,force:true});
  }
});
