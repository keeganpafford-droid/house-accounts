// TEMPORARY, FEATURE-BRANCH-ONLY QA FILE -- DELETE BEFORE MERGING TO MAIN.
//
// Purpose: send exactly one real-inbox rendering/deep-link QA copy of the
// redesigned notification email (api/lib/notification-digest.js) to
// kpafford@wodwelder.com, using the REAL rendering functions and the REAL
// sendEmail() (api/lib/email.js) -- not a hand-rolled HTML approximation --
// without touching ANY product state:
//   - never writes ha_notification_deliveries (no delivery row, no
//     watermark advance);
//   - never touches ha_users.notification_preference;
//   - never creates/modifies/deletes any ha_signals/ha_signal_events row;
//   - never invokes api/notification-scheduler.js or its selection logic
//     (selectDigestContent()) -- the exact two QA items below are read
//     once, read-only, and handed DIRECTLY to renderDigestSubject()/
//     renderDigestHtml(), bypassing watermark/eligibility computation
//     entirely, so this can never affect what a future real notifier run
//     considers new.
//
// Deliberately narrow, not a general-purpose tool: the recipient and the
// two source ids are hardcoded, not accepted from the request body/query.
// CRON_SECRET-gated (same pattern as api/notification-scheduler.js) so a
// stray request can't trigger a real send.
import { timingSafeEqual } from 'crypto';
import { sendEmail } from './lib/email.js';
import { renderDigestSubject, renderDigestHtml } from './lib/notification-digest.js';

const QA_RECIPIENT = 'kpafford@wodwelder.com';
const QA_SIGNAL_ID = '66c42ce0-da9d-42ca-83a6-c76197c385ee'; // L.L. Bean / Flagship Store Reopening
const QA_OUTREACH_EVENT_ID = 'fd344589-5a1c-4067-b3a0-04410d6ee3fc'; // Albany International outreach_made

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
// GET only -- this file never issues a POST/PATCH/DELETE against Supabase
// anywhere, structurally, so no accidental write path exists to audit.
async function supabaseGet(path) {
  const { url, key } = env();
  const resp = await fetch(`${url}/rest/v1/${path}`, {
    method: 'GET',
    headers: { apikey: key, Authorization: `Bearer ${key}` }
  });
  const text = await resp.text();
  let data = null;
  if (text) { try { data = JSON.parse(text); } catch { data = text; } }
  if (!resp.ok) throw new Error(`Supabase ${resp.status}: ${typeof data === 'string' ? data : JSON.stringify(data)}`);
  return data;
}

export default async function handler(req, res) {
  try {
    const cronSecret = process.env.CRON_SECRET;
    if (!cronSecret) return json(res, 503, { error: 'Service unavailable: not configured.' });
    const authHeader = req.headers.authorization || '';
    const bearerMatch = /^Bearer\s+(.+)$/i.exec(authHeader);
    const providedSecret = bearerMatch ? bearerMatch[1] : '';
    if (!providedSecret || !safeSecretEqual(providedSecret, cronSecret)) return json(res, 401, { error: 'Unauthorized' });

    const dryRun = req.query?.dryRun === '1' || req.body?.dryRun === true;

    const [signalRows, outreachRows] = await Promise.all([
      supabaseGet(`ha_signals?id=eq.${encodeURIComponent(QA_SIGNAL_ID)}&select=id,account_name,title,signal_type,first_seen_at&limit=1`),
      supabaseGet(`ha_signal_events?id=eq.${encodeURIComponent(QA_OUTREACH_EVENT_ID)}&select=id,account_name,created_at,event_type&limit=1`)
    ]);
    const signal = Array.isArray(signalRows) ? signalRows[0] : null;
    const outreachEvent = Array.isArray(outreachRows) ? outreachRows[0] : null;
    if (!signal) return json(res, 404, { error: `QA signal ${QA_SIGNAL_ID} not found -- refusing to send with fabricated content.` });
    if (!outreachEvent || !['outreach_made', 'opportunity_outreach_made'].includes(outreachEvent.event_type)) {
      return json(res, 404, { error: `QA outreach event ${QA_OUTREACH_EVENT_ID} not found or not an outreach event -- refusing to send.` });
    }

    // Safety: refuse to send if this outreach has since been resolved (an
    // outcome_reported child now exists) -- the whole point of this QA is a
    // deep link into a CURRENTLY unresolved row; sending a stale one would
    // be misleading, not merely harmless.
    const outcomeChildren = await supabaseGet(`ha_signal_events?event_type=eq.outcome_reported&parent_event_id=eq.${encodeURIComponent(QA_OUTREACH_EVENT_ID)}&select=id&limit=1`);
    if (Array.isArray(outcomeChildren) && outcomeChildren.length > 0) {
      return json(res, 409, { error: `QA outreach event ${QA_OUTREACH_EVENT_ID} already has an outcome_reported child -- no longer unresolved, refusing to send a stale deep link.` });
    }

    const now = new Date();
    const baseUrl = getBaseUrl(req);
    const newSignals = [signal];
    const promptEligibleOutreach = [{ outreachEventId: outreachEvent.id, accountName: outreachEvent.account_name, outreachCreatedAt: outreachEvent.created_at }];

    const subject = renderDigestSubject({ newSignals, promptEligibleOutreach });
    const html = renderDigestHtml({ user: { email: QA_RECIPIENT }, newSignals, promptEligibleOutreach, baseUrl, now });
    const reportOutcomeUrlMatch = html.match(/href="([^"]*outreach[^"]*)"/);

    if (dryRun) {
      return json(res, 200, { ok: true, dryRun: true, subject, reportOutcomeUrl: reportOutcomeUrlMatch ? reportOutcomeUrlMatch[1] : null, recipient: QA_RECIPIENT, signalId: signal.id, outreachEventId: outreachEvent.id });
    }

    // Subject/HTML sent verbatim, unmodified -- the founder is verifying
    // real production rendering, not a QA-decorated approximation of it.
    const result = await sendEmail({ to: QA_RECIPIENT, subject, html });
    // Deliberately no ha_notification_deliveries write here -- see the
    // header comment. Real success is still checked the same honest way
    // (a non-empty string .id) so the report to the founder is accurate.
    const sent = !!(result && typeof result.id === 'string' && result.id);
    return json(res, sent ? 200 : 502, {
      ok: sent,
      subject,
      recipient: QA_RECIPIENT,
      signalId: signal.id,
      outreachEventId: outreachEvent.id,
      reportOutcomeUrl: reportOutcomeUrlMatch ? reportOutcomeUrlMatch[1] : null,
      resendResult: result
    });
  } catch (err) {
    return json(res, 500, { error: err.message || 'QA notification email preview failed' });
  }
}
