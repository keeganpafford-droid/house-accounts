// Vercel Serverless Function: weekly monitoring scan + email report.
// Endpoint: GET /api/weekly-scan
//
// Query params:
//   ?limit=<n>      Bounds how many uploads the normal sweep processes
//                    (default 25, max 100). Ignored entirely when uploadId
//                    is present.
//   ?dryRun=true     Suppresses the outbound email only — every database
//                    write (run creation, stale-run settlement, progress
//                    PATCHes, signal persistence) still happens for real.
//   ?uploadId=<uuid> Operational/admin capability: restricts this invocation
//                    to exactly one upload instead of the normal
//                    limit-bounded sweep, for a targeted rerun or production
//                    debugging session (e.g. re-processing a single
//                    customer's list after a fix, without touching every
//                    other monitored upload). Returns 404 if the id doesn't
//                    resolve to an existing upload. Adds no separate
//                    authorization path — CRON_SECRET (below) still gates
//                    the whole request exactly as it does without this
//                    parameter; uploadId can only narrow what an
//                    already-authorized request processes, never bypass
//                    the check. When absent, behavior is unchanged from
//                    before this parameter existed.

import { timingSafeEqual } from 'crypto';
import { resolveOpportunityEvents, dedupeByEventFingerprint, isCommercialIntelligenceSignal } from './signal-intelligence.js';
// Foundation freeze, Phase 1B -- weekly scan writes through the identical
// resolveOpportunityEvents() -> event_fingerprint -> ha_signals insert path
// api/save-upload.js uses, but previously had no legacy compatibility
// bridge at all, meaning an unattended weekly rediscovery of an event that
// already has a legacy-format row could reinsert exactly the v1->v2
// duplicate the bridge exists to prevent. Reusing save-upload.js's own
// tested primitives here (rather than a second, divergent implementation)
// is deliberate -- see that file's header comment on the bridge for the
// full rationale.
import { fetchLegacySignalsForAccounts, applyLegacyFingerprintBridge } from './save-upload.js';
// QA round 3, item 1/6: digest eligibility is validated through the SAME
// canonical actionability boundary as every other reader (get-dashboard.js),
// never by trusting a persisted row's actionabilityStatus.isPriorityEligible
// directly.
import { classifyLegacySignalActionability } from './research-batch.js';
// Phase 2B founder Queue dark-run: see the call site below for why this
// legacy sweep must exclude Queue-managed organizations.
import { isQueueManagedOrganization } from './lib/monitoring-queue.js';

// Constant-time-ish secret comparison: equal-length secrets are compared via
// crypto.timingSafeEqual (no early-exit on byte mismatch); a length mismatch
// short-circuits to false since Node's timingSafeEqual throws on unequal
// lengths and there is no secret-dependent information to protect in a
// length check alone. Never logs either input.
function safeSecretEqual(provided, expected) {
  const providedBuf = Buffer.from(String(provided || ''), 'utf8');
  const expectedBuf = Buffer.from(String(expected || ''), 'utf8');
  if (providedBuf.length !== expectedBuf.length) return false;
  return timingSafeEqual(providedBuf, expectedBuf);
}

// ---------------------------------------------------------------------------
// Priority 0 (reliability) — hung weekly-run repair.
//
// Confirmed production root cause: this file made an unbounded, no-timeout
// fetch() to /api/research-batch inside a Vercel Serverless Function with no
// maxDuration override anywhere in this repo (confirmed by grep). When the
// platform's function-duration limit was hit mid-await, the host killed the
// process — not a catchable JS exception — so neither the success-path nor
// the failure-path PATCH to ha_weekly_runs ever ran, leaving
// status='running' / finished_at=NULL / summary frozen at its creation value
// indefinitely. A `finally` block cannot fix this: it cannot execute after a
// platform hard-kill either, so the fix here does not rely on one as the
// primary guard.
// ---------------------------------------------------------------------------

// No maxDuration override existed anywhere in this repo before this fix, and
// the repo alone could not prove the actual platform ceiling — Fluid Compute
// is a project-level setting (dashboard, or vercel.json's "fluid" key, which
// this repo also does not set) that isn't inferable from code. VERIFIED
// directly in the Vercel dashboard (Project Settings -> Functions) for this
// project: Fluid Compute is Enabled, the plan is Pro, and the configured
// Default Max Duration is 300 seconds. That is the real, confirmed ceiling
// this budget is built against — not an assumed legacy-Hobby number.
//
// The actual maxDuration override lives in vercel.json's "functions" block
// (this project is zero-config/framework-less, and current Vercel guidance
// for that project type is to configure duration there), not as an in-file
// `export const config`. Precedence between the two mechanisms when both are
// present is not clearly documented, so this file intentionally does not
// also export one — a single source of truth beats two that could drift.
// The constant below must be kept in sync with vercel.json's value for
// api/weekly-scan.js by hand; there is no way to import one into the other.
const FUNCTION_MAX_DURATION_MS = 300000;
// Reserved, unconditionally, for the last completion/failure PATCH plus
// building the JSON response, after chunk processing stops for any reason.
// Kept small in absolute terms even though the budget is now much larger —
// a couple of small Supabase PATCH calls never need more than this.
const FINALIZE_RESERVE_MS = 10000;
// Bound on a single research-batch chunk request. Deliberately NOT paired
// with a same-invocation retry: a retry on a genuine timeout spends the same
// budget again with no reason to expect a different outcome, and a retry on
// a slow-but-not-timed-out error risks stacking two near-timeout durations
// back to back, which is exactly the unpredictable-budget failure mode this
// fix removes. A failed/timed-out chunk is safely recoverable on a later,
// separate invocation (see the event-fingerprint dedup work — point 7 below).
// 60s gives real AI/web-search work in research-batch.js room to actually
// complete, while still comfortably supporting multiple chunks per
// invocation within the confirmed 300s budget (see maxChunksSafely below).
const RESEARCH_FETCH_TIMEOUT_MS = 60000;
// A run still 'running' this long after it started did not survive its own
// invocation (300s max) by any legitimate path — it was killed by the
// platform or crashed. 15 minutes stays comfortably longer (3x) than the
// confirmed maximum legitimate run, while remaining short enough to settle a
// stuck run the next time this upload is processed rather than leaving it
// stuck until the next weekly cron cycle notices it "by accident."
const STALE_RUN_THRESHOLD_MS = 15 * 60 * 1000;
// How many chunks can safely be attempted in one invocation, given the
// confirmed budget: (300s - 10s reserve) / 60s per chunk = 4, leaving
// meaningful slack for progress-PATCH overhead and the stale-run sweep
// rather than exactly exhausting the budget. Informational/diagnostic only —
// the actual stop condition is the real deadline check in the handler below,
// not this count, so a slow chunk still can't blow the budget even if fewer
// than 4 chunks were expected to be needed.
const MAX_CHUNKS_SAFELY_PER_INVOCATION = Math.floor((FUNCTION_MAX_DURATION_MS - FINALIZE_RESERVE_MS) / RESEARCH_FETCH_TIMEOUT_MS);

