// Vercel Serverless Function: Save Prospect Intelligence uploads to Supabase.
// Endpoint: POST /api/save-prospect-upload
//
// Uses the existing Prospect Intelligence tables exactly as currently defined:
// ha_prospect_uploads: id, user_email, filename, account_count, status, created_at
// ha_prospect_accounts: id, upload_id, company_name, website, industry, location, status, last_scanned_at, created_at
// ha_prospect_signals: id, prospect_account_id, upload_id, user_email, company_name, signal_type, title, summary,
//                      source_url, source_name, confidence_score, why_now_score, suggested_opener, created_at

function json(res, status, body) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  return res.status(status).json(body);
}

function log(label, payload) {
  try {
    console.log(`[Prospect Save] ${label}`, JSON.stringify(payload));
  } catch {
    console.log(`[Prospect Save] ${label}`, payload);
  }
}

function logError(label, err) {
  console.error(`[Prospect Save] ${label}`, err?.message || err);
}

function clean(value = '') {
  return String(value || '').trim();
}

function normalizeCompanyName(name = '') {
  return clean(name)
    .toLowerCase()
    .replace(/\b(incorporated|inc|llc|ltd|limited|corp|corporation|co|company)\b\.?/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
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
  if (text) {
    try { data = JSON.parse(text); } catch { data = text; }
  }

  if (!resp.ok) {
    const msg = typeof data === 'string' ? data : (data?.message || data?.hint || JSON.stringify(data));
    throw new Error(`Supabase ${resp.status}: ${msg}`);
  }

  return data;
}

async function authFetchUser(req) {
  const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!token) return null;

  const { url, key } = env();
  const resp = await fetch(`${url}/auth/v1/user`, {
    headers: {
      apikey: key,
      Authorization: `Bearer ${token}`
    }
  });

  if (!resp.ok) return null;
  return resp.json();
}

async function getUserFromAuth(req) {
  const authUser = await authFetchUser(req);
  if (!authUser?.id) return null;

  const byAuthId = await supabase(
    `ha_users?auth_user_id=eq.${encodeURIComponent(authUser.id)}&select=*&limit=1`,
    { method: 'GET' }
  );
  const existing = Array.isArray(byAuthId) ? byAuthId[0] : null;
  if (existing) return existing;

  const email = clean(authUser.email).toLowerCase();
  if (!email) return null;

  const byEmail = await supabase(
    `ha_users?email=eq.${encodeURIComponent(email)}&select=*&limit=1`,
    { method: 'GET' }
  );
  const emailUser = Array.isArray(byEmail) ? byEmail[0] : null;

  if (emailUser?.id) {
    const updated = await supabase(
      `ha_users?id=eq.${encodeURIComponent(emailUser.id)}`,
      {
        method: 'PATCH',
        body: JSON.stringify({
          auth_user_id: authUser.id,
          status: 'active',
          updated_at: new Date().toISOString()
        })
      }
    );
    return Array.isArray(updated) ? updated[0] : updated;
  }

  return null;
}

