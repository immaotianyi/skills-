import test from 'node:test';
import assert from 'node:assert/strict';
import { checkoutEligibility, createStripeCheckoutSession } from '../lib/billing.mjs';

const workspace={id:'wsp_billing',name:'Billing'};
const user={id:'usr_billing',email:'billing@example.test'};
const env={XHS_STUDIO_PUBLIC_URL:'http://127.0.0.1:5418',XHS_STUDIO_STRIPE_SECRET_KEY:'sk_test',XHS_STUDIO_STRIPE_PRICE_PILOT:'price_pilot'};

test('active/trialing/past-due Stripe subscriptions cannot create a duplicate Checkout subscription',async()=>{
  for(const status of ['active','trialing','past_due','unpaid','paused']){
    const entitlement={status,providerCustomerId:'cus_existing',providerSubscriptionId:'sub_existing'};
    assert.equal(checkoutEligibility(entitlement).usePortal,true);
    await assert.rejects(
      ()=>createStripeCheckoutSession({workspace,user,planId:'pilot',entitlement,env,fetchImpl:async()=>{throw new Error('Stripe must not be called')}}),
      error=>error?.code==='STRIPE_SUBSCRIPTION_EXISTS'&&error?.statusCode===409,
    );
  }
});

test('canceled subscription may restart Checkout and reuses the existing Stripe customer',async()=>{
  const entitlement={status:'canceled',providerCustomerId:'cus_existing',providerSubscriptionId:'sub_old'};
  let form;
  const fetchImpl=async(url,options)=>{
    assert.equal(url,'https://api.stripe.com/v1/checkout/sessions');
    form=new URLSearchParams(options.body);
    return {ok:true,status:200,async text(){return JSON.stringify({id:'cs_restart',url:'https://checkout.stripe.test/session'})}};
  };
  const result=await createStripeCheckoutSession({workspace,user,planId:'pilot',entitlement,env,fetchImpl});
  assert.equal(result.id,'cs_restart');
  assert.equal(form.get('customer'),'cus_existing');
  assert.equal(form.has('customer_email'),false,'existing customer must not be duplicated with customer_email');
});
