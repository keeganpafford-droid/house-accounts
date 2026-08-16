// GET /api/unresolved-outreach
// Notification & Outcome Loop V1: lightweight read endpoint for the
// dashboard's "You reached out N days ago -- how did it go?" surface.
// Deliberately broader than automatic-prompt eligibility (see
// api/lib/outcome-prompts.js's isStillOpen vs isEligibleForPrompt): the
// dashboard shows ANY outreach without a terminal outcome yet, so a rep can
// close one out at any time, not only once the 5/7-day automatic-email
// window opens.
//
// Current-rep-only, same scoping doctrine as api/signal-events.js's own
// GET read-back and approach_shared's personal-reflection posture -- an
// outreach attempt (and whether it has a real answer yet) is the acting
// rep's own history, never aggregated across the organization here.
import { evaluateOutreachOutcome } from './lib/outcome-prompts.js';

function json(res, status, body) { res.setHeader('Cache-Control', 'no-store, max-age=0'); return res.status(status).json(body); }
function clean(v = '') { return String(v || '').trim(); }

function env() {
  const rawUrl = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!rawUrl || !key) throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  const url = String(rawUrl).trim().replace(/\/+$/, '').replace(/\/rest\/v1$/i, '');
  return { url, key };
}
async function sb(path, options = {}) {
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
async function authFetchUser(req) {
  const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!token) return null;
  const { url, key } = env();
  const resp = await fetch(`${url}/auth/v1/user`, { headers: { apikey: key, Authorization: `Bearer ${token}` } });
  if (!resp.ok) return null;
  return resp.json();
}
// Same identity-resolution pattern as api/signal-events.js's own
// getUserFromAuth() -- duplicated rather than imported, matching this
// codebase's established per-file convention of each api/*.js route owning
// its own small Supabase/auth boilerplate (see monitoring-scheduler.js,
// weekly-scan.js, signal-events.js).
async function getUserFromAuth(req) {
  const authUser = await authFetchUser(req);
  if (!authUser?.id) return null;
  const byAuthId = await sb(`ha_users?auth_user_id=eq.${encodeURIComponent(authUser.id)}&select=*&limit=1`, { method: 'GET' });
  const existing = Array.isArray(byAuthId) ? byAuthId[0] : null;
  if (existing) return existing;
  const email = clean(authUser.email).toLowerCase();
  if (!email) return null;
  const byEmail = await sb(`ha_users?email=eq.${encodeURIComponent(email)}&select=*&limit=1`, { method: 'GET' });
  return Array.isArray(byEmail) ? (byEmail[0] || null) : null;
}

const OUTREACH_EVENT_TYPES = ['outreach_made', 'opportunity_outreach_made'];
// Bounds one dashboard load's worth of work -- a rep with more open
// outreach than this sees the OLDEST (longest-waiting, most urgent)
// entries first; not expected to be reached in V1 usage.
const MAX_OUTREACH_ROWS = 200;

// Two queries total (every outreach event, then every outcome_reported
// child of those events), never N+1 -- grouped in JS by parent_event_id.
// Exported (not just used by the default handler) so Step 3's notification
// digest builder can call this same function rather than re-deriving the
// query, keeping the dashboard and the email digest permanently in
// agreement about what "still open" means.
export async function listUnresolvedOutreach(userId, { now = new Date() } = {}) {
  const outreachRows = await sb(`ha_signal_events?user_id=eq.${encodeURIComponent(userId)}&event_type=in.(${OUTREACH_EVENT_TYPES.join(',')})&select=id,event_fingerprint,signal_id,opportunity_id,account_name,created_at&order=created_at.asc&limit=${MAX_OUTREACH_ROWS}`, { method: 'GET' });
  const outreach = Array.isArray(outreachRows) ? outreachRows : [];
  if (!outreach.length) return [];

  const outreachIds = outreach.map(o => o.id);
  const outcomeRows = await sb(`ha_signal_events?user_id=eq.${encodeURIComponent(userId)}&event_type=eq.outcome_reported&parent_event_id=in.(${outreachIds.map(id => encodeURIComponent(id)).join(',')})&select=parent_event_id,payload,created_at`, { method: 'GET' });
  const outcomesByParent = new Map();
  for (const row of (Array.isArray(outcomeRows) ? outcomeRows : [])) {
    const list = outcomesByParent.get(row.parent_event_id) || [];
    list.push(row);
    outcomesByParent.set(row.parent_event_id, list);
  }

  return outreach
    .map(o => {
      const evaluated = evaluateOutreachOutcome({ outreachCreatedAt: o.created_at, outcomeEvents: outcomesByParent.get(o.id) || [], now });
      return {
        outreachEventId: o.id, accountName: o.account_name, eventFingerprint: o.event_fingerprint,
        signalId: o.signal_id, opportunityId: o.opportunity_id, outreachCreatedAt: o.created_at,
        currentStatus: evaluated.currentStatus, isEligibleForPrompt: evaluated.isEligibleForPrompt, isStillOpen: evaluated.isStillOpen
      };
    })
    .filter(item => item.isStillOpen);
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return json(res, 405, { error: 'Method not allowed' });
  try {
    const user = await getUserFromAuth(req);
    if (!user?.id) return json(res, 401, { error: 'Authentication required' });
    const items = await listUnresolvedOutreach(user.id);
    return json(res, 200, { ok: true, items });
  } catch (err) {
    return json(res, 500, { error: err.message || 'Unresolved outreach request failed' });
  }
}
