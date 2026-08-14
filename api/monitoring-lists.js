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
  err.code=(d&&typeof d==='object')?d.code:undefined;
  // ROUND 13 fix: marks this as a RAW, unclassified upstream status -- see
  // the handler's top-level catch below. err.status here is whatever HTTP
  // status Supabase/PostgREST itself returned (which CAN be 404 -- e.g. a
  // table/view PostgREST's schema cache doesn't recognize, or a malformed
  // RPC signature -- among other possibilities). Passing that raw status
  // straight through to the client would be indistinguishable, in the
  // Network tab, from a genuinely missing Vercel serverless function. Any
  // caller that wants to deliberately map a specific upstream failure (see
  // deleteCustomerAccountViaSnapshot()'s HA004/55P03/42501 handling below)
  // does so by throwing a FRESH, unmarked Error -- only errors that reach
  // the top-level catch still carrying this flag get the safe default.
  err.fromSupabase=true;
  throw err}return d}
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
// ROUND 13 fix: previously issued one ha_research_runs query PER customer
// upload, inside the same per-upload Promise.all as ha_accounts/ha_signals
// -- for N uploaded lists that is N research-run queries on every single
// GET, and this endpoint is now polled repeatedly (bounded, but still
// repeatedly) while the Manage Customer Accounts modal has an active run.
// Batched here into exactly ONE upload_id=in.(...) query covering every
// customer upload this ctx can see, run ONCE before the per-upload loop --
// so the research-run query count is O(1) per GET regardless of how many
// lists the caller has, not O(N). Ownership stays scoped: the id list fed
// into upload_id=in.(...) is itself already the ctx-filtered `cu` result
// (ha_uploads?user_id=${ids}...), and user_id=${ids} is repeated on this
// query as defense in depth. Ordered upload_id then started_at DESC so the
// first row seen per upload_id below is that upload's own latest run.
async function loadResearchRunsByUpload(uploadIds, ids){
  const map = new Map();
  if(!uploadIds.length) return map;
  const rows = await sb(`ha_research_runs?upload_id=${inFilter(uploadIds)}&user_id=${ids}&select=upload_id,research_run_id,attempt_id,status,lease_expires_at,started_at,error_message&order=upload_id.asc,started_at.desc`);
  for(const row of (rows||[])){
    if(!map.has(row.upload_id)) map.set(row.upload_id, row);
  }
  return map;
}
// ---------------------------------------------------------------------------
// Scaling round: Manage Customer Accounts pagination. ha_accounts already
// carries a UNIQUE (upload_id, account_name) constraint (see
// ha_accounts_upload_account_name_key in supabase-schema.sql), so
// account_name alone is already a sufficient, deterministic keyset cursor
// within a given upload_id -- no new index or migration is needed. Counts
// use PostgREST's `Prefer: count=exact` (a standard, zero-migration
// feature) instead of ever downloading rows just to count them.
// ---------------------------------------------------------------------------
const ACCOUNTS_PAGE_DEFAULT_LIMIT=50;
const ACCOUNTS_PAGE_MAX_LIMIT=100;

// Same fetch machinery as sb(), but reads the exact result count from the
// Content-Range response header instead of returning a parsed body -- lets
// callers show "Showing 1-50 of 1,000" without ever transferring the rows
// themselves. limit=0 keeps the response body itself empty.
async function sbCount(path){
  const {url,key}=env();
  const sep=path.includes('?')?'&':'?';
  const r=await fetch(`${url}/rest/v1/${path}${sep}limit=0`,{headers:{apikey:key,Authorization:`Bearer ${key}`,'Content-Type':'application/json',Prefer:'count=exact'}});
  if(!r.ok){const t=await r.text().catch(()=>'');const err=new Error(`Supabase ${r.status}: ${t}`);err.status=r.status;err.fromSupabase=true;throw err}
  const range=r.headers.get('content-range')||'';
  const m=range.match(/\/(\d+)$/);
  return m?Number(m[1]):0;
}

