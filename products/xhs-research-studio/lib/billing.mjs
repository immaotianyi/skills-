import crypto from 'node:crypto';
import { HostedStoreError } from './hosted-db.mjs';

const ACTIVE_STRIPE_STATUSES=new Set(['active','trialing']);
const TERMINAL_SUBSCRIPTION_STATUSES=new Set(['canceled','incomplete_expired']);

export class BillingError extends Error{
  constructor(message,{code='BILLING_ERROR',statusCode=400}={}){super(message);this.code=code;this.statusCode=statusCode}
}

function intEnv(value,fallback){const n=Math.trunc(Number(value));return Number.isFinite(n)&&n>=0?n:fallback}
function planShape(id,label,priceId,limits){return {id,label,priceId:String(priceId||''),...limits}}

export function billingPlans(env=process.env){
  if(env.XHS_STUDIO_BILLING_PLANS_JSON){
    let parsed;
    try{parsed=JSON.parse(env.XHS_STUDIO_BILLING_PLANS_JSON)}catch{throw new BillingError('XHS_STUDIO_BILLING_PLANS_JSON must be valid JSON.',{code:'BILLING_CONFIG',statusCode:500})}
    if(!Array.isArray(parsed)||!parsed.length)throw new BillingError('Billing plans JSON must be a non-empty array.',{code:'BILLING_CONFIG',statusCode:500});
    return parsed.map((p,index)=>planShape(String(p.id||`plan-${index+1}`).slice(0,80),String(p.label||p.id||`Plan ${index+1}`).slice(0,120),p.priceId,{
      maxProjects:intEnv(p.maxProjects,1),maxRunsMonth:intEnv(p.maxRunsMonth,10),maxNotesRun:intEnv(p.maxNotesRun,80),maxCommentsRun:intEnv(p.maxCommentsRun,2000),
    }));
  }
  return [
    planShape('pilot','Paid Pilot',env.XHS_STUDIO_STRIPE_PRICE_PILOT,{maxProjects:intEnv(env.XHS_STUDIO_PILOT_MAX_PROJECTS,3),maxRunsMonth:intEnv(env.XHS_STUDIO_PILOT_MAX_RUNS,20),maxNotesRun:intEnv(env.XHS_STUDIO_PILOT_MAX_NOTES,100),maxCommentsRun:intEnv(env.XHS_STUDIO_PILOT_MAX_COMMENTS,5000)}),
    planShape('pro','Pro',env.XHS_STUDIO_STRIPE_PRICE_PRO,{maxProjects:intEnv(env.XHS_STUDIO_PRO_MAX_PROJECTS,20),maxRunsMonth:intEnv(env.XHS_STUDIO_PRO_MAX_RUNS,200),maxNotesRun:intEnv(env.XHS_STUDIO_PRO_MAX_NOTES,300),maxCommentsRun:intEnv(env.XHS_STUDIO_PRO_MAX_COMMENTS,15000)}),
  ];
}

export function publicBillingPlans(env=process.env){return billingPlans(env).map(({priceId,...plan})=>({...plan,configured:Boolean(priceId)}))}
function findPlan(planId,env=process.env){
  const plan=billingPlans(env).find(item=>item.id===String(planId||''));
  if(!plan)throw new BillingError('Unknown billing plan.',{code:'PLAN_NOT_FOUND',statusCode:404});
  return plan;
}
function publicUrl(env=process.env){
  const value=String(env.XHS_STUDIO_PUBLIC_URL||'').trim().replace(/\/$/u,'');
  if(!/^https:\/\//u.test(value)&&!/^http:\/\/127\.0\.0\.1(?::\d+)?$/u.test(value)&&!/^http:\/\/localhost(?::\d+)?$/u.test(value)){
    throw new BillingError('XHS_STUDIO_PUBLIC_URL must be HTTPS in hosted production (localhost allowed for tests).',{code:'BILLING_CONFIG',statusCode:503});
  }
  return value;
}
function stripeSecret(env){
  const secret=String(env.XHS_STUDIO_STRIPE_SECRET_KEY||'').trim();
  if(!secret)throw new BillingError('Stripe secret key is not configured.',{code:'BILLING_NOT_CONFIGURED',statusCode:503});
  return secret;
}
async function stripeFormRequest(endpoint,form,{fetchImpl=fetch,env=process.env,errorCode}){
  const response=await fetchImpl(`https://api.stripe.com${endpoint}`,{
    method:'POST',
    headers:{authorization:`Bearer ${stripeSecret(env)}`,'content-type':'application/x-www-form-urlencoded'},
    body:form.toString(),
  });
  const text=await response.text();
  let data;
  try{data=JSON.parse(text)}catch{data={}}
  if(!response.ok){
    const detail=data?.error?.message||`Stripe returned HTTP ${response.status}`;
    throw new BillingError(`Stripe request failed: ${detail}`,{code:errorCode,statusCode:502});
  }
  return data;
}

