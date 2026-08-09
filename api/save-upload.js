// Vercel Serverless Function: Save House Accounts uploads to Supabase.
// Endpoint: POST /api/save-upload

import { resolveOpportunityEvents, dedupeByEventFingerprint, displayLabelForEventType, materiallyRepeats } from './signal-intelligence.js';
import { normalizeCompanyName } from './company-identity.js';
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
// product/commercial-opportunity-intelligence, QA correction 4 (re-research
// persistence): the ignore-duplicates insert below only ever writes a row
// for a GENUINELY new event_fingerprint -- on a conflict with an
// already-persisted event it is, by design, a silent no-op, so that a
// retried/duplicate save never re-triggers a "new signal" notification.
// That is correct for identity/notification purposes but wrong for
// INTERPRETATION: re-researching an already-known event (Dover Honda,
// Catalyst, etc.) regenerates commercialPlay/activationIdeas/
// expansionPotential/conversationStarter/relatedPurchase, and those
// improvements were being silently discarded forever because the
// already-existing row was never touched again. This allowlist selects
// exactly the columns that represent "our current understanding of this
// event" -- never event_fingerprint/user_id (identity, must stay stable)
// and never first_seen_at (when we first learned about it, not when we
// last re-interpreted it) -- for a second, explicit refresh upsert.
function refreshableSignalRow(row){
  return {
    user_id: row.user_id,
    event_fingerprint: row.event_fingerprint,
    signal_hash: row.signal_hash,
    signal_type: row.signal_type,
    title: row.title,
    why_reach_out: row.why_reach_out,
    confidence: row.confidence,
    source_url: row.source_url,
    source_domain: row.source_domain,
    published_at: row.published_at,
    payload: row.payload,
    last_seen_at: row.last_seen_at
  };
}
// Fingerprint Stability sprint -- lazy legacy compatibility bridge.
//
// Existing ha_signals rows keep their original (pre-v2) event_fingerprint
// forever; rewriting that column to v2 format is an explicit, separately
// authorized backfill, not attempted here. This bridge's only job is to
// stop a v2-era rediscovery of an event that already has a legacy-format
// row from inserting a THIRD, duplicate row: it recomputes each existing
// row's v2-equivalent identity from its own stored payload -- the same
// technique scripts/find-duplicate-signals.js already uses for its
// read-only duplicate report -- and, on a match, submits the WINNING
// existing row's own literal fingerprint so the normal on-conflict upsert
// refreshes it in place instead of inserting alongside it. Every other
// legacy row (including a non-winner duplicate) is left completely
// untouched -- historical duplicate cleanup remains a separate,
// out-of-scope backfill/reconciliation concern.
//
// Deterministic winner rule, identical to find-duplicate-signals.js's
// chooseRetained(): highest confidence, then earliest first_seen_at
// (preserve original discovery), then id for total determinism regardless
// of SELECT ordering.
function chooseRetainedLegacyRow(rows){
  return [...rows].sort((a, b) => {
    const confDiff = Number(b.confidence || 0) - Number(a.confidence || 0);
    if (confDiff !== 0) return confDiff;
    const timeDiff = new Date(a.first_seen_at || 0) - new Date(b.first_seen_at || 0);
    if (timeDiff !== 0) return timeDiff;
    return String(a.id).localeCompare(String(b.id));
  })[0];
}

// ONE batched query per save-upload call (chunked only if the account list
// is large enough to risk a practical URL-length limit), scoped only to the
// accounts that actually have resolved signals in this save -- never the
// full table, never per-signal, never per-account. Mirrors the same
// account-scoped query shape find-duplicate-signals.js already uses.
async function fetchLegacySignalsForAccounts(userId, accountNames){
  const names = [...new Set((accountNames || []).map(n => clean(n)).filter(Boolean))];
  if(!names.length) return [];
  const chunkSize = 100;
  const rows = [];
  for(let i=0;i<names.length;i+=chunkSize){
    const chunk = names.slice(i, i+chunkSize);
    const inFilter = `in.(${chunk.map(n => encodeURIComponent(`"${n.replace(/"/g,'\\"')}"`)).join(',')})`;
    const page = await supabase(`ha_signals?user_id=eq.${encodeURIComponent(userId)}&account_name=${inFilter}&select=id,account_name,event_fingerprint,confidence,first_seen_at,payload,source_url,source_domain,title`, {method:'GET'}).catch(() => []);
    if(Array.isArray(page)) rows.push(...page);
  }
  return rows;
}

