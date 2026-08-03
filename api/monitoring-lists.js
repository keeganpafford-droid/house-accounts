function json(res,status,body){res.setHeader('Cache-Control','no-store, max-age=0');return res.status(status).json(body)}
function clean(v=''){return String(v||'').trim()}
function lower(v=''){return clean(v).toLowerCase()}
function env(){const raw=process.env.SUPABASE_URL,key=process.env.SUPABASE_SERVICE_ROLE_KEY;if(!raw||!key)throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');return{url:String(raw).trim().replace(/\/+$/,'').replace(/\/rest\/v1$/i,''),key}}
async function sb(path,opt={}){const{url,key}=env();const r=await fetch(`${url}/rest/v1/${path}`,{...opt,headers:{apikey:key,Authorization:`Bearer ${key}`,'Content-Type':'application/json',Prefer:opt.prefer||'return=representation',...(opt.headers||{})}});const t=await r.text();let d=null;if(t){try{d=JSON.parse(t)}catch{d=t}}if(!r.ok){const err=new Error(`Supabase ${r.status}: ${typeof d==='string'?d:(d?.message||d?.hint||JSON.stringify(d))}`);err.status=r.status;
  // Postgres sqlstate (e.g. '42501', 'HA004', '55P03'), when the response
  // body is a PostgREST-shaped RPC error -- lets callers branch on the
  // actual database error code, same pattern as api/save-upload.js's
  // supabase() helper. Previously absent here, which silently broke any
  // err.code-based branching a caller might add around an sb() RPC call.
  err.code=(d&&typeof d==='object')?d.code:undefined;throw err}return d}
async function authUser(req){const token=String(req.headers.authorization||'').replace(/^Bearer\s+/i,'');if(!token)return null;const{url,key}=env();const r=await fetch(`${url}/auth/v1/user`,{headers:{apikey:key,Authorization:`Bearer ${token}`}});if(!r.ok)return null;return r.json()}
async function context(req){const au=await authUser(req);if(!au?.id)return null;let rows=await sb(`ha_users?auth_user_id=eq.${encodeURIComponent(au.id)}&select=*&limit=1`);let user=Array.isArray(rows)?rows[0]:null;if(!user&&au.email){rows=await sb(`ha_users?email=eq.${encodeURIComponent(lower(au.email))}&select=*&limit=1`);user=Array.isArray(rows)?rows[0]:null}if(!user)return null;const role=lower(user.app_role||user.role||'member');const canViewTeam=role==='owner'||role==='admin';let visibleUsers=[user];if(canViewTeam&&user.organization_id){const users=await sb(`ha_users?organization_id=eq.${encodeURIComponent(user.organization_id)}&select=id,email,status,app_role,role`);visibleUsers=(Array.isArray(users)?users:[]).filter(x=>lower(x.status||'active')!=='inactive')}return{user,role,canViewTeam,userIds:visibleUsers.map(x=>x.id).filter(Boolean),emails:visibleUsers.map(x=>lower(x.email)).filter(Boolean)}}
function inFilter(vals){return `in.(${vals.map(v=>`\"${String(v).replace(/\"/g,'')}\"`).join(',')})`}
function isPaused(v){return ['paused','archived'].includes(lower(v))}
// Read-only, no-migration server-state signal for the Manage Customer
// Accounts modal's run-state reattachment: the LATEST ha_research_runs row
// for this upload (if any), collapsed to exactly the three states the UI
// needs. This is a plain SELECT against an existing table (no RPC, no
// schema change) -- it never claims, heartbeats, or mutates anything, so
// calling it on every modal open/poll is side-effect-free and cannot
// start, attach to, or interfere with a real claim_ha_research_run() call.
//   'active' -- status='running' AND the lease has not yet expired (the
//               SAME condition claim_ha_research_run()'s own exact-row
//               branch uses to decide attached-active vs reclaimable).
//   'failed' -- the most recent run for this upload ended in failure.
//   'idle'   -- no runs yet, the most recent one completed, or a
//               'running' row exists but its lease has already expired
//               (abandoned/reclaimable -- not meaningfully "active" from
//               the UI's point of view; a new claim would reclaim it).
function summarizeResearchRunState(row){
  if(!row) return {status:'idle', researchRunId:null, attemptId:null, startedAt:null, errorMessage:null};
  const leaseActive = row.status === 'running' && row.lease_expires_at && new Date(row.lease_expires_at).getTime() > Date.now();
  if(leaseActive) return {status:'active', researchRunId:row.research_run_id, attemptId:row.attempt_id, startedAt:row.started_at||null, errorMessage:null};
  if(row.status === 'failed') return {status:'failed', researchRunId:row.research_run_id, attemptId:row.attempt_id, startedAt:row.started_at||null, errorMessage:row.error_message||null};
  return {status:'idle', researchRunId:null, attemptId:null, startedAt:null, errorMessage:null};
}
async function loadLists(ctx){const ids=ctx.userIds.length?inFilter(ctx.userIds):'eq.__none__';const emails=ctx.emails.length?inFilter(ctx.emails):'eq.__none__';const [cu,pu]=await Promise.all([
 sb(`ha_uploads?user_id=${ids}&select=*&order=updated_at.desc&limit=200`),
 sb(`ha_prospect_uploads?user_email=${emails}&select=*&order=created_at.desc&limit=200`)
]);const customer=[];for(const u of (cu||[])){const [ac,sg,rr]=await Promise.all([sb(`ha_accounts?upload_id=eq.${encodeURIComponent(u.id)}&select=id,upload_id,account_name,industry,raw_data,created_at,updated_at&order=account_name.asc&limit=5000`),sb(`ha_signals?upload_id=eq.${encodeURIComponent(u.id)}&select=id,first_seen_at&order=first_seen_at.desc&limit=1`),sb(`ha_research_runs?upload_id=eq.${encodeURIComponent(u.id)}&select=research_run_id,attempt_id,status,lease_expires_at,started_at,error_message&order=started_at.desc&limit=1`)]);customer.push({id:u.id,type:'customer',name:u.upload_name||'Customer List',status:isPaused(u.stage)?'paused':'active',companyCount:(ac||[]).length,lastUpload:u.updated_at||u.created_at||'',lastScan:(sg||[])[0]?.first_seen_at||'',signalCount:(sg||[]).length,researchRunState:summarizeResearchRunState((rr||[])[0]),accounts:(ac||[]).map(a=>({id:a.id,uploadId:a.upload_id,name:a.account_name,industry:a.industry||'',monitoringStatus:lower(a.raw_data?.monitoring_status||'active'),researchStatus:lower(a.raw_data?.research_status||'uploaded'),lastResearchedAt:a.raw_data?.last_researched_at||'',domain:a.raw_data?.website||'',dateAdded:a.created_at||'',hasActionableAlert:false}))})}
 const prospect=[];for(const u of (pu||[])){const [ac,sg]=await Promise.all([sb(`ha_prospect_accounts?upload_id=eq.${encodeURIComponent(u.id)}&select=id,company_name,last_scanned_at,status&limit=5000`),sb(`ha_prospect_signals?upload_id=eq.${encodeURIComponent(u.id)}&select=id,created_at&order=created_at.desc&limit=5000`)]);const latest=(ac||[]).map(a=>a.last_scanned_at).filter(Boolean).sort().reverse()[0]||'';prospect.push({id:u.id,type:'prospect',name:u.filename||'Prospect List',status:isPaused(u.status)?'paused':'active',companyCount:(ac||[]).length,lastUpload:u.created_at||'',lastScan:latest,signalCount:(sg||[]).length,newSignalsThisWeek:(sg||[]).filter(s=>Date.now()-new Date(s.created_at||0).getTime()<=7*86400000).length})}
 return{customer,prospect}}
async function patchList(type,id,action,name){if(type==='customer'){const payload=action==='rename'?{upload_name:clean(name),updated_at:new Date().toISOString()}:{stage:action==='pause'?'paused':'uploaded',updated_at:new Date().toISOString()};return sb(`ha_uploads?id=eq.${encodeURIComponent(id)}`,{method:'PATCH',body:JSON.stringify(payload)})}const payload=action==='rename'?{filename:clean(name)}:{status:action==='pause'?'paused':'active'};await sb(`ha_prospect_uploads?id=eq.${encodeURIComponent(id)}`,{method:'PATCH',body:JSON.stringify(payload)});await sb(`ha_prospect_accounts?upload_id=eq.${encodeURIComponent(id)}`,{method:'PATCH',body:JSON.stringify({status:action==='pause'?'paused':'active'})});}

async function patchCustomerAccount(ctx,id,action){
  const owned = await sb(`ha_accounts?id=eq.${encodeURIComponent(id)}&user_id=${inFilter(ctx.userIds)}&select=id,user_id,upload_id,account_name,raw_data&limit=1`);
  const account = Array.isArray(owned) ? owned[0] : null;
  if(!account) throw new Error('Customer account not found or not accessible');
  const raw = account.raw_data || {};
  if(action === 'pause-account' || action === 'resume-account'){
    const next = {...raw, monitoring_status: action === 'pause-account' ? 'paused' : 'active', updated_by_account_management:true};
    return sb(`ha_accounts?id=eq.${encodeURIComponent(id)}`,{method:'PATCH',body:JSON.stringify({raw_data:next,updated_at:new Date().toISOString()})});
  }
  if(action === 'delete-account'){
    return deleteCustomerAccountViaSnapshot(account);
  }
  throw new Error('Invalid account action');
}

// Release blocker fix (post-Phase-2A review): account-level delete used to
// issue a direct DELETE against ha_accounts (plus a best-effort ha_signals
// DELETE), bypassing replace_ha_accounts_snapshot()'s migration-7
// accounts_maintenance identity lock entirely -- an account could be
// removed here even with research history present, exactly the HA004
// invariant the RPC exists to enforce. This routes account deletion through
// that same RPC (p_mode='accounts_maintenance') so the identity lock and
// active-run guard apply here exactly as they do to every other
// account-maintenance write; the backend enforces this, not just the UI.
//
// replace_ha_accounts_snapshot() is a FULL snapshot replace, so a deletion
// is expressed as "submit every other account on this upload, omit the one
// being deleted." Identity is the account_name SET, not full-row equality
// (see migration 7), so including every sibling account's real
// industry/contact/metrics/raw_data here is safe and does not itself count
// as a rename. Signals for the removed account are only deleted AFTER the
// RPC call has actually committed the removal -- a rejected call (HA004,
// 55P03, ownership) never reaches that line, so signals for a still-present
// account are never touched.
async function deleteCustomerAccountViaSnapshot(account){
  const siblings = await sb(`ha_accounts?upload_id=eq.${encodeURIComponent(account.upload_id)}&select=account_name,industry,contact_name,contact_email,metrics,raw_data&limit=5000`);
  const targetName = clean(account.account_name || '');
  const remaining = (Array.isArray(siblings) ? siblings : [])
    .filter(a => clean(a.account_name) !== targetName)
    .map(a => ({
      account_name: clean(a.account_name),
      industry: clean(a.industry),
      contact_name: clean(a.contact_name),
      contact_email: clean(a.contact_email).toLowerCase(),
      metrics: a.metrics || {},
      raw_data: a.raw_data || {}
    }));
  try{
    await sb('rpc/replace_ha_accounts_snapshot', {
      method:'POST',
      prefer:'return=representation',
      body: JSON.stringify({ p_upload_id: account.upload_id, p_user_id: account.user_id, p_accounts: remaining, p_mode: 'accounts_maintenance' })
    });
  }catch(err){
    if(err.code === 'HA004'){
      const e = new Error('This account cannot be deleted because research history exists for its upload; only contact, industry, metrics, and raw-data edits are permitted for existing account names.');
      e.status = 400; e.identityLocked = true; throw e;
    }
    if(err.code === '55P03'){
      const e = new Error('A research run is currently active for this upload; cannot delete an account while research is in progress.');
      e.status = 409; throw e;
    }
    if(err.code === '42501'){
      const e = new Error('You do not have access to this upload.');
      e.status = 403; throw e;
    }
    throw err;
  }
  // Release blocker fix: scoped by upload_id AND user_id AND account_name.
  // ha_signals' uniqueness is (user_id, event_fingerprint), NOT scoped by
  // upload_id -- the same user can genuinely have two different uploads
  // that each contain an account named e.g. "Acme Co". Filtering by
  // user_id + account_name alone (the original shape here) would delete
  // Acme Co's signals on EVERY upload that user owns, not just the one the
  // deleted account actually belonged to.
  await sb(`ha_signals?upload_id=eq.${encodeURIComponent(account.upload_id)}&user_id=eq.${encodeURIComponent(account.user_id)}&account_name=eq.${encodeURIComponent(targetName)}`,{method:'DELETE',prefer:'return=minimal'}).catch(()=>{});
}

async function deleteList(type,id){if(type==='customer'){await sb(`ha_signals?upload_id=eq.${encodeURIComponent(id)}`,{method:'DELETE',prefer:'return=minimal'});await sb(`ha_accounts?upload_id=eq.${encodeURIComponent(id)}`,{method:'DELETE',prefer:'return=minimal'});await sb(`ha_uploads?id=eq.${encodeURIComponent(id)}`,{method:'DELETE',prefer:'return=minimal'});return}await sb(`ha_prospect_signals?upload_id=eq.${encodeURIComponent(id)}`,{method:'DELETE',prefer:'return=minimal'});await sb(`ha_prospect_accounts?upload_id=eq.${encodeURIComponent(id)}`,{method:'DELETE',prefer:'return=minimal'});await sb(`ha_prospect_uploads?id=eq.${encodeURIComponent(id)}`,{method:'DELETE',prefer:'return=minimal'})}
export default async function handler(req,res){try{const ctx=await context(req);if(!ctx)return json(res,401,{error:'Authentication required'});if(req.method==='GET'){const lists=await loadLists(ctx);const activeCustomers=lists.customer.filter(x=>x.status==='active').reduce((n,x)=>n+x.companyCount,0),pausedCustomers=lists.customer.filter(x=>x.status==='paused').reduce((n,x)=>n+x.companyCount,0),activeProspects=lists.prospect.filter(x=>x.status==='active').reduce((n,x)=>n+x.companyCount,0),pausedProspects=lists.prospect.filter(x=>x.status==='paused').reduce((n,x)=>n+x.companyCount,0);return json(res,200,{ok:true,scope:ctx.canViewTeam?'organization':'user',role:ctx.role,lists,summary:{activeCustomers,pausedCustomers,activeProspects,pausedProspects,nextWeeklyScan:'Monday',monitoringStatus:(activeCustomers+activeProspects)>0?'Active':'No active lists'}})}if(req.method==='PATCH'){const{type,id,action,name}=req.body||{};if(type==='account'&&id&&['pause-account','resume-account','delete-account'].includes(action)){await patchCustomerAccount(ctx,id,action);return json(res,200,{ok:true})}if(!['customer','prospect'].includes(type)||!id||!['rename','pause','resume'].includes(action))return json(res,400,{error:'Invalid list update'});if(action==='rename'&&!clean(name))return json(res,400,{error:'List name is required'});await patchList(type,id,action,name);return json(res,200,{ok:true})}if(req.method==='DELETE'){const{type,id}=req.body||{};if(!['customer','prospect'].includes(type)||!id)return json(res,400,{error:'Invalid list delete'});await deleteList(type,id);return json(res,200,{ok:true})}return json(res,405,{error:'Method not allowed'})}catch(e){console.error('[Monitoring Lists]',e);return json(res,e.status||500,{error:e.message||'Monitoring list request failed',...(e.identityLocked?{identityLocked:true}:{})})}}
