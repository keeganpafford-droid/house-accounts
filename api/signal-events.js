// Vercel Serverless Function: signal feedback / organizational-learning
// event capture. Endpoint: POST /api/signal-events (write) and
// GET /api/signal-events (batched current-rep read-back).
//
// Product principle this file enforces: organization_id and user_id are
// ALWAYS server-derived from a verified Supabase Bearer token, never
// trusted from the request body. A referenced signal must resolve to a
// row owned by someone in the CALLER'S OWN organization (organization-
// level validation, not current-user-only -- teammates legitimately share
// organization intelligence) before any event is written against it. The
// recommendation snapshot attached to certain event types is derived
// server-side from the actual, currently-persisted ha_signals.payload --
// never from recommendation text the browser supplies. Raw rep behavior
// captured here is proprietary to the organization that generated it and
// is never pooled, benchmarked, or exposed across organizations.
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
  if (!resp.ok) {
    const msg = typeof data === 'string' ? data : (data?.message || data?.hint || JSON.stringify(data));
    const err = new Error(`Supabase ${resp.status}: ${msg}`);
    err.status = resp.status;
    err.code = (data && typeof data === 'object') ? data.code : undefined;
    throw err;
  }
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
// Same identity-resolution pattern used throughout api/*.js (e.g.
// api/save-prospect-upload.js's getUserFromAuth()): resolve by
// auth_user_id first, fall back to the token's own verified email
// (server-derived, never client-supplied), self-healing the legacy row's
// auth_user_id if found that way.
async function getUserFromAuth(req) {
  const authUser = await authFetchUser(req);
  if (!authUser?.id) return null;
  const byAuthId = await sb(`ha_users?auth_user_id=eq.${encodeURIComponent(authUser.id)}&select=*&limit=1`, { method: 'GET' });
  const existing = Array.isArray(byAuthId) ? byAuthId[0] : null;
  if (existing) return existing;
  const email = clean(authUser.email).toLowerCase();
  if (!email) return null;
  const byEmail = await sb(`ha_users?email=eq.${encodeURIComponent(email)}&select=*&limit=1`, { method: 'GET' });
  const emailUser = Array.isArray(byEmail) ? byEmail[0] : null;
  if (emailUser?.id) {
    const updated = await sb(`ha_users?id=eq.${encodeURIComponent(emailUser.id)}`, { method: 'PATCH', body: JSON.stringify({ auth_user_id: authUser.id, status: 'active', updated_at: new Date().toISOString() }) });
    return Array.isArray(updated) ? updated[0] : updated;
  }
  return null;
}

// Same shape as api/research-batch.js's resolveDuplicateCheckScopeUserIds():
// every user_id belonging to the caller's organization, regardless of
// role (this is deliberately broader than api/monitoring-lists.js's
// context(), which only expands to the whole org for owner/admin -- every
// rep, any role, must be able to give feedback on any signal their
// organization's team has discovered). Fails closed to solo scope (never
// wider) on any lookup error.
async function resolveOrgUserIds(userId, organizationId) {
  if (!organizationId) return [userId];
  try {
    const rows = await sb(`ha_users?organization_id=eq.${encodeURIComponent(organizationId)}&select=id`);
    const ids = (Array.isArray(rows) ? rows : []).map(u => u.id).filter(Boolean);
    return ids.length ? ids : [userId];
  } catch (err) {
    console.warn('[signal-events] org scope resolution failed; falling back to solo scope', { message: err && err.message });
    return [userId];
  }
}

const EVENT_TYPES = ['prepare_call_opened', 'signal_selected', 'signal_useful', 'signal_not_useful', 'outreach_made', 'approach_shared', 'outcome_reported'];
// signal_selected/signal_useful/signal_not_useful/outreach_made are the
// "the rep judged or acted on this signal" events -- these carry a
// compact snapshot of what HA actually recommended at that moment.
// prepare_call_opened (pure engagement, no judgment) and approach_shared
// (references its parent outreach_made's own snapshot via
// parent_event_id, never duplicates it) do not.
const SNAPSHOT_EVENT_TYPES = new Set(['signal_selected', 'signal_useful', 'signal_not_useful', 'outreach_made']);
const NOTE_MAX_LENGTH = 500;
const MAX_READBACK_FINGERPRINTS = 50;