// Strips '%'/'_'/'*' from a user-supplied search term before it is ever
// wrapped in an ilike.*...* filter -- '*' is PostgREST's own wildcard
// delimiter and '%'/'_' are raw SQL LIKE wildcards; stripping them (rather
// than attempting ILIKE ESCAPE-clause support PostgREST's simple filter
// syntax doesn't expose) means a search term can never act as a wildcard
// pattern of the caller's own choosing.
function sanitizeSearchTerm(v){return clean(v).replace(/[%_*]/g,'').slice(0,120)}

// Opaque keyset cursor -- literally the last-seen account_name, base64'd so
// it isn't a plain, directly-editable string in the URL.
function encodeCursor(accountName){return Buffer.from(String(accountName),'utf8').toString('base64')}
function decodeCursor(raw){try{return Buffer.from(String(raw),'base64').toString('utf8')||null}catch{return null}}

function accountListRow(a){return{id:a.id,uploadId:a.upload_id,name:a.account_name,industry:a.industry||'',monitoringStatus:lower(a.raw_data?.monitoring_status||'active'),researchStatus:lower(a.raw_data?.research_status||'uploaded'),lastResearchedAt:a.raw_data?.last_researched_at||'',domain:a.raw_data?.website||'',dateAdded:a.created_at||'',hasActionableAlert:false}}

// Confirms the requested upload actually belongs to a user this ctx can see
// -- same ownership-scoping shape as every other id=eq./user_id=in.() check
// in this file -- before a single ha_accounts row is ever queried. Treats a
// forged/foreign upload_id exactly like a non-existent one (404, never a
// distinguishable 403), so a caller learns nothing about whether the id
// belongs to someone else.
async function assertOwnedUpload(ctx,uploadId){
  const rows=await sb(`ha_uploads?id=eq.${encodeURIComponent(uploadId)}&user_id=${inFilter(ctx.userIds)}&select=id&limit=1`);
  if(!Array.isArray(rows)||!rows.length){const e=new Error('Upload not found or not accessible.');e.status=404;throw e}
}

// One bounded, keyset-paginated, optionally-search-scoped page of a single
// upload's accounts -- the ONLY place ha_accounts.raw_data is ever read for
// the Manage Customer Accounts list view, and it never leaves this
// function: accountListRow() extracts just the handful of derived display
// fields (monitoring/research status, last-researched date, domain) that
// otherwise have no dedicated column, and the raw blob itself is discarded
// before the response is built.
async function loadAccountPage(ctx,{uploadId,cursor,search,limit}){
  await assertOwnedUpload(ctx,uploadId);
  const pageSize=Math.min(Math.max(Number.isFinite(limit)?Math.trunc(limit):ACCOUNTS_PAGE_DEFAULT_LIMIT,1),ACCOUNTS_PAGE_MAX_LIMIT);
  const term=sanitizeSearchTerm(search);
  const scopeFilters=[`upload_id=eq.${encodeURIComponent(uploadId)}`];
  if(term)scopeFilters.push(`account_name=ilike.${encodeURIComponent(`*${term}*`)}`);
  const cursorName=cursor?decodeCursor(cursor):null;
  const pageFilters=cursorName?[...scopeFilters,`account_name=gt.${encodeURIComponent(cursorName)}`]:scopeFilters;
  // Over-fetch by one to learn hasMore without a second query -- the extra
  // row (if present) is trimmed below and never rendered. total is always
  // computed against scopeFilters (never pageFilters), so it reflects the
  // whole matching set regardless of which page is being viewed.
  const [rows,total]=await Promise.all([
    sb(`ha_accounts?${pageFilters.join('&')}&select=id,upload_id,account_name,industry,raw_data,created_at&order=account_name.asc&limit=${pageSize+1}`),
    sbCount(`ha_accounts?${scopeFilters.join('&')}`)
  ]);
  const list=Array.isArray(rows)?rows:[];
  const hasMore=list.length>pageSize;
  const page=hasMore?list.slice(0,pageSize):list;
  const nextCursor=hasMore?encodeCursor(page[page.length-1].account_name):null;
  return{accounts:page.map(accountListRow),pageInfo:{limit:pageSize,hasMore,nextCursor,total,search:term}};
}

