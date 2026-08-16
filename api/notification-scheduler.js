// POST/GET /api/notification-scheduler
// Notification & Outcome Loop V1 step 3: the independent notification job.
// Deliberately NOT added to vercel.json's crons -- stays a manually-
// invokable, CRON_SECRET-gated endpoint until Preview QA + founder approval
// (Step 4/5), matching api/monitoring-scheduler.js's own dark-run
// precedent. Zero research in this path: everything below only ever READS
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

async function processUser(user, { baseUrl, now }) {
  const lastSuccessfulDelivery = await fetchLastSuccessfulDelivery(user.id);
  if (user.notification_preference === 'weekly' && !isWeeklyUserDue(lastSuccessfulDelivery, now)) {
    return { outcome: 'not-due' };
  }

  const watermarkIso = lastSuccessfulDelivery
    ? lastSuccessfulDelivery.sent_at
    : new Date(now.getTime() - initialLookbackHours(user.notification_preference) * 60 * 60 * 1000).toISOString();
  const [signals, unresolvedOutreach] = await Promise.all([
    supabase(`ha_signals?user_id=eq.${encodeURIComponent(user.id)}&first_seen_at=gt.${encodeURIComponent(watermarkIso)}&select=id,account_name,title,signal_type,first_seen_at&order=first_seen_at.asc&limit=200`, { method: 'GET' }),
    listUnresolvedOutreach(user.id, { now })
  ]);

  const { hasContent, newSignals, promptEligibleOutreach } = selectDigestContent({ user, signals: Array.isArray(signals) ? signals : [], unresolvedOutreach, lastSuccessfulDelivery, now });
  if (!hasContent) return { outcome: 'empty-digest' };

  const subject = renderDigestSubject({ newSignals, promptEligibleOutreach });
  const html = renderDigestHtml({ user, newSignals, promptEligibleOutreach, baseUrl });
  const baseDeliveryRow = {
    user_id: user.id, organization_id: user.organization_id || null,
    new_signal_count: newSignals.length, unresolved_outreach_count: promptEligibleOutreach.length,
    included_signal_ids: newSignals.map(s => s.id), included_outreach_event_ids: promptEligibleOutreach.map(i => i.outreachEventId)
  };

  try {
    const result = await sendEmail({ to: user.email, subject, html });
    await supabase('ha_notification_deliveries', { method: 'POST', body: JSON.stringify([{ ...baseDeliveryRow, status: 'success', sent_at: now.toISOString(), resend_message_id: result?.id || null }]) });
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

    const results = { notDue: 0, emptyDigest: 0, sent: 0, failed: 0 };
    for (const user of candidates) {
      const { outcome } = await processUser(user, { baseUrl, now });
      if (outcome === 'not-due') results.notDue += 1;
      else if (outcome === 'empty-digest') results.emptyDigest += 1;
      else if (outcome === 'sent') results.sent += 1;
      else results.failed += 1;
    }

    console.log('[notification-scheduler.run]', JSON.stringify({ usersConsidered: candidates.length, ...results }));
    return json(res, 200, { ok: true, usersConsidered: candidates.length, ...results });
  } catch (err) {
    return json(res, 500, { error: err.message || 'Notification scheduler failed' });
  }
}
