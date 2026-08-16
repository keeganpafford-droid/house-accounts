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
//
// Identity, post-verification-pass correction: signal_id (the exact
// ha_signals row a rep saw/acted on) and event_fingerprint (the durable
// business-event identity, retained for longitudinal learning across a
// ha_signals row being refreshed) are deliberately DIFFERENT identities
// with different jobs. A write is always resolved by signal_id, never by
// event_fingerprint alone -- ha_signals' own persistence constraint,
// (user_id, event_fingerprint) with no account_name/upload_id scoping,
// proves event_fingerprint is not guaranteed unique to one account. Read-
// back (GET) is keyed by (event_fingerprint, account_name) together --
// the smallest durable pairing that stays correct across a refreshed
// ha_signals row while still preventing two different accounts that
// share a fingerprint from bleeding into each other's feedback state.
import { buildOpportunityRecommendationSnapshot } from './lib/account-opportunity-templates.js';

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

// Organizational Learning V1B: opportunity_* mirrors the signal_* judgment/
// outreach vocabulary exactly, but targets ha_account_opportunities
// (Follow-Up/Repeat/Pattern account-history opportunities) instead of
// ha_signals -- a structurally separate family, never the same row (see
// migration 12's ha_signal_events_target_family_check). There is no
// opportunity-side prepare_call_opened: Prepare for Call is a signal-only
// concept (opportunity cards do not have an equivalent engagement step).
const EVENT_TYPES = [
  'prepare_call_opened', 'signal_selected', 'signal_useful', 'signal_not_useful', 'outreach_made', 'approach_shared', 'outcome_reported',
  'opportunity_selected', 'opportunity_useful', 'opportunity_not_useful', 'opportunity_outreach_made', 'opportunity_approach_shared'
];
// signal_selected/signal_useful/signal_not_useful/outreach_made (and their
// opportunity_* counterparts) are the "the rep judged or acted on this"
// events -- these carry a compact snapshot of what HA actually recommended
// at that moment. prepare_call_opened (pure engagement, no judgment) and
// approach_shared/opportunity_approach_shared (reference their parent
// outreach event's own snapshot via parent_event_id, never duplicate it)
// do not.
const SNAPSHOT_EVENT_TYPES = new Set([
  'signal_selected', 'signal_useful', 'signal_not_useful', 'outreach_made',
  'opportunity_selected', 'opportunity_useful', 'opportunity_not_useful', 'opportunity_outreach_made'
]);
// Events that resolve their target by opportunityId (ha_account_opportunities)
// rather than signalId (ha_signals). opportunity_approach_shared is handled
// separately, alongside signal approach_shared, since both inherit their
// target entirely from their resolved parent event rather than a body-
// supplied id.
const OPPORTUNITY_EVENT_TYPES = new Set(['opportunity_selected', 'opportunity_useful', 'opportunity_not_useful', 'opportunity_outreach_made']);
const NOTE_MAX_LENGTH = 500;
const MAX_READBACK_FINGERPRINTS = 50;

