// Vercel Serverless Function: Save Prospect Intelligence uploads to Supabase.
// Endpoint: POST /api/save-prospect-upload

function json(res, status, body){ res.setHeader('Cache-Control','no-store, max-age=0'); return res.status(status).json(body); }
function debugLog(label, payload){
  try{ console.log(`[Prospect Save Debug] ${label}`, JSON.stringify(payload, null, 2)); }
  catch{ console.log(`[Prospect Save Debug] ${label}`, payload); }
}
function debugError(label, err){
  console.error(`[Prospect Save Debug] ${label}`, err?.message || err, err?.stack || '');
}
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
    throw new Error(`Supabase ${resp.status}: ${msg}`);
  }
  return data;
}

async function insertWithFallback(table, payloads, options={}){
  let lastError = null;
  let attempt = 0;
  for(const payload of payloads){
    attempt += 1;
    const rows = Array.isArray(payload) ? payload : [payload];
    const sample = rows[0] ? Object.keys(rows[0]) : [];
    debugLog(`${table} insert attempt`, {attempt, rowCount: rows.length, columns: sample});
    try{
      const result = await supabase(table, {
        method:'POST',
        prefer: options.prefer || 'return=representation',
        body: JSON.stringify(rows)
      });
      debugLog(`${table} insert success`, {attempt, rowCountInserted: Array.isArray(result) ? result.length : (options.prefer === 'return=minimal' ? rows.length : (result ? 1 : 0)), returned: Array.isArray(result) ? result.slice(0,3) : result});
      return result;
    } catch(err){
      lastError = err;
      debugError(`${table} insert attempt failed`, err);
    }
  }
  throw lastError || new Error(`Unable to insert into ${table}`);
}

function firstRow(rows){ return Array.isArray(rows) ? rows[0] : rows; }


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
    const name = clean(a.companyName || a.name || a.accountName);
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

async function upsertUser(lead = {}, page = '', req = null){
  const authUser = req ? await getUserFromAuth(req) : null;
  if(authUser?.id) return authUser;
  const email = clean(lead.email).toLowerCase();
  if(!email) throw new Error('Missing user email');
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
      source_page: clean(page),
      updated_at: new Date().toISOString()
    }])
  });
  const user = Array.isArray(users) ? users[0] : users;
  if(!user?.id) throw new Error('User upsert did not return an id.');
  return user;
}

async function authFetchUser(req){
  const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i,'');
  debugLog('auth header received', {hasAuthorizationHeader: !!req.headers.authorization, hasBearerToken: !!token});
  if(!token) return null;
  const {url, key} = env();
  const resp = await fetch(`${url}/auth/v1/user`, {headers:{apikey:key, Authorization:`Bearer ${token}`}});
  debugLog('Supabase auth user lookup response', {status: resp.status, ok: resp.ok});
  if(!resp.ok) return null;
  const authUser = await resp.json();
  debugLog('Supabase auth user resolved', {id: authUser?.id, email: authUser?.email});
  return authUser;
}
async function getUserFromAuth(req){
  const authUser = await authFetchUser(req);
  if(!authUser?.id){ debugLog('ha_users lookup skipped', {reason:'no auth user'}); return null; }
  const rows = await supabase(`ha_users?auth_user_id=eq.${encodeURIComponent(authUser.id)}&select=*&limit=1`, {method:'GET'});
  const existing = Array.isArray(rows) ? rows[0] : null;
  debugLog('ha_users lookup by auth_user_id', {authUserId: authUser.id, found: !!existing, userId: existing?.id, organizationId: existing?.organization_id});
  if(existing) return existing;
  const byEmail = await supabase(`ha_users?email=eq.${encodeURIComponent(String(authUser.email||'').toLowerCase())}&select=*&limit=1`, {method:'GET'});
  const emailUser = Array.isArray(byEmail) ? byEmail[0] : null;
  debugLog('ha_users lookup by email fallback', {email: authUser.email, found: !!emailUser, userId: emailUser?.id, organizationId: emailUser?.organization_id});
  if(emailUser?.id){
    const updated = await supabase(`ha_users?id=eq.${encodeURIComponent(emailUser.id)}`, {method:'PATCH', body:JSON.stringify({auth_user_id:authUser.id,status:'active',updated_at:new Date().toISOString()})});
    const updatedUser = Array.isArray(updated) ? updated[0] : updated;
    debugLog('ha_users auth_user_id patched', {userId: updatedUser?.id, organizationId: updatedUser?.organization_id});
    return updatedUser;
  }
  return null;
}

