// POST /api/stripe-webhook
// Minimal Stripe subscription lifecycle synchronization. Handles exactly
// three event types -- checkout.session.completed (establishes a new paid
// subscription), customer.subscription.updated (price/status changes made
// on Stripe's side), and customer.subscription.deleted (cancellation) --
// so that ha_organizations.subscription_status/stripe_price_id/
// account_capacity never survive stale against what Stripe actually
// thinks is true. No dunning, no retries, no invoice handling, no
// automatic band-crossing upgrades -- source-of-truth sync only.
//
// Verifies the Stripe-Signature header manually (HMAC-SHA256 over
// "<timestamp>.<raw body>") rather than adding the stripe npm SDK, same
// convention as api/create-checkout-session.js. This requires the RAW
// request body, so Vercel's automatic JSON body parsing is disabled below.
import { createHmac, timingSafeEqual } from 'crypto';
import { bandByKey, bandForStripePriceId, stripePriceIdForBand } from '../pricing-bands.js';

export const config = { api: { bodyParser: false } };

function json(res,status,body){res.setHeader('Cache-Control','no-store, max-age=0');return res.status(status).json(body)}
function env(){const rawUrl=process.env.SUPABASE_URL;const key=process.env.SUPABASE_SERVICE_ROLE_KEY;if(!rawUrl||!key)throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');const url=String(rawUrl).trim().replace(/\/+$/,'').replace(/\/rest\/v1$/i,'');return{url,key}}
async function sb(path, options={}){const{url,key}=env();const resp=await fetch(`${url}/rest/v1/${path}`,{...options,headers:{apikey:key,Authorization:`Bearer ${key}`,'Content-Type':'application/json',Prefer:options.prefer||'return=representation',...(options.headers||{})}});const text=await resp.text();let data=null;if(text){try{data=JSON.parse(text)}catch{data=text}}if(!resp.ok){const msg=typeof data==='string'?data:(data?.message||data?.hint||JSON.stringify(data));throw new Error(`Supabase ${resp.status}: ${msg}`)}return data}

function readRawBody(req){
  return new Promise((resolve,reject)=>{
    const chunks=[];
    req.on('data',c=>chunks.push(c));
    req.on('end',()=>resolve(Buffer.concat(chunks)));
    req.on('error',reject);
  });
}

// Stripe-Signature: "t=<unix ts>,v1=<hex hmac>[,v1=<hex hmac>...]".
// Signed payload is "<ts>.<raw body>", HMAC-SHA256 with the webhook
// signing secret, compared with a constant-time comparison. A 5-minute
// timestamp tolerance guards against replay of a captured payload.
export function verifyStripeSignature(rawBody, signatureHeader, secret, toleranceSeconds=300, nowMs=Date.now()){
  if(!signatureHeader||!secret)return false;
  const parts={v1:[]};
  for(const kv of String(signatureHeader).split(',')){
    const idx=kv.indexOf('=');
    if(idx<0)continue;
    const k=kv.slice(0,idx).trim(), v=kv.slice(idx+1).trim();
    if(k==='t')parts.t=v;
    else if(k==='v1')parts.v1.push(v);
  }
  if(!parts.t||!parts.v1.length)return false;
  if(Math.abs(nowMs/1000-Number(parts.t))>toleranceSeconds)return false;
  const signedPayload=`${parts.t}.${Buffer.isBuffer(rawBody)?rawBody.toString('utf8'):String(rawBody)}`;
  const expected=createHmac('sha256',secret).update(signedPayload).digest('hex');
  const expectedBuf=Buffer.from(expected,'hex');
  return parts.v1.some(sig=>{
    try{const sigBuf=Buffer.from(sig,'hex');return sigBuf.length===expectedBuf.length&&timingSafeEqual(sigBuf,expectedBuf)}
    catch{return false}
  });
}

async function orgByStripeCustomerId(customerId){
  if(!customerId)return null;
  const data=await sb(`ha_organizations?stripe_customer_id=eq.${encodeURIComponent(customerId)}&select=*&limit=1`);
  return Array.isArray(data)?data[0]:null;
}
async function patchOrg(id,patch){
  await sb(`ha_organizations?id=eq.${encodeURIComponent(id)}`,{method:'PATCH',body:JSON.stringify({...patch,updated_at:new Date().toISOString()})});
}

async function handleCheckoutSessionCompleted(session){
  const organizationId=session.metadata?.organization_id;
  const bandKey=session.metadata?.band_key;
  const band=bandByKey(bandKey);
  if(!organizationId||!band){console.warn('[stripe-webhook] checkout.session.completed missing organization_id/band_key metadata',{sessionId:session.id});return}
  await patchOrg(organizationId,{
    stripe_customer_id:session.customer,
    stripe_subscription_id:session.subscription,
    stripe_price_id:stripePriceIdForBand(band.key)||null,
    subscription_status:'active',
    plan:'paid',
    account_capacity:band.maxAccounts
  });
}

async function handleSubscriptionUpdated(subscription){
  const org=await orgByStripeCustomerId(subscription.customer);
  if(!org){console.warn('[stripe-webhook] customer.subscription.updated: no organization found for customer',{customer:subscription.customer});return}
  const priceId=subscription.items?.data?.[0]?.price?.id||null;
  const band=priceId?bandForStripePriceId(priceId):null;
  const patch={subscription_status:String(subscription.status||'active'),stripe_subscription_id:subscription.id};
  if(band){patch.stripe_price_id=priceId;patch.account_capacity=band.maxAccounts;patch.plan='paid'}
  await patchOrg(org.id,patch);
}

async function handleSubscriptionDeleted(subscription){
  const org=await orgByStripeCustomerId(subscription.customer);
  if(!org){console.warn('[stripe-webhook] customer.subscription.deleted: no organization found for customer',{customer:subscription.customer});return}
  // Deliberately does not touch account_capacity or plan -- the unified
  // entitlement logic (api/lib/entitlement.js) only reads account_capacity
  // when subscription_status is active/paid/manual, so flipping the
  // status alone is sufficient for entitlement to fall back to Free (or
  // to an independently active Beta trial, if one still applies) on its
  // very next read. account_capacity is left as a historical record of
  // what was last purchased.
  await patchOrg(org.id,{subscription_status:'canceled'});
}

export default async function handler(req,res){
  try{
    if(req.method!=='POST')return json(res,405,{error:'Method not allowed'});
    const secret=process.env.STRIPE_WEBHOOK_SECRET;
    if(!secret)return json(res,503,{error:'Stripe webhook is not configured.'});
    const rawBody=await readRawBody(req);
    const signature=req.headers['stripe-signature'];
    if(!verifyStripeSignature(rawBody,signature,secret))return json(res,400,{error:'Invalid Stripe signature.'});

    let event;
    try{event=JSON.parse(rawBody.toString('utf8'))}catch{return json(res,400,{error:'Invalid JSON payload.'})}

    switch(event.type){
      case 'checkout.session.completed':
        await handleCheckoutSessionCompleted(event.data.object);
        break;
      case 'customer.subscription.updated':
        await handleSubscriptionUpdated(event.data.object);
        break;
      case 'customer.subscription.deleted':
        await handleSubscriptionDeleted(event.data.object);
        break;
      default:
        break; // acknowledged, no action -- we only understand these three
    }
    return json(res,200,{received:true});
  }catch(err){
    console.error('[stripe-webhook]',err);
    return json(res,500,{error:err.message||'Webhook handling failed'});
  }
}
