// Vercel Serverless Function: Save House Accounts uploads to Supabase.
// Endpoint: POST /api/save-upload

import { resolveOpportunityEvents, dedupeByEventFingerprint, displayLabelForEventType } from './signal-intelligence.js';
import { createHash } from 'crypto';

// Phase 2A implementation-review item 5 — same instrumentation-privacy
// convention as api/research-batch.js: normal logs use counts and hashed
// identifiers only, raw account names withheld by default. See
// HA_DEBUG_INSTRUMENTATION there for the QA/debug opt-in (server-side env
// var only, never client-controllable).
const DEBUG_INSTRUMENTATION = String(process.env.HA_DEBUG_INSTRUMENTATION || '').toLowerCase() === 'true';
function shortHash(value = ''){ return createHash('sha256').update(String(value || '')).digest('hex').slice(0, 12); }

function json(res, status, body){ res.setHeader('Cache-Control','no-store, max-age=0'); return res.status(status).json(body); }
function clean(v=''){ return String(v || '').trim(); }
function hashString(input=''){
  let h = 2166136261;
  const s = String(input || '');
  for(let i=0;i<s.length;i++){ h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(16);
}
function signalHash(userId, uploadId, accountName, signal){
  return hashString([userId, uploadId, accountName, signal.signalType || signal.type || '', signal.signalTitle || signal.title || signal.whatChanged || '', signal.sourceUrl || signal.source || ''].join('|').toLowerCase());
}
function env(){
  const rawUrl = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if(!rawUrl || !key) throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');

  // SUPABASE_URL should be the project URL only, e.g. https://xxxx.supabase.co.
  // If someone accidentally pasted the REST endpoint, normalize it so we do not call /rest/v1/rest/v1.
  const url = String(rawUrl)
    .trim()
    .replace(/\/+$/, '')
    .replace(/\/rest\/v1$/i, '');

  return {url, key};
}
async function supabase(path, options={}){
  const {url, key} = env();
  const resp = await fetch(`${url}/rest/v1/${path}`, {
    ...options,
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      Prefer: options.prefer || 'return=representation',
      ...(options.headers || {})
    }
  });
  const text = await resp.text();
  let data = null;
  if(text){ try{ data = JSON.parse(text); } catch { data = text; } }
  if(!resp.ok){
    const msg = typeof data === 'string' ? data : (data?.message || data?.hint || JSON.stringify(data));
    const err = new Error(`Supabase ${resp.status}: ${msg}`);
    err.status = resp.status;
    // Postgres sqlstate (e.g. '42501', 'HA001'), when the response body is a
    // PostgREST-shaped RPC error -- lets callers branch on the actual
    // database error code (Phase 2A implementation-review ROUND 3).
    err.code = (data && typeof data === 'object') ? data.code : undefined;
    throw err;
  }
  return data;
}

async function authFetchUser(req){
  const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i,'');
  if(!token) return null;
  const {url, key} = env();
  const resp = await fetch(`${url}/auth/v1/user`, {headers:{apikey:key, Authorization:`Bearer ${token}`}});
  if(!resp.ok) return null;
  return resp.json();
}

function normalizeCompanyName(name=''){
  return clean(name).toLowerCase().replace(/\b(incorporated|inc|llc|ltd|limited|corp|corporation|co|company)\b\.?/g,'').replace(/[^a-z0-9]+/g,' ').trim();
}
async function orgUsers(orgId,userId){
  if(orgId){
    const rows = await supabase(`ha_users?organization_id=eq.${encodeURIComponent(orgId)}&select=id`, {method:'GET'}).catch(()=>[]);
    return (Array.isArray(rows)?rows:[]).map(u=>u.id).filter(Boolean);
  }
  return [userId].filter(Boolean);
}
async function getOrganization(user){
  if(!user?.organization_id) return null;
  const rows = await supabase(`ha_organizations?id=eq.${encodeURIComponent(user.organization_id)}&select=*&limit=1`, {method:'GET'}).catch(()=>[]);
  return Array.isArray(rows) ? rows[0] : null;
}