function truncate(value, max) {
  const str = clean(value);
  return str.length > max ? str.slice(0, max).replace(/\s+\S*$/, '') + '…' : str;
}
// Built ONLY from the actual, currently-persisted ha_signals.payload --
// the browser never supplies any of these fields. Compact by design: this
// exists so a future query can compare "what HA recommended" against
// "what the rep did," not to duplicate the full research record on every
// event.
function buildRecommendationSnapshot(payload = {}) {
  return {
    signalType: clean(payload.signalType || payload.type || ''),
    signalTitle: clean(payload.title || payload.signalTitle || ''),
    commercialPlay: truncate(payload.commercialPlay?.narrative || '', 300),
    recommendedContact: clean(payload.suggestedContact || (Array.isArray(payload.recommendedBuyingTeam) ? payload.recommendedBuyingTeam[0] : '') || ''),
    activationIdeas: (Array.isArray(payload.activationIdeas) ? payload.activationIdeas : []).slice(0, 3).map(clean),
    conversationStarter: truncate(payload.conversationStarter || '', 300)
  };
}

async function handlePost(req, res, user, organizationId) {
  const body = req.body || {};
  const clientEventId = clean(body.clientEventId);
  const eventType = clean(body.eventType);
  if (!clientEventId) return json(res, 400, { error: 'clientEventId is required.' });
  if (!EVENT_TYPES.includes(eventType)) return json(res, 400, { error: `Unknown eventType "${eventType}".` });
  if (eventType === 'outcome_reported') return json(res, 400, { error: 'outcome_reported is not supported yet.' });

  // Idempotency: a request replaying a (user_id, client_event_id) pair
  // that already succeeded returns the existing event rather than writing
  // a second one. Checked before anything else, for every event type --
  // this is what makes a retried "I reached out" click, or a network
  // retry of any of these calls, safe.
  const existingRows = await sb(`ha_signal_events?user_id=eq.${encodeURIComponent(user.id)}&client_event_id=eq.${encodeURIComponent(clientEventId)}&select=id&limit=1`, { method: 'GET' });
  const existing = Array.isArray(existingRows) ? existingRows[0] : null;
  if (existing?.id) return json(res, 200, { ok: true, id: existing.id, replayed: true });

  if (eventType === 'approach_shared') {
    const parentEventId = clean(body.parentEventId);
    if (!parentEventId) return json(res, 400, { error: 'parentEventId is required for approach_shared.' });
    const note = clean(body.note);
    if (!note) return json(res, 400, { error: 'A non-empty note is required.' });
    if (note.length > NOTE_MAX_LENGTH) return json(res, 400, { error: `Note must be ${NOTE_MAX_LENGTH} characters or fewer.` });
    const parentRows = await sb(`ha_signal_events?id=eq.${encodeURIComponent(parentEventId)}&select=*&limit=1`, { method: 'GET' });
    const parent = Array.isArray(parentRows) ? parentRows[0] : null;
    // A note is a personal reflection on the REP'S OWN outreach attempt --
    // scoped to this same rep, not merely the same organization.
    if (!parent || parent.event_type !== 'outreach_made' || parent.user_id !== user.id || parent.organization_id !== organizationId) {
      return json(res, 404, { error: 'Outreach attempt not found.' });
    }
    const inserted = await sb('ha_signal_events', {
      method: 'POST',
      body: JSON.stringify([{
        organization_id: organizationId, user_id: user.id, client_event_id: clientEventId,
        event_fingerprint: parent.event_fingerprint, signal_id: parent.signal_id, parent_event_id: parent.id,
        account_name: parent.account_name, event_type: 'approach_shared', schema_version: 1,
        payload: { approachNote: note }
      }])
    });
    const row = Array.isArray(inserted) ? inserted[0] : inserted;
    return json(res, 200, { ok: true, id: row.id });
  }

  // Every other event type references a signal by its durable
  // event_fingerprint, resolved against the CALLER'S ORGANIZATION (not
  // just their own rows) -- a fingerprint that doesn't resolve to any
  // org-owned ha_signals row is rejected outright, before anything is
  // written. account_name and the recommendation snapshot come from the
  // resolved row itself; a signalId "hint" is never trusted or used to
  // bypass this lookup.
  const eventFingerprint = clean(body.eventFingerprint);
  if (!eventFingerprint) return json(res, 400, { error: 'eventFingerprint is required.' });

  const orgUserIds = await resolveOrgUserIds(user.id, organizationId);
  const signalRows = await sb(`ha_signals?event_fingerprint=eq.${encodeURIComponent(eventFingerprint)}&user_id=in.(${orgUserIds.map(id => encodeURIComponent(id)).join(',')})&select=*`, { method: 'GET' });
  const candidates = Array.isArray(signalRows) ? signalRows : [];
  if (!candidates.length) return json(res, 404, { error: 'Signal not found for your organization.' });
  const signal = candidates.find(r => r.user_id === user.id) || candidates[0];

  // Semantic dedupe for signal judgment only: a changed opinion (Useful ->
  // Not useful, or vice versa) is real new learning history; repeating
  // the SAME opinion the rep already has on record for this signal is
  // not, even when the client generated a fresh clientEventId for it (a
  // second, independent click). No such collapsing applies to
  // outreach_made -- two legitimate outreach attempts must both persist,
  // by design.
  if (eventType === 'signal_useful' || eventType === 'signal_not_useful') {
    const priorRows = await sb(`ha_signal_events?user_id=eq.${encodeURIComponent(user.id)}&event_fingerprint=eq.${encodeURIComponent(eventFingerprint)}&event_type=in.(signal_useful,signal_not_useful)&select=id,event_type&order=created_at.desc&limit=1`, { method: 'GET' });
    const latest = Array.isArray(priorRows) ? priorRows[0] : null;
    if (latest && latest.event_type === eventType) {
      return json(res, 200, { ok: true, id: latest.id, noOp: true, currentState: eventType });
    }
  }

  const payload = SNAPSHOT_EVENT_TYPES.has(eventType) ? buildRecommendationSnapshot(signal.payload || {}) : {};
  const inserted = await sb('ha_signal_events', {
    method: 'POST',
    body: JSON.stringify([{
      organization_id: organizationId, user_id: user.id, client_event_id: clientEventId,
      event_fingerprint: signal.event_fingerprint, signal_id: signal.id, parent_event_id: null,
      account_name: signal.account_name, event_type: eventType, schema_version: 1, payload
    }])
  });
  const row = Array.isArray(inserted) ? inserted[0] : inserted;
  return json(res, 200, { ok: true, id: row.id });
}

