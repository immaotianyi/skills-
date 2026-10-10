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
  XHS_STUDIO_PILOT_MAX_PROJECTS:'3',
  XHS_STUDIO_PRO_MAX_PROJECTS:'20',
};

async function withStore(fn){
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'xhs-billing-switch-'));
  const store=new HostedStore(dir);
  try{return await fn(store)}finally{store.close();await fs.rm(dir,{recursive:true,force:true})}
}

function subscriptionEvent({id,workspaceId,priceId,status='active',metadataPlan='pilot'}){
  return {
    id,type:'customer.subscription.updated',data:{object:{
      id:'sub_switch',object:'subscription',customer:'cus_switch',status,
      metadata:{workspace_id:workspaceId,plan:metadataPlan},
      items:{data:[{id:'si_switch',price:{id:priceId},current_period_end:Math.floor(Date.now()/1000)+30*24*3600}]},
    }},
  };
}

test('subscription.updated derives workspace plan from current Stripe Price instead of stale metadata.plan',()=>withStore(async store=>{
  const created=store.register({email:'switch@example.test',password:'switch-password-12345',workspaceName:'Switch'});
  const event=subscriptionEvent({id:'evt_switch_pro',workspaceId:created.workspace.id,priceId:'price_pro',metadataPlan:'pilot'});
  const result=applyStripeEvent(store,event,{rawBody:JSON.stringify(event),env});
  assert.equal(result.entitlement.plan,'pro');
  assert.equal(result.entitlement.status,'active');
  assert.equal(result.entitlement.maxProjects,20);
  assert.equal(result.entitlement.providerSubscriptionId,'sub_switch');
  assert.ok(result.entitlement.currentPeriodEnd);
}));

test('unconfigured subscription Price fails closed and leaves event retryable',()=>withStore(async store=>{
  const created=store.register({email:'unknown-price@example.test',password:'unknown-price-password-12345',workspaceName:'Unknown'});
  const event=subscriptionEvent({id:'evt_unknown_price',workspaceId:created.workspace.id,priceId:'price_not_configured',metadataPlan:'pilot'});
  assert.throws(
    ()=>applyStripeEvent(store,event,{rawBody:JSON.stringify(event),env}),
    error=>error?.code==='STRIPE_PRICE_NOT_CONFIGURED'&&error?.statusCode===503,
  );
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM billing_events WHERE provider_event_id=?').get(event.id).n,0,'failed event must not be marked processed');
  assert.equal(store.getEntitlement(created.workspace.id).status,'inactive');
}));