// Notification & Outcome Loop V1: outcome_reported's allowed statuses.
// 'no_response_yet' is deliberately a REAL report, not the absence of one --
// it is what a rep files when they truly don't know yet, and it remains
// eligible for a later automatic prompt (see api/lib/outcome-prompts.js);
// the other three are terminal for automatic-prompting purposes (a rep can
// still manually append a later update, this only stops the SYSTEM asking
// again). Kept here, not in outcome-prompts.js, since this is the one place
// that owns what a valid write actually is -- outcome-prompts.js imports it
// rather than redeclaring it.
export const OUTCOME_STATUSES = ['no_response_yet', 'engaged', 'progressed', 'went_nowhere'];

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

  if (eventType === 'opportunity_approach_shared') {
    const parentEventId = clean(body.parentEventId);
    if (!parentEventId) return json(res, 400, { error: 'parentEventId is required for opportunity_approach_shared.' });
    const note = clean(body.note);
    if (!note) return json(res, 400, { error: 'A non-empty note is required.' });
    if (note.length > NOTE_MAX_LENGTH) return json(res, 400, { error: `Note must be ${NOTE_MAX_LENGTH} characters or fewer.` });
    const parentRows = await sb(`ha_signal_events?id=eq.${encodeURIComponent(parentEventId)}&select=*&limit=1`, { method: 'GET' });
    const parent = Array.isArray(parentRows) ? parentRows[0] : null;
    // Same personal-reflection scoping as approach_shared: the REP'S OWN
    // opportunity_outreach_made attempt, not merely the same organization.
    if (!parent || parent.event_type !== 'opportunity_outreach_made' || parent.user_id !== user.id || parent.organization_id !== organizationId) {
      return json(res, 404, { error: 'Outreach attempt not found.' });
    }
    const inserted = await sb('ha_signal_events', {
      method: 'POST',
      body: JSON.stringify([{
        organization_id: organizationId, user_id: user.id, client_event_id: clientEventId,
        event_fingerprint: parent.event_fingerprint, opportunity_id: parent.opportunity_id, parent_event_id: parent.id,
        account_name: parent.account_name, event_type: 'opportunity_approach_shared', schema_version: 1,
        payload: { approachNote: note }
      }])
    });
    const row = Array.isArray(inserted) ? inserted[0] : inserted;
    return json(res, 200, { ok: true, id: row.id });
  }

  // Notification & Outcome Loop V1: outcome_reported is an append-only
  // child of the SPECIFIC outreach_made/opportunity_outreach_made event it
  // reports on, via parent_event_id -- never resolved by event_fingerprint
  // or a bare account reference, same posture as approach_shared/
  // opportunity_approach_shared and for the same reason (a rep's outcome
  // report is a personal reflection on their OWN outreach attempt, not
  // attachable to a teammate's or to "the account" in the abstract).
  // Unlike approach_shared, this is NEVER deduped/no-op'd against a prior
  // report on the same parent -- multiple later outcome updates are
  // explicitly valid history (a rep who reported 'no_response_yet' and
  // later gets a reply reports 'engaged' as a NEW row, the old one stays
  // exactly as it was). signal_id/opportunity_id are inherited from
  // whichever family the parent belongs to (never supplied by the caller),
  // satisfying migration 21's XOR check the same way prepare_call_opened's
  // does.
  if (eventType === 'outcome_reported') {
    const parentEventId = clean(body.parentEventId);
    if (!parentEventId) return json(res, 400, { error: 'parentEventId is required for outcome_reported.' });
    const outcomeStatus = clean(body.outcomeStatus);
    if (!OUTCOME_STATUSES.includes(outcomeStatus)) return json(res, 400, { error: `Unknown outcomeStatus "${outcomeStatus}".` });
    const note = clean(body.note);
    if (note.length > NOTE_MAX_LENGTH) return json(res, 400, { error: `Note must be ${NOTE_MAX_LENGTH} characters or fewer.` });
    const parentRows = await sb(`ha_signal_events?id=eq.${encodeURIComponent(parentEventId)}&select=*&limit=1`, { method: 'GET' });
    const parent = Array.isArray(parentRows) ? parentRows[0] : null;
    if (!parent || !['outreach_made', 'opportunity_outreach_made'].includes(parent.event_type) || parent.user_id !== user.id || parent.organization_id !== organizationId) {
      return json(res, 404, { error: 'Outreach attempt not found.' });
    }
    const inserted = await sb('ha_signal_events', {
      method: 'POST',
      body: JSON.stringify([{
        organization_id: organizationId, user_id: user.id, client_event_id: clientEventId,
        event_fingerprint: parent.event_fingerprint, signal_id: parent.signal_id, opportunity_id: parent.opportunity_id, parent_event_id: parent.id,
        account_name: parent.account_name, event_type: 'outcome_reported', schema_version: 1,
        payload: note ? { outcomeStatus, note } : { outcomeStatus }
      }])
    });
    const row = Array.isArray(inserted) ? inserted[0] : inserted;
    return json(res, 200, { ok: true, id: row.id });
  }

  // Organizational Learning V1B, Correction 1: opportunity_selected/
  // opportunity_useful/opportunity_not_useful/opportunity_outreach_made
  // target the EXACT ha_account_opportunities row the rep acted on, by
  // opportunityId -- resolved and organization-scoped the same way
  // signalId is resolved below, never trusted from the browser beyond the
  // id itself. event_fingerprint/account_name/category are then derived
  // from that exact resolved row. prepare_call_opened is the one event
  // type genuinely SHARED between both families (migration 12's
  // ha_signal_events_target_family_check enforces the XOR directly) --
  // when the caller supplies opportunityId, it resolves through this same
  // branch and naturally gets an empty payload (SNAPSHOT_EVENT_TYPES does
  // not include prepare_call_opened) and skips the useful/not_useful
  // dedupe below (neither applies to it); a prepare_call_opened with only
  // a signalId still falls through to the signal branch, unchanged.
  if (OPPORTUNITY_EVENT_TYPES.has(eventType) || (eventType === 'prepare_call_opened' && clean(body.opportunityId))) {
    const opportunityId = clean(body.opportunityId);
    if (!opportunityId) return json(res, 400, { error: 'opportunityId is required.' });

    const orgUserIds = await resolveOrgUserIds(user.id, organizationId);
    const opportunityRows = await sb(`ha_account_opportunities?id=eq.${encodeURIComponent(opportunityId)}&select=*&limit=1`, { method: 'GET' });
    const opportunity = Array.isArray(opportunityRows) ? opportunityRows[0] : null;
    if (!opportunity || !orgUserIds.includes(opportunity.user_id)) return json(res, 404, { error: 'Opportunity not found for your organization.' });
    const eventFingerprint = opportunity.fingerprint;

    // Same semantic-dedupe rule as signal_useful/signal_not_useful: a
    // changed opinion is real new history, repeating the SAME opinion
    // already on record is not. opportunity_outreach_made is exempt, same
    // as outreach_made -- multiple real outreach attempts on one
    // opportunity instance must all persist.
    if (eventType === 'opportunity_useful' || eventType === 'opportunity_not_useful') {
      const priorRows = await sb(`ha_signal_events?user_id=eq.${encodeURIComponent(user.id)}&event_fingerprint=eq.${encodeURIComponent(eventFingerprint)}&event_type=in.(opportunity_useful,opportunity_not_useful)&select=id,event_type&order=created_at.desc&limit=1`, { method: 'GET' });
      const latest = Array.isArray(priorRows) ? priorRows[0] : null;
      if (latest && latest.event_type === eventType) {
        return json(res, 200, { ok: true, id: latest.id, noOp: true, currentState: eventType });
      }
    }

    const payload = SNAPSHOT_EVENT_TYPES.has(eventType)
      ? buildOpportunityRecommendationSnapshot({ opportunityType: opportunity.opportunity_type, category: opportunity.category, templateKey: clean(body.templateKey) })
      : {};
    const inserted = await sb('ha_signal_events', {
      method: 'POST',
      body: JSON.stringify([{
        organization_id: organizationId, user_id: user.id, client_event_id: clientEventId,
        event_fingerprint: opportunity.fingerprint, opportunity_id: opportunity.id, parent_event_id: null,
        account_name: opportunity.account_name, event_type: eventType, schema_version: 1, payload
      }])
    });
    const row = Array.isArray(inserted) ? inserted[0] : inserted;
    return json(res, 200, { ok: true, id: row.id });
  }

  // Every other event type references the EXACT ha_signals row the rep
  // acted on, by signalId -- never by event_fingerprint alone.
  // event_fingerprint is NOT guaranteed to identify one account/business-
  // event context: ha_signals' own persistence constraint is (user_id,
  // event_fingerprint) only (see api/save-upload.js's and api/lib/signal-
  // persistence.js's `on_conflict=user_id,event_fingerprint` upserts) --
  // there is no
  // account_name or upload_id in that key. Two distinct real accounts
  // under the same user whose company name/family/subtype/month/entity
  // tokens happen to normalize identically (normalizeCompany() in
  // api/signal-intelligence.js aggressively strips punctuation, case, and
  // corporate suffixes) would upsert into the SAME ha_signals row, so
  // resolving a write by fingerprint alone could attach a rep's judgment
  // to the wrong account's row. Resolving by the exact row id, then
  // verifying that row's owner is in the caller's organization, is what
  // keeps this correct; event_fingerprint/account_name/the recommendation
  // snapshot are then derived from that exact resolved row, never trusted
  // from the browser.
  const signalId = clean(body.signalId);
  if (!signalId) return json(res, 400, { error: 'signalId is required.' });

  const orgUserIds = await resolveOrgUserIds(user.id, organizationId);
  const signalRows = await sb(`ha_signals?id=eq.${encodeURIComponent(signalId)}&select=*&limit=1`, { method: 'GET' });
  const signal = (Array.isArray(signalRows) ? signalRows[0] : null);
  if (!signal || !orgUserIds.includes(signal.user_id)) return json(res, 404, { error: 'Signal not found for your organization.' });
  const eventFingerprint = signal.event_fingerprint;

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

