// Vercel Serverless Function: durable, organization-scoped Cell-Level
// Buying Center x Offering Confirmation / Correction V1.
// Endpoints:
//   GET  /api/whitespace-cell-answers                 -> { ok:true, answers:{normalizedName:{cellKey:answer}} }
//     (one bounded request per render -- every cell answer for the whole
//     organization, keyed by normalized_company_name then cellKey -- same
//     "one bounded request per render" doctrine as api/whitespace-map.js's
//     batch mode.)
//   GET  /api/whitespace-cell-answers?accountName=...  -> { ok:true, cellAnswers:{cellKey:answer} }
//     (single-account convenience mode)
//   POST /api/whitespace-cell-answers { accountName, buyingCenter, category, answer }
//     -> upserts the (buying center, category) answer for that account and
//        returns the updated { ok:true, cellAnswers:{cellKey:answer} }
//
// This is the SECOND, distinct half of the V1 Covered truth rule
// (dashboard/index.html's computeAccountWhitespaceMatrix() module doctrine
// comment): a cell may render Covered only when (1) source data explicitly
// proves the specific buying-center-to-offering linkage, or (2) a rep
// explicitly confirms they sell that offering into that buying center.
// This endpoint is condition (2). It does NOT replace or read
// api/whitespace-map.js's buying-center-level confirmations (migration 24)
// -- a buying-center confirmation never implies any offering cell is
// Covered, and a cell answer here never writes to that other table.
//
// cellKey format: `${buyingCenter}||${category}` -- matches the client's
// whitespaceCellKey() in dashboard/index.html exactly. Double-pipe is safe
// as a separator since neither taxonomy string ever contains "|".
//
// Identity is resolved ONLY from a verified Supabase Auth Bearer token
// (see resolveWhitespaceCellAnswersUser() below); organization_id is
// always server-derived from that token's matching ha_users row, never
// accepted from the client -- same doctrine as api/whitespace-map.js and
// every other org-scoped endpoint in this codebase.
//
// (organization_id, normalized_company_name) is a V1 account-resolution
// key, not an immutable account identifier -- see
// supabase-schema-migration-25-whitespace-cell-answers.sql's header
// comment (and migration 24's, which established the same doctrine) for
// the full rename/re-upload safety analysis.
//
// "Latest answer wins" is enforced by a real atomic upsert (PostgREST
// on_conflict + Prefer: resolution=merge-duplicates), not a client-side
// read-then-write race like api/whitespace-map.js's toggle needs -- there
// is no existence-check-then-insert-or-delete step here, and therefore no
// concurrent-insert race to special-case.
//
// Explicitly NOT emitted into ha_signal_events / Behavioral Learning, not
// aggregated across accounts or organizations (founder instruction,
// 2026-08-19) -- this endpoint only ever reads/writes
// ha_whitespace_cell_answers.
import { normalizeCompanyName } from './company-identity.js';

const WHITESPACE_DEPARTMENTS = ['HR / People', 'Events', 'Marketing', 'Operations / Facilities', 'Procurement', 'Sales / Client Experience', 'Leadership'];
const WHITESPACE_CATEGORIES = ['Apparel', 'Headwear', 'Drinkware', 'Event / Giveaway', 'Recognition / Awards', 'Print / Stationery', 'Onboarding / Recruiting', 'Safety', 'Wellness / Employee Engagement', 'Client Gifts', 'Sales Incentive'];
const WHITESPACE_CELL_ANSWERS = ['covered', 'whitespace', 'not_applicable'];

function cellKey(buyingCenter, category){ return `${buyingCenter}||${category}`; }

function json(res, status, body){ return res.status(status).json(body); }
function clean(v=''){ return String(v || '').trim(); }
function env(){
  const rawUrl = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if(!rawUrl || !key) throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  const url = String(rawUrl).trim().replace(/\/+$/, '').replace(/\/rest\/v1$/i, '');
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
    const error = new Error(`Supabase ${resp.status}: ${msg}`);
    error.status = resp.status;
    error.body = data;
    throw error;
  }
  return data;
}
async function authFetchUser(req){
  const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if(!token) return {ok:false, reason:'no-token'};
  const {url, key} = env();
  const resp = await fetch(`${url}/auth/v1/user`, {headers:{apikey:key, Authorization:`Bearer ${token}`}});
  if(!resp.ok) return {ok:false, reason:'invalid-token'};
  const authUser = await resp.json().catch(() => null);
  if(!authUser?.id) return {ok:false, reason:'invalid-token'};
  return {ok:true, authUser};
}
async function resolveWhitespaceCellAnswersUser(req){
  const auth = await authFetchUser(req);
  if(!auth.ok) return {user:null, reason:auth.reason};
  const byAuth = await supabase(`ha_users?select=*&auth_user_id=eq.${encodeURIComponent(auth.authUser.id)}&limit=1`);
  const user = Array.isArray(byAuth) ? byAuth[0] : null;
  if(!user) return {user:null, reason:'no-account'};
  return {user, reason:null};
}

