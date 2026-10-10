import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HostedStore } from '../lib/hosted-db.mjs';
import { createStripeCheckoutSession, verifyStripeWebhook, applyStripeEvent } from '../lib/billing.mjs';

function sign(raw,secret,timestamp=Math.floor(Date.now()/1000)){
  const value=crypto.createHmac('sha256',secret).update(`${timestamp}.${raw}`).digest('hex');
  return `t=${timestamp},v1=${value}`;
}
async function withStore(fn){
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'xhs-billing-'));
  const store=new HostedStore(dir);
  try{return await fn(store)}finally{store.close();await fs.rm(dir,{recursive:true,force:true})}
}
const env={
  XHS_STUDIO_PUBLIC_URL:'http://127.0.0.1:5418',
  XHS_STUDIO_STRIPE_SECRET_KEY:'sk_test_unit',
  XHS_STUDIO_STRIPE_WEBHOOK_SECRET:'whsec_unit',
  XHS_STUDIO_STRIPE_PRICE_PILOT:'price_pilot',
  XHS_STUDIO_PILOT_MAX_PROJECTS:'4',
  XHS_STUDIO_PILOT_MAX_RUNS:'12',
  XHS_STUDIO_PILOT_MAX_NOTES:'90',
  XHS_STUDIO_PILOT_MAX_COMMENTS:'3000',
};

test('Stripe checkout is server-created with subscription price and workspace metadata',async()=>{
  let call;
  const fetchImpl=async(url,opts)=>{
    call={url,opts};
    return new Response(JSON.stringify({id:'cs_test_1',url:'https://checkout.stripe.com/c/pay/test'}),{status:200,headers:{'content-type':'application/json'}});
  };
  const result=await createStripeCheckoutSession({workspace:{id:'wsp_123'},user:{email:'owner@example.com'},planId:'pilot',fetchImpl,env});
  assert.equal(result.id,'cs_test_1');
  assert.equal(call.url,'https://api.stripe.com/v1/checkout/sessions');
  assert.match(call.opts.headers.authorization,/Bearer sk_test_unit/);
  const form=new URLSearchParams(call.opts.body);
  assert.equal(form.get('mode'),'subscription');
  assert.equal(form.get('line_items[0][price]'),'price_pilot');
  assert.equal(form.get('metadata[workspace_id]'),'wsp_123');
  assert.equal(form.get('subscription_data[metadata][plan]'),'pilot');
  assert.equal(form.get('client_reference_id'),'wsp_123');
});

test('Stripe webhook verification checks raw body, multiple v1 signatures, and replay window',()=>{
  const raw=JSON.stringify({id:'evt_1',type:'checkout.session.completed',data:{object:{id:'cs_1'}}});
  const timestamp=1_800_000_000;
  const valid=sign(raw,'whsec_unit',timestamp);
  const header=`t=${timestamp},v1=${'0'.repeat(64)},v1=${valid.split('v1=')[1]}`;
  const event=verifyStripeWebhook(raw,header,'whsec_unit',{nowSeconds:timestamp});
  assert.equal(event.id,'evt_1');
  assert.throws(()=>verifyStripeWebhook(raw+' ',header,'whsec_unit',{nowSeconds:timestamp}),error=>error.code==='STRIPE_SIGNATURE');
  assert.throws(()=>verifyStripeWebhook(raw,valid,'whsec_unit',{nowSeconds:timestamp+301}),error=>error.code==='STRIPE_SIGNATURE_EXPIRED');
});

test('signed billing events activate, downgrade, and deduplicate workspace entitlement',()=>withStore(async(store)=>{
  const {workspace}=store.register({email:'pay@example.com',password:'a sufficiently long password 123'});
  const checkout={
    id:'evt_checkout',type:'checkout.session.completed',data:{object:{
      object:'checkout.session',id:'cs_1',mode:'subscription',payment_status:'paid',customer:'cus_1',subscription:'sub_1',client_reference_id:workspace.id,
      metadata:{workspace_id:workspace.id,plan:'pilot'},
    }},
  };
  const raw=JSON.stringify(checkout);
  const verified=verifyStripeWebhook(raw,sign(raw,env.XHS_STUDIO_STRIPE_WEBHOOK_SECRET),env.XHS_STUDIO_STRIPE_WEBHOOK_SECRET);
  const first=applyStripeEvent(store,verified,{rawBody:raw,env});
  assert.equal(first.applied,true);
  assert.equal(store.getEntitlement(workspace.id).status,'active');
  assert.equal(store.getEntitlement(workspace.id).maxRunsMonth,12);
  const duplicate=applyStripeEvent(store,verified,{rawBody:raw,env});
  assert.equal(duplicate.duplicate,true);

  const pastDue={id:'evt_sub_update',type:'customer.subscription.updated',data:{object:{
    object:'subscription',id:'sub_1',customer:'cus_1',status:'past_due',current_period_end:1_900_000_000,metadata:{workspace_id:workspace.id,plan:'pilot'},
  }}};
  applyStripeEvent(store,pastDue,{rawBody:JSON.stringify(pastDue),env});
  assert.equal(store.getEntitlement(workspace.id).status,'past_due');
  assert.throws(()=>store.reserveRun(workspace.id,{maxNotes:1,maxComments:0}),error=>error.code==='ENTITLEMENT_REQUIRED');

  const canceled={id:'evt_sub_delete',type:'customer.subscription.deleted',data:{object:{
    object:'subscription',id:'sub_1',customer:'cus_1',status:'canceled',metadata:{workspace_id:workspace.id,plan:'pilot'},
  }}};
  applyStripeEvent(store,canceled,{rawBody:JSON.stringify(canceled),env});
  assert.equal(store.getEntitlement(workspace.id).status,'canceled');
  assert.ok(store.auditLog(workspace.id).some(x=>x.action==='billing.entitlement.sync'));
}));