// event_fingerprint alone is not a safe read-back key for the same reason
// it is not a safe write-resolution key (see handlePost's own identity
// comment): ha_signals only guarantees uniqueness per (user_id,
// event_fingerprint), never per account, so two distinct real accounts
// that happen to normalize to the same fingerprint could otherwise bleed
// each other's feedback history together. account_name is captured on
// every ha_signal_events row at write time (see handlePost), so pairing
// it with event_fingerprint is the smallest additional identity that
// keeps read-back attached to the correct account context -- without
// giving up longitudinal read-back across a ha_signals row being
// refreshed/upserted in place (a switch to signal_id would break that,
// since a refreshed row's id can change while its fingerprint/account
// stay the same for what is still, to the rep, the same business event).
function readBackKey(eventFingerprint, accountName) {
  return `${eventFingerprint}::${clean(accountName)}`;
}

// Batched, current-rep-only read-back -- reflects THIS rep's own latest
// state so the UI doesn't feel like it forgot prior feedback on reopen.
// Deliberately never aggregates across the organization (no manager/team
// visibility here) -- scoped entirely by user_id, which also means no
// separate signal-ownership check is needed: the query can never surface
// another user's rows regardless of what fingerprints are requested.
async function handleGet(req, res, user) {
  let requestedKeys;
  try {
    const raw = clean(req.query?.keys || '');
    if (!raw) throw new Error('empty');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error('not an array');
    requestedKeys = parsed
      .map(k => ({ eventFingerprint: clean(k?.eventFingerprint), accountName: clean(k?.accountName) }))
      .filter(k => k.eventFingerprint);
  } catch {
    return json(res, 400, { error: 'keys is required (a JSON array of {eventFingerprint, accountName}).' });
  }
  const seen = new Set();
  const keys = [];
  for (const k of requestedKeys) {
    const composite = readBackKey(k.eventFingerprint, k.accountName);
    if (seen.has(composite)) continue;
    seen.add(composite);
    keys.push(k);
  }
  const capped = keys.slice(0, MAX_READBACK_FINGERPRINTS);
  if (!capped.length) return json(res, 400, { error: 'keys is required (a JSON array of {eventFingerprint, accountName}).' });

  const fingerprints = [...new Set(capped.map(k => k.eventFingerprint))];
  const filter = `in.(${fingerprints.map(f => `"${f.replace(/"/g, '')}"`).join(',')})`;
  const rows = await sb(`ha_signal_events?user_id=eq.${encodeURIComponent(user.id)}&event_fingerprint=${filter}&select=*&order=created_at.desc`, { method: 'GET' });
  const allRows = Array.isArray(rows) ? rows : [];

  const states = {};
  for (const k of capped) {
    const composite = readBackKey(k.eventFingerprint, k.accountName);
    const state = { feedback: null, selected: false, outreachLogged: false, latestOutreachEventId: null, approachNote: null, outcomeStatus: null, latestOutcomeReportedAt: null };
    states[composite] = state;
    // Rows arrive newest-first; scoped to this exact (fingerprint,
    // account) pair so a different account sharing the same fingerprint
    // can never contribute to this state.
    const relevant = allRows.filter(row => row.event_fingerprint === k.eventFingerprint && clean(row.account_name) === clean(k.accountName));
    // Organizational Learning V1B, item 11: read-back is source-agnostic by
    // design -- a fingerprint's namespace alone (unprefixed for ha_signals,
    // opp:*:v1: for ha_account_opportunities) already keeps the two
    // families from ever colliding on the same (eventFingerprint,
    // accountName) key, so this loop simply recognizes both the signal_*
    // and opportunity_* spellings of the same underlying judgment/action
    // rather than needing to know in advance which family `k` belongs to.
    for (const row of relevant) {
      if (state.feedback === null && (row.event_type === 'signal_useful' || row.event_type === 'opportunity_useful' || row.event_type === 'signal_not_useful' || row.event_type === 'opportunity_not_useful')) {
        state.feedback = (row.event_type === 'signal_useful' || row.event_type === 'opportunity_useful') ? 'useful' : 'not_useful';
      }
      // signal_selected/opportunity_selected is durable, historical-use
      // acknowledgement, not a single "currently active" pointer -- the
      // mere EXISTENCE of at least one such event for this rep on this
      // exact signal/opportunity+account context means "the rep has
      // already chosen to work this," so a rep reopening it never has to
      // re-select it (and never causes a second selected event) merely to
      // reopen Prepare for Call.
      if (row.event_type === 'signal_selected' || row.event_type === 'opportunity_selected') state.selected = true;
      if (!state.outreachLogged && (row.event_type === 'outreach_made' || row.event_type === 'opportunity_outreach_made')) {
        state.outreachLogged = true;
        state.latestOutreachEventId = row.id;
      }
    }
    // approach_shared/opportunity_approach_shared is created AFTER its
    // parent outreach event, so it sorts BEFORE its own parent in this
    // newest-first list -- the note for THIS state must only ever come
    // from the approach-note row whose parent_event_id is the latest
    // outreach attempt just resolved above, never merely the most recent
    // approach-note row seen for this fingerprint/account. An older
    // outreach attempt's leftover note must never appear to belong to a
    // newer attempt that has none yet.
    if (state.latestOutreachEventId) {
      const note = relevant.find(row => (row.event_type === 'approach_shared' || row.event_type === 'opportunity_approach_shared') && row.parent_event_id === state.latestOutreachEventId);
      if (note) state.approachNote = note.payload?.approachNote || null;
      // Notification & Outcome Loop V1, UX read-back correction: the latest
      // outcome_reported child of the LATEST outreach attempt, same scoping
      // rule as approachNote just above -- an older attempt's outcome must
      // never appear to belong to a newer attempt that has none of its own
      // yet. `relevant` is still newest-first here, so the first match is
      // already the latest report.
      const outcome = relevant.find(row => row.event_type === 'outcome_reported' && row.parent_event_id === state.latestOutreachEventId);
      if (outcome) {
        state.outcomeStatus = outcome.payload?.outcomeStatus || null;
        state.latestOutcomeReportedAt = outcome.created_at;
      }
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

export { resolveOrgUserIds, buildRecommendationSnapshot, truncate, EVENT_TYPES, OPPORTUNITY_EVENT_TYPES, SNAPSHOT_EVENT_TYPES, readBackKey };
