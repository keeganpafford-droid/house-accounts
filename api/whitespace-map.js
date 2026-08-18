// Vercel Serverless Function: durable, organization-scoped Account
// Expansion / Whitespace Intelligence buying-center confirmations.
// Endpoints:
//   GET  /api/whitespace-map                 -> { ok:true, confirmations:{normalizedName:[...]} }
//     (one bounded request per render -- every confirmation for the whole
//     organization, keyed by normalized_company_name -- matches the "one
//     bounded request per render" doctrine established by
//     fetchOrgSignalPreferences() in api/get-dashboard.js rather than one
//     request per account.)
//   GET  /api/whitespace-map?accountName=... -> { ok:true, confirmedCenters:[...] }
//     (single-account convenience mode, still supported for callers that
//     only need one account's centers)
//   POST /api/whitespace-map { accountName, buyingCenter } -> toggles the
//     confirmation and returns the updated { ok:true, confirmedCenters:[...] }
//
// Replaces the interim client-local (localStorage) implementation shipped
// with the Buying Center x Offering matrix -- a rep confirming "we have a
// relationship in Marketing at this account" is organization intelligence:
// durable, cross-device, visible to every authorized member of that
// organization -- never a browser preference.
//
// Identity is resolved ONLY from a verified Supabase Auth Bearer token
// (see resolveWhitespaceMapUser() below); organization_id is always
// server-derived from that token's matching ha_users row, never accepted
// from the client -- same doctrine as every other org-scoped endpoint in
// this codebase (see api/get-dashboard.js's fetchOrgSignalPreferences()).
// Confirmations are keyed by (organization_id, normalizeCompanyName(accountName))
// -- see supabase-schema-migration-24-whitespace-confirmations.sql's own
// header comment for why this identity convention, reused from
// ha_monitoring_targets, was chosen over a hard foreign key or an
// ha_signal_events-based representation.
import { normalizeCompanyName } from './company-identity.js';

const WHITESPACE_DEPARTMENTS = ['HR / People', 'Events', 'Marketing', 'Operations / Facilities', 'Procurement', 'Sales / Client Experience', 'Leadership'];

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
async function resolveWhitespaceMapUser(req){
  const auth = await authFetchUser(req);
  if(!auth.ok) return {user:null, reason:auth.reason};
  const byAuth = await supabase(`ha_users?select=*&auth_user_id=eq.${encodeURIComponent(auth.authUser.id)}&limit=1`);
  const user = Array.isArray(byAuth) ? byAuth[0] : null;
  if(!user) return {user:null, reason:'no-account'};
  return {user, reason:null};
}

async function fetchConfirmedCenters(organizationId, normalizedName){
  const rows = await supabase(`ha_whitespace_confirmations?organization_id=eq.${encodeURIComponent(organizationId)}&normalized_company_name=eq.${encodeURIComponent(normalizedName)}&select=buying_center`);
  return (Array.isArray(rows) ? rows : []).map(r => r.buying_center);
}
async function fetchAllConfirmations(organizationId){
  const rows = await supabase(`ha_whitespace_confirmations?organization_id=eq.${encodeURIComponent(organizationId)}&select=normalized_company_name,buying_center`);
  const confirmations = {};
  for(const row of (Array.isArray(rows) ? rows : [])){
    const key = row.normalized_company_name;
    if(!key) continue;
    if(!confirmations[key]) confirmations[key] = [];
    confirmations[key].push(row.buying_center);
  }
  return confirmations;
}

export default async function handler(req, res){
  try{
    const {user, reason} = await resolveWhitespaceMapUser(req);
    if(!user) return json(res, reason === 'no-account' ? 403 : 401, {error: 'Not authenticated'});
    // A user with no organization (shouldn't happen for a real Beta
    // account, but fails safe rather than throwing) has no confirmations
    // to read or write.
    if(!user.organization_id) return json(res, 200, {ok:true, confirmedCenters:[], confirmations:{}});

    if(req.method === 'GET'){
      const accountName = clean(req.query?.accountName || '');
      if(!accountName){
        const confirmations = await fetchAllConfirmations(user.organization_id);
        return json(res, 200, {ok:true, confirmations});
      }
      const normalizedName = normalizeCompanyName(accountName);
      const confirmedCenters = await fetchConfirmedCenters(user.organization_id, normalizedName);
      return json(res, 200, {ok:true, confirmedCenters});
    }

    if(req.method === 'POST'){
      const body = req.body || {};
      const accountName = clean(body.accountName || '');
      const buyingCenter = clean(body.buyingCenter || '');
      if(!accountName) return json(res, 400, {error: 'accountName is required'});
      if(!WHITESPACE_DEPARTMENTS.includes(buyingCenter)) return json(res, 400, {error: 'buyingCenter is not a recognized buying center'});
      const normalizedName = normalizeCompanyName(accountName);

      const existing = await supabase(`ha_whitespace_confirmations?organization_id=eq.${encodeURIComponent(user.organization_id)}&normalized_company_name=eq.${encodeURIComponent(normalizedName)}&buying_center=eq.${encodeURIComponent(buyingCenter)}&select=id`);
      const existingRow = Array.isArray(existing) ? existing[0] : null;
      if(existingRow){
        await supabase(`ha_whitespace_confirmations?id=eq.${encodeURIComponent(existingRow.id)}`, {method:'DELETE', prefer:'return=minimal'});
      } else {
        try{
          await supabase('ha_whitespace_confirmations', {
            method:'POST', prefer:'return=minimal',
            body: JSON.stringify({
              organization_id: user.organization_id,
              normalized_company_name: normalizedName,
              buying_center: buyingCenter,
              confirmed_by_user_id: user.id
            })
          });
        }catch(err){
          // A concurrent request from another tab/teammate already inserted
          // the same (org, account, buying center) row between our existence
          // check and this insert -- the unique constraint rejects the
          // duplicate. The end state (confirmed) is exactly what this
          // request wanted, so treat it as success rather than a real error.
          const isDuplicate = err?.status === 409 || /duplicate key|already exists/i.test(String(err?.message || ''));
          if(!isDuplicate) throw err;
        }
      }
      const confirmedCenters = await fetchConfirmedCenters(user.organization_id, normalizedName);
      return json(res, 200, {ok:true, confirmedCenters});
    }

    return json(res, 405, {error: 'Method not allowed'});
  }catch(err){
    console.error('[whitespace-map] request failed', err?.message || err);
    return json(res, 500, {error: 'Internal error'});
  }
}

export { WHITESPACE_DEPARTMENTS, resolveWhitespaceMapUser, fetchConfirmedCenters, fetchAllConfirmations };
