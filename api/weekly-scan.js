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

import { resolveOpportunityEvents, dedupeByEventFingerprint } from './signal-intelligence.js';

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
    throw new Error(`Supabase ${resp.status}: ${msg}`);
  }
  return data;
}
function signalHash(userId, uploadId, accountName, s){
  return hashString([userId, uploadId, accountName, s.signalType || s.type || '', s.signalTitle || s.title || s.whatChanged || '', s.sourceUrl || s.source || ''].join('|').toLowerCase());
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
    repeatPatterns: raw.repeatPatterns || []
  };
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
function whyItMatters(signal={}){
  const payload = signal.payload || {};
  return clean(
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
    if(process.env.CRON_SECRET){
      const provided = req.headers.authorization?.replace(/^Bearer\s+/i, '') || req.query?.secret;
      if(provided !== process.env.CRON_SECRET) return json(res, 401, {error:'Unauthorized'});
    }
    const dryRun = String(req.query?.dryRun || '').toLowerCase() === 'true';
    // Operational/admin targeting: ?uploadId=<uuid> restricts this invocation
    // to exactly one upload, for a manual rerun or production debugging
    // session, instead of the normal limit-bounded sweep across every
    // monitored upload. This is read only after the CRON_SECRET check above
    // and adds no separate authorization path of its own — it cannot be used
    // to bypass CRON_SECRET, only to narrow what an already-authorized
    // request processes. When absent, behavior is byte-for-byte the same as
    // before this parameter existed: the limit-bounded query below still
    // decides what gets processed, and `limit` is otherwise unused/ignored.
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
      uploads = await supabase(`ha_uploads?select=id,user_id,upload_name,summary,created_at,ha_users(id,email,name,company)&order=updated_at.desc&limit=${limit}`);
    }
    const baseUrl = getBaseUrl(req);
    const runSummary = [];

    for(const upload of uploads || []){
      const user = upload.ha_users;
      if(!user?.email) continue;
      const accounts = await supabase(`ha_accounts?select=*&upload_id=eq.${encodeURIComponent(upload.id)}&limit=5000`);
      const accountPayloads = (accounts || []).map(accountPayload).filter(a => a.name && !['paused','archived'].includes(clean(a.monitoringStatus || '').toLowerCase()));
      if(!accountPayloads.length) continue;

      // Settle any prior run for this upload that never reached a completion
      // PATCH (killed by a platform timeout, crash, etc.) before starting a
      // new one. Nothing can reach back into a killed invocation, so this is
      // the only place a stuck run gets settled — the next time this upload
      // is processed, whether by the weekly cron or a manual trigger.
      try{
        const priorRunning = await supabase(`ha_weekly_runs?upload_id=eq.${encodeURIComponent(upload.id)}&status=eq.running&select=id,started_at,summary&limit=20`);
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
      const runRows = await supabase('ha_weekly_runs', {method:'POST', body: JSON.stringify([{user_id:user.id, upload_id:upload.id, status:'running', started_at:started, summary:{
        accounts:totalAccounts, totalChunks, chunksAttempted:0, chunksCompleted:0,
        accountsAttempted:0, accountsProcessed:0, accountsFailed:0, diagnostics:[]
      }}])});
      const run = Array.isArray(runRows) ? runRows[0] : runRows;

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
              headers:{'Content-Type':'application/json'},
              body: JSON.stringify({mode:'weekly-monitoring', accounts: batch})
            }, RESEARCH_FETCH_TIMEOUT_MS);
            const parsed = await researchResp.json();
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
          if(!dryRun && newSignalRows.length){
            await sendEmail({to:user.email, subject:weeklyBriefSubject(newSignalRows), html:reportHtml(user, upload, newSignalRows, baseUrl, weeklySummaryFromSignals(newSignalRows, accountPayloads.length))});
          }
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
    return json(res, 200, {ok:true, dryRun, scopedUploadId: requestedUploadId || null, processed:runSummary.length, runs:runSummary});
  }catch(err){
    return json(res, 500, {error:err.message || 'Weekly scan failed'});
  }
}

export {
  FUNCTION_MAX_DURATION_MS, FINALIZE_RESERVE_MS, RESEARCH_FETCH_TIMEOUT_MS, STALE_RUN_THRESHOLD_MS,
  MAX_CHUNKS_SAFELY_PER_INVOCATION,
  computeDeadline, isStaleRun, fetchWithTimeout, summarizeChunkResult, accumulateProgress, decideFinalStatus
};