async function fetchCellAnswers(organizationId, normalizedName){
  const rows = await supabase(`ha_whitespace_cell_answers?organization_id=eq.${encodeURIComponent(organizationId)}&normalized_company_name=eq.${encodeURIComponent(normalizedName)}&select=buying_center,category,answer`);
  const cellAnswers = {};
  for(const row of (Array.isArray(rows) ? rows : [])){
    cellAnswers[cellKey(row.buying_center, row.category)] = row.answer;
  }
  return cellAnswers;
}
async function fetchAllCellAnswers(organizationId){
  const rows = await supabase(`ha_whitespace_cell_answers?organization_id=eq.${encodeURIComponent(organizationId)}&select=normalized_company_name,buying_center,category,answer`);
  const answers = {};
  for(const row of (Array.isArray(rows) ? rows : [])){
    const key = row.normalized_company_name;
    if(!key) continue;
    if(!answers[key]) answers[key] = {};
    answers[key][cellKey(row.buying_center, row.category)] = row.answer;
  }
  return answers;
}

export default async function handler(req, res){
  try{
    const {user, reason} = await resolveWhitespaceCellAnswersUser(req);
    if(!user) return json(res, reason === 'no-account' ? 403 : 401, {error: 'Not authenticated'});
    // A user with no organization (shouldn't happen for a real Beta
    // account, but fails safe rather than throwing) has no cell answers to
    // read or write -- same posture as api/whitespace-map.js.
    if(!user.organization_id) return json(res, 200, {ok:true, cellAnswers:{}, answers:{}});

    if(req.method === 'GET'){
      const accountName = clean(req.query?.accountName || '');
      if(!accountName){
        const answers = await fetchAllCellAnswers(user.organization_id);
        return json(res, 200, {ok:true, answers});
      }
      const normalizedName = normalizeCompanyName(accountName);
      const cellAnswers = await fetchCellAnswers(user.organization_id, normalizedName);
      return json(res, 200, {ok:true, cellAnswers});
    }

    if(req.method === 'POST'){
      const body = req.body || {};
      const accountName = clean(body.accountName || '');
      const buyingCenter = clean(body.buyingCenter || '');
      const category = clean(body.category || '');
      const answer = clean(body.answer || '');
      if(!accountName) return json(res, 400, {error: 'accountName is required'});
      if(!WHITESPACE_DEPARTMENTS.includes(buyingCenter)) return json(res, 400, {error: 'buyingCenter is not a recognized buying center'});
      if(!WHITESPACE_CATEGORIES.includes(category)) return json(res, 400, {error: 'category is not a recognized offering'});
      if(!WHITESPACE_CELL_ANSWERS.includes(answer)) return json(res, 400, {error: 'answer must be one of: covered, whitespace, not_applicable'});
      const normalizedName = normalizeCompanyName(accountName);

      // Atomic upsert: PostgREST's on_conflict + merge-duplicates resolves
      // insert-vs-update at the database layer in one request -- "latest
      // answer wins," no existence-check-then-write race to handle (unlike
      // api/whitespace-map.js's toggle, which deletes/inserts and therefore
      // does need one).
      await supabase(`ha_whitespace_cell_answers?on_conflict=organization_id,normalized_company_name,buying_center,category`, {
        method:'POST',
        prefer:'resolution=merge-duplicates,return=minimal',
        body: JSON.stringify({
          organization_id: user.organization_id,
          normalized_company_name: normalizedName,
          buying_center: buyingCenter,
          category,
          answer,
          confirmed_by_user_id: user.id,
          updated_at: new Date().toISOString()
        })
      });
      const cellAnswers = await fetchCellAnswers(user.organization_id, normalizedName);
      return json(res, 200, {ok:true, cellAnswers});
    }

    return json(res, 405, {error: 'Method not allowed'});
  }catch(err){
    console.error('[whitespace-cell-answers] request failed', err?.message || err);
    return json(res, 500, {error: 'Internal error'});
  }
}

export { WHITESPACE_DEPARTMENTS, WHITESPACE_CATEGORIES, WHITESPACE_CELL_ANSWERS, cellKey, resolveWhitespaceCellAnswersUser, fetchCellAnswers, fetchAllCellAnswers };
