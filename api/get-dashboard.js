// Vercel Serverless Function: retrieve saved House Accounts dashboard by email.
// Endpoint: GET /api/get-dashboard?email=user@example.com

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
    throw new Error(`Supabase ${resp.status}: ${msg}`);
  }
  return data;
}
function sourceDomain(url=''){
  try{ return new URL(url).hostname.replace(/^www\./,''); } catch { return ''; }
}
function confidenceWord(score){
  const n = Number(score || 0);
  if(n >= 80) return 'High';
  if(n >= 55) return 'Medium';
  return 'Low';
}
function rowToSignal(row){
  const payload = row.payload || {};
  const sourceUrl = clean(row.source_url || payload.sourceUrl || '');
  const confidence = Number(row.confidence || payload.confidenceScore || payload.confidence || 0) || 0;
  return {
    ...payload,
    isReal: true,
    accountName: row.account_name,
    signalType: row.signal_type || payload.signalType || 'Business Activity',
    type: row.signal_type || payload.type || 'Business Activity',
    title: row.title || payload.title || payload.signalTitle || 'Verified business signal',
    signalTitle: row.title || payload.signalTitle || payload.title || 'Verified business signal',
    signalDetail: row.title || payload.signalDetail || payload.whatChanged || 'Verified business signal',
    whyNow: row.why_reach_out || payload.whyNow || payload.whyItMattersForPromo || payload.reasonToReachOut || '',
    whyItMattersForPromo: row.why_reach_out || payload.whyItMattersForPromo || payload.whyNow || '',
    confidence,
    confidenceScore: confidence,
    confidenceLevel: confidenceWord(confidence),
    sourceUrl,
    cleanSourceName: row.source_domain || payload.cleanSourceName || sourceDomain(sourceUrl),
    publishedDate: row.published_at || payload.publishedDate || payload.publicationDate || '',
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at
  };
}

function uniqueSignalRows(rows){
  const map = new Map();
  for(const row of rows || []){
    const payload = row.payload || {};
    const source = sourceDomain(row.source_url || payload.sourceUrl || '');
    const key = String(`${row.account_name || ''}|${row.signal_type || payload.signalType || ''}|${row.title || payload.title || payload.signalTitle || ''}|${source}`)
      .toLowerCase()
      .replace(/[^a-z0-9|]+/g,' ')
      .replace(/\s+/g,' ')
      .trim();
    if(!key) continue;
    const existing = map.get(key);
    const score = Number(row.confidence || payload.confidenceScore || payload.confidence || 0) || 0;
    const existingScore = Number(existing?.confidence || existing?.payload?.confidenceScore || existing?.payload?.confidence || 0) || 0;
    if(!existing || score > existingScore) map.set(key, row);
  }
  return Array.from(map.values());
}

function signalToOpportunity(row){
  const s = rowToSignal(row);
  const products = Array.isArray(s.likelyProducts) && s.likelyProducts.length ? s.likelyProducts
    : Array.isArray(s.commonPromoCategories) && s.commonPromoCategories.length ? s.commonPromoCategories
    : ['employee apparel','event support','recognition gifts','onboarding items'];
  const buyers = Array.isArray(s.likelyBuyers) && s.likelyBuyers.length ? s.likelyBuyers : [s.suggestedContact || 'Relevant department lead'];
  const confidence = Number(s.confidenceScore || 0) || 70;
  return {
    account: row.account_name,
    opportunity: s.promoOpportunity || s.opportunityCategory || s.signalType || 'Business Activity',
    opportunityCategory: s.opportunityCategory || s.signalType || 'Business Activity',
    signalLayerType: 'Business Activity Signal',
    isVerifiedSignalOpportunity: true,
    signalType: s.signalType || 'Business Activity',
    signalTitle: s.signalTitle || s.title,
    signalSummary: s.signalDetail || s.title,
    sourceUrl: s.sourceUrl,
    cleanSourceName: s.cleanSourceName,
    signalDate: s.publishedDate || s.firstSeenAt || s.lastSeenAt || new Date().toISOString(),
    firstSeenAt: s.firstSeenAt,
    whyNow: s.whyNow || s.whyItMattersForPromo || s.signalDetail,
    reasonToReachOut: s.whyItMattersForPromo || s.whyNow || s.signalDetail,
    conversationStarter: s.conversationStarter || s.suggestedOpener || `Ask whether ${row.account_name} has anything worth planning around based on this recent business activity.`,
    contactTitle: buyers.slice(0,2).join(' / '),
    contact: buyers.slice(0,2).join(' / '),
    likelyBuyers: buyers,
    commonPromoCategories: products,
    suggestedProducts: products,
    likelyProducts: products,
    evidence: [
      s.cleanSourceName ? `Source: ${s.cleanSourceName}` : 'Source: public web',
      s.publishedDate ? `Published: ${s.publishedDate}` : '',
      s.signalDetail || s.title || ''
    ].filter(Boolean),
    confidence,
    quickWinScore: confidence,
    closeProbability: confidence,
    estimatedValue: 0,
    valueSource: 'Verified Signal',
    businessSignals: [s],
    email: ''
  };
}

