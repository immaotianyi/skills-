import crypto from 'node:crypto';
import { HostedStoreError } from './hosted-db.mjs';

const ACTIVE_STRIPE_STATUSES=new Set(['active','trialing']);
const TERMINAL_SUBSCRIPTION_STATUSES=new Set(['canceled','incomplete_expired']);
const CLOCK_PREFIX='stripe_entitlement_clock:';

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
function findPlanByPrice(priceId,env=process.env){return billingPlans(env).find(item=>item.priceId&&item.priceId===String(priceId||''))||null}
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
  const text=await response.text();let data;
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
  return {allowed:!existingManagedSubscription,usePortal:existingManagedSubscription,customerId:String(entitlement?.providerCustomerId||'').trim()||null,subscriptionId:subscriptionId||null,status};
}

export async function createStripeCheckoutSession({workspace,user,planId,entitlement={},fetchImpl=fetch,env=process.env}){
  const eligibility=checkoutEligibility(entitlement);
  if(!eligibility.allowed)throw new BillingError('This workspace already has a managed Stripe subscription. Use the Billing Portal to change plan, update payment details, view invoices, or cancel.',{code:'STRIPE_SUBSCRIPTION_EXISTS',statusCode:409});
  const plan=findPlan(planId,env);
  if(!plan.priceId)throw new BillingError(`Stripe price is not configured for plan ${plan.id}.`,{code:'PLAN_NOT_CONFIGURED',statusCode:503});
  const origin=publicUrl(env),form=new URLSearchParams();
  form.set('mode','subscription');form.set('success_url',`${origin}/?billing=success`);form.set('cancel_url',`${origin}/?billing=cancelled`);form.set('client_reference_id',workspace.id);
  if(eligibility.customerId)form.set('customer',eligibility.customerId);else form.set('customer_email',user.email);
  form.set('line_items[0][price]',plan.priceId);form.set('line_items[0][quantity]','1');form.set('metadata[workspace_id]',workspace.id);form.set('metadata[plan]',plan.id);form.set('subscription_data[metadata][workspace_id]',workspace.id);form.set('subscription_data[metadata][plan]',plan.id);
  const data=await stripeFormRequest('/v1/checkout/sessions',form,{fetchImpl,env,errorCode:'STRIPE_CHECKOUT_FAILED'});
  if(!data?.id||!data?.url)throw new BillingError('Stripe Checkout Session response is incomplete.',{code:'STRIPE_CHECKOUT_FAILED',statusCode:502});
  return {id:data.id,url:data.url,plan:{id:plan.id,label:plan.label}};
}

export async function createStripePortalSession({workspace,entitlement,fetchImpl=fetch,env=process.env}){
  const customerId=String(entitlement?.providerCustomerId||'').trim();
  if(!customerId)throw new BillingError('This workspace does not have a Stripe customer yet.',{code:'STRIPE_CUSTOMER_REQUIRED',statusCode:409});
  const origin=publicUrl(env),form=new URLSearchParams();
  form.set('customer',customerId);form.set('return_url',`${origin}/?billing=portal-return`);
  if(env.XHS_STUDIO_STRIPE_PORTAL_CONFIGURATION_ID)form.set('configuration',String(env.XHS_STUDIO_STRIPE_PORTAL_CONFIGURATION_ID));
  const data=await stripeFormRequest('/v1/billing_portal/sessions',form,{fetchImpl,env,errorCode:'STRIPE_PORTAL_FAILED'});
  if(!data?.id||!data?.url)throw new BillingError('Stripe Billing Portal Session response is incomplete.',{code:'STRIPE_PORTAL_FAILED',statusCode:502});
  return {id:data.id,url:data.url,workspaceId:workspace.id};
}

function safeHexEqual(a,b){
  if(!/^[0-9a-f]+$/iu.test(String(a||''))||!/^[0-9a-f]+$/iu.test(String(b||'')))return false;
  const A=Buffer.from(a,'hex'),B=Buffer.from(b,'hex');return A.length===B.length&&crypto.timingSafeEqual(A,B);
}