function daysRemaining(date){const t=new Date(date||0).getTime();if(!Number.isFinite(t)||t<=0)return null;return Math.max(0,Math.ceil((t-Date.now())/86400000))}
function entitlement(org={}){const plan=clean(org.plan||'free').toLowerCase();const sub=clean(org.subscription_status||'').toLowerCase();const trial=clean(org.trial_status||'').toLowerCase();const trialDays=daysRemaining(org.trial_end);const trialActive=(trial==='active'||sub==='trialing')&&trialDays!==null&&trialDays>0;const paidActive=['active','paid','manual'].includes(sub);const unlimited=(plan!=='free')&&(trialActive||paidActive||plan==='enterprise');const expired=(sub==='trialing'||trial==='active')&&trialDays===0;return{plan,isFreePlan:!unlimited,companyLimit:unlimited?Infinity:10,trialDaysRemaining:trialDays,trialExpired:expired,trialUsed:!!org.trial_used,trialStartedAt:org.trial_started_at||''}}
async function getUsageContext(user){
  const org = await getOrganization(user);
  const ent = entitlement(org || {});
  const ids = await orgUsers(user.organization_id, user.id);
  const inFilter = `in.(${ids.map(encodeURIComponent).join(',')})`;
  let customer=[];
  try{
    const uploads = await supabase(`ha_uploads?user_id=${inFilter}&select=id,stage`, {method:'GET'});
    const activeUploadIds = (Array.isArray(uploads)?uploads:[]).filter(u=>!['paused','archived'].includes(clean(u.stage).toLowerCase())).map(u=>u.id).filter(Boolean);
    if(activeUploadIds.length){
      const uploadFilter = `in.(${activeUploadIds.map(encodeURIComponent).join(',')})`;
      customer = await supabase(`ha_accounts?upload_id=${uploadFilter}&select=account_name`, {method:'GET'});
    }
  }catch{}
  const monitored = new Set([...(Array.isArray(customer)?customer:[]).map(r=>normalizeCompanyName(r.account_name))].filter(Boolean));
  return {org, plan:ent.plan, isFreePlan: ent.isFreePlan, companyLimit: ent.companyLimit, monitored};
}
function applyFreeLimitToAccounts(accounts, usage){
  if(!usage?.isFreePlan) return {accounts, lockedCount:0, totalMonitoredAfter:null};
  const monitored = new Set(usage.monitored || []);
  let unlocked = 0, lockedCount = 0;
  const limited = accounts.map(a => {
    const name = clean(a.name || a.accountName);
    const key = normalizeCompanyName(name);
    const alreadyMonitored = key && monitored.has(key);
    const canUnlock = alreadyMonitored || monitored.size < usage.companyLimit;
    if(key && canUnlock && !alreadyMonitored) monitored.add(key);
    if(canUnlock) unlocked += 1;
    else lockedCount += 1;
    return {...a, _locked: !canUnlock};
  });
  return {accounts: limited, lockedCount, totalMonitoredAfter: monitored.size};
}

// Phase 2A implementation-review ROUND 4, item 1 — saves whose stage
// represents research OUTPUT now REQUIRE attempt metadata; this is no
// longer an opt-in check. The standalone single-account "Research Account"
// button now claims its own manual research run before calling providers
// (see dashboard/index.html's researchAccountByName()), so it always has
// real attempt metadata to send when it saves. There is no longer any code
// path that legitimately reaches a RESEARCH_OUTPUT_STAGES save without one.
const RESEARCH_OUTPUT_STAGES = new Set(['researched', 'research_updated']);

// Phase 2A implementation-review ROUND 5, item 2 — the complete, explicit
// server-side stage state machine. "The only untracked save stage may be
// the initial upload/account-persistence operation" -- ALLOWED_STAGES is
// the full universe of legal stage values; anything else is rejected (400)
// rather than silently accepted and passed through to ha_uploads.stage.
// dashboard/index.html's refreshOpportunityViews() previously used a
// separate 'view_updated' stage for non-research resaves (manual account
// edits, filter changes); that is now folded into 'uploaded' -- both are,
// from this server's perspective, the SAME operation class (accounts-only,
// no research fields), so there is exactly one untracked stage string, not
// two, matching the requirement literally.
const ALLOWED_STAGES = new Set(['uploaded', 'researched', 'research_updated']);
// Fields that only make sense as the OUTPUT of a completed research pass.
// A stage='uploaded' request carrying any of these (non-zero) is rejected
// -- "research summaries/results must be absent" is enforced here, not
// merely documented, so a client cannot smuggle research-shaped content
// through the one stage that is exempt from attempt-metadata validation.
const RESEARCH_RESULT_SUMMARY_FIELDS = ['reasonsToReachOut', 'highConfidenceAccounts', 'businessSignals', 'followUpSignals', 'repeatPatternSignals'];