// Batched, current-rep-only read-back -- reflects THIS rep's own latest
// state so the UI doesn't feel like it forgot prior feedback on reopen.
// Deliberately never aggregates across the organization (no manager/team
// visibility here) -- scoped entirely by user_id, which also means no
// separate signal-ownership check is needed: the query can never surface
// another user's rows regardless of what fingerprints are requested.
async function handleGet(req, res, user) {
  const raw = clean(req.query?.eventFingerprints || '');
  const fingerprints = [...new Set(raw.split(',').map(clean).filter(Boolean))].slice(0, MAX_READBACK_FINGERPRINTS);
  if (!fingerprints.length) return json(res, 400, { error: 'eventFingerprints is required.' });

  const filter = `in.(${fingerprints.map(f => `"${f.replace(/"/g, '')}"`).join(',')})`;
  const rows = await sb(`ha_signal_events?user_id=eq.${encodeURIComponent(user.id)}&event_fingerprint=${filter}&select=*&order=created_at.desc`, { method: 'GET' });

  const states = {};
  for (const fp of fingerprints) states[fp] = { feedback: null, outreachLogged: false, latestOutreachEventId: null, approachNote: null };
  for (const row of (Array.isArray(rows) ? rows : [])) {
    const state = states[row.event_fingerprint];
    if (!state) continue;
    // Rows arrive newest-first, so the first row seen per fingerprint for
    // a given field IS the latest -- only ever set once per field.
    if (state.feedback === null && (row.event_type === 'signal_useful' || row.event_type === 'signal_not_useful')) {
      state.feedback = row.event_type === 'signal_useful' ? 'useful' : 'not_useful';
    }
    if (!state.outreachLogged && row.event_type === 'outreach_made') {
      state.outreachLogged = true;
      state.latestOutreachEventId = row.id;
    }
    if (state.approachNote === null && row.event_type === 'approach_shared') {
      state.approachNote = row.payload?.approachNote || null;
    }
  }
  return json(res, 200, { ok: true, states });
}

export default async function handler(req, res) {
  if (req.method !== 'POST' && req.method !== 'GET') return json(res, 405, { error: 'Method not allowed' });
  try {
    const user = await getUserFromAuth(req);
    if (!user?.id) return json(res, 401, { error: 'Authentication required' });
    if (req.method === 'GET') return await handleGet(req, res, user);

    const organizationId = user.organization_id || null;
    if (!organizationId) return json(res, 400, { error: 'No organization associated with this account.' });
    return await handlePost(req, res, user, organizationId);
  } catch (err) {
    return json(res, 500, { error: err.message || 'Signal event request failed' });
  }
}

export { resolveOrgUserIds, buildRecommendationSnapshot, truncate, EVENT_TYPES };