export function verifyStripeWebhook(rawBody,signatureHeader,secret,{toleranceSeconds=300,nowSeconds=Math.floor(Date.now()/1000)}={}){
  const body=Buffer.isBuffer(rawBody)?rawBody:Buffer.from(String(rawBody??''),'utf8');
  if(!body.length||!signatureHeader||!secret)throw new BillingError('Missing Stripe webhook signature inputs.',{code:'STRIPE_SIGNATURE',statusCode:400});
  const pairs=String(signatureHeader).split(',').map(part=>part.trim()).filter(Boolean).map(part=>{const i=part.indexOf('=');return i<0?[part,'']:[part.slice(0,i),part.slice(i+1)]});
  const timestamp=pairs.find(([key])=>key==='t')?.[1],signatures=pairs.filter(([key,value])=>key==='v1'&&value).map(([,value])=>value),ts=Number(timestamp);
  if(!Number.isInteger(ts)||!signatures.length)throw new BillingError('Malformed Stripe-Signature header.',{code:'STRIPE_SIGNATURE',statusCode:400});
  if(Math.abs(nowSeconds-ts)>Math.max(1,Number(toleranceSeconds)||300))throw new BillingError('Stripe webhook timestamp is outside the replay tolerance.',{code:'STRIPE_SIGNATURE_EXPIRED',statusCode:400});
  const expected=crypto.createHmac('sha256',secret).update(Buffer.concat([Buffer.from(`${timestamp}.`,'utf8'),body])).digest('hex');
  if(!signatures.some(signature=>safeHexEqual(signature,expected)))throw new BillingError('Invalid Stripe webhook signature.',{code:'STRIPE_SIGNATURE',statusCode:400});
  let event;try{event=JSON.parse(body.toString('utf8'))}catch{throw new BillingError('Stripe webhook body is not valid JSON.',{code:'STRIPE_WEBHOOK_JSON',statusCode:400})}
  if(!event?.id||!event?.type||!event?.data?.object)throw new BillingError('Stripe webhook event shape is incomplete.',{code:'STRIPE_WEBHOOK_SHAPE',statusCode:400});
  return event;
}

function entitlementFromPlan(plan,status,object={}){
  const period=Number(object.current_period_end??object.items?.data?.[0]?.current_period_end);
  return {
    plan:plan.id,status:String(status||'inactive'),providerCustomerId:typeof object.customer==='string'?object.customer:null,
    providerSubscriptionId:typeof object.subscription==='string'?object.subscription:(String(object.object)==='subscription'?object.id:null),
    currentPeriodEnd:Number.isFinite(period)&&period>0?new Date(period*1000).toISOString():null,
    maxProjects:plan.maxProjects,maxRunsMonth:plan.maxRunsMonth,maxNotesRun:plan.maxNotesRun,maxCommentsRun:plan.maxCommentsRun,
  };
}

function existingEntitlementRow(db,object={}){
  const subscriptionId=String(object.object)==='subscription'?String(object.id||'').trim():String(object.subscription||'').trim();
  if(subscriptionId){
    const bySubscription=db.prepare('SELECT * FROM entitlements WHERE provider_subscription_id=?').get(subscriptionId);
    if(bySubscription)return bySubscription;
  }
  const customerId=String(object.customer||'').trim();
  if(customerId)return db.prepare('SELECT * FROM entitlements WHERE provider_customer_id=?').get(customerId)||null;
  return null;
}

function eventResolution(store,event,env){
  const object=event.data.object||{},metadata=object.metadata||{},existing=existingEntitlementRow(store.db,object);
  const workspaceId=String(metadata.workspace_id||object.client_reference_id||existing?.workspace_id||'').trim();
  if(!workspaceId)return null;
  if(String(object.object)==='subscription'&&event.type!=='customer.subscription.deleted'){
    const items=Array.isArray(object.items?.data)?object.items.data:[];
    if(items.length!==1)throw new BillingError('Hosted billing expects exactly one recurring subscription item.',{code:'STRIPE_SUBSCRIPTION_ITEMS_UNSUPPORTED',statusCode:503});
    const priceId=String(items[0]?.price?.id||items[0]?.plan?.id||'').trim(),plan=findPlanByPrice(priceId,env);
    if(!plan)throw new BillingError(`Stripe subscription uses an unconfigured Price: ${priceId||'(missing)'}.`,{code:'STRIPE_PRICE_NOT_CONFIGURED',statusCode:503});
    return {workspaceId,plan,object,existing};
  }
  if(event.type==='customer.subscription.deleted'){
    const metadataPlan=String(metadata.plan||'').trim();
    const plan=metadataPlan?findPlan(metadataPlan,env):null;
    return {workspaceId,plan,object,existing};
  }
  const planId=String(metadata.plan||'').trim();
  if(!planId)return {workspaceId,plan:null,object,existing};
  return {workspaceId,plan:findPlan(planId,env),object,existing};
}