function computeDeadline(invocationStartMs){
  return invocationStartMs + FUNCTION_MAX_DURATION_MS - FINALIZE_RESERVE_MS;
}

// A run is stale only if it is still 'running' and started long enough ago
// that no legitimate invocation of this function could still be executing it.
function isStaleRun(run, { thresholdMs = STALE_RUN_THRESHOLD_MS, now = Date.now() } = {}){
  if(!run || run.status !== 'running') return false;
  const startedAt = new Date(run.started_at || 0).getTime();
  if(!Number.isFinite(startedAt) || startedAt <= 0) return false;
  return (now - startedAt) > thresholdMs;
}

// Bounds a single fetch with an AbortController. Normalizes the abort into a
// distinguishable AbortError so callers can tell "our own timeout fired"
// apart from any other network/HTTP failure.
async function fetchWithTimeout(url, options = {}, timeoutMs = RESEARCH_FETCH_TIMEOUT_MS){
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try{
    return await fetch(url, { ...options, signal: controller.signal });
  }catch(err){
    if(err?.name === 'AbortError'){
      const timeoutErr = new Error(`research-batch request exceeded ${timeoutMs}ms`);
      timeoutErr.name = 'AbortError';
      throw timeoutErr;
    }
    throw err;
  }finally{
    clearTimeout(timer);
  }
}

// Extracts one chunk's outcome from a research-batch response (or the
// synthetic all-failed shape used when the chunk never got a response at all).
function summarizeChunkResult(chunk, batchLength){
  const s = chunk?.diagnostics?.structuredSummary || {};
  const processed = Number(s.processedAccounts || 0);
  const failed = Number(s.failedAccounts || 0);
  const attempted = Number(s.eligibleAccounts || batchLength || (processed + failed));
  return { accountsAttempted: attempted, accountsProcessed: processed, accountsFailed: failed };
}

// Folds one chunk's outcome into the run's cumulative, persistable progress
// summary. Only ever adds to prior counts — never replaces them — so a kill
// between chunks leaves the last successfully-persisted totals intact rather
// than losing everything back to the creation-time summary.
function accumulateProgress(prevSummary, { chunkIndex, totalChunks, chunkOutcome, chunkDiagnostics, totalAccounts }){
  const prev = prevSummary || {};
  return {
    accounts: totalAccounts,
    totalChunks,
    chunksAttempted: Number(prev.chunksAttempted || 0) + 1,
    chunksCompleted: Number(prev.chunksCompleted || 0) + (chunkOutcome.completed ? 1 : 0),
    lastCompletedChunk: chunkOutcome.completed ? chunkIndex : (prev.lastCompletedChunk ?? 0),
    accountsAttempted: Number(prev.accountsAttempted || 0) + chunkOutcome.accountsAttempted,
    accountsProcessed: Number(prev.accountsProcessed || 0) + chunkOutcome.accountsProcessed,
    accountsFailed: Number(prev.accountsFailed || 0) + chunkOutcome.accountsFailed,
    diagnostics: [...(prev.diagnostics || []), chunkDiagnostics].filter(Boolean),
    progressUpdatedAt: new Date().toISOString()
  };
}

// Decides the final, explicit outcome state for a run. 'running' is never a
// value this returns — it is the transient starting state only, settled
// here at the end of a normal invocation, or by isStaleRun() on a later one
// if this invocation never reaches this point at all.
function decideFinalStatus({ accountsProcessed, accountsFailed, totalAccounts, sawTimeout }){
  if(accountsProcessed <= 0) return sawTimeout ? 'timed_out' : 'failed';
  if(accountsProcessed >= totalAccounts && accountsFailed === 0 && !sawTimeout) return 'complete';
  return 'partial';
}

function json(res, status, body){ return res.status(status).json(body); }
function clean(v=''){ return String(v || '').trim(); }
function hashString(input=''){
  let h = 2166136261;
  const s = String(input || '');
  for(let i=0;i<s.length;i++){ h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(16);
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
    const httpErr = new Error(`Supabase ${resp.status}: ${msg}`);
    // Attached so callers can distinguish specific failure modes (e.g. a
    // 409 unique-violation) without re-parsing the message string for a
    // status code that is already known here.
    httpErr.status = resp.status;
    throw httpErr;
  }
  return data;
}
function signalHash(userId, uploadId, accountName, s){
  return hashString([userId, uploadId, accountName, s.signalType || s.type || '', s.signalTitle || s.title || s.whatChanged || '', s.sourceUrl || s.source || ''].join('|').toLowerCase());
}
// product/commercial-opportunity-intelligence, QA correction 4 (re-research
// persistence) -- same allowlist and rationale as api/save-upload.js's own
// refreshableSignalRow(): never event_fingerprint/user_id (identity, must
// stay stable) and never first_seen_at (when we first learned about it),
// but every column that represents our CURRENT interpretation of the event.
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
function getBaseUrl(req){
  if(process.env.APP_BASE_URL) return process.env.APP_BASE_URL.replace(/\/$/, '');
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const proto = req.headers['x-forwarded-proto'] || 'https';
  return `${proto}://${host}`;
}
function accountPayload(row){
  const raw = row.raw_data || {};
  const metrics = row.metrics || {};
  return {
    name: row.account_name,
    // Correction: the eligibility filter below (accountPayloads.filter)
    // has always checked a.monitoringStatus, but this function never
    // actually set it -- the real per-account pause flag api/
    // monitoring-lists.js's pause-account action writes lives at
    // raw_data.monitoring_status (snake_case), so the filter was a
    // permanent no-op and an individually-paused account was still
    // re-researched every week. Same field api/lib/entitlement.js's
    // usageFor() now reads for capacity -- one pause definition, not two.
    monitoringStatus: raw.monitoring_status || 'active',
    industry: row.industry || raw.industry || '',
    contactName: row.contact_name || raw.contactName || '',
    contactEmail: row.contact_email || raw.contactEmail || '',
    contacts: Array.isArray(raw.contacts) ? raw.contacts : [],
    website: raw.website || '',
    location: raw.location || '',
    assignedRep: raw.assignedRep || raw.assigned_rep || '',
    intelligenceMode: raw.intelligenceMode || raw.intelligence_mode || (Number(metrics.orderCount || 0) > 0 ? 'historical' : 'warm'),
    notes: raw.notes || '',
    employees: raw.employees || '',
    orderCount: metrics.orderCount || 0,
    revenue: metrics.revenue || 0,
    relationshipStrength: metrics.relationshipStrength || 0,
    historicalCategories: raw.historicalCategories || [],
    historicalProjects: raw.historicalProjects || [],
    recentOrderDates: raw.recentOrderDates || [],
    existingSignals: raw.existingSignals || [],
    repeatPatterns: raw.repeatPatterns || [],
    // Core defect fix (same root cause as api/research-batch.js's
    // safeAccounts): raw_data.purchases is already persisted on every save
    // (dashboard/index.html's serializeAccountForStorage()) but this
    // function never read it back out, so the weekly automated scan sent
    // no purchase history at all -- api/research-batch.js's own
    // pairedPurchases() normalizes this raw record shape into the paired
    // {category, project, dateStr} shape findLikelyRelatedPurchase() and
    // the live model's prompt context both need.
    purchases: raw.purchases || []
  };
}

