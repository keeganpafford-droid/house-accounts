import { entitlement, usageFor as sharedUsageFor } from './lib/entitlement.js';

function json(res,status,body){res.setHeader('Cache-Control','no-store, max-age=0');return res.status(status).json(body)}
function clean(v=''){return String(v||'').trim()}
function env(){const rawUrl=process.env.SUPABASE_URL;const key=process.env.SUPABASE_SERVICE_ROLE_KEY;if(!rawUrl||!key)throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');const url=String(rawUrl).trim().replace(/\/+$/,'').replace(/\/rest\/v1$/i,'');return{url,key}}
async function sb(path, options={}){const{url,key}=env();const resp=await fetch(`${url}/rest/v1/${path}`,{...options,headers:{apikey:key,Authorization:`Bearer ${key}`,'Content-Type':'application/json',Prefer:options.prefer||'return=representation',...(options.headers||{})}});const text=await resp.text();let data=null;if(text){try{data=JSON.parse(text)}catch{data=text}}if(!resp.ok){const msg=typeof data==='string'?data:(data?.message||data?.hint||JSON.stringify(data));throw new Error(`Supabase ${resp.status}: ${msg}`)}return {data,headers:resp.headers}}
// Thin adapter so api/lib/entitlement.js's shared usageFor() (written
// against a plain sb(path)=>data contract) can reuse this file's own
// {data,headers}-returning sb() unchanged.
async function sbData(path, options={}){return (await sb(path, options)).data}
async function authUser(req){const token=(req.headers.authorization||'').replace(/^Bearer\s+/i,'');if(!token)return null;const{url,key}=env();const resp=await fetch(`${url}/auth/v1/user`,{headers:{apikey:key,Authorization:`Bearer ${token}`}});if(!resp.ok)return null;return resp.json()}
async function haUser(req){const au=await authUser(req);if(!au?.id)return null;const {data}=await sb(`ha_users?auth_user_id=eq.${encodeURIComponent(au.id)}&select=*&limit=1`);return Array.isArray(data)?data[0]:null}
async function loadOrg(user){if(!user?.organization_id)return null;const {data}=await sb(`ha_organizations?id=eq.${encodeURIComponent(user.organization_id)}&select=*&limit=1`);return Array.isArray(data)?data[0]:null}
// Phase 2A / A1, narrowed 2026-08-13: the only plan value a client is
// allowed to request through this public endpoint is 'free'. 'solo' and
// 'team' were removed from this allowlist because we no longer grant new
// 30-day paid-capacity trials -- paid capacity is purchased through
// Stripe Checkout (api/create-checkout-session.js) instead. This endpoint
// now only serves self-service downgrade-to-free; planConfig()/
// planPatch() below still know how to build solo/team/enterprise patches
// (kept for any future internal/admin-only caller, e.g. the manual beta
// billing process in BETA_OPERATIONS.md), but this allowlist is the
// actual gate: a request for anything outside this list is rejected
// before planPatch() is ever called. See settings.audit log for every
// accepted and rejected attempt.
const CLIENT_REQUESTABLE_PLANS = ['free'];
function auditLog(entry){
  try{ console.log('[settings.audit]', JSON.stringify({ ts:new Date().toISOString(), ...entry })); }
  catch{ console.log('[settings.audit] (unserializable entry)'); }
}
// planConfig()/orgDefaults() still assign the legacy seat_limit value on
// plan changes for historical-data consistency, but seat_limit is no
// longer read as a gate anywhere (see api/team.js) -- every organization
// has unlimited seats regardless of plan.
function planConfig(planRaw){const plan=clean(planRaw||'free').toLowerCase();if(plan==='solo')return{plan:'solo',seat_limit:1};if(plan==='team')return{plan:'team',seat_limit:25};if(plan==='enterprise')return{plan:'enterprise',seat_limit:null};return{plan:'free',seat_limit:1}}
async function usageFor(user, org=null){return sharedUsageFor(sbData, user, org)}
function planPatch(planRaw, org={}){const cfg=planConfig(planRaw);const now=new Date();const patch={plan:cfg.plan,seat_limit:cfg.seat_limit,updated_at:now.toISOString()};const ent=entitlement(org);if(cfg.plan==='free'){Object.assign(patch,{trial_status:'inactive',subscription_status:'inactive',trial_end:null,seat_limit:1});return patch;}if(cfg.plan==='solo'||cfg.plan==='team'){if(ent.trialActive){Object.assign(patch,{trial_status:'active',subscription_status:'trialing'});return patch;}if(!ent.trialUsed){const started=now.toISOString();const end=new Date(now.getTime()+30*86400000).toISOString();Object.assign(patch,{trial_status:'active',subscription_status:'trialing',trial_started_at:started,trial_end:end,trial_used:true});return patch;}const err=new Error('Your 30-day trial has already been used. Upgrade will be available soon.');err.status=403;throw err;}if(cfg.plan==='enterprise'){Object.assign(patch,{trial_status:'inactive',subscription_status:'manual',trial_end:null});return patch;}return patch}
export default async function handler(req,res){try{const user=await haUser(req);if(!user)return json(res,401,{error:'Not authenticated'});if(req.method==='GET'){const org=await loadOrg(user);const usage=await usageFor(user, org);return json(res,200,{user,organization:org,usage,entitlement:usage})}if(req.method==='POST'){const action=clean(req.body?.action||'');if(action!=='update-plan')return json(res,400,{error:'Unknown settings action.'});if(!user.organization_id)return json(res,400,{error:'User is not linked to an organization.'});
    const requestedPlan=clean(req.body?.plan||'').toLowerCase();
    const currentOrg=await loadOrg(user);
    const actorRole=clean(user.app_role||'').toLowerCase();
    if(actorRole!=='owner'){
      auditLog({event:'update-plan.rejected',reason:'not-owner',actorUserId:user.id,actorEmail:user.email,actorRole:actorRole||'(none)',organizationId:user.organization_id,requestedPlan,previousPlan:currentOrg?.plan||null});
      return json(res,403,{error:'Only an organization owner can change the plan.'});
    }
    if(!CLIENT_REQUESTABLE_PLANS.includes(requestedPlan)){
      auditLog({event:'update-plan.rejected',reason:'plan-not-allowlisted',actorUserId:user.id,actorEmail:user.email,actorRole,organizationId:user.organization_id,requestedPlan:requestedPlan||'(empty)',previousPlan:currentOrg?.plan||null});
      return json(res,400,{error:`Unknown plan requested. Allowed values: ${CLIENT_REQUESTABLE_PLANS.join(', ')}.`});
    }
    const previousState={plan:currentOrg?.plan||null,subscription_status:currentOrg?.subscription_status||null,trial_status:currentOrg?.trial_status||null};
    const patch=planPatch(requestedPlan,currentOrg||{});const {data}=await sb(`ha_organizations?id=eq.${encodeURIComponent(user.organization_id)}`,{method:'PATCH',body:JSON.stringify(patch)});const org=Array.isArray(data)?data[0]:data;
    auditLog({event:'update-plan.applied',mechanism:'self-service',actorUserId:user.id,actorEmail:user.email,actorRole,organizationId:user.organization_id,requestedPlan,previousState,resultingState:{plan:org?.plan||null,subscription_status:org?.subscription_status||null,trial_status:org?.trial_status||null}});
    const usage=await usageFor(user, org);return json(res,200,{ok:true,organization:org,usage,entitlement:usage})}return json(res,405,{error:'Method not allowed'})}catch(err){return json(res,err.status||500,{error:err.message||'Settings failed'})}}

export { CLIENT_REQUESTABLE_PLANS, planConfig, planPatch, entitlement, auditLog };