export default async function handler(req, res){
  if(req.method !== 'POST') return json(res, 405, {error:'Method not allowed'});
  try{
    const body = req.body || {};
    const lead = body.lead || {};
    const rawAccounts = Array.isArray(body.accounts) ? body.accounts : [];
    debugLog('request received', {
      method: req.method,
      uploadName: body.uploadName,
      stage: body.stage,
      page: body.page || body.sourcePage,
      hasLead: !!body.lead,
      leadEmail: lead?.email || null,
      accountCount: rawAccounts.length,
      signalCount: rawAccounts.reduce((sum,a)=>sum+(Array.isArray(a.signals)?a.signals.length:0),0),
      firstAccounts: rawAccounts.slice(0,3).map(a=>({name:a.companyName||a.name||a.accountName, signals:Array.isArray(a.signals)?a.signals.length:0, contacts:Array.isArray(a.contacts)?a.contacts.length:0}))
    });
    const user = await upsertUser(lead, body.page || body.sourcePage, req);
    debugLog('resolved ha_user for save', {userId:user?.id, email:user?.email, organizationId:user?.organization_id});
    if(!rawAccounts.length) return json(res, 400, {error:'No prospect accounts provided'});
    const usageContext = await getUsageContext(user);
    debugLog('usage context resolved', {organizationId:user.organization_id, plan:usageContext.plan, isFreePlan:usageContext.isFreePlan, companyLimit:Number.isFinite(usageContext.companyLimit)?usageContext.companyLimit:null, monitoredBefore:usageContext.monitored?.size});
    const limitResult = applyFreeLimitToAccounts(rawAccounts, usageContext);
    const accounts = limitResult.accounts;
    const unlockedAccounts = accounts.filter(a => !a._locked);
    debugLog('free limit applied before save', {accountsReceived:accounts.length, unlockedAccounts:unlockedAccounts.length, lockedCount:limitResult.lockedCount||0, totalMonitoredAfter:limitResult.totalMonitoredAfter});

    const totalSignals = accounts.reduce((sum, a) => sum + (Array.isArray(a.signals) ? a.signals.length : 0), 0);
    const summary = body.summary || {
      accountCount: accounts.length,
      businessSignals: totalSignals,
      savedAt: new Date().toISOString()
    };

    const now = new Date().toISOString();
    const uploadPayload = {
      user_id: user.id,
      upload_name: clean(body.uploadName || 'Uploaded target account list'),
      stage: clean(body.stage || 'researched'),
      summary,
      source_page: clean(body.page || body.sourcePage),
      created_at: now,
      updated_at: now
    };
    const uploads = await insertWithFallback('ha_prospect_uploads', [
      uploadPayload,
      { user_id: user.id, upload_name: uploadPayload.upload_name, stage: uploadPayload.stage, summary, created_at: now, updated_at: now },
      { user_id: user.id, upload_name: uploadPayload.upload_name, stage: uploadPayload.stage, created_at: now },
      { user_id: user.id, upload_name: uploadPayload.upload_name, created_at: now },
      { user_id: user.id }
    ]);
    const upload = firstRow(uploads);
    debugLog('ha_prospect_uploads selected upload row', {uploadId: upload?.id, keys: upload ? Object.keys(upload) : []});
    if(!upload?.id) throw new Error('Prospect upload save did not return an id. Confirm prospect tables exist.');

    function buildProspectAccountRows(linkColumn, shape='full'){
      return unlockedAccounts.slice(0, 500).map(a => {
        const base = {
          user_id: user.id,
          [linkColumn]: upload.id,
          company_name: clean(a.companyName || a.name || a.accountName),
          website: clean(a.website),
          industry: clean(a.industry),
          location: clean(a.location || a.cityState),
          created_at: now
        };
        if(shape === 'full'){
          return {
            ...base,
            signal_count: Array.isArray(a.signals) ? a.signals.length : 0,
            signals: Array.isArray(a.signals) ? a.signals : [],
            raw_data: { ...(a.rawData || {}), uploaded_contacts: Array.isArray(a.contacts) ? a.contacts : [], raw_rows: Array.isArray(a.rawRows) ? a.rawRows : [] },
            updated_at: now
          };
        }
        return base;
      }).filter(a => a.company_name);
    }

    const savedAccounts = [];
    const accountInsertAttempts = [
      buildProspectAccountRows('upload_id','full'),
      buildProspectAccountRows('prospect_upload_id','full'),
      buildProspectAccountRows('upload_id','minimal'),
      buildProspectAccountRows('prospect_upload_id','minimal')
    ].filter(rows => rows.length);
    if(accountInsertAttempts.length){
      const inserted = await insertWithFallback('ha_prospect_accounts', accountInsertAttempts);
      if(Array.isArray(inserted)) savedAccounts.push(...inserted);
      debugLog('ha_prospect_accounts insert final', {savedAccounts: savedAccounts.length, firstSaved: savedAccounts.slice(0,3).map(a=>({id:a.id, company_name:a.company_name, keys:Object.keys(a||{})}))});
    }

    const accountIdByName = new Map(savedAccounts
      .filter(a => a && a.id && a.company_name)
      .map(a => [clean(a.company_name || a.name || a.account_name).toLowerCase(), a.id]));

    debugLog('prospect account id map', {mappedCount: accountIdByName.size, sample: Array.from(accountIdByName.entries()).slice(0,5)});

    function buildSignalRows(uploadLinkColumn, shape='full'){
      const out = [];
      for(const a of unlockedAccounts){
        const companyName = clean(a.companyName || a.name || a.accountName);
        const prospectAccountId = accountIdByName.get(companyName.toLowerCase()) || null;
        const signals = Array.isArray(a.signals) ? a.signals : [];
        for(const sig of signals){
          const base = {
            user_id: user.id,
            [uploadLinkColumn]: upload.id,
            prospect_account_id: prospectAccountId,
            account_name: companyName || clean(sig.accountName || sig.company || sig.account || sig.company_name || sig.companyName),
            signal_type: clean(sig.signalType || sig.signal_type || sig.type || sig.opportunityType || 'Business Activity'),
            title: clean(sig.concrete_trigger || sig.concreteTrigger || sig.title || sig.signalTitle || sig.headline || 'Business activity signal'),
            first_seen_at: now,
            last_seen_at: now
          };
          if(shape === 'full'){
            out.push({
              ...base,
              why_reach_out: clean(sig.reasonToReachOut || sig.whyNow || sig.whyThisMatters || sig.why_it_matters || sig.whyItMattersForPromo || sig.whyItMatters || sig.signalDetail),
              confidence: Number(sig.confidenceScore || sig.why_now_score || (Number(sig.confidence || 0) <= 1 ? Number(sig.confidence || 0) * 100 : sig.confidence) || 0),
              source_url: clean(sig.sourceUrl || sig.source_url || sig.url || sig.sources?.[0]?.url),
              source_domain: clean(sig.sourceDomain || sig.source_name || sig.cleanSourceName || sig.sourceType || sig.sourceAuthority),
              published_at: clean(sig.publishedDate || sig.publicationDate || sig.event_date || sig.date || ''),
              payload: sig
            });
          } else {
            out.push(base);
          }
        }
      }
      return out.filter(r => r.account_name && r.title);
    }

    let signalsSaved = 0;
    const signalInsertAttempts = [
      buildSignalRows('upload_id','full'),
      buildSignalRows('prospect_upload_id','full'),
      buildSignalRows('upload_id','minimal'),
      buildSignalRows('prospect_upload_id','minimal')
    ].filter(rows => rows.length);
    debugLog('signal rows prepared', {attempts: signalInsertAttempts.length, firstAttemptRows: signalInsertAttempts[0]?.length || 0, sample: (signalInsertAttempts[0]||[]).slice(0,3).map(r=>({account_name:r.account_name, prospect_account_id:r.prospect_account_id, signal_type:r.signal_type, title:r.title, columns:Object.keys(r)}))});
    if(signalInsertAttempts.length){
      await insertWithFallback('ha_prospect_signals', signalInsertAttempts, {prefer:'return=minimal'});
      signalsSaved = signalInsertAttempts[0].length;
    } else {
      debugLog('ha_prospect_signals insert skipped', {reason:'no signal rows prepared'});
    }

    return json(res, 200, {ok:true, userId:user.id, uploadId:upload.id, accountsAnalyzed:accounts.length, accountsSaved:savedAccounts.length, lockedCount:limitResult.lockedCount||0, totalMonitoredCompanies:limitResult.totalMonitoredAfter, companyLimit:Number.isFinite(usageContext.companyLimit)?usageContext.companyLimit:null, signalsSaved});
  } catch(err){
    debugError('handler failed', err);
    return json(res, 500, {error: err.message || 'Prospect save failed'});
  }
}
