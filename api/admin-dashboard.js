// Vercel Serverless Function: House Accounts beta admin dashboard data.
// Endpoint: GET /api/admin-dashboard?email=<authorized-admin-email>
// Uses existing Supabase tables only. Service role key stays server-side.

function json(res, status, body){ return res.status(status).json(body); }
function clean(v=''){ return String(v || '').trim(); }
function env(){
  const rawUrl = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const adminEmail = clean(process.env.ADMIN_EMAIL).toLowerCase();
  if(!rawUrl || !key) throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  if(!adminEmail) throw new Error('Missing ADMIN_EMAIL');
  const url = String(rawUrl).trim().replace(/\/+$/, '').replace(/\/rest\/v1$/i, '');
  return {url, key, adminEmail};
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
  return {data, headers: resp.headers};
}

async function maybeSupabase(path, options={}){
  try{ return await supabase(path, options); }
  catch(err){
    const msg = String(err?.message || '').toLowerCase();
    if(msg.includes('ha_feedback') || msg.includes('could not find') || msg.includes('does not exist') || msg.includes('schema cache')){
      return {data:null, headers:new Headers(), missing:true};
    }
    throw err;
  }
}

async function countRows(table){
  const {headers} = await supabase(`${table}?select=id&limit=1`, {
    headers: {Prefer: 'count=exact'}
  });
  const range = headers.get('content-range') || '';
  const total = Number((range.split('/')[1] || '').trim());
  return Number.isFinite(total) ? total : 0;
}

function parseDate(value){
  const t = new Date(value || 0).getTime();
  return Number.isFinite(t) && t > 0 ? t : 0;
}
function latestDate(rows, field){
  const latest = Math.max(0, ...(rows || []).map(r => parseDate(r?.[field])));
  return latest ? new Date(latest).toISOString() : '';
}
function groupByUser(rows){
  const map = new Map();
  for(const row of rows || []){
    const id = row?.user_id;
    if(!id) continue;
    if(!map.has(id)) map.set(id, []);
    map.get(id).push(row);
  }
  return map;
}
function feedbackUserId(row){
  return row?.user_id || row?.userId || row?.user || '';
}
function feedbackEmail(row){ return clean(row?.email || row?.user_email || row?.userEmail).toLowerCase(); }
function feedbackCreatedAt(row){ return row?.created_at || row?.timestamp || row?.submitted_at || row?.createdAt || ''; }
function feedbackType(row){ return row?.type || row?.feedback_type || row?.feedbackType || 'Feedback'; }
function feedbackMessage(row){ return row?.message || row?.body || row?.comment || row?.feedback || ''; }