async function loadLists(ctx){const ids=ctx.userIds.length?inFilter(ctx.userIds):'eq.__none__';const emails=ctx.emails.length?inFilter(ctx.emails):'eq.__none__';const [cu,pu]=await Promise.all([
 sb(`ha_uploads?user_id=${ids}&select=*&order=updated_at.desc&limit=200`),
 sb(`ha_prospect_uploads?user_email=${emails}&select=*&order=created_at.desc&limit=200`)
]);
 const customerUploadIds=(cu||[]).map(u=>u.id).filter(Boolean);
 const researchRunsByUpload=await loadResearchRunsByUpload(customerUploadIds, ids);
 // Scaling round: the modal-open summary never needs a single account row
 // -- only counts, an "ever researched" flag, and the latest-signal marker
 // -- so this is now a small, fixed number of tiny queries per upload
 // (run in parallel ACROSS uploads too) instead of one query per upload
 // that downloaded up to 5000 raw_data-laden rows. activeCount/pausedCount
 // preserve the exact wording the "Research Entire List" confirmation
 // dialog already relies on (client-side, unchanged) without ever fetching
 // the accounts themselves.
 const customer=await Promise.all((cu||[]).map(async u=>{
   const uploadIdFilter=`ha_accounts?upload_id=eq.${encodeURIComponent(u.id)}`;
   const [totalCount,pausedCount,researchedRows,sg]=await Promise.all([
     sbCount(uploadIdFilter),
     sbCount(`${uploadIdFilter}&raw_data->>monitoring_status=eq.paused`),
     // QA correction: a never-researched account can carry raw_data.last_researched_at
     // as an empty string (client saves it as '' rather than omitting the key) --
     // "not.is.null" alone treats '' as present, so also require it be non-empty
     // to avoid flagging every previously-uploaded list as everResearched:true.
     sb(`${uploadIdFilter}&raw_data->>last_researched_at=not.is.null&raw_data->>last_researched_at=neq.&select=id&limit=1`),
     sb(`ha_signals?upload_id=eq.${encodeURIComponent(u.id)}&select=id,first_seen_at&order=first_seen_at.desc&limit=1`)
   ]);
   return{id:u.id,type:'customer',name:u.upload_name||'Customer List',status:isPaused(u.stage)?'paused':'active',companyCount:totalCount,activeCount:Math.max(0,totalCount-pausedCount),pausedCount,everResearched:Array.isArray(researchedRows)&&researchedRows.length>0,lastUpload:u.updated_at||u.created_at||'',lastScan:(sg||[])[0]?.first_seen_at||'',signalCount:(sg||[]).length,researchRunState:summarizeResearchRunState(researchRunsByUpload.get(u.id))};
 }));
 const prospect=[];for(const u of (pu||[])){const [ac,sg]=await Promise.all([sb(`ha_prospect_accounts?upload_id=eq.${encodeURIComponent(u.id)}&select=id,company_name,last_scanned_at,status&limit=5000`),sb(`ha_prospect_signals?upload_id=eq.${encodeURIComponent(u.id)}&select=id,created_at&order=created_at.desc&limit=5000`)]);const latest=(ac||[]).map(a=>a.last_scanned_at).filter(Boolean).sort().reverse()[0]||'';prospect.push({id:u.id,type:'prospect',name:u.filename||'Prospect List',status:isPaused(u.status)?'paused':'active',companyCount:(ac||[]).length,lastUpload:u.created_at||'',lastScan:latest,signalCount:(sg||[]).length,newSignalsThisWeek:(sg||[]).filter(s=>Date.now()-new Date(s.created_at||0).getTime()<=7*86400000).length})}
 return{customer,prospect}}
