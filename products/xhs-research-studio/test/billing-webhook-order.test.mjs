import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HostedStore } from '../lib/hosted-db.mjs';
import { applyStripeEvent } from '../lib/billing.mjs';

const env={
  XHS_STUDIO_STRIPE_PRICE_PILOT:'price_pilot',
  XHS_STUDIO_STRIPE_PRICE_PRO:'price_pro',
  XHS_STUDIO_PILOT_MAX_RUNS:'10',
  XHS_STUDIO_PRO_MAX_RUNS:'100',
};

async function withStore(fn){
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'xhs-billing-order-'));
  const store=new HostedStore(dir);
  try{return await fn(store)}finally{store.close();await fs.rm(dir,{recursive:true,force:true})}
}

function raw(event){return JSON.stringify(event)}
function subEvent({id,type='customer.subscription.updated',created,subscription='sub_1',customer='cus_1',status='active',workspaceId='',priceId='price_pilot'}){
  const object={id:subscription,object:'subscription',customer,status,metadata:{}};
  if(workspaceId)object.metadata.workspace_id=workspaceId;
  if(type!=='customer.subscription.deleted')object.items={data:[{id:`si_${subscription}`,price:{id:priceId},current_period_end:created+3600}]};
  return {id,type,created,data:{object}};
}

test('subscription deletion resolves workspace from stored subscription and stale older update cannot reactivate it',()=>withStore(async store=>{
  const {workspace}=store.register({email:'order@example.test',password:'order-password-12345',workspaceName:'Order'});
  const checkout={id:'evt_checkout_order',type:'checkout.session.completed',created:100,data:{object:{object:'checkout.session',mode:'subscription',payment_status:'paid',client_reference_id:workspace.id,customer:'cus_1',subscription:'sub_1',metadata:{workspace_id:workspace.id,plan:'pilot'}}}};
  applyStripeEvent(store,checkout,{rawBody:raw(checkout),env});
  assert.equal(store.getEntitlement(workspace.id).status,'active');

  const deleted=subEvent({id:'evt_deleted',type:'customer.subscription.deleted',created:300,status:'canceled'});
  const canceled=applyStripeEvent(store,deleted,{rawBody:raw(deleted),env});
  assert.equal(canceled.applied,true);
  assert.equal(store.getEntitlement(workspace.id).status,'canceled');
  assert.equal(store.getEntitlement(workspace.id).plan,'pilot','cancellation without metadata must preserve the known plan while revoking access');

  const olderActive=subEvent({id:'evt_older_active',created:200,status:'active'});
  const stale=applyStripeEvent(store,olderActive,{rawBody:raw(olderActive),env});
  assert.equal(stale.stale,true);
  assert.equal(stale.applied,false);
  assert.equal(store.getEntitlement(workspace.id).status,'canceled','out-of-order active event must not reactivate a canceled subscription');

  const newSubscription=subEvent({id:'evt_new_sub',created:400,subscription:'sub_2',status:'active',priceId:'price_pro'});
  const upgraded=applyStripeEvent(store,newSubscription,{rawBody:raw(newSubscription),env});
  assert.equal(upgraded.applied,true);
  assert.equal(store.getEntitlement(workspace.id).status,'active');
  assert.equal(store.getEntitlement(workspace.id).plan,'pro');
  assert.equal(store.getEntitlement(workspace.id).providerSubscriptionId,'sub_2');
  assert.equal(store.getEntitlement(workspace.id).maxRunsMonth,100);
}));

test('reused Stripe event id with a different payload is rejected instead of silently deduplicated',()=>withStore(async store=>{
  const {workspace}=store.register({email:'conflict@example.test',password:'conflict-password-12345',workspaceName:'Conflict'});
  const first={id:'evt_same',type:'checkout.session.completed',created:100,data:{object:{object:'checkout.session',mode:'subscription',payment_status:'paid',client_reference_id:workspace.id,customer:'cus_conflict',subscription:'sub_conflict',metadata:{workspace_id:workspace.id,plan:'pilot'}}}};
  applyStripeEvent(store,first,{rawBody:raw(first),env});
  const duplicate=applyStripeEvent(store,first,{rawBody:raw(first),env});
  assert.equal(duplicate.duplicate,true);

  const mutated=structuredClone(first);
  mutated.data.object.metadata.plan='pro';
  assert.throws(
    ()=>applyStripeEvent(store,mutated,{rawBody:raw(mutated),env}),
    error=>error?.code==='STRIPE_EVENT_ID_CONFLICT'&&error?.statusCode===409,
  );
  assert.equal(store.getEntitlement(workspace.id).plan,'pilot');
}));