async function upsertUser(lead = {}, page = '', req = null) {
  const authUser = req ? await getUserFromAuth(req) : null;
  if (authUser?.id) return authUser;

  const email = clean(lead.email).toLowerCase();
  if (!email) throw new Error('Missing user email');

  const users = await supabase('ha_users?on_conflict=email', {
    method: 'POST',
    prefer: 'resolution=merge-duplicates,return=representation',
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
  if (!user?.id) throw new Error('User upsert did not return an id.');
  return user;
}

function dedupeAccounts(rawAccounts) {
  const byCompany = new Map();

  for (const account of rawAccounts) {
    const companyName = clean(account.companyName || account.name || account.accountName || account.company || account.company_name);
    const key = normalizeCompanyName(companyName);
    if (!key) continue;

    const existing = byCompany.get(key);
    if (!existing) {
      byCompany.set(key, {
        ...account,
        companyName,
        contacts: Array.isArray(account.contacts) ? account.contacts : [],
        rawRows: Array.isArray(account.rawRows) ? account.rawRows : [],
        signals: Array.isArray(account.signals) ? account.signals : []
      });
      continue;
    }

    existing.contacts = [
      ...(Array.isArray(existing.contacts) ? existing.contacts : []),
      ...(Array.isArray(account.contacts) ? account.contacts : [])
    ];
    existing.rawRows = [
      ...(Array.isArray(existing.rawRows) ? existing.rawRows : []),
      ...(Array.isArray(account.rawRows) ? account.rawRows : [])
    ];
    existing.signals = [
      ...(Array.isArray(existing.signals) ? existing.signals : []),
      ...(Array.isArray(account.signals) ? account.signals : [])
    ];

    if (!existing.website && account.website) existing.website = account.website;
    if (!existing.industry && account.industry) existing.industry = account.industry;
    if (!existing.location && (account.location || account.cityState)) existing.location = account.location || account.cityState;
  }

  return Array.from(byCompany.values());
}

function numberOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function signalTitle(sig = {}) {
  return clean(
    sig.concrete_trigger ||
    sig.concreteTrigger ||
    sig.buying_moment ||
    sig.buyingMoment ||
    sig.title ||
    sig.signalTitle ||
    sig.headline ||
    'Business activity signal'
  );
}

function signalSummary(sig = {}) {
  return clean(
    sig.summary ||
    sig.business_context ||
    sig.businessContext ||
    sig.why_this_matters ||
    sig.whyThisMatters ||
    sig.whyItMattersForPromo ||
    sig.reasonToReachOut ||
    sig.signalDetail
  );
}

function signalType(sig = {}) {
  return clean(
    sig.signal_type ||
    sig.signalType ||
    sig.type ||
    sig.opportunityType ||
    'Business Activity'
  );
}

function sourceUrl(sig = {}) {
  return clean(
    sig.source_url ||
    sig.sourceUrl ||
    sig.url ||
    (Array.isArray(sig.sources) ? sig.sources[0]?.url : '')
  );
}

function sourceName(sig = {}) {
  return clean(
    sig.source_name ||
    sig.sourceName ||
    sig.cleanSourceName ||
    sig.sourceDomain ||
    sig.sourceType ||
    sig.sourceAuthority ||
    (Array.isArray(sig.sources) ? sig.sources[0]?.title || sig.sources[0]?.source_name : '')
  );
}

function confidenceScore(sig = {}) {
  const raw = sig.confidence_score ?? sig.confidenceScore ?? sig.confidence;
  const n = numberOrNull(raw);
  if (n === null) return null;
  return n <= 1 ? Math.round(n * 100) : Math.round(n);
}

function whyNowScore(sig = {}) {
  const raw = sig.why_now_score ?? sig.whyNowScore ?? sig.whyNow ?? sig.score;
  const n = numberOrNull(raw);
  if (n === null) return confidenceScore(sig);
  return n <= 1 ? Math.round(n * 100) : Math.round(n);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed' });

  try {
    const body = req.body || {};
    const lead = body.lead || {};
    const rawAccounts = Array.isArray(body.accounts) ? body.accounts : [];

    if (!rawAccounts.length) return json(res, 400, { error: 'No prospect accounts provided' });

    const user = await upsertUser(lead, body.page || body.sourcePage, req);
    const userEmail = clean(user.email || lead.email).toLowerCase();
    if (!userEmail) throw new Error('Could not resolve user email for prospect save.');

    const accounts = dedupeAccounts(rawAccounts);
    const now = new Date().toISOString();
    const filename = clean(body.uploadName || body.filename || 'Uploaded target account list');

    log('save started', {
      userEmail,
      filename,
      rawAccountRows: rawAccounts.length,
      uniqueCompanies: accounts.length
    });

    // 1) Create one prospect upload row using the actual ha_prospect_uploads schema.
    const uploads = await supabase('ha_prospect_uploads', {
      method: 'POST',
      body: JSON.stringify([{
        user_email: userEmail,
        filename,
        account_count: accounts.length,
        status: clean(body.stage || 'researched'),
        created_at: now
      }])
    });

    const upload = Array.isArray(uploads) ? uploads[0] : uploads;
    if (!upload?.id) throw new Error('Prospect upload insert did not return an id.');

    log('ha_prospect_uploads insert success', {
      uploadId: upload.id,
      rowCountInserted: 1
    });

    // 2) Insert one row per unique company using the actual ha_prospect_accounts schema.
    const accountRows = accounts.map(account => ({
      upload_id: upload.id,
      company_name: clean(account.companyName || account.name || account.accountName || account.company || account.company_name),
      website: clean(account.website),
      industry: clean(account.industry),
      location: clean(account.location || account.cityState),
      status: account._locked ? 'locked' : 'active',
      last_scanned_at: now,
      created_at: now
    })).filter(row => row.company_name);

    let savedAccounts = [];
    if (accountRows.length) {
      savedAccounts = await supabase('ha_prospect_accounts', {
        method: 'POST',
        body: JSON.stringify(accountRows)
      });
    }

    log('ha_prospect_accounts insert success', {
      uploadId: upload.id,
      rowCountInserted: Array.isArray(savedAccounts) ? savedAccounts.length : 0
    });

    const accountIdByName = new Map(
      (Array.isArray(savedAccounts) ? savedAccounts : [])
        .filter(row => row?.id && row?.company_name)
        .map(row => [normalizeCompanyName(row.company_name), row.id])
    );

    // 3) Insert one row per returned signal using the actual ha_prospect_signals schema.
    const signalRows = [];
    for (const account of accounts) {
      const companyName = clean(account.companyName || account.name || account.accountName || account.company || account.company_name);
      const companyKey = normalizeCompanyName(companyName);
      const prospectAccountId = accountIdByName.get(companyKey);
      const signals = Array.isArray(account.signals) ? account.signals : [];

      for (const sig of signals) {
        if (!prospectAccountId) continue;

        signalRows.push({
          prospect_account_id: prospectAccountId,
          upload_id: upload.id,
          user_email: userEmail,
          company_name: companyName,
          signal_type: signalType(sig),
          title: signalTitle(sig),
          summary: signalSummary(sig),
          source_url: sourceUrl(sig),
          source_name: sourceName(sig),
          confidence_score: confidenceScore(sig),
          why_now_score: whyNowScore(sig),
          suggested_opener: clean(sig.suggested_opener || sig.suggestedOpener || sig.opener || sig.recommendedNextStep),
          created_at: now
        });
      }
    }

    let savedSignals = [];
    if (signalRows.length) {
      savedSignals = await supabase('ha_prospect_signals', {
        method: 'POST',
        body: JSON.stringify(signalRows)
      });
    }

    log('ha_prospect_signals insert success', {
      uploadId: upload.id,
      rowCountInserted: Array.isArray(savedSignals) ? savedSignals.length : 0
    });

    console.log(`Prospect upload saved successfully: ${accountRows.length} companies, ${signalRows.length} signals.`);

    return json(res, 200, {
      ok: true,
      uploadId: upload.id,
      userEmail,
      accountsReceived: rawAccounts.length,
      uniqueCompanies: accounts.length,
      accountsSaved: accountRows.length,
      signalsSaved: signalRows.length
    });
  } catch (err) {
    logError('save failed', err);
    return json(res, 500, { error: err.message || 'Prospect save failed' });
  }
}