// P0 security fix (pre-beta blocker hardening): patchList()/deleteList() used
// to act directly on a client-supplied list id with zero ownership check --
// unlike every other mutating path in this file (patchCustomerAccount()'s
// own owned-row lookup, assertOwnedUpload() for account pagination), which
// verify the resource actually belongs to this ctx before doing anything.
// Fixed the same way: resolve-and-verify ownership FIRST, using the
// ownership model each upload TYPE actually persists under -- ha_uploads is
// scoped by user_id (assertOwnedUpload(), already existed above);
// ha_prospect_uploads is scoped by user_email, per loadLists()'s own query
// above (assertOwnedProspectUpload(), new here, same shape). A forged/
// foreign id is treated exactly like a non-existent one (404, never a
// distinguishable 403), so a caller learns nothing about whether the id
// belongs to someone else -- the same contract assertOwnedUpload() already
// established.
async function assertOwnedProspectUpload(ctx,uploadId){
  const rows=await sb(`ha_prospect_uploads?id=eq.${encodeURIComponent(uploadId)}&user_email=${inFilter(ctx.emails)}&select=id&limit=1`);
  if(!Array.isArray(rows)||!rows.length){const e=new Error('List not found or not accessible.');e.status=404;throw e}
}
async function patchList(ctx,type,id,action,name){if(type==='customer'){await assertOwnedUpload(ctx,id);const payload=action==='rename'?{upload_name:clean(name),updated_at:new Date().toISOString()}:{stage:action==='pause'?'paused':'uploaded',updated_at:new Date().toISOString()};return sb(`ha_uploads?id=eq.${encodeURIComponent(id)}`,{method:'PATCH',body:JSON.stringify(payload)})}await assertOwnedProspectUpload(ctx,id);const payload=action==='rename'?{filename:clean(name)}:{status:action==='pause'?'paused':'active'};await sb(`ha_prospect_uploads?id=eq.${encodeURIComponent(id)}`,{method:'PATCH',body:JSON.stringify(payload)});await sb(`ha_prospect_accounts?upload_id=eq.${encodeURIComponent(id)}`,{method:'PATCH',body:JSON.stringify({status:action==='pause'?'paused':'active'})});}