async function getUserFromAuth(req){
  const authUser = await authFetchUser(req);
  if(!authUser?.id) return null;
  const rows = await supabase(`ha_users?auth_user_id=eq.${encodeURIComponent(authUser.id)}&select=*&limit=1`, {method:'GET'});
  const existing = Array.isArray(rows) ? rows[0] : null;
  if(existing) return existing;
  const byEmail = await supabase(`ha_users?email=eq.${encodeURIComponent(String(authUser.email||'').toLowerCase())}&select=*&limit=1`, {method:'GET'});
  const emailUser = Array.isArray(byEmail) ? byEmail[0] : null;
  if(emailUser?.id){
    const updated = await supabase(`ha_users?id=eq.${encodeURIComponent(emailUser.id)}`, {method:'PATCH', body:JSON.stringify({auth_user_id:authUser.id,status:'active',updated_at:new Date().toISOString()})});
    return Array.isArray(updated) ? updated[0] : updated;
  }
  return null;
}

export default async function handler(req, res){
  if(req.method !== 'POST') return json(res, 405, {error:'Method not allowed'});
  try{
    const body = req.body || {};
    const lead = body.lead || {};
    let user = await getUserFromAuth(req);
    if(!user){
      const email = clean(lead.email).toLowerCase();
      if(!email) return json(res, 401, {error:'Login required'});
      const users = await supabase('ha_users?on_conflict=email', {
        method:'POST',
        prefer:'resolution=merge-duplicates,return=representation',
        body: JSON.stringify([{
          email,
          name: clean(lead.name),
          company: clean(lead.company),
          role: clean(lead.role),
          house_accounts: clean(lead.houseAccounts || lead.house_accounts),
          crm_erp: clean(lead.crmErp || lead.crm_erp),
          source_page: clean(body.page || body.sourcePage),
          updated_at: new Date().toISOString()
        }])
      });
      user = Array.isArray(users) ? users[0] : users;
    }
    if(!user?.id) throw new Error('User lookup did not return an id.');

    let uploadId = clean(body.uploadId);
    const stage = clean(body.stage || 'uploaded');

    // Phase 2A implementation-review ROUND 5, item 2 — reject unknown/invalid
    // stage strings outright, before any other processing. Do not rely on
    // the client to send a value from a fixed set; enforce it here.
    if(!ALLOWED_STAGES.has(stage)){
      return json(res, 400, {error:`Unknown stage "${stage}".`});
    }
    const isResearchOutputStage = RESEARCH_OUTPUT_STAGES.has(stage);
    const summary = body.summary || {};
    const rawAccountsForValidation = Array.isArray(body.accounts) ? body.accounts : [];

    // Phase 2A implementation-review ROUND 4, item 1 — attempt metadata is
    // now MANDATORY for research-output stages, full stop.
    const rawResearchRunId = clean(body.researchRunId);
    const rawAttemptId = clean(body.attemptId);
    if(isResearchOutputStage){
      if(!rawResearchRunId || !rawAttemptId){
        return json(res, 400, {error:'researchRunId and attemptId are required for a research-output-stage save.'});
      }
      if(!uploadId){
        return json(res, 400, {error:'uploadId is required for a research-output-stage save.'});
      }
    } else {
      // stage === 'uploaded' -- the ONLY untracked stage. Phase 2A
      // implementation-review ROUND 5, item 2's full state machine:
      if(rawResearchRunId || rawAttemptId){
        return json(res, 400, {error:'stage="uploaded" cannot carry research run/attempt metadata.'});
      }
      const hasAnySignals = rawAccountsForValidation.some(a => Array.isArray(a.signals) && a.signals.length > 0);
      if(hasAnySignals){
        return json(res, 400, {error:'stage="uploaded" cannot carry signals; signals are research output.'});
      }
      const hasResearchResultSummary = RESEARCH_RESULT_SUMMARY_FIELDS.some(field => Number(summary?.[field] || 0) > 0);
      if(hasResearchResultSummary){
        return json(res, 400, {error:'stage="uploaded" cannot carry a research-result summary.'});
      }
      // "Must not be usable to overwrite or append research output to an
      // upload that already has an ACTIVE research run" -- an untracked
      // save against an upload with a currently-running, unexpired attempt
      // is rejected, since its client-held account list could be stale
      // relative to what that active run is about to persist. A upload
      // whose most recent run is merely COMPLETED (the normal, permanent
      // state after research finishes) is unaffected -- plain account edits
      // must keep working after research completes; they carry no research
      // output (already guaranteed by the two checks above), so they cannot
      // violate the invariant regardless of run state.
      if(uploadId){
        const activeRuns = await supabase(`ha_research_runs?upload_id=eq.${encodeURIComponent(uploadId)}&status=eq.running&lease_expires_at=gt.${encodeURIComponent(new Date().toISOString())}&select=id&limit=1`, {method:'GET'}).catch(() => []);
        if(Array.isArray(activeRuns) && activeRuns.length){
          return json(res, 409, {error:'A research run is currently active for this upload; cannot save an untracked update while research is in progress.'});
        }
      }
    }
    const trackedAttempt = isResearchOutputStage;

    // ===========================================================================
    // UNTRACKED PATH: stage='uploaded' is the ONLY untracked stage (Phase 2A
    // implementation-review ROUND 5, item 2) -- the state machine above has
    // already rejected any request that tries to carry research output,
    // attempt metadata, or target an upload with an active run. A plain
    // ha_uploads PATCH/INSERT, then replace_ha_accounts_snapshot() with no
    // attempt parameters, then a signals insert that will always process
    // zero rows now (signals are rejected above for this stage) but is left
    // in place structurally rather than special-cased further.
    // ===========================================================================
    if(!trackedAttempt){
      const uploadRow = {
        user_id: user.id,
        upload_name: clean(body.uploadName || 'Uploaded account list'),
        stage,
        summary,
        source_page: clean(body.page || body.sourcePage),
        updated_at: new Date().toISOString()
      };

      let upload;
      if(uploadId){
        const updated = await supabase(`ha_uploads?id=eq.${encodeURIComponent(uploadId)}&user_id=eq.${encodeURIComponent(user.id)}`, {
          method:'PATCH',
          body: JSON.stringify(uploadRow)
        });
        upload = Array.isArray(updated) && updated[0] ? updated[0] : {id: uploadId};
      } else {
        const inserted = await supabase('ha_uploads', { method:'POST', body: JSON.stringify([uploadRow]) });
        upload = Array.isArray(inserted) ? inserted[0] : inserted;
        uploadId = upload.id;
      }
      if(!uploadId) throw new Error('Upload save did not return an id. Confirm ha_uploads table exists.');

      const rawAccounts = Array.isArray(body.accounts) ? body.accounts : [];
      const usageContext = await getUsageContext(user);
      const limitResult = applyFreeLimitToAccounts(rawAccounts, usageContext);
      const accounts = limitResult.accounts;
      const unlockedAccounts = accounts.filter(a => !a._locked);
      let persistedAccountCount = 0;
      if(accounts.length){
        const accountPayload = unlockedAccounts.slice(0, 2500).map(a => ({
          account_name: clean(a.name || a.accountName),
          industry: clean(a.industry),
          contact_name: clean(a.contactName),
          contact_email: clean(a.contactEmail).toLowerCase(),
          metrics: a.metrics || {},
          raw_data: a.rawData || {}
        })).filter(a => a.account_name);
        if(accountPayload.length){
          const snapshotResult = await supabase('rpc/replace_ha_accounts_snapshot', {
            method:'POST',
            prefer:'return=representation',
            body: JSON.stringify({ p_upload_id: uploadId, p_user_id: user.id, p_accounts: accountPayload })
          });
          persistedAccountCount = Array.isArray(snapshotResult) ? snapshotResult.length : 0;
        }
      }

      const rawSignals = [];
      for(const account of unlockedAccounts){
        const signals = Array.isArray(account.signals) ? account.signals : [];
        const accountName = clean(account.name || account.accountName);
        for(const s of signals){
          rawSignals.push({ ...s, accountName, companyName: s.companyName || accountName });
        }
      }
      const resolvedSignals = resolveOpportunityEvents(rawSignals);
      let classificationCorrections = 0;
      for(const s of resolvedSignals){
        const canonicalLabel = s.eventIdentity?.eventType ? displayLabelForEventType(s.eventIdentity.eventType) : null;
        const declaredLabel = clean(s.signalType || s.type || '');
        if(canonicalLabel && declaredLabel && canonicalLabel !== declaredLabel){
          console.warn('[save-upload] classification mismatch corrected before persistence', {
            accountNameHash: shortHash(s.accountName), declaredLabel, canonicalLabel, eventType: s.eventIdentity.eventType,
            ...(DEBUG_INSTRUMENTATION ? { accountName: s.accountName } : {})
          });
          s.signalType = canonicalLabel; s.signal_type = canonicalLabel; s.type = canonicalLabel;
          classificationCorrections += 1;
        }
      }
      const candidateRows = resolvedSignals.map(s => ({
        user_id: user.id,
        upload_id: uploadId,
        account_name: clean(s.accountName),
        event_fingerprint: s.eventFingerprint,
        signal_hash: signalHash(user.id, uploadId, s.accountName, s),
        signal_type: clean(s.signalType || s.type || 'Business Activity'),
        title: clean(s.signalTitle || s.title || s.whatChanged),
        why_reach_out: clean(s.whyItMattersForPromo || s.whyReachOut || s.reasonToReachOut || s.whyNow),
        confidence: Number(s.confidenceScore || s.confidence || 0) || null,
        source_url: clean(s.sourceUrl || s.url),
        source_domain: clean(s.cleanSourceName || s.sourceName || ''),
        published_at: clean(s.publicationDate || s.publishedAt) || null,
        payload: s,
        first_seen_at: new Date().toISOString(),
        last_seen_at: new Date().toISOString()
      })).filter(row => row.event_fingerprint);
      const signalRows = dedupeByEventFingerprint(candidateRows, {
        keyOf: row => `${row.user_id}|${row.event_fingerprint}`,
        scoreOf: row => Number(row.confidence || 0)
      });
      let insertedFingerprints = [];
      if(signalRows.length){
        const chunkSize = 200;
        for(let i=0;i<signalRows.length;i+=chunkSize){
          const inserted = await supabase('ha_signals?on_conflict=user_id,event_fingerprint', {
            method:'POST',
            prefer:'resolution=ignore-duplicates,return=representation',
            body: JSON.stringify(signalRows.slice(i, i+chunkSize))
          });
          if(Array.isArray(inserted)) insertedFingerprints.push(...inserted.map(r => r.event_fingerprint));
        }
      }
      const conflictIgnoredCount = Math.max(0, signalRows.length - insertedFingerprints.length);
      const responseResearchRunId = rawResearchRunId || 'unattributed';

      console.log('[save-upload.instrumentation]', JSON.stringify({
        ts: new Date().toISOString(),
        researchRunId: responseResearchRunId,
        uploadId,
        userId: user.id,
        tracked: false,
        signalsReceivedFromClient: rawSignals.length,
        canonicalEventsAfterResolution: resolvedSignals.length,
        uniqueEventFingerprints: new Set(resolvedSignals.map(s => s.eventFingerprint)).size,
        classificationCorrections,
        attemptedSignalInserts: signalRows.length,
        persistedSignalRows: insertedFingerprints.length,
        conflictIgnoredRows: conflictIgnoredCount,
        persistedAccountCount
      }));

      return json(res, 200, {ok:true, userId:user.id, uploadId, researchRunId:responseResearchRunId, accountsAnalyzed:accounts.length, accountsSaved:persistedAccountCount, lockedCount:limitResult.lockedCount||0, totalMonitoredCompanies:limitResult.totalMonitoredAfter, companyLimit:Number.isFinite(usageContext.companyLimit)?usageContext.companyLimit:null, signalsSaved:insertedFingerprints.length, signalsAttempted:signalRows.length, signalsConflictIgnored:conflictIgnoredCount});
    }

    // ===========================================================================
    // TRACKED PATH (ROUND 4): accounts, signals, and ha_uploads research-state
    // are all persisted through ONE atomic, attempt-guarded call to
    // persist_ha_research_output(). No separate ha_uploads PATCH runs before
    // it -- the RPC itself updates stage/summary, guarded by the SAME
    // attempt check as everything else, closing the gap a pre-flight-only
    // check (round 3) left open. See
    // supabase-schema-migration-6-attempt-guarded-persistence.sql.
    // ===========================================================================
    const rawAccounts = Array.isArray(body.accounts) ? body.accounts : [];
    const usageContext = await getUsageContext(user);
    const limitResult = applyFreeLimitToAccounts(rawAccounts, usageContext);
    const accounts = limitResult.accounts;
    const unlockedAccounts = accounts.filter(a => !a._locked);
    const accountPayload = unlockedAccounts.slice(0, 2500).map(a => ({
      account_name: clean(a.name || a.accountName),
      industry: clean(a.industry),
      contact_name: clean(a.contactName),
      contact_email: clean(a.contactEmail).toLowerCase(),
      metrics: a.metrics || {},
      raw_data: a.rawData || {}
    })).filter(a => a.account_name);

    // Collect every account's raw signals first, then run ONE global
    // event-resolution pass across the whole upload before persisting. This
    // is the same fix applied in weekly-scan.js: the same real-world event
    // described with different wording (or generated on a separate save)
    // must resolve to a single event_fingerprint, not one row per phrasing.
    const rawSignals = [];
    for(const account of unlockedAccounts){
      const signals = Array.isArray(account.signals) ? account.signals : [];
      const accountName = clean(account.name || account.accountName);
      for(const s of signals){
        rawSignals.push({ ...s, accountName, companyName: s.companyName || accountName });
      }
    }
    const resolvedSignals = resolveOpportunityEvents(rawSignals);
    // Phase 2A / B3 defense in depth: contradictory fields cannot persist.
    // By construction (see api/research-batch.js makeSignal() and
    // resolveEvents()'s reuse of canonicalEventType) signal_type and
    // eventIdentity.eventType should already agree for every signal produced
    // by the current pipeline. This guard catches and corrects the rare case
    // where they don't — e.g. a signal from an older client build, or any
    // future caller that hasn't adopted canonicalEventType — by preferring
    // the canonical eventType's mapped label and logging the correction,
    // rather than silently persisting two disagreeing classification fields.
    let classificationCorrections = 0;
    for(const s of resolvedSignals){
      const canonicalLabel = s.eventIdentity?.eventType ? displayLabelForEventType(s.eventIdentity.eventType) : null;
      const declaredLabel = clean(s.signalType || s.type || '');
      if(canonicalLabel && declaredLabel && canonicalLabel !== declaredLabel){
        console.warn('[save-upload] classification mismatch corrected before persistence', {
          accountNameHash: shortHash(s.accountName), declaredLabel, canonicalLabel, eventType: s.eventIdentity.eventType,
          ...(DEBUG_INSTRUMENTATION ? { accountName: s.accountName } : {})
        });
        s.signalType = canonicalLabel; s.signal_type = canonicalLabel; s.type = canonicalLabel;
        classificationCorrections += 1;
      }
    }
    const candidateRows = resolvedSignals.map(s => ({
      user_id: user.id,
      upload_id: uploadId,
      account_name: clean(s.accountName),
      event_fingerprint: s.eventFingerprint,
      signal_hash: signalHash(user.id, uploadId, s.accountName, s),
      signal_type: clean(s.signalType || s.type || 'Business Activity'),
      title: clean(s.signalTitle || s.title || s.whatChanged),
      why_reach_out: clean(s.whyItMattersForPromo || s.whyReachOut || s.reasonToReachOut || s.whyNow),
      confidence: Number(s.confidenceScore || s.confidence || 0) || null,
      source_url: clean(s.sourceUrl || s.url),
      source_domain: clean(s.cleanSourceName || s.sourceName || ''),
      published_at: clean(s.publicationDate || s.publishedAt) || null,
      payload: s,
      first_seen_at: new Date().toISOString(),
      last_seen_at: new Date().toISOString()
    })).filter(row => row.event_fingerprint);
    // Defensive in-memory dedup before the bulk write, same as weekly-scan.js —
    // the database's composite unique constraint is the final safety net.
    // Deliberately NOT scoped by upload_id: see weekly-scan.js for why —
    // the product monitors companies, not uploads.
    const signalRows = dedupeByEventFingerprint(candidateRows, {
      keyOf: row => `${row.user_id}|${row.event_fingerprint}`,
      scoreOf: row => Number(row.confidence || 0)
    });
    // Phase 2A implementation-review ROUND 4, item 1: accounts, signals, and
    // the ha_uploads research-state update all happen through ONE call to
    // persist_ha_research_output() -- one transaction, one advisory lock,
    // one attempt validation. A stale/replaced attempt is rejected here
    // (HA001) and NOTHING is written: not accounts, not signals, not
    // upload state. See supabase-schema-migration-6-attempt-guarded-persistence.sql
    // §4 for the exact race this closes, re-verified for all three tables.
    let rpcResult;
    try {
      rpcResult = await supabase('rpc/persist_ha_research_output', {
        method:'POST',
        prefer:'return=representation',
        body: JSON.stringify({
          p_upload_id: uploadId,
          p_user_id: user.id,
          p_research_run_id: rawResearchRunId,
          p_attempt_id: rawAttemptId,
          p_accounts: accountPayload.length ? accountPayload : null,
          p_signals: signalRows,
          p_upload_stage: stage,
          p_upload_summary: summary
        })
      });
    } catch(err) {
      if(err.code === 'HA001'){
        return json(res, 409, {error:'This research attempt is no longer active; nothing was saved.', staleAttempt:true});
      }
      if(err.code === '42501'){
        return json(res, 403, {error:'You do not have access to this upload.'});
      }
      throw err;
    }

    const persistedAccountCount = Number(rpcResult?.accountsPersisted || 0);
    const signalsAttempted = Number(rpcResult?.signalsAttempted || 0);
    const signalsPersisted = Number(rpcResult?.signalsPersisted || 0);
    const conflictIgnoredCount = Number(rpcResult?.signalsConflictIgnored || 0);

    console.log('[save-upload.instrumentation]', JSON.stringify({
      ts: new Date().toISOString(),
      researchRunId: rawResearchRunId,
      uploadId,
      userId: user.id,
      tracked: true,
      attemptId: rawAttemptId,
      signalsReceivedFromClient: rawSignals.length,
      canonicalEventsAfterResolution: resolvedSignals.length,
      uniqueEventFingerprints: new Set(resolvedSignals.map(s => s.eventFingerprint)).size,
      classificationCorrections,
      attemptedSignalInserts: signalsAttempted,
      persistedSignalRows: signalsPersisted,
      conflictIgnoredRows: conflictIgnoredCount,
      persistedAccountCount
    }));

    return json(res, 200, {ok:true, userId:user.id, uploadId, researchRunId:rawResearchRunId, attemptId:rawAttemptId, runStatus:rpcResult?.status || 'completed', completedAt:rpcResult?.completedAt, accountsAnalyzed:accounts.length, accountsSaved:persistedAccountCount, lockedCount:limitResult.lockedCount||0, totalMonitoredCompanies:limitResult.totalMonitoredAfter, companyLimit:Number.isFinite(usageContext.companyLimit)?usageContext.companyLimit:null, signalsSaved:signalsPersisted, signalsAttempted, signalsConflictIgnored:conflictIgnoredCount});
  } catch(err){
    return json(res, 500, {error: err.message || 'Save failed'});
  }
}
