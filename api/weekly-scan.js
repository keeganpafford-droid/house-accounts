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
function escapeHtml(value=''){
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
function firstNameFromUser(user={}){
  const name = clean(user.name || '');
  if(!name || name.includes('@')) return '';
  return name.split(/\s+/)[0] || '';
}
function weeklyBriefSubject(newSignals=[]){
  const count = newSignals.length;
  if(count === 1){
    const topAccount = clean(newSignals[0]?.account_name) || 'your top account';
    return `1 new reason to reach out this week: ${topAccount}`;
  }
  return `${count} new reasons to reach out this week`;
}
function metricRows(summary={}){
  const rows = [
    ['New Opportunities', summary.opportunityCount],
    ['Business Activity Signals', summary.businessSignalCount],
    ['Follow-up Opportunities', summary.followUpCount],
    ['Repeat Buying Opportunities', summary.repeatBuyingCount],
    ['Accounts Monitored', summary.accountsMonitored]
  ];
  return rows
    .filter(([,value]) => Number.isFinite(Number(value)) && Number(value) >= 0)
    .map(([label,value]) => `<li style="margin:6px 0;"><strong>${Number(value)}</strong> ${escapeHtml(label)}</li>`)
    .join('');
}
function signalCategory(signalType=''){
  const type = String(signalType || '').toLowerCase();
  if(type.includes('repeat') || type.includes('reorder') || type.includes('buying')) return 'repeat';
  if(type.includes('follow')) return 'followUp';
  return 'business';
}
function suggestedNextMove(signal={}){
  const payload = signal.payload || {};
  return clean(
    payload.suggestedNextMove ||
    payload.recommendedNextStep ||
    payload.suggestedOpener ||
    payload.nextStep ||
    signal.why_reach_out ||
    'Open the account and decide whether to call, email, or ask for a referral this week.'
  );
}
function whyItMatters(signal={}){
  const payload = signal.payload || {};
  return clean(
    signal.why_reach_out ||
    payload.whyItMattersForPromo ||
    payload.whyItMatters ||
    payload.opportunitySummary ||
    payload.signalTitle ||
    signal.title ||
    'This account showed a timely reason to reconnect.'
  );
}
function opportunityCardHtml(signal={}){
  const account = escapeHtml(signal.account_name || 'Account');
  const signalType = escapeHtml(signal.signal_type || 'Business Activity');
  const why = escapeHtml(whyItMatters(signal));
  const nextMove = escapeHtml(suggestedNextMove(signal));

  return `<div style="border:1px solid #D8DEE9;border-radius:14px;background:#ffffff;padding:18px 18px 16px;margin:16px 0;">
    <h2 style="font-size:18px;line-height:1.3;margin:0 0 12px;color:#17375E;">${account}</h2>
    <div style="margin:0 0 12px;">
      <div style="font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;color:#6b7280;margin-bottom:3px;">Signal</div>
      <div style="font-size:14px;color:#17375E;">${signalType}</div>
    </div>
    <div style="margin:0 0 12px;">
      <div style="font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;color:#6b7280;margin-bottom:3px;">Why it matters</div>
      <div style="font-size:14px;color:#25364d;line-height:1.5;">${why}</div>
    </div>
    <div>
      <div style="font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;color:#6b7280;margin-bottom:3px;">Suggested next move</div>
      <div style="font-size:14px;color:#25364d;line-height:1.5;">${nextMove}</div>
    </div>
  </div>`;
}
function weeklySummaryFromSignals(newSignals=[], accountsMonitored){
  const summary = {
    opportunityCount: newSignals.length,
    businessSignalCount: 0,
    followUpCount: 0,
    repeatBuyingCount: 0,
    accountsMonitored
  };
  for(const signal of newSignals){
    const category = signalCategory(signal.signal_type || signal.title || '');
    if(category === 'repeat') summary.repeatBuyingCount += 1;
    else if(category === 'followUp') summary.followUpCount += 1;
    else summary.businessSignalCount += 1;
  }
  return summary;
}
function reportHtml(user, upload, newSignals, baseUrl, summary={}){
  const firstName = firstNameFromUser(user);
  const opportunityCount = newSignals.length;
  const dashboardUrl = `${String(baseUrl || '').replace(/\/$/,'')}?dashboardEmail=${encodeURIComponent(user.email || '')}`;
  const topOpportunities = newSignals.slice(0,3);
  const cards = topOpportunities.map(opportunityCardHtml).join('');
  const extraCount = Math.max(opportunityCount - topOpportunities.length, 0);
  const extraCopy = extraCount > 0
    ? `<p style="margin:8px 0 0;color:#5b677a;font-size:14px;">There ${extraCount===1?'is':'are'} ${extraCount} more ${extraCount===1?'opportunity':'opportunities'} waiting in your dashboard.</p>`
    : '';
  const summaryRows = metricRows(summary);
  const greeting = firstName ? `Good morning, ${escapeHtml(firstName)}.` : 'Good morning.';

  return `<div style="margin:0;padding:0;background:#F7F8FA;font-family:Arial,sans-serif;color:#17375E;">
    <div style="max-width:680px;margin:0 auto;padding:28px 16px;">
      <div style="background:#ffffff;border:1px solid #D8DEE9;border-radius:18px;padding:28px;">
        <div style="font-size:13px;font-weight:700;color:#1FB7AE;letter-spacing:.04em;text-transform:uppercase;margin-bottom:8px;">House Accounts</div>
        <h1 style="font-size:28px;line-height:1.2;margin:0 0 12px;color:#17375E;">Your Monday House Accounts Brief</h1>
        <p style="font-size:16px;line-height:1.55;margin:0 0 4px;color:#25364d;">${greeting}</p>
        <p style="font-size:16px;line-height:1.55;margin:0 0 20px;color:#25364d;">We found <strong>${opportunityCount}</strong> new ${opportunityCount===1?'opportunity':'opportunities'} across your monitored accounts this week.</p>

        ${cards}
        ${extraCopy}

        ${summaryRows ? `<div style="background:#F7F8FA;border:1px solid #D8DEE9;border-radius:14px;padding:16px 18px;margin:22px 0 0;">
          <h3 style="font-size:16px;margin:0 0 8px;color:#17375E;">This Week's Summary</h3>
          <ul style="margin:0;padding-left:20px;color:#25364d;font-size:14px;line-height:1.45;">${summaryRows}</ul>
        </div>` : ''}

        <div style="margin:26px 0 0;">
          <a href="${dashboardUrl}" style="display:inline-block;background:#1FB7AE;color:#ffffff;padding:14px 22px;text-decoration:none;border-radius:8px;font-weight:700;font-size:15px;">Open Dashboard →</a>
        </div>
      </div>
      <p style="text-align:center;margin:16px 0 0;color:#7b8794;font-size:12px;">House Accounts helps you focus on who to contact this week, and why.</p>
    </div>
  </div>`;
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
            await sendEmail({to:user.email, subject:weeklyBriefSubject(newSignalRows), html:reportHtml(user, upload, newSignalRows, baseUrl, weeklySummaryFromSignals(newSignalRows, accountPayloads.length))});
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