export default async function handler(req, res){
  if(req.method !== 'GET') return json(res, 405, {error:'Method not allowed'});
  try{
    const requesterEmail = clean(req.query?.email).toLowerCase();
    const {adminEmail} = env();
    if(!requesterEmail || requesterEmail !== adminEmail){
      return json(res, 403, {error:'Admin access only'});
    }

    const [
      totalUsers,
      totalUploads,
      totalAccounts,
      totalSignals,
      totalWeeklyRuns
    ] = await Promise.all([
      countRows('ha_users'),
      countRows('ha_uploads'),
      countRows('ha_accounts'),
      countRows('ha_signals'),
      countRows('ha_weekly_runs')
    ]);

    const feedbackCountResult = await maybeSupabase('ha_feedback?select=id&limit=1', {headers:{Prefer:'count=exact'}});
    let totalFeedback = null;
    if(!feedbackCountResult.missing){
      const range = feedbackCountResult.headers.get('content-range') || '';
      const total = Number((range.split('/')[1] || '').trim());
      totalFeedback = Number.isFinite(total) ? total : 0;
    }

    const [usersRes, uploadsRes, accountsRes, signalsRes, runsRes, feedbackRes] = await Promise.all([
      supabase('ha_users?select=*&order=created_at.desc&limit=500'),
      supabase('ha_uploads?select=*&order=created_at.desc&limit=1000'),
      supabase('ha_accounts?select=id,user_id,upload_id,account_name,created_at&order=created_at.desc&limit=5000'),
      supabase('ha_signals?select=id,user_id,upload_id,account_name,signal_type,title,first_seen_at,last_seen_at&order=first_seen_at.desc&limit=1000'),
      supabase('ha_weekly_runs?select=*&order=started_at.desc&limit=500'),
      maybeSupabase('ha_feedback?select=*&order=created_at.desc&limit=500')
    ]);

    const users = usersRes.data || [];
    const uploads = uploadsRes.data || [];
    const accounts = accountsRes.data || [];
    const signals = signalsRes.data || [];
    const weeklyRuns = runsRes.data || [];
    const feedback = Array.isArray(feedbackRes.data) ? feedbackRes.data : [];

    const userById = new Map(users.map(u => [u.id, u]));
    const userByEmail = new Map(users.map(u => [clean(u.email).toLowerCase(), u]));
    const uploadsByUser = groupByUser(uploads);
    const accountsByUser = groupByUser(accounts);
    const signalsByUser = groupByUser(signals);
    const runsByUser = groupByUser(weeklyRuns);
    const feedbackByUser = new Map();
    for(const row of feedback){
      const uid = feedbackUserId(row) || userByEmail.get(feedbackEmail(row))?.id;
      if(!uid) continue;
      if(!feedbackByUser.has(uid)) feedbackByUser.set(uid, []);
      feedbackByUser.get(uid).push(row);
    }

    const betaUsers = users.map(user => {
      const userUploads = uploadsByUser.get(user.id) || [];
      const userAccounts = accountsByUser.get(user.id) || [];
      const userSignals = signalsByUser.get(user.id) || [];
      const userRuns = runsByUser.get(user.id) || [];
      const userFeedback = feedbackByUser.get(user.id) || [];
      return {
        id: user.id,
        name: user.name || '',
        email: user.email || '',
        company: user.company || '',
        role: user.role || '',
        crmErp: user.crm_erp || '',
        houseAccountCount: user.house_accounts || '',
        signupDate: user.created_at || '',
        uploadCount: userUploads.length,
        accountCount: userAccounts.length,
        signalCount: userSignals.length,
        lastUploadDate: latestDate(userUploads, 'created_at') || latestDate(userUploads, 'updated_at'),
        lastWeeklyRunDate: latestDate(userRuns, 'started_at') || latestDate(userRuns, 'finished_at'),
        feedbackCount: userFeedback.length,
        dashboardUrl: `/?dashboardEmail=${encodeURIComponent(user.email || '')}`
      };
    });

    function decorate(row){
      const user = userById.get(row?.user_id) || {};
      return {
        ...row,
        userEmail: user.email || '',
        userName: user.name || '',
        company: user.company || ''
      };
    }

    return json(res, 200, {
      ok:true,
      metrics: {
        totalBetaUsers: totalUsers,
        totalUploads,
        totalAccountsAnalyzed: totalAccounts,
        totalSavedSignals: totalSignals,
        totalWeeklyRuns,
        totalFeedbackSubmissions: totalFeedback
      },
      betaUsers,
      recentActivity: {
        uploads: uploads.slice(0, 10).map(decorate),
        signals: signals.slice(0, 10).map(decorate),
        weeklyRuns: weeklyRuns.slice(0, 10).map(decorate),
        feedback: feedback.slice(0, 10).map(row => ({
          id: row.id,
          type: feedbackType(row),
          message: feedbackMessage(row),
          email: feedbackEmail(row),
          currentPage: row.current_page || row.currentPage || '',
          createdAt: feedbackCreatedAt(row)
        }))
      },
      feedbackStored: !feedbackRes.missing
    });
  }catch(err){
    return json(res, 500, {error: err.message || 'Admin dashboard failed'});
  }
}