// Fingerprint Stability sprint, correction round: replaces literal
// event_fingerprint STRING equality with a dedicated identity comparison.
// A legacy row's payload is frequently INCOMPLETE relative to what a fresh
// v2 resolution now captures -- an older payload may never have resolved an
// exact date (v1's own fingerprint only ever encoded a bare year, so its
// absence proves nothing about whether the payload's evidence text could
// support one), or may predate rawTitle/rawSnippet threading entirely.
// Requiring full-string equality means a genuinely-the-same event never
// bridges merely because one side's resolution knows less than the other's
// (confirmed production case: the Dover Holiday Parade legacy row, whose
// exact-string fingerprint never matched a fresh, fully-resolved
// re-research of the same event). This is intentionally LOOSER than
// resolveEvents()'s own merge rule, and that looseness is scoped to the
// bridge only -- resolveEvents()'s general merge gate is untouched.
//
// Rules (weak-to-strong temporal enrichment allowed, never masking a real
// conflict):
//   - both sides carry a distinctive anchor: identity iff they agree,
//     regardless of URL/date -- a genuine anchor disagreement never bridges.
//   - an exact-date vs. exact-date conflict never bridges.
//   - a resolved-year vs. resolved-year conflict never bridges (this is
//     also what catches a legacy bare year against a fresh exact date whose
//     YEAR disagrees; a fresh exact date whose year AGREES with a legacy
//     bare year is exactly the weak-to-strong enrichment case this bridge
//     exists to allow).
//   - past those checks, either a one-sided (or both-sided-agreeing) anchor
//     is sufficient on its own ("strong event evidence"); with no anchor on
//     either side, same normalized source URL is REQUIRED (never
//     sufficient alone) plus the underlying evidence text materially
//     agreeing (materiallyRepeats()) -- the same corroboration-strength bar
//     resolveEvents() itself uses elsewhere.
function legacyBridgeCompatible(fresh, legacy){
  if(!fresh || !legacy) return false;
  if(fresh.companyNorm && legacy.companyNorm && fresh.companyNorm !== legacy.companyNorm) return false;

  const freshAnchor = fresh.anchor ? String(fresh.anchor).trim().toLowerCase() : '';
  const legacyAnchor = legacy.anchor ? String(legacy.anchor).trim().toLowerCase() : '';
  if(freshAnchor && legacyAnchor) return freshAnchor === legacyAnchor;

  const freshExact = fresh.dateConfidence === 'exact' ? fresh.eventDate : null;
  const legacyExact = legacy.dateConfidence === 'exact' ? legacy.eventDate : null;
  if(freshExact && legacyExact && freshExact !== legacyExact) return false;

  const freshYear = fresh.year || (freshExact ? freshExact.slice(0, 4) : null);
  const legacyYear = legacy.year || (legacyExact ? legacyExact.slice(0, 4) : null);
  if(freshYear && legacyYear && String(freshYear) !== String(legacyYear)) return false;

  if(freshAnchor || legacyAnchor) return true; // one-sided anchor, no temporal conflict found above

  const sameUrl = fresh.normalizedUrl && legacy.normalizedUrl && fresh.normalizedUrl === legacy.normalizedUrl;
  if(!sameUrl) return false;
  return materiallyRepeats(fresh.evidenceText || '', legacy.evidenceText || '');
}

