// Vercel Serverless Function: Save House Accounts uploads to Supabase.
// Endpoint: POST /api/save-upload

function json(res, status, body){ return res.status(status).json(body); }
function clean(v=''){ return String(v || '').trim(); }
function hashString(input=''){
  let h = 2166136261;
  const s = String(input || '');
  for(let i=0;i<s.length;i++){ h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(16);
}
function signalHash(userId, uploadId, accountName, signal){
  return hashString([userId, uploadId, accountName, signal.signalType || signal.type || '', signal.signalTitle || signal.title || signal.whatChanged || '', signal.sourceUrl || signal.source || ''].join('|').toLowerCase());
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

async function authFetchUser(req){
  const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i,'');
  if(!token) return null;
  const {url, key} = env();
  const resp = await fetch(`${url}/auth/v1/user`, {headers:{apikey:key, Authorization:`Bearer ${token}`}});
  if(!resp.ok) return null;
  return resp.json();
}

function normalizeCompanyName(name=''){
  return clean(name).toLowerCase().replace(/\b(incorporated|inc|llc|ltd|limited|corp|corporation|co|company)\b\.?/g,'').replace(/[^a-z0-9]+/g,' ').trim();
}
async function orgUsers(orgId,userId){
  if(orgId){
    const rows = await supabase(`ha_users?organization_id=eq.${encodeURIComponent(orgId)}&select=id`, {method:'GET'}).catch(()=>[]);
    return (Array.isArray(rows)?rows:[]).map(u=>u.id).filter(Boolean);
  }
  return [userId].filter(Boolean);
}
async function getOrganization(user){
  if(!user?.organization_id) return null;
  const rows = await supabase(`ha_organizations?id=eq.${encodeURIComponent(user.organization_id)}&select=*&limit=1`, {method:'GET'}).catch(()=>[]);
  return Array.isArray(rows) ? rows[0] : null;
}
async function getUsageContext(user){
  const org = await getOrganization(user);
  const plan = clean(org?.plan || 'free').toLowerCase();
  const companyLimit = plan === 'free' ? 10 : Infinity;
  const ids = await orgUsers(user.organization_id, user.id);
  const inFilter = `in.(${ids.map(encodeURIComponent).join(',')})`;
  let customer=[], prospect=[];
  try{ customer = await supabase(`ha_accounts?user_id=${inFilter}&select=account_name`, {method:'GET'}); }catch{}
  try{ prospect = await supabase(`ha_prospect_accounts?user_id=${inFilter}&select=company_name`, {method:'GET'}); }catch{}
  const monitored = new Set([...(Array.isArray(customer)?customer:[]).map(r=>normalizeCompanyName(r.account_name)), ...(Array.isArray(prospect)?prospect:[]).map(r=>normalizeCompanyName(r.company_name))].filter(Boolean));
  return {org, plan, isFreePlan: plan === 'free', companyLimit, monitored};
}
function applyFreeLimitToAccounts(accounts, usage){
  if(!usage?.isFreePlan) return {accounts, lockedCount:0, totalMonitoredAfter:null};
  const monitored = new Set(usage.monitored || []);
  let unlocked = 0, lockedCount = 0;
  const limited = accounts.map(a => {
    const name = clean(a.name || a.accountName);
    const key = normalizeCompanyName(name);
    const alreadyMonitored = key && monitored.has(key);
    const canUnlock = alreadyMonitored || monitored.size < usage.companyLimit;
    if(key && canUnlock && !alreadyMonitored) monitored.add(key);
    if(canUnlock) unlocked += 1;
    else lockedCount += 1;
    return {...a, _locked: !canUnlock};
  });
  return {accounts: limited, lockedCount, totalMonitoredAfter: monitored.size};
}

async function getUserFromAuth(req){
  const authUser = await authFetchUser(req);
  if(!authUser?.id) return null;
  const rows = await supabase(`ha_users?auth_user_id=eq.${encodeURIComponent(authUser.id)}&select=*&limit=1`, {method:'GET'});
  const existing = Array.isArray(rows) ? rows[0] : null;
  if(existing) return existing;
  const byEmail = await supabase(`ha_users?email=eq.${encodeURIComponent(String(authUser.email||'').toLowerCase())}&select=*&limit=1`, {method:'GET'});
  const emailUser = Array.isArray(byEmail) ? byEmail[0] : null;
  if(emailUser?.id){
    const updated = await supabase(`ha_users?id=eq.${encodeURIComponent(emailUser.id)}`, {method:'PATCH', body:JSON.stringify({auth_user_id:authUser.id,status:'active',updated_at:new Date().toISOString()})});
    return Array.isArray(updated) ? updated[0] : updated;
  }
  return null;
}

export default async function handler(req, res){
  if(req.method !== 'POST') return json(res, 405, {error:'Method not allowed'});
  try{
    const body = req.body || {};
    const lead = body.lead || {};
    let user = await getUserFromAuth(req);
    if(!user){
      const email = clean(lead.email).toLowerCase();
      if(!email) return json(res, 401, {error:'Login required'});
      const users = await supabase('ha_users?on_conflict=email', {
        method:'POST',
        prefer:'resolution=merge-duplicates,return=representation',
        body: JSON.stringify([{
          email,
          name: clean(lead.name),
          company: clean(lead.company),
          role: clean(lead.role),
          house_accounts: clean(lead.houseAccounts || lead.house_accounts),
          crm_erp: clean(lead.crmErp || lead.crm_erp),
          source_page: clean(body.page || body.sourcePage),
          updated_at: new Date().toISOString()
        }])
      });
      user = Array.isArray(users) ? users[0] : users;
    }
    if(!user?.id) throw new Error('User lookup did not return an id.');

    let uploadId = clean(body.uploadId);
    const summary = body.summary || {};
    const uploadRow = {
      user_id: user.id,
      upload_name: clean(body.uploadName || 'Uploaded account list'),
      stage: clean(body.stage || 'uploaded'),
      summary,
      source_page: clean(body.page || body.sourcePage),
      updated_at: new Date().toISOString()
    };

    let upload;
    if(uploadId){
      const updated = await supabase(`ha_uploads?id=eq.${encodeURIComponent(uploadId)}&user_id=eq.${encodeURIComponent(user.id)}`, {
        method:'PATCH',
        body: JSON.stringify(uploadRow)
      });
      upload = Array.isArray(updated) && updated[0] ? updated[0] : {id: uploadId};
    } else {
      const inserted = await supabase('ha_uploads', { method:'POST', body: JSON.stringify([uploadRow]) });
      upload = Array.isArray(inserted) ? inserted[0] : inserted;
      uploadId = upload.id;
    }
    if(!uploadId) throw new Error('Upload save did not return an id. Confirm ha_uploads table exists.');

    const rawAccounts = Array.isArray(body.accounts) ? body.accounts : [];
    const usageContext = await getUsageContext(user);
    const limitResult = applyFreeLimitToAccounts(rawAccounts, usageContext);
    const accounts = limitResult.accounts;
    const unlockedAccounts = accounts.filter(a => !a._locked);
    if(accounts.length){
      await supabase(`ha_accounts?upload_id=eq.${encodeURIComponent(uploadId)}`, { method:'DELETE', prefer:'return=minimal' });
      const accountRows = unlockedAccounts.slice(0, 2500).map(a => ({
        user_id: user.id,
        upload_id: uploadId,
        account_name: clean(a.name || a.accountName),
        industry: clean(a.industry),
        contact_name: clean(a.contactName),
        contact_email: clean(a.contactEmail).toLowerCase(),
        metrics: a.metrics || {},
        raw_data: a.rawData || {},
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      })).filter(a => a.account_name);
      if(accountRows.length){
        const chunkSize = 250;
        for(let i=0;i<accountRows.length;i+=chunkSize){
          await supabase('ha_accounts', { method:'POST', prefer:'return=minimal', body: JSON.stringify(accountRows.slice(i, i+chunkSize)) });
        }
      }
    }

    const signalRows = [];
    for(const account of unlockedAccounts){
      const signals = Array.isArray(account.signals) ? account.signals : [];
      for(const s of signals){
        const h = signalHash(user.id, uploadId, account.name || account.accountName, s);
        signalRows.push({
          user_id: user.id,
          upload_id: uploadId,
          account_name: clean(account.name || account.accountName),
          signal_hash: h,
          signal_type: clean(s.signalType || s.type || 'Business Activity'),
          title: clean(s.signalTitle || s.title || s.whatChanged),
          why_reach_out: clean(s.whyItMattersForPromo || s.whyReachOut || s.reasonToReachOut || s.whyNow),
          confidence: Number(s.confidenceScore || s.confidence || 0) || null,
          source_url: clean(s.sourceUrl || s.url),
          source_domain: clean(s.cleanSourceName || s.sourceName || ''),
          published_at: clean(s.publicationDate || s.publishedAt) || null,
          payload: s,
          first_seen_at: new Date().toISOString(),
          last_seen_at: new Date().toISOString()
        });
      }
    }
    if(signalRows.length){
      const chunkSize = 200;
      for(let i=0;i<signalRows.length;i+=chunkSize){
        await supabase('ha_signals?on_conflict=signal_hash', {
          method:'POST',
          prefer:'resolution=ignore-duplicates,return=minimal',
          body: JSON.stringify(signalRows.slice(i, i+chunkSize))
        });
      }
    }

    return json(res, 200, {ok:true, userId:user.id, uploadId, accountsAnalyzed:accounts.length, accountsSaved:unlockedAccounts.length, lockedCount:limitResult.lockedCount||0, totalMonitoredCompanies:limitResult.totalMonitoredAfter, companyLimit:Number.isFinite(usageContext.companyLimit)?usageContext.companyLimit:null, signalsSaved:signalRows.length});
  } catch(err){
    return json(res, 500, {error: err.message || 'Save failed'});
  }
}
