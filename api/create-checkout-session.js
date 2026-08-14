// POST /api/create-checkout-session
// Starts a Stripe-hosted Checkout session for the account-capacity band
// matching the requested monitored-account count. Talks to Stripe's REST
// API directly via fetch (same convention this codebase already uses for
// Supabase and Resend) rather than adding the stripe npm SDK as a new
// dependency.
//
// The band is always re-derived here from the requested account count,
// never trusted from the client as a band key -- this is what the actual
// Stripe Price charged traces back to, so it must be server-computed.
import { bandForAccountCount, stripePriceIdForBand } from '../pricing-bands.js';
import { entitlement } from './lib/entitlement.js';

function json(res,status,body){res.setHeader('Cache-Control','no-store, max-age=0');return res.status(status).json(body)}
function clean(v=''){return String(v??'').trim()}
function env(){const rawUrl=process.env.SUPABASE_URL;const key=process.env.SUPABASE_SERVICE_ROLE_KEY;if(!rawUrl||!key)throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');const url=String(rawUrl).trim().replace(/\/+$/,'').replace(/\/rest\/v1$/i,'');return{url,key}}
async function sb(path, options={}){const{url,key}=env();const resp=await fetch(`${url}/rest/v1/${path}`,{...options,headers:{apikey:key,Authorization:`Bearer ${key}`,'Content-Type':'application/json',Prefer:options.prefer||'return=representation',...(options.headers||{})}});const text=await resp.text();let data=null;if(text){try{data=JSON.parse(text)}catch{data=text}}if(!resp.ok){const msg=typeof data==='string'?data:(data?.message||data?.hint||JSON.stringify(data));throw new Error(`Supabase ${resp.status}: ${msg}`)}return data}
async function authUser(req){const token=(req.headers.authorization||'').replace(/^Bearer\s+/i,'');if(!token)return null;const{url,key}=env();const resp=await fetch(`${url}/auth/v1/user`,{headers:{apikey:key,Authorization:`Bearer ${token}`}});if(!resp.ok)return null;return resp.json()}
async function haUser(req){const au=await authUser(req);if(!au?.id)return null;const data=await sb(`ha_users?auth_user_id=eq.${encodeURIComponent(au.id)}&select=*&limit=1`);return Array.isArray(data)?data[0]:null}
async function loadOrg(orgId){if(!orgId)return null;const data=await sb(`ha_organizations?id=eq.${encodeURIComponent(orgId)}&select=*&limit=1`);return Array.isArray(data)?data[0]:null}
function appBaseUrl(req){const configured=clean(process.env.APP_BASE_URL||process.env.PUBLIC_APP_URL);if(configured)return configured.replace(/\/+$/,'');const host=clean(req?.headers?.host);if(/^(localhost|127\.0\.0\.1)(:\d+)?$/i.test(host))return `http://${host}`;return 'https://www.houseaccounts.ai'}

// Flattens a nested object/array into Stripe's bracket-notation
// x-www-form-urlencoded body shape, e.g. {line_items:[{price:'x'}]} ->
// "line_items[0][price]=x".
function flattenForm(obj, prefix=''){
  const pairs=[];
  for(const [k,v] of Object.entries(obj||{})){
    if(v===undefined||v===null)continue;
    const key=prefix?`${prefix}[${k}]`:k;
    if(Array.isArray(v)){
      v.forEach((item,i)=>{
        const arrKey=`${key}[${i}]`;
        if(item&&typeof item==='object')pairs.push(...flattenForm(item,arrKey));
        else pairs.push([arrKey,String(item)]);
      });
    }else if(typeof v==='object'){
      pairs.push(...flattenForm(v,key));
    }else{
      pairs.push([key,String(v)]);
    }
  }
  return pairs;
}
function toFormBody(obj){return flattenForm(obj).map(([k,v])=>`${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&')}
async function stripeFetch(path, params){
  const key=process.env.STRIPE_SECRET_KEY;
  if(!key)throw new Error('Missing STRIPE_SECRET_KEY');
  const resp=await fetch(`https://api.stripe.com/v1/${path}`,{method:'POST',headers:{Authorization:`Bearer ${key}`,'Content-Type':'application/x-www-form-urlencoded'},body:toFormBody(params||{})});
  const data=await resp.json().catch(()=>({}));
  if(!resp.ok){const err=new Error(data?.error?.message||`Stripe ${resp.status}`);err.status=resp.status;throw err}
  return data;
}
// GET counterpart to stripeFetch() -- used only to VALIDATE that a stored
// Stripe object (customer or subscription id) still resolves in whichever
// Stripe environment STRIPE_SECRET_KEY currently points at, before ever
// reusing it. Returns {ok:false} instead of throwing on a 404/any error --
// a stale id (deleted, or minted under a different test/live key than is
// configured now) is an expected, handleable case here, never a crash.
async function stripeGet(path){
  const key=process.env.STRIPE_SECRET_KEY;
  if(!key)throw new Error('Missing STRIPE_SECRET_KEY');
  const resp=await fetch(`https://api.stripe.com/v1/${path}`,{headers:{Authorization:`Bearer ${key}`}});
  const data=await resp.json().catch(()=>({}));
  if(!resp.ok)return{ok:false,error:data?.error};
  return{ok:true,data};
}

export default async function handler(req,res){
  try{
    if(req.method!=='POST')return json(res,405,{error:'Method not allowed'});
    const user=await haUser(req);
    if(!user)return json(res,401,{error:'Not authenticated'});
    if(!user.organization_id)return json(res,400,{error:'User is not linked to an organization.'});
    if(clean(user.app_role||'').toLowerCase()!=='owner')return json(res,403,{error:'Only an organization owner can start checkout.'});

    const requestedAccountCount=Number(req.body?.requestedAccountCount);
    if(!Number.isFinite(requestedAccountCount)||requestedAccountCount<=0)return json(res,400,{error:'requestedAccountCount must be a positive number.'});

    const band=bandForAccountCount(requestedAccountCount);
    if(band.key==='free')return json(res,400,{error:'This account count is covered by the Free plan -- no checkout required. Sign up for free instead.'});
    if(band.contactSales)return json(res,400,{error:'This account count requires an Enterprise plan. Contact sales instead of checkout.'});

    let org=await loadOrg(user.organization_id);
    if(!org)return json(res,404,{error:'Organization not found.'});

    const base=appBaseUrl(req);

    // Production incident (founder QA): an org whose subscription_status is
    // already active/paid/manual clicking Subscribe (same tier or a
    // different one) used to fall straight through to creating ANOTHER
    // Checkout Session against its existing Stripe customer -- Stripe does
    // not itself prevent a customer from ending up with two simultaneous
    // subscriptions, so this could silently create a second, parallel one.
    // entitlement().paidActive is the SAME authoritative check
    // api/lib/entitlement.js uses everywhere else -- a real Stripe
    // Checkout is never offered again once an org is genuinely paid; a
    // paid org changes tier or cancels through Stripe's own Billing Portal
    // instead, which handles proration/upgrade/downgrade correctly rather
    // than this app reimplementing that logic by hand.
    if(entitlement(org).paidActive){
      const existingSubscriptionId=clean(org.stripe_subscription_id);
      const existingCustomerId=clean(org.stripe_customer_id);
      if(existingSubscriptionId&&existingCustomerId){
        const subCheck=await stripeGet(`subscriptions/${encodeURIComponent(existingSubscriptionId)}`);
        if(subCheck.ok&&['active','trialing','past_due'].includes(subCheck.data.status)){
          const portal=await stripeFetch('billing_portal/sessions',{customer:existingCustomerId,return_url:`${base}/pricing.html`});
          return json(res,200,{ok:true,url:portal.url,portal:true});
        }
      }
      // The org's own record says it is already paying, but the Stripe
      // subscription/customer that would back that up cannot be confirmed
      // (missing, or does not resolve in whatever Stripe environment
      // STRIPE_SECRET_KEY currently points at -- e.g. a test-mode id left
      // over from before switching to live-mode keys, or a manually
      // granted plan with no real Stripe object at all). Never silently
      // create a fresh Stripe customer/subscription here -- that is exactly
      // the "accidentally create a second parallel subscription" case this
      // guard exists to prevent. A clean, actionable message instead of a
      // raw Stripe error string; resolving it is an operator action
      // (reconcile or clear this org's stored Stripe fields once the real
      // state is confirmed in the Stripe dashboard).
      console.error('[create-checkout-session] paid org has no verifiable Stripe subscription -- refusing to start a new checkout',{organizationId:user.organization_id,stripeCustomerId:existingCustomerId||null,stripeSubscriptionId:existingSubscriptionId||null});
      return json(res,409,{error:'Your account already shows an active subscription, but we could not verify it with our billing provider right now. Please contact support so we can fix your billing record before making any changes.'});
    }

    // Only reached for an org that is NOT already paid -- the price id is
    // irrelevant to the Billing Portal path above (a portal session takes
    // no price at all), so this check is deliberately AFTER that branch,
    // not before it.
    const priceId=stripePriceIdForBand(band.key);
    if(!priceId)return json(res,500,{error:`Stripe is not configured for the ${band.label} band yet.`});

    let stripeCustomerId=clean(org.stripe_customer_id);
    if(stripeCustomerId){
      // Stale/deleted/wrong-environment customer id -- safe to replace
      // outright here: the org is NOT currently paid (the branch above
      // already handled that case), so there is no existing paid
      // relationship a fresh customer could collide with.
      const customerCheck=await stripeGet(`customers/${encodeURIComponent(stripeCustomerId)}`);
      if(!customerCheck.ok||customerCheck.data?.deleted)stripeCustomerId='';
    }
    if(!stripeCustomerId){
      const customer=await stripeFetch('customers',{email:clean(user.email),name:clean(org.name),metadata:{organization_id:user.organization_id}});
      stripeCustomerId=customer.id;
      await sb(`ha_organizations?id=eq.${encodeURIComponent(user.organization_id)}`,{method:'PATCH',body:JSON.stringify({stripe_customer_id:stripeCustomerId,updated_at:new Date().toISOString()})});
    }

    const session=await stripeFetch('checkout/sessions',{
      mode:'subscription',
      customer:stripeCustomerId,
      line_items:[{price:priceId,quantity:1}],
      success_url:`${base}/dashboard?checkout=success`,
      cancel_url:`${base}/pricing.html?checkout=cancelled`,
      metadata:{organization_id:user.organization_id,band_key:band.key},
      subscription_data:{metadata:{organization_id:user.organization_id,band_key:band.key}}
    });

    return json(res,200,{ok:true,url:session.url,band:{key:band.key,label:band.label,maxAccounts:band.maxAccounts,priceCents:band.priceCents}});
  }catch(err){
    console.error('[create-checkout-session]',err);
    return json(res,err.status||500,{error:err.message||'Could not start checkout.'});
  }
}
