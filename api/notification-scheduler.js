// POST/GET /api/notification-scheduler
// Notification & Outcome Loop V1 step 3: the independent notification job.
// Automated in vercel.json's crons array (0 12 * * *, once daily) as of the
// Full Beta Cutover, after Preview QA, founder approval, and live Production
// proof against the four approved Beta organizations. Remains
// CRON_SECRET-gated the same way it always was, so a manual founder-run curl
// invocation still works identically alongside the cron. Zero research in
// this path: everything below only ever READS
// ha_signals/ha_signal_events (via listUnresolvedOutreach) and
// ha_notification_deliveries -- no provider call, no import of
// research-batch.js or any provider wrapper, structurally.
//
// One invocation, once per day, serves BOTH cadences with a single
// scheduling concept: 'daily' users are always considered due; 'weekly'
// users are due only once >=7 days have passed since their last
// status='success' ha_notification_deliveries row (or they've never had
// one). That same row's sent_at also IS the "new since when" watermark for
// signals -- one watermark, reused for both due-checking and content
// selection, not two independently-tracked concepts. 'in_app_only' users
// never receive email at all (their surface is the dashboard's own
// unresolved-outreach panel, api/unresolved-outreach.js).
//
// An empty digest (nothing new, nothing prompt-eligible) is never sent and
// never logged -- ha_notification_deliveries only ever records a genuine
// decision to email someone, success or failure, never a no-op.
//
// NOTIFICATION_ENABLED_ORGANIZATION_IDS: activation safety, not a user
// preference -- same fail-closed allowlist philosophy as
// QUEUE_MANAGED_ORGANIZATION_IDS (api/lib/monitoring-queue.js's
// isQueueManagedOrganization()), kept as its own gate here rather than
// reused directly since it answers a different question (which orgs may
// receive email today) than the Queue gate (which orgs' monitoring runs on
// the new path). Unset/empty -> nobody is a candidate, full stop, checked
// BEFORE any ha_users query even runs. notification_preference (daily/
// weekly/in_app_only) is the user's own choice of cadence; this allowlist
// is a separate, coarser switch that must ALSO pass -- an in_app_only user
// is never a candidate regardless of their org's allowlist state, and an
// enabled org's user still respects their own preference. Migration 22
// defaults every existing user to 'weekly', which is exactly why this gate
// exists: without it, enabling the scheduler at all would be capable of
// emailing every Beta user immediately, including in a Preview environment
// that shares live Supabase data.
import { timingSafeEqual } from 'crypto';
import { sendEmail } from './lib/email.js';
import { selectDigestContent, renderDigestSubject, renderDigestHtml, initialLookbackHours } from './lib/notification-digest.js';
import { listUnresolvedOutreach } from './unresolved-outreach.js';
// Signal doctrine: a persisted ha_signals row is not automatically eligible
// for a proactive surface -- buildTargetIdentityIndex() is built ONCE per
// invocation from a single bounded query (never per-user, never per-signal),
// exactly matching api/weekly-scan.js's own digestUserIds/
// monitoringTargetsForDigest pattern -- one shared implementation of "which
// target does this signal belong to," not a second one invented here.
import { buildTargetIdentityIndex } from './lib/monitoring-identity.js';

const WEEKLY_DUE_DAYS = 7;
const NON_EMAIL_PREFERENCES = new Set(['in_app_only']);

export function isNotificationEnabledOrganization(organizationId, allowlistEnvValue) {
  const list = String(allowlistEnvValue || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!list.length || !organizationId) return false;
  return list.includes(String(organizationId));
}

function safeSecretEqual(provided, expected) {
  const providedBuf = Buffer.from(String(provided || ''), 'utf8');
  const expectedBuf = Buffer.from(String(expected || ''), 'utf8');
  if (providedBuf.length !== expectedBuf.length) return false;
  return timingSafeEqual(providedBuf, expectedBuf);
}

function json(res, status, body) { res.setHeader('Cache-Control', 'no-store, max-age=0'); return res.status(status).json(body); }

function getBaseUrl(req) {
  if (process.env.APP_BASE_URL) return process.env.APP_BASE_URL.replace(/\/$/, '');
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const proto = req.headers['x-forwarded-proto'] || 'https';
  return `${proto}://${host}`;
}