export function checkoutEligibility(entitlement={}){
  const subscriptionId=String(entitlement?.providerSubscriptionId||'').trim();
  const status=String(entitlement?.status||'inactive').trim();
  const existingManagedSubscription=Boolean(subscriptionId&&!TERMINAL_SUBSCRIPTION_STATUSES.has(status));
  return {
    allowed:!existingManagedSubscription,
    usePortal:existingManagedSubscription,
    customerId:String(entitlement?.providerCustomerId||'').trim()||null,
    subscriptionId:subscriptionId||null,
    status,
  };
}

export async function createStripeCheckoutSession({workspace,user,planId,entitlement={},fetchImpl=fetch,env=process.env}){
  const eligibility=checkoutEligibility(entitlement);
  if(!eligibility.allowed){
    throw new BillingError('This workspace already has a managed Stripe subscription. Use the Billing Portal to change plan, update payment details, view invoices, or cancel.',{code:'STRIPE_SUBSCRIPTION_EXISTS',statusCode:409});
  }
  const plan=findPlan(planId,env);
  if(!plan.priceId)throw new BillingError(`Stripe price is not configured for plan ${plan.id}.`,{code:'PLAN_NOT_CONFIGURED',statusCode:503});
  const origin=publicUrl(env);
  const form=new URLSearchParams();
  form.set('mode','subscription');
  form.set('success_url',`${origin}/?billing=success`);
  form.set('cancel_url',`${origin}/?billing=cancelled`);
  form.set('client_reference_id',workspace.id);
  if(eligibility.customerId)form.set('customer',eligibility.customerId);else form.set('customer_email',user.email);
  form.set('line_items[0][price]',plan.priceId);
  form.set('line_items[0][quantity]','1');
  form.set('metadata[workspace_id]',workspace.id);
  form.set('metadata[plan]',plan.id);
  form.set('subscription_data[metadata][workspace_id]',workspace.id);
  form.set('subscription_data[metadata][plan]',plan.id);
  const data=await stripeFormRequest('/v1/checkout/sessions',form,{fetchImpl,env,errorCode:'STRIPE_CHECKOUT_FAILED'});
  if(!data?.id||!data?.url)throw new BillingError('Stripe Checkout Session response is incomplete.',{code:'STRIPE_CHECKOUT_FAILED',statusCode:502});
  return {id:data.id,url:data.url,plan:{id:plan.id,label:plan.label}};
}

export async function createStripePortalSession({workspace,entitlement,fetchImpl=fetch,env=process.env}){
  const customerId=String(entitlement?.providerCustomerId||'').trim();
  if(!customerId)throw new BillingError('This workspace does not have a Stripe customer yet.',{code:'STRIPE_CUSTOMER_REQUIRED',statusCode:409});
  const origin=publicUrl(env);
  const form=new URLSearchParams();
  form.set('customer',customerId);
  form.set('return_url',`${origin}/?billing=portal-return`);
  if(env.XHS_STUDIO_STRIPE_PORTAL_CONFIGURATION_ID)form.set('configuration',String(env.XHS_STUDIO_STRIPE_PORTAL_CONFIGURATION_ID));
  const data=await stripeFormRequest('/v1/billing_portal/sessions',form,{fetchImpl,env,errorCode:'STRIPE_PORTAL_FAILED'});
  if(!data?.id||!data?.url)throw new BillingError('Stripe Billing Portal Session response is incomplete.',{code:'STRIPE_PORTAL_FAILED',statusCode:502});
  return {id:data.id,url:data.url,workspaceId:workspace.id};
}

function safeHexEqual(a,b){
  if(!/^[0-9a-f]+$/iu.test(String(a||''))||!/^[0-9a-f]+$/iu.test(String(b||'')))return false;
  const A=Buffer.from(a,'hex'),B=Buffer.from(b,'hex');
  return A.length===B.length&&crypto.timingSafeEqual(A,B);
}