function eventStatus(event){
  const object=event.data.object||{};
  if(event.type==='checkout.session.completed')return object.mode==='subscription'&&['paid','no_payment_required'].includes(String(object.payment_status))?'active':null;
  if(event.type==='customer.subscription.created'||event.type==='customer.subscription.updated')return String(object.status||'inactive');
  if(event.type==='customer.subscription.deleted')return 'canceled';
  return null;
}
function eventSubscriptionId(object={}){return String(object.object)==='subscription'?String(object.id||'').trim():String(object.subscription||'').trim()}
function eventCreated(event){const value=Math.trunc(Number(event?.created));return Number.isFinite(value)&&value>0?value:0}
function clockKey(workspaceId){return `${CLOCK_PREFIX}${workspaceId}`}
function readClock(db,workspaceId){
  const row=db.prepare('SELECT value FROM hosted_meta WHERE key=?').get(clockKey(workspaceId));
  if(!row?.value)return null;
  try{return JSON.parse(row.value)}catch{return null}
}
function writeClock(db,workspaceId,value){
  db.prepare('INSERT INTO hosted_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(clockKey(workspaceId),JSON.stringify(value));
}
function isStaleEntitlementEvent(clock,{created,subscriptionId,status}){
  if(!clock)return false;
  if(created&&Number(clock.created||0)>created)return true;
  if(subscriptionId&&clock.subscriptionId===subscriptionId&&clock.status==='canceled'&&status!=='canceled')return true;
  return false;
}
function recordBillingEvent(db,event,payloadHash){
  db.prepare('INSERT INTO billing_events(provider_event_id,type,payload_hash,processed_at) VALUES(?,?,?,?)').run(event.id,event.type,payloadHash,new Date().toISOString());
}

export function applyStripeEvent(store,event,{rawBody='',env=process.env}={}){
  if(!store?.db)throw new TypeError('HostedStore is required');
  const payloadHash=crypto.createHash('sha256').update(Buffer.isBuffer(rawBody)?rawBody:Buffer.from(String(rawBody||JSON.stringify(event)))).digest('hex'),db=store.db;
  db.exec('BEGIN IMMEDIATE');
  try{
    const seen=db.prepare('SELECT payload_hash FROM billing_events WHERE provider_event_id=?').get(event.id);
    if(seen){
      if(seen.payload_hash!==payloadHash)throw new BillingError('Stripe event ID was reused with a different payload.',{code:'STRIPE_EVENT_ID_CONFLICT',statusCode:409});
      db.exec('COMMIT');return {applied:false,duplicate:true,stale:false,entitlement:null};
    }

    const resolved=eventResolution(store,event,env);let entitlement=null,stale=false;
    const status=eventStatus(event),object=event.data.object||{};
    if(resolved&&status){
      const created=eventCreated(event),subscriptionId=eventSubscriptionId(object),clock=readClock(db,resolved.workspaceId);
      stale=isStaleEntitlementEvent(clock,{created,subscriptionId,status});
      if(!stale){
        if(event.type==='customer.subscription.deleted'){
          const patch={status:'canceled',providerCustomerId:typeof object.customer==='string'?object.customer:null,providerSubscriptionId:subscriptionId||null};
          if(resolved.plan){
            Object.assign(patch,entitlementFromPlan(resolved.plan,'canceled',object));
          }
          entitlement=store.setEntitlement(resolved.workspaceId,patch);
        }else{
          if(!resolved.plan)throw new BillingError('Stripe billing event does not identify a configured plan.',{code:'STRIPE_PLAN_REQUIRED',statusCode:503});
          entitlement=store.setEntitlement(resolved.workspaceId,entitlementFromPlan(resolved.plan,status,object));
        }
        const nextClock={created,eventId:event.id,eventType:event.type,subscriptionId:subscriptionId||entitlement?.providerSubscriptionId||null,status:entitlement?.status||status};
        writeClock(db,resolved.workspaceId,nextClock);
        store.audit({workspaceId:resolved.workspaceId,action:'billing.entitlement.sync',targetType:'subscription',targetId:entitlement?.providerSubscriptionId||subscriptionId||null,metadata:{provider:'stripe',eventId:event.id,eventType:event.type,plan:entitlement?.plan||null,status:entitlement?.status||status,created}});
      }else{
        store.audit({workspaceId:resolved.workspaceId,action:'billing.event.stale_ignored',targetType:'subscription',targetId:subscriptionId||null,metadata:{provider:'stripe',eventId:event.id,eventType:event.type,status,created,clock}});
      }
    }
    recordBillingEvent(db,event,payloadHash);
    db.exec('COMMIT');return {applied:!stale,duplicate:false,stale,entitlement};
  }catch(error){try{db.exec('ROLLBACK')}catch{}throw error}
}

export function assertBillingOwner(store,userId,workspaceId){
  try{return store.requireRole(userId,workspaceId,['owner','admin'])}
  catch(error){if(error instanceof HostedStoreError)throw error;throw new BillingError(error.message)}
}

export const billingStatus=Object.freeze({activeStatuses:[...ACTIVE_STRIPE_STATUSES],terminalSubscriptionStatuses:[...TERMINAL_SUBSCRIPTION_STATUSES]});