// Commercial-readiness correction round (final): the functional gap this
// closes -- account-history opportunities (recent-order follow-ups,
// upcoming/current/overdue reorder patterns) were computed and displayed
// correctly on the dashboard, but never entered the weekly digest's own
// input at all. The dashboard already computes and persists them on every
// save (dashboard/index.html's serializeAccountForStorage() writes
// existingSignals/repeatPatterns into ha_accounts.raw_data, and
// accountPayload() above already reads both back out) -- so this reads
// that ALREADY-COMPUTED, ALREADY-GROUNDED data (the exact same
// signalLayerType/opportunityType/whyNow/reasonToReachOut/
// conversationStarter text a rep sees on the dashboard, including this
// round's corrected wording and lapsed-window honesty) rather than
// recomputing anything server-side or adding a new table/migration.
//
// Deliberately excludes generic, non-grounded Repeat/Pattern-Signal
// opportunities (opportunityType !== 'REPEAT PATTERN') from the digest --
// same reasoning as the dashboard's own collapseDuplicateGenericRepeatSignals():
// they are not evidence of a real detected reorder cadence, just an
// industry-template guess, and do not belong in an actionability
// notification like the digest.
//
// Honest limitation (documented, not fixed here, per "do not add a new
// persistence table or migration"): unlike business signals (deduped
// across invocations via the persisted event_fingerprint unique
// constraint), there is no persisted "already digested this account-
// history opportunity" record. A reorder opportunity that is still
// current/approaching next week will appear in next week's digest again,
// for as long as the underlying condition holds. Exact duplicates WITHIN
// one invocation (the required, in-scope guarantee) are still fully
// prevented -- see the per-account collapse below and dedupeDigestRows().
function deriveAccountHistoryDigestRows(accountPayloads){
  const rows = [];
  for(const account of accountPayloads || []){
    if(!account || !account.name) continue;
    const existingSignals = Array.isArray(account.existingSignals) ? account.existingSignals : [];
    const repeatPatterns = Array.isArray(account.repeatPatterns) ? account.repeatPatterns : [];

    // At most one Follow-Up Signal per account -- the highest-scoring one --
    // mirroring the dashboard's own collapseDuplicateFollowUps() (every
    // Follow-Up template for one account describes the SAME single recent
    // order, never genuinely distinct orders; see that function's comment).
    const followUp = existingSignals
      .filter(o => o && o.signalLayerType === 'Follow-Up Signal')
      .sort((a, b) => Number(b.quickWinScore || b.confidence || 0) - Number(a.quickWinScore || a.confidence || 0))[0];
    if(followUp){
      rows.push({
        account_name: account.name,
        signal_type: 'Follow-Up Signal',
        why_reach_out: clean(followUp.whyNow || followUp.reasonToReachOut || ''),
        payload: { suggestedNextMove: followUp.conversationStarter || '', signalTitle: followUp.opportunity || followUp.opportunityName || '' }
      });
    }

    // Every genuine, grounded reorder pattern (one per real detected
    // category cadence) -- deduped by opportunity name as a defensive
    // safety net against a stale/double-saved persisted duplicate.
    const seenPatternKeys = new Set();
    for(const pattern of repeatPatterns){
      if(!pattern || pattern.opportunityType !== 'REPEAT PATTERN') continue;
      const key = String(pattern.opportunity || pattern.opportunityName || '').toLowerCase().trim();
      if(!key || seenPatternKeys.has(key)) continue;
      seenPatternKeys.add(key);
      rows.push({
        account_name: account.name,
        signal_type: 'Repeat / Pattern Signal',
        why_reach_out: clean(pattern.whyNow || pattern.reasonToReachOut || ''),
        payload: { suggestedNextMove: pattern.conversationStarter || '', signalTitle: pattern.opportunity || pattern.opportunityName || '' }
      });
    }
  }
  return rows;
}