function env() {
  const rawUrl = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!rawUrl || !key) throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  const url = String(rawUrl).trim().replace(/\/+$/, '').replace(/\/rest\/v1$/i, '');
  return { url, key };
}
async function supabase(path, options = {}) {
  const { url, key } = env();
  const resp = await fetch(`${url}/rest/v1/${path}`, {
    ...options,
    headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Prefer: options.prefer || 'return=representation', ...(options.headers || {}) }
  });
  const text = await resp.text();
  let data = null;
  if (text) { try { data = JSON.parse(text); } catch { data = text; } }
  if (!resp.ok) throw new Error(`Supabase ${resp.status}: ${typeof data === 'string' ? data : JSON.stringify(data)}`);
  return data;
}

async function fetchLastSuccessfulDelivery(userId) {
  const rows = await supabase(`ha_notification_deliveries?user_id=eq.${encodeURIComponent(userId)}&status=eq.success&select=sent_at,included_signal_ids,included_outreach_event_ids&order=sent_at.desc&limit=1`, { method: 'GET' });
  return Array.isArray(rows) && rows[0] ? rows[0] : null;
}

function isWeeklyUserDue(lastSuccessfulDelivery, now) {
  if (!lastSuccessfulDelivery) return true;
  const daysSinceLastSend = (now.getTime() - new Date(lastSuccessfulDelivery.sent_at).getTime()) / (24 * 60 * 60 * 1000);
  return daysSinceLastSend >= WEEKLY_DUE_DAYS;
}

async function processUser(user, { baseUrl, now, targetIdentityIndex }) {
  const lastSuccessfulDelivery = await fetchLastSuccessfulDelivery(user.id);
  if (user.notification_preference === 'weekly' && !isWeeklyUserDue(lastSuccessfulDelivery, now)) {
    return { outcome: 'not-due' };
  }

  const watermarkIso = lastSuccessfulDelivery
    ? lastSuccessfulDelivery.sent_at
    : new Date(now.getTime() - initialLookbackHours(user.notification_preference) * 60 * 60 * 1000).toISOString();
  const [signals, unresolvedOutreach] = await Promise.all([
    supabase(`ha_signals?user_id=eq.${encodeURIComponent(user.id)}&first_seen_at=gt.${encodeURIComponent(watermarkIso)}&select=id,account_name,title,signal_type,first_seen_at,payload&order=first_seen_at.asc&limit=200`, { method: 'GET' }),
    listUnresolvedOutreach(user.id, { now })
  ]);

  const { hasContent, newSignals, promptEligibleOutreach } = selectDigestContent({ user, signals: Array.isArray(signals) ? signals : [], unresolvedOutreach, lastSuccessfulDelivery, targetIdentityIndex, now });
  if (!hasContent) return { outcome: 'empty-digest' };

  const subject = renderDigestSubject({ newSignals, promptEligibleOutreach });
  const html = renderDigestHtml({ user, newSignals, promptEligibleOutreach, baseUrl, now });
  const baseDeliveryRow = {
    user_id: user.id, organization_id: user.organization_id || null,
    new_signal_count: newSignals.length, unresolved_outreach_count: promptEligibleOutreach.length,
    included_signal_ids: newSignals.map(s => s.id), included_outreach_event_ids: promptEligibleOutreach.map(i => i.outreachEventId)
  };

  try {
    const result = await sendEmail({ to: user.email, subject, html });
    // Contract fix: api/lib/email.js's sendEmail() returns { skipped: true,
    // reason } WITHOUT throwing when RESEND_API_KEY is unset -- a
    // deliberate no-op contract shared with (and unchanged for)
    // api/weekly-scan.js's own digest send, which has no watermark to
    // falsely advance and so was never at risk from it. "Did not throw" is
    // NOT the same claim as "Resend actually accepted this message" --
    // only a real, non-empty string id (Resend's own documented
    // SendEmailResponse schema: { id: string }, the sole documented
    // field on an accepted send) is positive proof of transport success.
    // A skipped/no-op result is logged as a durable 'failed' row (the
    // schema's own two-value status vocabulary, migration 22 -- not a
    // silently-dropped attempt) with an honest reason, but must never be
    // counted as 'sent', never advance the watermark, and never suppress
    // an included outreach prompt.
    if (!result || typeof result.id !== 'string' || !result.id) {
      const reason = result?.skipped ? (result.reason || 'sendEmail skipped: no provider message id returned') : 'sendEmail returned no provider message id';
      await supabase('ha_notification_deliveries', { method: 'POST', body: JSON.stringify([{ ...baseDeliveryRow, status: 'failed', error: reason }]) });
      return { outcome: 'skipped', error: reason };
    }
    await supabase('ha_notification_deliveries', { method: 'POST', body: JSON.stringify([{ ...baseDeliveryRow, status: 'success', sent_at: now.toISOString(), resend_message_id: result.id }]) });
    return { outcome: 'sent' };
  } catch (err) {
    // Isolated per-user -- one Resend failure never blocks the rest of this
    // run. A 'failed' row is logged (never silently dropped) but does NOT
    // advance the watermark, so this exact same content is retried on the
    // next scheduler invocation against the same unadvanced watermark.
    await supabase('ha_notification_deliveries', { method: 'POST', body: JSON.stringify([{ ...baseDeliveryRow, status: 'failed', error: err.message }]) }).catch(() => {});
    return { outcome: 'failed', error: err.message };
  }
}