// Recomputes each legacy row's v2-equivalent identity from its own stored
// payload -- same reconstruction technique scripts/find-duplicate-signals.js
// already uses for its read-only duplicate report.
function recomputeLegacyIdentity(row){
  if(String(row.event_fingerprint || '').startsWith('v2|')) return null; // already v2-format, nothing to bridge
  const payload = row.payload || {};
  const opportunity = {
    ...payload,
    accountName: payload.accountName || row.account_name,
    companyName: payload.companyName || payload.accountName || row.account_name,
    headline: payload.headline || payload.signalTitle || row.title,
    whatChanged: payload.whatChanged || payload.businessContext || row.title,
    rawTitle: payload.rawTitle || '',
    rawSnippet: payload.rawSnippet || '',
    rawContent: payload.rawContent || '',
    sourceUrl: payload.sourceUrl || row.source_url,
    eventDate: payload.eventDate || '',
    publishedAt: payload.publishedAt || payload.eventDate || row.published_at
  };
  try {
    const resolved = resolveOpportunityEvents([opportunity])[0];
    return resolved?.eventIdentity || null;
  } catch { return null; }
}

// Mutates resolvedSignals in place: for any signal whose fresh v2 identity
// is bridge-compatible with one or more legacy rows' recomputed identity,
// replaces that signal's eventFingerprint with the deterministic winner's
// literal existing fingerprint. Every candidateRows/RPC mapping downstream
// reads s.eventFingerprint, so this is the only touch point needed for both
// the tracked (RPC) and untracked (direct REST) write paths.
function applyLegacyFingerprintBridge(legacyRows, resolvedSignals){
  if(!legacyRows.length) return { bridged: 0, multiMatch: 0 };
  const recomputed = legacyRows
    .map(row => ({ row, identity: recomputeLegacyIdentity(row) }))
    .filter(entry => entry.identity);

  let bridged = 0, multiMatch = 0;
  for(const s of resolvedSignals){
    const fresh = s.eventIdentity;
    if(!fresh) continue;
    const matches = recomputed.filter(entry => legacyBridgeCompatible(fresh, entry.identity));
    if(!matches.length) continue;
    const winner = chooseRetainedLegacyRow(matches.map(m => m.row));
    if(matches.length > 1){
      multiMatch += 1;
      console.warn('[save-upload] legacy fingerprint bridge: multiple existing rows matched one v2 identity', {
        accountNameHash: shortHash(s.accountName),
        v2Fingerprint: s.eventFingerprint,
        matchedLegacyFingerprints: matches.map(m => m.row.event_fingerprint),
        winnerFingerprint: winner.event_fingerprint,
        ...(DEBUG_INSTRUMENTATION ? { accountName: s.accountName } : {})
      });
    }
    s.eventFingerprint = winner.event_fingerprint;
    bridged += 1;
  }
  return { bridged, multiMatch };
}

export { chooseRetainedLegacyRow, applyLegacyFingerprintBridge, fetchLegacySignalsForAccounts, legacyBridgeCompatible };

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

// FR: duplicate-company-research-control round -- normalizeCompanyName() is
// now the shared api/company-identity.js implementation (byte-identical
// regex to what lived here before), also used by api/settings.js and
// api/research-batch.js's duplicate-company research check, instead of each
// file hand-maintaining its own copy.
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