// Required proof (duplicate history opportunities produce one digest
// entry): a final, cheap safety net applied to the whole consolidated
// bucket right before send -- catches the case deriveAccountHistoryDigestRows()'s
// own per-upload dedup cannot see on its own, the SAME account appearing
// in two different uploads this user owns with the same underlying
// opportunity. Business-signal rows (which already carry a DB-enforced
// unique event_fingerprint) are unaffected in practice -- two genuinely
// different real events for the same account essentially never produce
// byte-identical why_reach_out text, so this key does not merge them.
function dedupeDigestRows(rows){
  const seen = new Set();
  const out = [];
  for(const row of rows || []){
    const key = `${String(row.account_name || '').toLowerCase().trim()}|${String(row.signal_type || '').toLowerCase().trim()}|${String(row.why_reach_out || '').toLowerCase().trim()}`;
    if(seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}

async function sendEmail({to, subject, html}){
  const key = process.env.RESEND_API_KEY;
  if(!key) return {skipped:true, reason:'Missing RESEND_API_KEY'};
  const from = process.env.ALERTS_FROM_EMAIL || 'House Accounts <alerts@houseaccounts.ai>';
  const resp = await fetch('https://api.resend.com/emails', {
    method:'POST',
    headers:{Authorization:`Bearer ${key}`, 'Content-Type':'application/json'},
    body: JSON.stringify({from, to, subject, html})
  });
  const data = await resp.json().catch(()=>({}));
  if(!resp.ok) throw new Error(`Resend ${resp.status}: ${data.message || JSON.stringify(data)}`);
  return data;
}
function escapeHtml(value=''){
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
function firstNameFromUser(user={}){
  const name = clean(user.name || '');
  if(!name || name.includes('@')) return '';
  return name.split(/\s+/)[0] || '';
}
function weeklyBriefSubject(newSignals=[]){
  const count = newSignals.length;
  if(count === 1){
    const topAccount = clean(newSignals[0]?.account_name) || 'your top account';
    return `1 new reason to reach out this week: ${topAccount}`;
  }
  return `${count} new reasons to reach out this week`;
}
function metricRows(summary={}){
  const rows = [
    ['New Opportunities', summary.opportunityCount],
    ['Business Activity Signals', summary.businessSignalCount],
    ['Follow-up Opportunities', summary.followUpCount],
    ['Repeat Buying Opportunities', summary.repeatBuyingCount],
    ['Accounts Monitored', summary.accountsMonitored]
  ];
  return rows
    .filter(([,value]) => Number.isFinite(Number(value)) && Number(value) >= 0)
    .map(([label,value]) => `<li style="margin:6px 0;"><strong>${Number(value)}</strong> ${escapeHtml(label)}</li>`)
    .join('');
}
function signalCategory(signalType=''){
  const type = String(signalType || '').toLowerCase();
  if(type.includes('repeat') || type.includes('reorder') || type.includes('buying')) return 'repeat';
  if(type.includes('follow')) return 'followUp';
  return 'business';
}
function suggestedNextMove(signal={}){
  const payload = signal.payload || {};
  return clean(
    payload.suggestedNextMove ||
    payload.recommendedNextStep ||
    payload.suggestedOpener ||
    payload.nextStep ||
    signal.why_reach_out ||
    'Open the account and decide whether to call, email, or ask for a referral this week.'
  );
}
// product/commercial-opportunity-intelligence, QA correction 1: a
// new-schema signal (went through normalizeCommercialIntelligence(),
// confirmed by isCommercialIntelligenceSignal()) whose model declined to
// produce a commercialPlay has NO credible commercial interpretation --
// signal.why_reach_out/payload.whyItMattersForPromo are, in that specific
// case, only the deterministic legacy-compatibility fallback text
// (makeSignal()'s salesReadyWhy()/makeAISignal()'s equivalent), kept
// populated purely so validateOpportunity() and old code paths never see
// an empty required field. That fallback text is generic sales-category
// language ("Facility launches usually create needs around employee
// apparel...") that reads exactly like a fabricated commercial play --
// surfacing it in the weekly digest would silently resurrect the recommendation
// the primary card and Prepare for Call correctly declined to show,
// contradicting the "absence of a credible play is meaningful" principle.
// A real commercialPlay.narrative (when present) is preferred FIRST, richer
// than the legacy fields it was itself derived from.
function whyItMatters(signal={}){
  const payload = signal.payload || {};
  if(isCommercialIntelligenceSignal(payload) && !(payload.commercialPlay && payload.commercialPlay.narrative)){
    return clean(payload.signalTitle || signal.title || 'This account showed a timely public update.');
  }
  return clean(
    payload.commercialPlay?.narrative ||
    signal.why_reach_out ||
    payload.whyItMattersForPromo ||
    payload.whyItMatters ||
    payload.opportunitySummary ||
    payload.signalTitle ||
    signal.title ||
    'This account showed a timely reason to reconnect.'
  );
}
function opportunityCardHtml(signal={}){
  const account = escapeHtml(signal.account_name || 'Account');
  const signalType = escapeHtml(signal.signal_type || 'Business Activity');
  const why = escapeHtml(whyItMatters(signal));
  const nextMove = escapeHtml(suggestedNextMove(signal));

  return `<div style="border:1px solid #D8DEE9;border-radius:14px;background:#ffffff;padding:18px 18px 16px;margin:16px 0;">
    <h2 style="font-size:18px;line-height:1.3;margin:0 0 12px;color:#17375E;">${account}</h2>
    <div style="margin:0 0 12px;">
      <div style="font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;color:#6b7280;margin-bottom:3px;">Signal</div>
      <div style="font-size:14px;color:#17375E;">${signalType}</div>
    </div>
    <div style="margin:0 0 12px;">
      <div style="font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;color:#6b7280;margin-bottom:3px;">Why it matters</div>
      <div style="font-size:14px;color:#25364d;line-height:1.5;">${why}</div>
    </div>
    <div>
      <div style="font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;color:#6b7280;margin-bottom:3px;">Suggested next move</div>
      <div style="font-size:14px;color:#25364d;line-height:1.5;">${nextMove}</div>
    </div>
  </div>`;
}
function weeklySummaryFromSignals(newSignals=[], accountsMonitored){
  const summary = {
    opportunityCount: newSignals.length,
    businessSignalCount: 0,
    followUpCount: 0,
    repeatBuyingCount: 0,
    accountsMonitored
  };
  for(const signal of newSignals){
    const category = signalCategory(signal.signal_type || signal.title || '');
    if(category === 'repeat') summary.repeatBuyingCount += 1;
    else if(category === 'followUp') summary.followUpCount += 1;
    else summary.businessSignalCount += 1;
  }
  return summary;
}
function reportHtml(user, upload, newSignals, baseUrl, summary={}){
  const firstName = firstNameFromUser(user);
  const opportunityCount = newSignals.length;
  const dashboardUrl = `${String(baseUrl || '').replace(/\/$/,'')}?dashboardEmail=${encodeURIComponent(user.email || '')}`;
  const topOpportunities = newSignals.slice(0,3);
  const cards = topOpportunities.map(opportunityCardHtml).join('');
  const extraCount = Math.max(opportunityCount - topOpportunities.length, 0);
  const extraCopy = extraCount > 0
    ? `<p style="margin:8px 0 0;color:#5b677a;font-size:14px;">There ${extraCount===1?'is':'are'} ${extraCount} more ${extraCount===1?'opportunity':'opportunities'} waiting in your dashboard.</p>`
    : '';
  const summaryRows = metricRows(summary);
  const greeting = firstName ? `Good morning, ${escapeHtml(firstName)}.` : 'Good morning.';

  return `<div style="margin:0;padding:0;background:#F7F8FA;font-family:Arial,sans-serif;color:#17375E;">
    <div style="max-width:680px;margin:0 auto;padding:28px 16px;">
      <div style="background:#ffffff;border:1px solid #D8DEE9;border-radius:18px;padding:28px;">
        <div style="font-size:13px;font-weight:700;color:#1FB7AE;letter-spacing:.04em;text-transform:uppercase;margin-bottom:8px;">House Accounts</div>
        <h1 style="font-size:28px;line-height:1.2;margin:0 0 12px;color:#17375E;">Your Monday House Accounts Brief</h1>
        <p style="font-size:16px;line-height:1.55;margin:0 0 4px;color:#25364d;">${greeting}</p>
        <p style="font-size:16px;line-height:1.55;margin:0 0 20px;color:#25364d;">We found <strong>${opportunityCount}</strong> new ${opportunityCount===1?'opportunity':'opportunities'} across your monitored accounts this week.</p>

        ${cards}
        ${extraCopy}

        ${summaryRows ? `<div style="background:#F7F8FA;border:1px solid #D8DEE9;border-radius:14px;padding:16px 18px;margin:22px 0 0;">
          <h3 style="font-size:16px;margin:0 0 8px;color:#17375E;">This Week's Summary</h3>
          <ul style="margin:0;padding-left:20px;color:#25364d;font-size:14px;line-height:1.45;">${summaryRows}</ul>
        </div>` : ''}

        <div style="margin:26px 0 0;">
          <a href="${dashboardUrl}" style="display:inline-block;background:#1FB7AE;color:#ffffff;padding:14px 22px;text-decoration:none;border-radius:8px;font-weight:700;font-size:15px;">Open Dashboard →</a>
        </div>
      </div>
      <p style="text-align:center;margin:16px 0 0;color:#7b8794;font-size:12px;">House Accounts helps you focus on who to contact this week, and why.</p>
    </div>
  </div>`;
}

export default async function handler(req, res){
  const invocationStart = Date.now();
  const deadline = computeDeadline(invocationStart);
  try{
    // Fail-closed authorization: this must be the very first thing the
    // handler does, before any query parameter (dryRun/uploadId/limit) is
    // read and before any Supabase, provider, or email work. A missing
    // CRON_SECRET is a misconfiguration, not an "open" state -- it now
    // returns 503 instead of silently skipping authorization. The secret is
    // accepted only via the Authorization: Bearer header; the previous
    // ?secret= query-string fallback has been removed. Neither the supplied
    // nor the expected value is ever logged.
    const cronSecret = process.env.CRON_SECRET;
    if (!cronSecret) return json(res, 503, {error:'Service unavailable: not configured.'});
    const authHeader = req.headers.authorization || '';
    const bearerMatch = /^Bearer\s+(.+)$/i.exec(authHeader);
    const providedSecret = bearerMatch ? bearerMatch[1] : '';
    if (!providedSecret || !safeSecretEqual(providedSecret, cronSecret)) {
      return json(res, 401, {error:'Unauthorized'});
    }

    const dryRun = String(req.query?.dryRun || '').toLowerCase() === 'true';
    // Operational/admin targeting: ?uploadId=<uuid> restricts this invocation
    // to exactly one upload, for a manual rerun or production debugging
    // session, instead of the normal limit-bounded sweep across every
    // monitored upload. This is read only after the authorization check
    // above and adds no separate authorization path of its own — it cannot
    // be used to bypass authorization, only to narrow what an
    // already-authorized request processes. When absent, behavior is
    // byte-for-byte the same as before this parameter existed: the
    // limit-bounded query below still decides what gets processed, and
    // `limit` is otherwise unused/ignored.
    const requestedUploadId = clean(req.query?.uploadId || '');
    let uploads;
    if(requestedUploadId){
      let targetedUpload = null;
      try{
        const found = await supabase(`ha_uploads?id=eq.${encodeURIComponent(requestedUploadId)}&select=id,user_id,upload_name,summary,created_at,ha_users(id,email,name,company)&limit=1`);
        targetedUpload = Array.isArray(found) ? found[0] : null;
      }catch{
        // A malformed uploadId (not a valid uuid) surfaces as a PostgREST
        // error here — treated the same as "not found" from the caller's
        // perspective (a 404), not a 500, since this is a client input
        // problem, not a system failure.
        targetedUpload = null;
      }
      if(!targetedUpload) return json(res, 404, {error:`No upload found for uploadId=${requestedUploadId}`});
      uploads = [targetedUpload];
    } else {
      const limit = Math.min(Number(req.query?.limit || 25), 100);
      uploads = await supabase(`ha_uploads?select=id,user_id,upload_name,summary,created_at,ha_users(id,email,name,company,organization_id)&order=updated_at.desc&limit=${limit}`);
    }
    const baseUrl = getBaseUrl(req);
    const runSummary = [];
    // Priority 6: newly-inserted signals accumulate here across every
    // upload processed in this invocation, keyed by user id, so a user with
    // multiple uploads gets exactly one consolidated digest email instead
    // of one email per upload. Drained after the per-upload loop below.
    //
    // Reconciliation item 3 -- known beta limitation, intentionally not
    // closed in this pass (would require a migration): this Map is
    // per-invocation, in-memory state, not a persisted
    // one-digest-per-user-per-delivery-period guarantee. The event-fingerprint
    // unique constraint on ha_signals means a second invocation within the
    // same delivery period never re-emails about the SAME event (its insert
    // is silently ignore-duplicated, so it never lands in newSignalRows
    // again) -- but if a second invocation genuinely discovers different new
    // events for the same user within that period (e.g. a retry, a manual
    // re-trigger, or a cron double-fire), that invocation independently
    // sends its own additional digest. There is no persisted "already sent
    // user X a digest for period Y" record to prevent that. Tracked as
    // backlog, not fixed here per this reconciliation's explicit no-migration
    // constraint.
    const perUserDigest = new Map();

    for(const upload of uploads || []){
      const user = upload.ha_users;
      if(!user?.email) continue;
      // Phase 2B founder Queue dark-run: an organization explicitly listed in
      // QUEUE_MANAGED_ORGANIZATION_IDS is being monitored by the new
      // scheduler/Queue/worker path instead (see api/monitoring-scheduler.js
      // and api/lib/monitoring-queue.js) -- this legacy sweep must not also
      // research it, or the same account would be researched (and billed for)
      // twice and could produce duplicate digest emails. Empty/unset by
      // default, so this is a no-op for every organization until the founder
      // deliberately opts one in for the dark run -- no existing Beta
      // organization's monitoring is affected by this change alone.
      if(isQueueManagedOrganization(user.organization_id, process.env.QUEUE_MANAGED_ORGANIZATION_IDS)) continue;

      // Settle any prior run for this upload that never reached a completion
      // PATCH (killed by a platform timeout, crash, etc.) before doing
      // anything else for this upload — deliberately BEFORE the
      // eligible-accounts check below, not after. A run can get stuck while
      // its accounts were still eligible, then have every one of them later
      // marked paused/archived (or removed); if settlement only ran after
      // the eligible-accounts gate, the early `continue` on zero eligible
      // accounts would skip settlement entirely and that stuck run would
      // never be revisited by any future invocation. Settlement must not
      // depend on this upload still having eligible accounts today.
      try{
        // select= must include `status`: isStaleRun()'s guard reads
        // run.status directly, and PostgREST's select= is a column
        // projection — status=eq.running above is a server-side filter, it
        // does not add `status` to the returned row on its own. Omitting it
        // here previously made isStaleRun() see `undefined` for every row,
        // never settling anything regardless of age (confirmed against the
        // July 27 production row: it survived a full successful reprocessing
        // of its own upload because this exact query never actually
        // observed it as running).
        const priorRunning = await supabase(`ha_weekly_runs?upload_id=eq.${encodeURIComponent(upload.id)}&status=eq.running&select=id,status,started_at,summary&limit=20`);
        for(const staleRun of priorRunning || []){
          if(!isStaleRun(staleRun, { now: invocationStart })) continue;
          await supabase(`ha_weekly_runs?id=eq.${encodeURIComponent(staleRun.id)}`, {method:'PATCH', body: JSON.stringify({
            status:'timed_out',
            finished_at:new Date().toISOString(),
            summary:{ ...(staleRun.summary||{}), timeoutReason:`No completion PATCH was recorded within ${STALE_RUN_THRESHOLD_MS}ms of started_at; settled as stale by a later invocation.` }
          })});
        }
      }catch(staleErr){
        console.error('[Weekly Scan] failed to settle stale runs for upload', upload.id, staleErr);
      }

      const accounts = await supabase(`ha_accounts?select=*&upload_id=eq.${encodeURIComponent(upload.id)}&limit=5000`);
      const accountPayloads = (accounts || []).map(accountPayload).filter(a => a.name && !['paused','archived'].includes(clean(a.monitoringStatus || '').toLowerCase()));
      if(!accountPayloads.length) continue;

      // Computed here (cheap, synchronous, no network/provider call) so it
      // is captured even if this upload's business-signal research below
      // is skipped or partially cut off by the invocation deadline --
      // account-history opportunities come entirely from already-stored
      // order history, independent of this run's research outcome.
      const accountHistoryDigestRows = deriveAccountHistoryDigestRows(accountPayloads);

      if(Date.now() >= deadline){
        // No time left in this invocation to even start this upload. It is
        // simply not processed this cycle — no 'running' row is created, so
        // there is nothing left stuck. It will be picked up on the next
        // invocation that reaches it.
        runSummary.push({uploadId:upload.id, email:user.email, skipped:true, reason:'invocation deadline reached before this upload could start'});
        continue;
      }

      const started = new Date().toISOString();
      const totalAccounts = accountPayloads.length;
      // Default kept at 5 (not restored to the confirmed-safe budget's
      // theoretical max) so the confirmed 10-account production case still
      // exercises 2 chunks — real progress-persistence granularity, not one
      // giant chunk that only PATCHes once at the end. The env override is
      // preserved. Its upper clamp is restored to the original 25: unlike
      // before this fix, a large chunk is no longer catastrophic even if an
      // operator overrides upward — RESEARCH_FETCH_TIMEOUT_MS bounds every
      // chunk unconditionally now, regardless of size, so a too-large chunk
      // just risks that one chunk being marked failed/timed-out rather than
      // hanging the whole invocation.
      const batchSize = Math.max(1, Math.min(Number(process.env.WEEKLY_RESEARCH_BATCH_SIZE || 5), 25));
      const totalChunks = Math.ceil(totalAccounts / batchSize);

      let run;
      try{
        const runRows = await supabase('ha_weekly_runs', {method:'POST', body: JSON.stringify([{user_id:user.id, upload_id:upload.id, status:'running', started_at:started, summary:{
          accounts:totalAccounts, totalChunks, chunksAttempted:0, chunksCompleted:0,
          accountsAttempted:0, accountsProcessed:0, accountsFailed:0, diagnostics:[]
        }}])});
        run = Array.isArray(runRows) ? runRows[0] : runRows;
      }catch(createErr){
        // idx_ha_weekly_runs_one_running_per_upload (partial unique index on
        // upload_id where status='running') rejects this insert with a 409
        // if another invocation already holds a running row for this same
        // upload — e.g. an overlapping cron tick and a manual ?uploadId=
        // trigger, or two overlapping cron ticks. The stale-run sweep above
        // already settled anything actually stuck, so a conflict here means
        // a genuinely concurrent, still-live run owns this upload right now.
        // That is not a processing failure for THIS invocation: do not
        // create/mark a 'failed' run (there is nothing wrong — the other run
        // is doing the work), make no further calls for this upload
        // (no research-batch, no ha_signals writes), and report a clear,
        // operator-facing reason instead of a generic error.
        if(createErr?.status === 409 && /idx_ha_weekly_runs_one_running_per_upload/.test(createErr.message || '')){
          let activeRun = null;
          try{
            const activeRows = await supabase(`ha_weekly_runs?upload_id=eq.${encodeURIComponent(upload.id)}&status=eq.running&select=id,started_at&limit=1`);
            activeRun = Array.isArray(activeRows) ? activeRows[0] : null;
          }catch{
            // Best-effort diagnostic only — the skip below does not depend
            // on this lookup succeeding.
          }
          runSummary.push({
            uploadId:upload.id,
            email:user.email,
            skipped:true,
            reason: activeRun
              ? `another run (id=${activeRun.id}, started_at=${activeRun.started_at}) is already in progress for this upload`
              : 'another run is already in progress for this upload'
          });
          continue;
        }
        // Any other run-creation failure (network error, malformed
        // response, etc.) is a genuine problem, but it is isolated to this
        // upload — the same per-upload isolation the rest of this loop
        // already relies on — rather than aborting every remaining upload
        // in this invocation.
        console.error('[Weekly Scan] failed to create run for upload', upload.id, createErr);
        runSummary.push({uploadId:upload.id, email:user.email, error:createErr.message});
        continue;
      }

      let newSignalRows = [];
      let progressSummary = { accounts:totalAccounts, totalChunks, chunksAttempted:0, chunksCompleted:0, accountsAttempted:0, accountsProcessed:0, accountsFailed:0, diagnostics:[] };
      let sawTimeout = false;

      try{
        const researchChunks = [];
        let chunkIndex = 0;
        for(let offset=0; offset<accountPayloads.length; offset+=batchSize){
          chunkIndex += 1;
          if(Date.now() >= deadline){
            // Stop starting new chunks; whatever was persisted after the
            // last completed chunk stands as this run's progress.
            sawTimeout = true;
            break;
          }
          const batch = accountPayloads.slice(offset, offset + batchSize);
          let research = null;
          let chunkSucceeded = false;
          let chunkError = null;
          try{
            const researchResp = await fetchWithTimeout(`${baseUrl}/api/research-batch`, {
              method:'POST',
              headers:{'Content-Type':'application/json', 'Authorization': `Bearer ${cronSecret}`},
              body: JSON.stringify({mode:'weekly-monitoring', accounts: batch})
            }, RESEARCH_FETCH_TIMEOUT_MS);
            // Read the body once as text, then parse — a Response body can
            // only be consumed once, so this replaces .json() rather than
            // supplementing it. Every return path in research-batch.js
            // returns JSON (confirmed by reading the whole file: one
            // try/catch wraps its entire handler and every branch, including
            // its own catch-all, calls res.status(...).json(...)), so a
            // non-JSON body here is not a research-batch application error —
            // most likely a platform-level failure (e.g. a Vercel
            // function-invocation timeout or crash) whose error page is
            // plain text/HTML. Preserve exactly what's needed to diagnose
            // that, and nothing else: no request payload, no headers beyond
            // content-type, no API keys/secrets.
            const rawBody = await researchResp.text();
            let parsed;
            try{
              parsed = JSON.parse(rawBody);
            }catch{
              const contentType = researchResp.headers.get('content-type') || 'unknown';
              const vercelId = researchResp.headers.get('x-vercel-id');
              const bodyPreview = rawBody.replace(/\s+/g, ' ').trim().slice(0, 300);
              throw new Error(`research-batch returned non-JSON (HTTP ${researchResp.status}, content-type: ${contentType}${vercelId ? `, x-vercel-id: ${vercelId}` : ''}): ${bodyPreview}`);
            }
            if(!researchResp.ok) throw new Error(parsed.error || 'Research batch failed');
            research = parsed;
            chunkSucceeded = true;
          }catch(error){
            chunkError = error;
            if(error?.name === 'AbortError') sawTimeout = true;
          }
          if(!research){
            research = {signals:[], diagnostics:{structuredSummary:{eligibleAccounts:batch.length,queuedAccounts:batch.length,processedAccounts:0,failedAccounts:batch.length,failureReasons:batch.map(a=>({accountName:a.name,reason:chunkError?.message || 'unknown'}))}}};
          }
          researchChunks.push(research);
          const chunkOutcome = { ...summarizeChunkResult(research, batch.length), completed: chunkSucceeded };
          progressSummary = accumulateProgress(progressSummary, { chunkIndex, totalChunks, chunkOutcome, chunkDiagnostics: research.diagnostics || null, totalAccounts });
          // Persist progress after every chunk — not just at the end — so a
          // kill mid-flight leaves real evidence instead of only the
          // creation-time summary.
          await supabase(`ha_weekly_runs?id=eq.${encodeURIComponent(run?.id)}`, {method:'PATCH', body: JSON.stringify({summary: progressSummary})})
            .catch(progressErr => console.error('[Weekly Scan] failed to persist chunk progress', run?.id, progressErr));
        }

        const research = {
          signals: researchChunks.flatMap(chunk => Array.isArray(chunk.signals) ? chunk.signals : []),
          diagnostics: { chunks: researchChunks.map(chunk => chunk.diagnostics || {}) }
        };
        // Global event-resolution boundary: merge across ALL chunks for this
        // upload before persisting, not per-HTTP-chunk. This is what stops the
        // same real-world event — produced by two chunks, two sources, or two
        // differently phrased AI generations — from being written as two rows.
        const resolvedSignals = resolveOpportunityEvents(research.signals);
        // Foundation freeze, Phase 1B -- same batched pre-flight + bridge
        // api/save-upload.js runs before every write, reused verbatim here.
        // One query, scoped to the accounts actually touched in this
        // upload's chunk, never per-signal/per-account.
        const legacyRowsForBridge = await fetchLegacySignalsForAccounts(user.id, resolvedSignals.map(s => s.accountName));
        const bridgeStats = applyLegacyFingerprintBridge(legacyRowsForBridge, resolvedSignals);
        const candidateRows = resolvedSignals.map(s => ({
          user_id:user.id,
          upload_id:upload.id,
          weekly_run_id:run?.id || null,
          account_name: clean(s.accountName),
          event_fingerprint: s.eventFingerprint,
          signal_hash: signalHash(user.id, upload.id, s.accountName, s),
          signal_type: clean(s.signalType || 'Business Activity'),
          title: clean(s.signalTitle || s.whatChanged || ''),
          why_reach_out: clean(s.whyItMattersForPromo || s.suggestedOpener || ''),
          confidence: Number(s.confidenceScore || s.confidence || 0) || null,
          source_url: clean(s.sourceUrl || ''),
          source_domain: clean(s.cleanSourceName || s.sourceName || ''),
          published_at: clean(s.publicationDate || '') || null,
          payload:s,
          first_seen_at:new Date().toISOString(),
          last_seen_at:new Date().toISOString()
        })).filter(row => row.event_fingerprint);
        // Defensive in-memory dedup immediately before the bulk write. The
        // database's composite unique constraint (user_id, event_fingerprint)
        // is the final safety net here, not the only guard. Deliberately NOT
        // scoped by upload_id: the product monitors companies, not uploads,
        // so the same real-world event for the same company must resolve to
        // one row regardless of which upload/list/intake source produced it
        // (including a re-upload of the same list, which mints a new
        // upload_id today, or a retried/timed-out run being re-run later).
        const rowsToInsert = dedupeByEventFingerprint(candidateRows, {
          keyOf: row => `${row.user_id}|${row.event_fingerprint}`,
          scoreOf: row => Number(row.confidence || 0)
        });
        if(rowsToInsert.length){
          const inserted = await supabase('ha_signals?on_conflict=user_id,event_fingerprint', {
            method:'POST',
            prefer:'resolution=ignore-duplicates,return=representation',
            body: JSON.stringify(rowsToInsert)
          });
          // With ignore-duplicates, rows that collide with an already-stored
          // event for this account are silently skipped by Postgres and are
          // not returned here — so newSignalRows reflects genuinely new
          // events, and re-running a timed-out/partial run never re-emails
          // or re-inserts an event it already persisted.
          newSignalRows = Array.isArray(inserted) ? inserted : [];
          // QA correction 4 (re-research persistence): a weekly re-scan can
          // regenerate materially better commercialPlay/activationIdeas/
          // expansionPotential/conversationStarter for an event it already
          // knows about -- the ignore-duplicates insert above never lets
          // that reach the stored row. This second upsert refreshes exactly
          // that interpretation (never identity, never first_seen_at, never
          // newSignalRows/digest-notification behavior, which stays keyed
          // off the ignore-duplicates result above only).
          const refreshRows = rowsToInsert.map(refreshableSignalRow);
          const chunkSize = 200;
          for(let i=0;i<refreshRows.length;i+=chunkSize){
            await supabase('ha_signals?on_conflict=user_id,event_fingerprint', {
              method:'POST',
              prefer:'resolution=merge-duplicates',
              body: JSON.stringify(refreshRows.slice(i, i+chunkSize))
            });
          }
        }
        if(bridgeStats.bridged || bridgeStats.multiMatch){
          console.log('[weekly-scan.instrumentation] legacy fingerprint bridge', JSON.stringify({ uploadId: upload.id, legacyFingerprintsBridged: bridgeStats.bridged, legacyMultiMatchCount: bridgeStats.multiMatch }));
        }
        // Priority 6 (paid-beta weekly digest correction): no email is sent
        // here per-upload. Eligible signals are accumulated into
        // perUserDigest, keyed by user, and exactly one consolidated email
        // per user is sent after the whole per-upload loop below finishes --
        // see the digest-send step after the loop. This is unchanged for
        // run tracking/dedup: ha_weekly_runs still gets one row per upload,
        // the event-fingerprint dedup and the partial-unique-index
        // concurrency guard are untouched.
        //
        // Reconciliation item 1: newSignalRows itself (used just below for
        // the run's own newSignals count) still reflects EVERY genuinely
        // new row persisted this run, including stale/undated/ceiling-past
        // signals that are correctly retained for Research Details/account
        // history. The digest, however, is an actionability notification,
        // not a persistence report -- only rows the canonical boundary
        // classifies as priority-eligible are accumulated into the user's
        // digest bucket, so a user with only non-actionable new rows this
        // run gets no email. QA round 3: routed through
        // classifyLegacySignalActionability() rather than trusting
        // row.payload.actionabilityStatus directly, so an internally
        // inconsistent stored value can never leak an ineligible signal
        // into the digest. This gate is specific to business signals --
        // account-history rows (accountHistoryDigestRows) have no
        // actionabilityStatus concept and are never subject to it.
        //
        // Commercial-readiness correction round (final): moved outside the
        // `if(rowsToInsert.length)` block above and combined with
        // accountHistoryDigestRows here so a run that found ZERO new
        // business signals (the common case) still correctly surfaces this
        // upload's follow-up/reorder opportunities in the SAME digest
        // bucket, updating accountsMonitored exactly once per upload either
        // way.
        const digestEligibleRows = newSignalRows.filter(row => classifyLegacySignalActionability(row.payload || {}).actionabilityStatus?.isPriorityEligible !== false);
        const allDigestRowsForUpload = [...digestEligibleRows, ...accountHistoryDigestRows];
        if(allDigestRowsForUpload.length){
          const bucket = perUserDigest.get(user.id) || { user, newSignalRows: [], accountsMonitored: 0 };
          bucket.newSignalRows.push(...allDigestRowsForUpload);
          bucket.accountsMonitored += accountPayloads.length;
          perUserDigest.set(user.id, bucket);
        }
        const finalStatus = decideFinalStatus({
          accountsProcessed: progressSummary.accountsProcessed,
          accountsFailed: progressSummary.accountsFailed,
          totalAccounts,
          sawTimeout
        });
        const finalSummary = { ...progressSummary, newSignals:newSignalRows.length, diagnostics: research.diagnostics };
        await supabase(`ha_weekly_runs?id=eq.${encodeURIComponent(run?.id)}`, {method:'PATCH', body: JSON.stringify({status:finalStatus, finished_at:new Date().toISOString(), summary:finalSummary})});
        runSummary.push({uploadId:upload.id, email:user.email, accounts:totalAccounts, newSignals:newSignalRows.length, status:finalStatus});
      }catch(err){
        // Point 5: never silently swallow finalization failure. Log the
        // original processing error and, separately, any error finalizing
        // the run, so Vercel logs expose both distinctly.
        console.error('[Weekly Scan] processing error for upload', upload.id, err);
        if(run?.id){
          try{
            await supabase(`ha_weekly_runs?id=eq.${encodeURIComponent(run.id)}`, {method:'PATCH', body: JSON.stringify({status:'failed', finished_at:new Date().toISOString(), summary:{...progressSummary, error:err.message}})});
          }catch(finalizeErr){
            console.error('[Weekly Scan] FAILED TO FINALIZE run after a processing error — run may be left recoverable only by the stale-run sweep on a later invocation', {uploadId:upload.id, runId:run.id, processingError:err.message, finalizeError:finalizeErr.message});
          }
        }
        runSummary.push({uploadId:upload.id, email:user.email, error:err.message});
      }
    }

    // Priority 6: consolidated per-user digest send, one email per user per
    // invocation, sent only after every upload's ha_weekly_runs row has
    // already been finalized above. An email failure here is caught and
    // logged for exactly this user's digest -- it can never retroactively
    // turn an already-successful research/signal-persistence run back into
    // a failed one (that status was written and returned in runSummary
    // before this step ever runs), and it never blocks another user's
    // digest from sending.
    const digestSummary = [];
    if(!dryRun){
      for(const [userId, bucket] of perUserDigest){
        // Final, whole-bucket dedup -- catches the same account-history
        // opportunity surfacing from two different uploads this user owns
        // (deriveAccountHistoryDigestRows()'s own dedup is per-upload only).
        const dedupedRows = dedupeDigestRows(bucket.newSignalRows);
        if(!dedupedRows.length) continue;
        try{
          await sendEmail({
            to: bucket.user.email,
            subject: weeklyBriefSubject(dedupedRows),
            html: reportHtml(bucket.user, null, dedupedRows, baseUrl, weeklySummaryFromSignals(dedupedRows, bucket.accountsMonitored))
          });
          digestSummary.push({userId, email:bucket.user.email, newSignals:dedupedRows.length, emailSent:true});
        }catch(emailErr){
          console.error('[Weekly Scan] digest email failed for user', userId, emailErr);
          digestSummary.push({userId, email:bucket.user.email, newSignals:dedupedRows.length, emailSent:false, emailError:emailErr.message});
        }
      }
    }

    return json(res, 200, {ok:true, dryRun, scopedUploadId: requestedUploadId || null, processed:runSummary.length, runs:runSummary, digest:digestSummary});
  }catch(err){
    return json(res, 500, {error:err.message || 'Weekly scan failed'});
  }
}

export {
  FUNCTION_MAX_DURATION_MS, FINALIZE_RESERVE_MS, RESEARCH_FETCH_TIMEOUT_MS, STALE_RUN_THRESHOLD_MS,
  MAX_CHUNKS_SAFELY_PER_INVOCATION,
  computeDeadline, isStaleRun, fetchWithTimeout, summarizeChunkResult, accumulateProgress, decideFinalStatus,
  safeSecretEqual,
  // Commercial-readiness correction round, item 8: exported (no behavior
  // change -- these are unchanged) so a local, no-email preview tool can
  // render the REAL production digest HTML instead of a mockup. See
  // scripts/generate-digest-preview.js.
  reportHtml, opportunityCardHtml, weeklySummaryFromSignals, weeklyBriefSubject, metricRows,
  // Commercial-readiness correction round (final): exported (no behavior
  // change) so the local preview tool can drive the exact same digest-row
  // derivation the real handler uses, per "generate the local HTML preview
  // through the exact final weekly-scan input path."
  accountPayload, deriveAccountHistoryDigestRows, dedupeDigestRows,
  refreshableSignalRow
};