export default async function handler(req, res){
  if(req.method !== 'GET') return json(res, 405, {error:'Method not allowed'});
  try{
    const email = clean(req.query?.email).toLowerCase();
    if(!email) return json(res, 400, {error:'Missing email'});
    const users = await supabase(`ha_users?select=*&email=eq.${encodeURIComponent(email)}&limit=1`);
    const user = Array.isArray(users) ? users[0] : null;
    if(!user) return json(res, 404, {error:'No saved dashboard found for that email.'});

    const uploads = await supabase(`ha_uploads?select=*&user_id=eq.${encodeURIComponent(user.id)}&order=updated_at.desc&limit=1`);
    const upload = Array.isArray(uploads) ? uploads[0] : null;
    if(!upload) return json(res, 404, {error:'No upload found for that email yet.'});

    const accounts = await supabase(`ha_accounts?select=*&upload_id=eq.${encodeURIComponent(upload.id)}&order=account_name.asc&limit=2500`);
    const signals = await supabase(`ha_signals?select=*&upload_id=eq.${encodeURIComponent(upload.id)}&order=first_seen_at.desc&limit=500`);
    const weeklyRuns = await supabase(`ha_weekly_runs?select=*&upload_id=eq.${encodeURIComponent(upload.id)}&order=started_at.desc&limit=8`);
    const uniqueSignals = uniqueSignalRows(signals || []);
    const byAccount = new Map();
    for(const a of accounts || []){
      const raw = a.raw_data || {};
      const historicalProjects = Array.isArray(raw.historicalProjects) ? raw.historicalProjects : [];
      const purchases = Array.isArray(raw.purchases) && raw.purchases.length ? raw.purchases : historicalProjects.map(p => ({
        project: p.project || p.name || p.description || p.orderName || 'Historical order',
        category: p.category || p.productCategory || p.type || '',
        revenue: Number(p.revenue || p.amount || p.total || 0) || 0,
        dateStr: p.dateStr || p.date || p.orderDate || p.order_date || '',
        status: p.status || 'Historical'
      }));
      const storedOpps = [
        ...(Array.isArray(raw.existingSignals) ? raw.existingSignals : []),
        ...(Array.isArray(raw.repeatPatterns) ? raw.repeatPatterns : [])
      ];
      byAccount.set(a.account_name, {
        name: a.account_name,
        industry: a.industry || 'Saved Account',
        contactName: a.contact_name || '',
        contactEmail: a.contact_email || '',
        revenue: Number(a.metrics?.revenue || 0),
        orderCount: Number(a.metrics?.orderCount || 0),
        confidence: Number(a.metrics?.confidence || a.metrics?.quickWinScore || 0),
        relationshipStrength: Number(a.metrics?.relationshipStrength || 0),
        mostRecentDate: a.metrics?.mostRecentDate || 'Unknown',
        activePipelineValue: Number(a.metrics?.activePipelineValue || 0),
        activePipelineCount: Number(a.metrics?.activePipelineCount || 0),
        subscores: a.metrics?.subscores || {revenue:0, frequency:0, recency:0, diversity:0},
        purchases,
        projects: historicalProjects,
        allProjects: Array.isArray(raw.allProjects) ? raw.allProjects : historicalProjects,
        activePipeline: Array.isArray(raw.activePipeline) ? raw.activePipeline : [],
        categoryTypes: Array.isArray(raw.historicalCategories) ? raw.historicalCategories : [],
        signals: [],
        futureOpportunities: storedOpps
      });
    }
    for(const row of uniqueSignals || []){
      if(!byAccount.has(row.account_name)){
        byAccount.set(row.account_name, {name: row.account_name, industry:'Saved Account', revenue:0, orderCount:0, confidence:0, relationshipStrength:0, mostRecentDate:'Unknown', categoryTypes:[], signals:[], futureOpportunities:[]});
      }
      const acct = byAccount.get(row.account_name);
      acct.signals.push(rowToSignal(row));
      acct.futureOpportunities.push(signalToOpportunity(row));
    }
    const accountList = Array.from(byAccount.values()).map(a => {
      if(a.futureOpportunities.length){
        a.confidence = Math.max(a.confidence || 0, ...a.futureOpportunities.map(o => Number(o.confidence || 0)));
      }
      return a;
    });

    const sevenDaysAgo = Date.now() - 7*24*60*60*1000;
    const newThisWeek = (uniqueSignals || []).filter(s => {
      const t = new Date(s.first_seen_at || s.created_at || 0).getTime();
      return Number.isFinite(t) && t >= sevenDaysAgo;
    }).map(signalToOpportunity);

    return json(res, 200, {
      ok:true,
      user,
      upload,
      summary: upload.summary || {},
      accounts: accountList,
      signals: (uniqueSignals || []).map(rowToSignal),
      weeklyRuns: weeklyRuns || [],
      newThisWeek
    });
  }catch(err){
    return json(res, 500, {error: err.message || 'Dashboard lookup failed'});
  }
}