// Phase 2A implementation-review ROUND 6, item 3 — the complete, explicit
// server-side stage state machine, with TWO untracked stages now that
// "initial upload creation" and "post-research accounts-only maintenance"
// are recognized as genuinely different operations (round 5 conflated them
// under 'uploaded', which made "the only untracked write is initial upload
// creation" not literally true -- a stage='uploaded' save was also being
// used, legitimately, to edit accounts on an upload that already had a
// completed research run):
//   - 'uploaded': initial upload creation ONLY. Rejected if the target
//     upload already has ANY research history (a row in ha_research_runs,
//     active or completed) -- at that point "initial creation" has already
//     happened, and a caller must use 'accounts_updated' instead.
//   - 'accounts_updated': authenticated, accounts-only maintenance for an
//     upload that already exists. No signals, no research summary, no
//     attempt metadata (same rules as 'uploaded'). Rejected while an ACTIVE
//     research run exists. Permitted after a run has completed. Critically,
//     unlike 'uploaded', this stage NEVER touches ha_uploads.stage or
//     ha_uploads.summary at all -- the prior research stage and summary are
//     preserved exactly, not overwritten or reset.
const ACCOUNTS_MAINTENANCE_STAGE = 'accounts_updated';
const ALLOWED_STAGES = new Set(['uploaded', ACCOUNTS_MAINTENANCE_STAGE, 'researched', 'research_updated']);
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

    // Phase 2A implementation-review ROUND 7, item 2 — stage and uploadId
    // are read BEFORE any identity is resolved, so identity resolution
    // itself can be gated by them. Unknown stages are rejected immediately,
    // before touching auth, the database, or anything else.
    let uploadId = clean(body.uploadId);
    const stage = clean(body.stage || 'uploaded');
    if(!ALLOWED_STAGES.has(stage)){
      return json(res, 400, {error:`Unknown stage "${stage}".`});
    }

    // ROUND 7, item 2 — identity rules:
    //   - uploadId present, OR stage is anything other than "uploaded"
    //     (i.e. accounts_updated / researched / research_updated, every one
    //     of which either requires an existing upload or IS a write against
    //     one): a real, verified Bearer token is mandatory, and the
    //     resulting user must actually own p_upload_id. lead.email is NEVER
    //     consulted for this branch, let alone trusted as identity — a
    //     request-supplied email is not authentication, full stop.
    //   - stage="uploaded" with NO uploadId: the one remaining legitimate
    //     anonymous-creation case (a genuinely new, not-yet-owned-by-anyone
    //     upload). A valid token is still preferred and used if present;
    //     only in its absence does the legacy lead.email upsert apply, and
    //     only here.
    // Every one of these failures happens before ANY RPC call or mutation.
    const requiresAuthenticatedOwner = !!uploadId || stage !== 'uploaded';
    let user = await getUserFromAuth(req);
    if(requiresAuthenticatedOwner){
      if(!user?.id){
        return json(res, 401, {error:'A valid session is required to modify an existing upload.'});
      }
      if(uploadId){
        const ownedRows = await supabase(`ha_uploads?id=eq.${encodeURIComponent(uploadId)}&user_id=eq.${encodeURIComponent(user.id)}&select=id&limit=1`, {method:'GET'});
        if(!Array.isArray(ownedRows) || !ownedRows.length){
          return json(res, 403, {error:'You do not have access to this upload.'});
        }
      }
    } else if(!user){
      // Legacy anonymous-creation flow: stage="uploaded", no uploadId, no
      // token. lead.email is used ONLY to create/attach a NEW upload's
      // owner -- it can never target an upload that already exists, because
      // requiresAuthenticatedOwner is true the moment uploadId is present.
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
      // stage === 'uploaded' or 'accounts_updated' -- the two untracked
      // stages. Phase 2A implementation-review ROUND 6, item 3's full state
      // machine. Both are subject to the same "no research output, no
      // attempt metadata" rules; they differ in whether prior research
      // history is required/forbidden (see below) and whether
      // ha_uploads.stage/summary may be touched (see the untracked-path
      // branch further down).
      if(rawResearchRunId || rawAttemptId){
        return json(res, 400, {error:`stage="${stage}" cannot carry research run/attempt metadata.`});
      }
      const hasAnySignals = rawAccountsForValidation.some(a => Array.isArray(a.signals) && a.signals.length > 0);
      if(hasAnySignals){
        return json(res, 400, {error:`stage="${stage}" cannot carry signals; signals are research output.`});
      }
      const hasResearchResultSummary = RESEARCH_RESULT_SUMMARY_FIELDS.some(field => Number(summary?.[field] || 0) > 0);
      if(hasResearchResultSummary){
        return json(res, 400, {error:`stage="${stage}" cannot carry a research-result summary.`});
      }
      if(stage === ACCOUNTS_MAINTENANCE_STAGE && !uploadId){
        return json(res, 400, {error:'uploadId is required for stage="accounts_updated" -- it is accounts-only maintenance for an upload that already exists, not a way to create one.'});
      }
      // Phase 2A implementation-review ROUND 7, item 3 — the active-run and
      // research-history checks that used to live here as separate,
      // `.catch(() => [])`-guarded GET requests are GONE. A failed lookup
      // used to be silently treated as "no active run" / "no history" --
      // fail OPEN, exactly backwards for a state gate. Both checks now run
      // INSIDE replace_ha_accounts_snapshot()'s own advisory-locked
      // transaction (see supabase-schema-migration-7-mode-scoped-account-writes.sql),
      // in the SAME call that performs the write, so there is no gap
      // between "checked" and "wrote," and any failure to establish state
      // (a thrown RPC error, a network failure) fails the whole request
      // rather than being interpreted as a green light.
    }
    const trackedAttempt = isResearchOutputStage;

    // ===========================================================================
    // UNTRACKED PATH: 'uploaded' or 'accounts_updated' (Phase 2A
    // implementation-review ROUND 6, item 3; mode-scoped as of ROUND 7, item
    // 3) -- the state machine above has already rejected any request that
    // tries to carry research output or attempt metadata. Ownership was
    // already verified above (ROUND 7, item 2) before this point for any
    // request carrying uploadId. replace_ha_accounts_snapshot() now performs
    // the active-run / research-history / account-identity checks itself,
    // atomically, before writing a single row -- see migration 7. A signals
    // insert that will always process zero rows now (signals are rejected
    // above for both these stages) is left in place structurally rather
    // than special-cased further.
    // ===========================================================================
    if(!trackedAttempt){
      const isAccountsMaintenance = stage === ACCOUNTS_MAINTENANCE_STAGE;
      const accountWriteMode = isAccountsMaintenance ? 'accounts_maintenance' : 'initial_upload';
      const isNewUpload = !uploadId;

      // A brand-new upload's ha_uploads row must exist before
      // replace_ha_accounts_snapshot()'s ownership check can pass, so it is
      // created first (there is nothing to reorder around here -- there is
      // no prior state for a new row to accidentally overwrite). For an
      // EXISTING upload, the accounts RPC below now runs BEFORE any
      // ha_uploads PATCH (see after the RPC call), so a rejection (active
      // run, reused "uploaded", or an accounts_maintenance identity-lock
      // violation) leaves ha_uploads completely untouched -- no partial
      // write on failure.
      if(isNewUpload){
        const uploadRow = {
          user_id: user.id,
          upload_name: clean(body.uploadName || 'Uploaded account list'),
          stage,
          summary,
          source_page: clean(body.page || body.sourcePage),
          updated_at: new Date().toISOString()
        };
        const inserted = await supabase('ha_uploads', { method:'POST', body: JSON.stringify([uploadRow]) });
        const upload = Array.isArray(inserted) ? inserted[0] : inserted;
        uploadId = upload?.id;
      }
      if(!uploadId) throw new Error('Upload save did not return an id. Confirm ha_uploads table exists.');

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

      // Phase 2A implementation-review ROUND 7, item 3 — the RPC is ALWAYS
      // called for an untracked-stage save, even with an empty accounts
      // array, so the atomic mode-check ALWAYS runs. Previously this call
      // was skipped entirely when the client sent no accounts, which meant
      // the (then application-side, now RPC-side) active-run/history checks
      // never ran for that request either -- harmless in practice (nothing
      // was written), but it left "the check always runs" not literally
      // true. An empty p_accounts array is documented, tested RPC behavior
      // (migration 4 §6a: clears the snapshot to empty) -- not a new risk
      // introduced here.
      let persistedAccountCount = 0;
      try{
        const snapshotResult = await supabase('rpc/replace_ha_accounts_snapshot', {
          method:'POST',
          prefer:'return=representation',
          body: JSON.stringify({ p_upload_id: uploadId, p_user_id: user.id, p_accounts: accountPayload, p_mode: accountWriteMode })
        });
        persistedAccountCount = Array.isArray(snapshotResult) ? snapshotResult.length : 0;
      }catch(err){
        if(err.code === 'HA003'){
          return json(res, 400, {error:'stage="uploaded" cannot be reused for an upload that already has research history; use stage="accounts_updated" for a post-research account edit.'});
        }
        if(err.code === 'HA004'){
          return json(res, 400, {error:'stage="accounts_updated" cannot add, remove, or rename accounts once research history exists for this upload; only contact, industry, metrics, and raw-data edits are permitted for the existing account names.', identityLocked:true});
        }
        if(err.code === '55P03'){
          return json(res, 409, {error:'A research run is currently active for this upload; cannot save an untracked update while research is in progress.'});
        }
        if(err.code === '42501'){
          return json(res, 403, {error:'You do not have access to this upload.'});
        }
        throw err;
      }

      // Only stage="uploaded" ever touches ha_uploads.stage/summary, and
      // only when the row already existed (a brand-new upload already got
      // these fields via the INSERT above). accounts_updated NEVER touches
      // them -- "must preserve the existing research stage and research
      // summary rather than overwrite/reset them" -- and this now runs
      // AFTER the accounts RPC has already succeeded, so a rejected RPC
      // call never leaves a PATCHed ha_uploads row behind it.
      if(!isAccountsMaintenance && !isNewUpload){
        const uploadRow = {
          user_id: user.id,
          upload_name: clean(body.uploadName || 'Uploaded account list'),
          stage,
          summary,
          source_page: clean(body.page || body.sourcePage),
          updated_at: new Date().toISOString()
        };
        await supabase(`ha_uploads?id=eq.${encodeURIComponent(uploadId)}&user_id=eq.${encodeURIComponent(user.id)}`, {
          method:'PATCH',
          body: JSON.stringify(uploadRow)
        });
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
      const legacyRowsForBridge = await fetchLegacySignalsForAccounts(user.id, unlockedAccounts.map(a => clean(a.name || a.accountName)));
      const bridgeStats = applyLegacyFingerprintBridge(legacyRowsForBridge, resolvedSignals);
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
          const chunk = signalRows.slice(i, i+chunkSize);
          const inserted = await supabase('ha_signals?on_conflict=user_id,event_fingerprint', {
            method:'POST',
            prefer:'resolution=ignore-duplicates,return=representation',
            body: JSON.stringify(chunk)
          });
          if(Array.isArray(inserted)) insertedFingerprints.push(...inserted.map(r => r.event_fingerprint));
        }
        // QA correction 4: every row in signalRows now exists (either just
        // inserted above, or already existed before this request) -- this
        // second upsert always takes the ON CONFLICT UPDATE branch, never
        // the INSERT branch, so omitting first_seen_at from the payload is
        // safe (see refreshableSignalRow()'s header comment).
        const refreshRows = signalRows.map(refreshableSignalRow);
        for(let i=0;i<refreshRows.length;i+=chunkSize){
          await supabase('ha_signals?on_conflict=user_id,event_fingerprint', {
            method:'POST',
            prefer:'resolution=merge-duplicates',
            body: JSON.stringify(refreshRows.slice(i, i+chunkSize))
          });
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
        legacyFingerprintsBridged: bridgeStats.bridged,
        legacyMultiMatchCount: bridgeStats.multiMatch,
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
    const legacyRowsForBridge = await fetchLegacySignalsForAccounts(user.id, unlockedAccounts.map(a => clean(a.name || a.accountName)));
    const bridgeStats = applyLegacyFingerprintBridge(legacyRowsForBridge, resolvedSignals);
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
      // Migration 8: the submitted account snapshot does not match this
      // upload's own existing account_name set (an added, removed,
      // renamed, or foreign-upload account) -- see
      // supabase-schema-migration-8-tracked-research-identity-guard.sql.
      // Nothing was written; surfaced distinctly so the client can tell
      // this apart from a generic failure and from a stale-attempt 409.
      if(err.code === 'HA005'){
        return json(res, 409, {error:'This research save does not match the upload it targeted; nothing was saved.', snapshotMismatch:true});
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
      legacyFingerprintsBridged: bridgeStats.bridged,
      legacyMultiMatchCount: bridgeStats.multiMatch,
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