export function verifyStripeWebhook(rawBody,signatureHeader,secret,{toleranceSeconds=300,nowSeconds=Math.floor(Date.now()/1000)}={}){
  const body=Buffer.isBuffer(rawBody)?rawBody:Buffer.from(String(rawBody??''),'utf8');
  if(!body.length||!signatureHeader||!secret)throw new BillingError('Missing Stripe webhook signature inputs.',{code:'STRIPE_SIGNATURE',statusCode:400});
  const pairs=String(signatureHeader).split(',').map(part=>part.trim()).filter(Boolean).map(part=>{const i=part.indexOf('=');return i<0?[part,'']:[part.slice(0,i),part.slice(i+1)]});
  const timestamp=pairs.find(([key])=>key==='t')?.[1];
  const signatures=pairs.filter(([key,value])=>key==='v1'&&value).map(([,value])=>value);
  const ts=Number(timestamp);
  if(!Number.isInteger(ts)||!signatures.length)throw new BillingError('Malformed Stripe-Signature header.',{code:'STRIPE_SIGNATURE',statusCode:400});
  if(Math.abs(nowSeconds-ts)>Math.max(1,Number(toleranceSeconds)||300))throw new BillingError('Stripe webhook timestamp is outside the replay tolerance.',{code:'STRIPE_SIGNATURE_EXPIRED',statusCode:400});
  const expected=crypto.createHmac('sha256',secret).update(Buffer.concat([Buffer.from(`${timestamp}.`,'utf8'),body])).digest('hex');
  if(!signatures.some(signature=>safeHexEqual(signature,expected)))throw new BillingError('Invalid Stripe webhook signature.',{code:'STRIPE_SIGNATURE',statusCode:400});
  let event;
  try{event=JSON.parse(body.toString('utf8'))}catch{throw new BillingError('Stripe webhook body is not valid JSON.',{code:'STRIPE_WEBHOOK_JSON',statusCode:400})}
  if(!event?.id||!event?.type||!event?.data?.object)throw new BillingError('Stripe webhook event shape is incomplete.',{code:'STRIPE_WEBHOOK_SHAPE',statusCode:400});
  return event;
}

function entitlementFromPlan(plan,status,object={}){
  const period=Number(object.current_period_end);
  return {
    plan:plan.id,status:String(status||'inactive'),
    providerCustomerId:typeof object.customer==='string'?object.customer:null,
    providerSubscriptionId:typeof object.subscription==='string'?object.subscription:(String(object.object)==='subscription'?object.id:null),
    currentPeriodEnd:Number.isFinite(period)&&period>0?new Date(period*1000).toISOString():null,
    maxProjects:plan.maxProjects,maxRunsMonth:plan.maxRunsMonth,maxNotesRun:plan.maxNotesRun,maxCommentsRun:plan.maxCommentsRun,
  };
}

function eventWorkspacePlan(event,env){
  const object=event.data.object||{};
  const metadata=object.metadata||{};
  const workspaceId=String(metadata.workspace_id||object.client_reference_id||'').trim();
  const planId=String(metadata.plan||'').trim();
  if(!workspaceId||!planId)return null;
  return {workspaceId,plan:findPlan(planId,env),object};
}

export function applyStripeEvent(store,event,{rawBody='',env=process.env}={}){
  if(!store?.db)throw new TypeError('HostedStore is required');
  const payloadHash=crypto.createHash('sha256').update(Buffer.isBuffer(rawBody)?rawBody:Buffer.from(String(rawBody||JSON.stringify(event)))).digest('hex');
  const db=store.db;
  db.exec('BEGIN IMMEDIATE');
  try{
    if(db.prepare('SELECT 1 AS seen FROM billing_events WHERE provider_event_id=?').get(event.id)){
      db.exec('COMMIT');return {applied:false,duplicate:true,entitlement:null};
    }
    const resolved=eventWorkspacePlan(event,env);
    let entitlement=null;
    const object=event.data.object||{};
    if(resolved){
      let status=null;
      if(event.type==='checkout.session.completed'){
        if(object.mode==='subscription'&&['paid','no_payment_required'].includes(String(object.payment_status)))status='active';
      }else if(event.type==='customer.subscription.created'||event.type==='customer.subscription.updated'){
        status=String(object.status||'inactive');
      }else if(event.type==='customer.subscription.deleted'){
        status='canceled';
      }
      if(status){
        entitlement=store.setEntitlement(resolved.workspaceId,entitlementFromPlan(resolved.plan,status,object));
        store.audit({workspaceId:resolved.workspaceId,action:'billing.entitlement.sync',targetType:'subscription',targetId:entitlement.providerSubscriptionId,metadata:{provider:'stripe',eventId:event.id,eventType:event.type,plan:entitlement.plan,status:entitlement.status}});
      }
    }
    db.prepare('INSERT INTO billing_events(provider_event_id,type,payload_hash,processed_at) VALUES(?,?,?,?)').run(event.id,event.type,payloadHash,new Date().toISOString());
    db.exec('COMMIT');
    return {applied:true,duplicate:false,entitlement};
  }catch(error){try{db.exec('ROLLBACK')}catch{}throw error}
}

export function assertBillingOwner(store,userId,workspaceId){
  try{return store.requireRole(userId,workspaceId,['owner','admin'])}
  catch(error){if(error instanceof HostedStoreError)throw error;throw new BillingError(error.message)}
}

export const billingStatus=Object.freeze({activeStatuses:[...ACTIVE_STRIPE_STATUSES],terminalSubscriptionStatuses:[...TERMINAL_SUBSCRIPTION_STATUSES]});
