// Vercel Serverless Function: weekly monitoring scan + email report.
// Endpoint: GET /api/weekly-scan

function json(res, status, body){ return res.status(status).json(body); }
function clean(v=''){ return String(v || '').trim(); }
function hashString(input=''){
  let h = 2166136261;
  const s = String(input || '');
  for(let i=0;i<s.length;i++){ h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(16);
}
function env(){
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if(!url || !key) throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  return {url: url.replace(/\/$/, ''), key};
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
function signalHash(userId, uploadId, accountName, s){
  return hashString([userId, uploadId, accountName, s.signalType || s.type || '', s.signalTitle || s.title || s.whatChanged || '', s.sourceUrl || s.source || ''].join('|').toLowerCase());
}
function getBaseUrl(req){
  if(process.env.APP_BASE_URL) return process.env.APP_BASE_URL.replace(/\/$/, '');
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const proto = req.headers['x-forwarded-proto'] || 'https';
  return `${proto}://${host}`;
}
function accountPayload(row){
  const raw = row.raw_data || {};
  const metrics = row.metrics || {};
  return {
    name: row.account_name,
    industry: row.industry || raw.industry || '',
    contactName: row.contact_name || raw.contactName || '',
    contactEmail: row.contact_email || raw.contactEmail || '',
    notes: raw.notes || '',
    employees: raw.employees || '',
    orderCount: metrics.orderCount || 0,
    revenue: metrics.revenue || 0,
    relationshipStrength: metrics.relationshipStrength || 0,
    historicalCategories: raw.historicalCategories || [],
    historicalProjects: raw.historicalProjects || [],
    recentOrderDates: raw.recentOrderDates || [],
    existingSignals: raw.existingSignals || [],
    repeatPatterns: raw.repeatPatterns || []
  };
}
async function sendEmail({to, subject, html}){
  const key = process.env.RESEND_API_KEY;
  if(!key) return {skipped:true, reason:'Missing RESEND_API_KEY'};
  const from = process.env.ALERTS_FROM_EMAIL || 'House Accounts <alerts@houseaccounts.ai>';
  const resp = await fetch('https://api.resend.com/emails', {
    method:'POST',
    headers:{Authorization:`Bearer ${key}`, 'Content-Type':'application/json'},
    body: JSON.stringify({from, to, subject, html})
  });
  const data = await resp.json().catch(()=>({}));
  if(!resp.ok) throw new Error(`Resend ${resp.status}: ${data.message || JSON.stringify(data)}`);
  return data;
}
function reportHtml(user, upload, newSignals){
  const rows = newSignals.slice(0,10).map(s => `<tr><td style="padding:10px;border-bottom:1px solid #e5e7eb;"><strong>${s.account_name}</strong><br><span style="color:#6b7280;">${s.signal_type}</span></td><td style="padding:10px;border-bottom:1px solid #e5e7eb;"><strong>${s.title}</strong><br>${s.why_reach_out || ''}</td></tr>`).join('');
  return `<div style="font-family:Arial,sans-serif;line-height:1.5;color:#0b2d4d;"><h1>House Accounts: New reasons to reach out</h1><p>${newSignals.length} new business signal${newSignals.length===1?'':'s'} found for ${upload.upload_name || 'your account list'}.</p><table style="border-collapse:collapse;width:100%;">${rows}</table><p style="margin-top:24px;color:#6b7280;font-size:13px;">House Accounts scans public business activity and your uploaded account data to identify who to contact and why.</p></div>`;
}

export default async function handler(req, res){
  try{
    if(process.env.CRON_SECRET){
      const provided = req.headers.authorization?.replace(/^Bearer\s+/i, '') || req.query?.secret;
      if(provided !== process.env.CRON_SECRET) return json(res, 401, {error:'Unauthorized'});
    }
    const limit = Math.min(Number(req.query?.limit || 10), 25);
    const dryRun = String(req.query?.dryRun || '').toLowerCase() === 'true';
    const uploads = await supabase(`ha_uploads?select=id,user_id,upload_name,summary,created_at,ha_users(id,email,name,company)&order=updated_at.desc&limit=${limit}`);
    const baseUrl = getBaseUrl(req);
    const runSummary = [];

    for(const upload of uploads || []){
      const user = upload.ha_users;
      if(!user?.email) continue;
      const accounts = await supabase(`ha_accounts?select=*&upload_id=eq.${encodeURIComponent(upload.id)}&limit=75`);
      const accountPayloads = (accounts || []).map(accountPayload).filter(a => a.name).slice(0,50);
      if(!accountPayloads.length) continue;

      const started = new Date().toISOString();
      const runRows = await supabase('ha_weekly_runs', {method:'POST', body: JSON.stringify([{user_id:user.id, upload_id:upload.id, status:'running', started_at:started, summary:{accounts:accountPayloads.length}}])});
      const run = Array.isArray(runRows) ? runRows[0] : runRows;
      let newSignalRows = [];
      try{
        const researchResp = await fetch(`${baseUrl}/api/research-batch`, {
          method:'POST',
          headers:{'Content-Type':'application/json'},
          body: JSON.stringify({mode:'weekly-monitoring', accounts: accountPayloads})
        });
        const research = await researchResp.json();
        if(!researchResp.ok) throw new Error(research.error || 'Research batch failed');
        const signals = Array.isArray(research.signals) ? research.signals : [];
        for(const s of signals){
          const h = signalHash(user.id, upload.id, s.accountName, s);
          const existing = await supabase(`ha_signals?select=id&signal_hash=eq.${encodeURIComponent(h)}&limit=1`);
          if(existing && existing.length) continue;
          newSignalRows.push({
            user_id:user.id,
            upload_id:upload.id,
            weekly_run_id:run?.id || null,
            account_name: clean(s.accountName),
            signal_hash:h,
            signal_type: clean(s.signalType || 'Business Activity'),
            title: clean(s.signalTitle || s.whatChanged || ''),
            why_reach_out: clean(s.whyItMattersForPromo || s.suggestedOpener || ''),
            confidence: Number(s.confidenceScore || s.confidence || 0) || null,
            source_url: clean(s.sourceUrl || ''),
            source_domain: clean(s.cleanSourceName || s.sourceName || ''),
            published_at: clean(s.publicationDate || '') || null,
            payload:s,
            first_seen_at:new Date().toISOString(),
            last_seen_at:new Date().toISOString()
          });
        }
        if(newSignalRows.length){
          await supabase('ha_signals', {method:'POST', prefer:'return=minimal', body: JSON.stringify(newSignalRows)});
          if(!dryRun){
            await sendEmail({to:user.email, subject:`${newSignalRows.length} new House Accounts reason${newSignalRows.length===1?'':'s'} to reach out`, html:reportHtml(user, upload, newSignalRows)});
          }
        }
        await supabase(`ha_weekly_runs?id=eq.${encodeURIComponent(run?.id)}`, {method:'PATCH', body: JSON.stringify({status:'complete', finished_at:new Date().toISOString(), summary:{accounts:accountPayloads.length, newSignals:newSignalRows.length, diagnostics:research.diagnostics || {}}})});
        runSummary.push({uploadId:upload.id, email:user.email, accounts:accountPayloads.length, newSignals:newSignalRows.length});
      }catch(err){
        if(run?.id){ await supabase(`ha_weekly_runs?id=eq.${encodeURIComponent(run.id)}`, {method:'PATCH', body: JSON.stringify({status:'failed', finished_at:new Date().toISOString(), summary:{error:err.message}})}).catch(()=>{}); }
        runSummary.push({uploadId:upload.id, email:user.email, error:err.message});
      }
    }
    return json(res, 200, {ok:true, dryRun, processed:runSummary.length, runs:runSummary});
  }catch(err){
    return json(res, 500, {error:err.message || 'Weekly scan failed'});
  }
}