async function patchCustomerAccount(ctx,id,action){
  const owned = await sb(`ha_accounts?id=eq.${encodeURIComponent(id)}&user_id=${inFilter(ctx.userIds)}&select=id,user_id,upload_id,account_name,raw_data&limit=1`);
  const account = Array.isArray(owned) ? owned[0] : null;
  // ROUND 13 fix: these two are deliberately app-decided statuses for a
  // successfully-routed request against a specific resource (this account
  // id) -- a 404 here is a normal, well-understood REST response ("this
  // account id doesn't exist or isn't yours"), categorically different
  // from an unexpected raw upstream failure. Explicitly setting .status
  // (and leaving err.fromSupabase unset, since these are fresh Error
  // objects, not the sb() failure itself) is what lets the top-level catch
  // trust and pass these through instead of normalizing them to 502.
  if(!account){ const e = new Error('Customer account not found or not accessible'); e.status = 404; throw e; }
  const raw = account.raw_data || {};
  if(action === 'pause-account' || action === 'resume-account'){
    const next = {...raw, monitoring_status: action === 'pause-account' ? 'paused' : 'active', updated_by_account_management:true};
    return sb(`ha_accounts?id=eq.${encodeURIComponent(id)}`,{method:'PATCH',body:JSON.stringify({raw_data:next,updated_at:new Date().toISOString()})});
  }
  if(action === 'delete-account'){
    return deleteCustomerAccountViaSnapshot(account);
  }
  { const e = new Error('Invalid account action'); e.status = 400; throw e; }
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

// Organizational Learning V1B, production bug fix: ha_account_opportunities
// is a DURABLE, cross-upload identity (keyed by user_id + fingerprint, not
// by upload_id -- see migration 12's own header comment; upload_id there is
// purely informational, "which upload most recently confirmed this
// instance"). Deleting a customer list's ha_accounts rows does not, by
// itself, mean those opportunities should vanish or stay "active" forever
// -- they should transition to 'inactive' (append-only history preserved,
// same lifecycle model reconcileAccountOpportunities() already uses when
// an account's evidence disappears), UNLESS the same account_name is still
// represented by a DIFFERENT, still-live upload for this same user
// (account names are unique only WITHIN one upload, never globally per
// user -- see loadAccountPage()'s own Round-13 comment above), in which
// case that account's opportunities must be left completely untouched.
// Never destroys the ha_account_opportunities rows themselves (that would
// discard real longitudinal history), and never touches ha_signal_events
// (migration 12's opportunity_id/signal_id FKs already use ON DELETE SET
// NULL there, independent of this).
async function inactivateOrphanedAccountOpportunities(userId,accountNames){
  if(!userId||!accountNames.length)return;
  const stillPresent=await sb(`ha_accounts?user_id=eq.${encodeURIComponent(userId)}&account_name=${inFilter(accountNames)}&select=account_name`);
  const stillPresentNames=new Set((Array.isArray(stillPresent)?stillPresent:[]).map(r=>r.account_name));
  const orphaned=accountNames.filter(n=>!stillPresentNames.has(n));
  if(!orphaned.length)return;
  await sb(`ha_account_opportunities?user_id=eq.${encodeURIComponent(userId)}&account_name=${inFilter(orphaned)}&status=eq.active`,{method:'PATCH',prefer:'return=minimal',body:JSON.stringify({status:'inactive',updated_at:new Date().toISOString()})});
}
// Ownership of the parent list is established BEFORE any child mutation
// begins -- assertOwned{Upload,ProspectUpload}() throws (no DB write of any
// kind attempted yet) if `id` doesn't belong to this ctx, so an unauthorized
// delete request performs zero child mutations and zero parent mutation.
async function deleteList(ctx,type,id){if(type==='customer'){await assertOwnedUpload(ctx,id);
  // Captured BEFORE the deletes below so the accounts this upload actually
  // owned are still known afterward -- see inactivateOrphanedAccountOpportunities()'s
  // own comment for why this matters and how it stays scoped.
  const ownedAccounts=await sb(`ha_accounts?upload_id=eq.${encodeURIComponent(id)}&select=user_id,account_name`);
  await sb(`ha_signals?upload_id=eq.${encodeURIComponent(id)}`,{method:'DELETE',prefer:'return=minimal'});await sb(`ha_accounts?upload_id=eq.${encodeURIComponent(id)}`,{method:'DELETE',prefer:'return=minimal'});await sb(`ha_uploads?id=eq.${encodeURIComponent(id)}`,{method:'DELETE',prefer:'return=minimal'});
  // Best-effort, fire-after-commit cleanup -- never blocks or fails the
  // list delete itself (which has already fully succeeded by this point).
  // A failure here just means the orphaned rows stay 'active' until the
  // next reconciliation pass or a future cleanup retry -- self-healing,
  // same non-critical-side-effect posture api/save-upload.js's own
  // reconciliation hook already uses.
  try{
    const byUser=new Map();
    for(const a of(Array.isArray(ownedAccounts)?ownedAccounts:[])){
      if(!a.user_id||!a.account_name)continue;
      if(!byUser.has(a.user_id))byUser.set(a.user_id,new Set());
      byUser.get(a.user_id).add(a.account_name);
    }
    await Promise.all([...byUser.entries()].map(([uid,names])=>inactivateOrphanedAccountOpportunities(uid,[...names])));
  }catch(err){
    console.warn('[Monitoring Lists] account-opportunity cleanup after list delete failed; self-heals on next reconciliation',{message:err&&err.message,uploadId:id});
  }
  return}await assertOwnedProspectUpload(ctx,id);await sb(`ha_prospect_signals?upload_id=eq.${encodeURIComponent(id)}`,{method:'DELETE',prefer:'return=minimal'});await sb(`ha_prospect_accounts?upload_id=eq.${encodeURIComponent(id)}`,{method:'DELETE',prefer:'return=minimal'});await sb(`ha_prospect_uploads?id=eq.${encodeURIComponent(id)}`,{method:'DELETE',prefer:'return=minimal'})}
export default async function handler(req,res){try{const ctx=await context(req);if(!ctx)return json(res,401,{error:'Authentication required'});if(req.method==='GET'){
  // Scaling round: a GET carrying ?uploadId= is a request for one bounded,
  // keyset-paginated (optionally search-scoped) page of that upload's
  // accounts -- the "expand an upload" fetch -- entirely separate from the
  // upload-summary fetch below, and independently authorization-checked
  // (assertOwnedUpload) on every call rather than trusting the caller's own
  // uploadId. ?cursor=/?q=/?limit= are otherwise-untrusted input: cursor is
  // just an opaque account_name, q is sanitized before use, and limit is
  // clamped -- see loadAccountPage()'s own comments.
  const requestedUploadId=clean(req.query?.uploadId||'');
  if(requestedUploadId){
    const limitRaw=Number(req.query?.limit);
    const page=await loadAccountPage(ctx,{uploadId:requestedUploadId,cursor:clean(req.query?.cursor||'')||null,search:req.query?.q||'',limit:limitRaw});
    return json(res,200,{ok:true,uploadId:requestedUploadId,...page});
  }
  const lists=await loadLists(ctx);const activeCustomers=lists.customer.filter(x=>x.status==='active').reduce((n,x)=>n+x.companyCount,0),pausedCustomers=lists.customer.filter(x=>x.status==='paused').reduce((n,x)=>n+x.companyCount,0),activeProspects=lists.prospect.filter(x=>x.status==='active').reduce((n,x)=>n+x.companyCount,0),pausedProspects=lists.prospect.filter(x=>x.status==='paused').reduce((n,x)=>n+x.companyCount,0);
  // Billing/monitoring correction: only customer accounts are ever
  // re-researched by api/weekly-scan.js's recurring cron -- prospect
  // accounts are one-shot research snapshots (see api/lib/entitlement.js's
  // usageFor()). monitoringStatus/nextWeeklyScan must reflect that: they
  // used to fold activeProspects into "Active"/"next scan Monday" even
  // when an org had zero active customer lists, implying prospects are
  // under the same continuous weekly watch customer accounts get, which
  // they are not.
  return json(res,200,{ok:true,scope:ctx.canViewTeam?'organization':'user',role:ctx.role,lists,summary:{activeCustomers,pausedCustomers,activeProspects,pausedProspects,nextWeeklyScan:activeCustomers>0?'Monday':null,monitoringStatus:activeCustomers>0?'Active':'No active lists'}})}if(req.method==='PATCH'){const{type,id,action,name}=req.body||{};if(type==='account'&&id&&['pause-account','resume-account','delete-account'].includes(action)){await patchCustomerAccount(ctx,id,action);return json(res,200,{ok:true})}if(!['customer','prospect'].includes(type)||!id||!['rename','pause','resume'].includes(action))return json(res,400,{error:'Invalid list update'});if(action==='rename'&&!clean(name))return json(res,400,{error:'List name is required'});await patchList(ctx,type,id,action,name);return json(res,200,{ok:true})}if(req.method==='DELETE'){const{type,id}=req.body||{};if(!['customer','prospect'].includes(type)||!id)return json(res,400,{error:'Invalid list delete'});await deleteList(ctx,type,id);return json(res,200,{ok:true})}return json(res,405,{error:'Method not allowed'})}catch(e){console.error('[Monitoring Lists]',e);
  // ROUND 13 fix: e.fromSupabase (set only inside sb() -- see its own
  // comment) means NO application code chose this status; it is whatever
  // raw HTTP status Supabase/PostgREST happened to return for some
  // downstream request (any of the ha_uploads/ha_accounts/ha_signals/
  // ha_research_runs/ha_prospect_* reads, or the replace_ha_accounts_snapshot
  // RPC, made anywhere above). That CAN be 404 (e.g. a table/view PostgREST's
  // schema cache doesn't recognize) and previously passed straight through
  // via e.status||500 -- indistinguishable, in the Network tab, from this
  // Vercel function itself being missing/undeployed. Normalized to 502
  // (Bad Gateway: this route ran, but a downstream dependency failed) so an
  // unexpected upstream failure can never be misread as a routing problem.
  // Deliberately-classified errors (HA004/55P03/42501 in
  // deleteCustomerAccountViaSnapshot, the two in patchCustomerAccount, and
  // every direct 400/401/403/405 returned above) are fresh, unmarked Error
  // objects and are unaffected -- they still return exactly the status
  // application code chose.
  if(e&&e.fromSupabase) return json(res,502,{error:'A downstream data request failed. Please try again.',upstreamStatus:e.status||null});
  return json(res,e.status||500,{error:e.message||'Monitoring list request failed',...(e.identityLocked?{identityLocked:true}:{})})}}