export default async function handler(req, res) {
  try {
    const cronSecret = process.env.CRON_SECRET;
    if (!cronSecret) return json(res, 503, { error: 'Service unavailable: not configured.' });
    const authHeader = req.headers.authorization || '';
    const bearerMatch = /^Bearer\s+(.+)$/i.exec(authHeader);
    const providedSecret = bearerMatch ? bearerMatch[1] : '';
    if (!providedSecret || !safeSecretEqual(providedSecret, cronSecret)) return json(res, 401, { error: 'Unauthorized' });

    const allowlist = process.env.NOTIFICATION_ENABLED_ORGANIZATION_IDS || '';
    if (!allowlist.trim()) return json(res, 200, { ok: true, usersConsidered: 0, reason: 'NOTIFICATION_ENABLED_ORGANIZATION_IDS is empty -- no organization is notification-enabled yet.' });

    const now = new Date();
    const baseUrl = getBaseUrl(req);
    const users = await supabase(`ha_users?select=id,email,organization_id,notification_preference&limit=1000`, { method: 'GET' });
    const candidates = (Array.isArray(users) ? users : [])
      .filter(u => u.email && !NON_EMAIL_PREFERENCES.has(u.notification_preference))
      .filter(u => isNotificationEnabledOrganization(u.organization_id, allowlist));

    // ONE bounded query for every candidate user's monitoring targets,
    // built before the loop -- same efficiency doctrine as
    // api/weekly-scan.js's own monitoringTargetsForDigest, never a
    // per-user or per-signal database call.
    const candidateUserIds = candidates.map(u => u.id);
    const monitoringTargets = candidateUserIds.length
      ? await supabase(`ha_monitoring_targets?select=user_id,display_account_name,identity_status,identity_domain,identity_domain_source&user_id=in.(${candidateUserIds.map(id => encodeURIComponent(id)).join(',')})&limit=5000`, { method: 'GET' })
      : [];
    const targetIdentityIndex = buildTargetIdentityIndex(monitoringTargets);

    const results = { notDue: 0, emptyDigest: 0, sent: 0, skipped: 0, failed: 0 };
    for (const user of candidates) {
      const { outcome } = await processUser(user, { baseUrl, now, targetIdentityIndex });
      if (outcome === 'not-due') results.notDue += 1;
      else if (outcome === 'empty-digest') results.emptyDigest += 1;
      else if (outcome === 'sent') results.sent += 1;
      // 'skipped' (sendEmail no-op, e.g. missing RESEND_API_KEY) is
      // tracked separately from 'failed' (a genuine provider/transport
      // error) so a config gap is never mistaken for a Resend outage, or
      // vice versa -- both are non-successes for watermark/counting
      // purposes (neither is ever 'sent'), the distinction is purely
      // diagnostic. The underlying delivery row's own `error` text already
      // carries this same distinction for anyone querying the table
      // directly; this just surfaces it in the response too.
      else if (outcome === 'skipped') results.skipped += 1;
      else results.failed += 1;
    }

    console.log('[notification-scheduler.run]', JSON.stringify({ usersConsidered: candidates.length, ...results }));
    return json(res, 200, { ok: true, usersConsidered: candidates.length, ...results });
  } catch (err) {
    return json(res, 500, { error: err.message || 'Notification scheduler failed' });
  }
}
