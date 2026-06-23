
// Global state for signal mode
let signalMode = 'simulated'; // 'simulated' or 'real'
let accountSignalsCache = {}; // Cache for real signals to avoid re-fetching

let currentLead = null;
let lastAnalysisSummary = null;

function getSavedLead(){
  try { return JSON.parse(localStorage.getItem('houseAccountsLead') || 'null'); }
  catch(e){ return null; }
}

function setLeadGateState(){
  const saved = getSavedLead();
  if(saved && saved.email){
    currentLead = saved;
    const gate = document.getElementById('leadGate');
    const dz = document.getElementById('dropzone');
    if(gate) gate.style.display = 'none';
    if(dz) dz.classList.remove('locked');
  }
}

async function captureLead(stage, payload){
  const body = {
    stage,
    capturedAt: new Date().toISOString(),
    page: window.location.href,
    ...payload
  };
  try{
    await fetch('/api/lead-capture', {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify(body)
    });
  }catch(err){
    console.warn('Lead capture API unavailable; saved locally only.', err);
  }
  try{
    const all = JSON.parse(localStorage.getItem('houseAccountsLeadEvents') || '[]');
    all.push(body);
    localStorage.setItem('houseAccountsLeadEvents', JSON.stringify(all.slice(-25)));
  }catch(e){}
}

document.addEventListener('DOMContentLoaded', () => {
  setLeadGateState();

  const leadForm = document.getElementById('leadForm');
  if(leadForm){
    leadForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const lead = {
        name: document.getElementById('leadName').value.trim(),
        email: document.getElementById('leadEmail').value.trim(),
        company: document.getElementById('leadCompany').value.trim(),
        role: document.getElementById('leadRole').value,
        houseAccounts: document.getElementById('houseAccounts').value
      };
      if(!lead.name || !lead.email || !lead.company || !lead.role || !lead.houseAccounts){
        showError('Please complete all beta access fields.');
        return;
      }
      currentLead = lead;
      localStorage.setItem('houseAccountsLead', JSON.stringify(lead));
      await captureLead('report_gate', {lead});
      setLeadGateState();
      clearError();
    });
  }

  const betaForm = document.getElementById('betaForm');
  if(betaForm){
    betaForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const beta = {
        priority: document.getElementById('betaPriority').value,
        approxHouseAccounts: document.getElementById('betaAccounts').value.trim(),
        erp: document.getElementById('betaErp').value.trim(),
        analysisSummary: lastAnalysisSummary
      };
      await captureLead('founding_beta', {lead: currentLead || getSavedLead(), beta});
      const success = document.getElementById('betaSuccess');
      if(success) success.style.display = 'block';
    });
  }
});

const dropzone = document.getElementById('dropzone');
const fileInput = document.getElementById('fileInput');
const browseBtn = document.getElementById('browseBtn');
const errorBox = document.getElementById('error');

browseBtn.addEventListener('click', (e) => { e.stopPropagation(); fileInput.click(); });
dropzone.addEventListener('click', () => fileInput.click());

['dragenter','dragover'].forEach(ev => dropzone.addEventListener(ev, e => {
  e.preventDefault(); dropzone.classList.add('drag');
}));
['dragleave','drop'].forEach(ev => dropzone.addEventListener(ev, e => {
  e.preventDefault(); dropzone.classList.remove('drag');
}));
dropzone.addEventListener('drop', e => {
  if(e.dataTransfer.files.length) handleFile(e.dataTransfer.files[0]);
});
fileInput.addEventListener('change', e => {
  if(e.target.files.length) handleFile(e.target.files[0]);
});

function showError(msg){
  errorBox.textContent = msg;
  errorBox.style.display = 'block';
}
function clearError(){
  errorBox.style.display = 'none';
}

function handleFile(file){
  clearError();
  if(!currentLead && !getSavedLead()){
    showError('Please enter your name, work email, and company before generating the report.');
    return;
  }
  if(!file.name.toLowerCase().endsWith('.csv')){
    showError('Please upload a .csv file.');
    return;
  }
  const reader = new FileReader();
  reader.onload = e => {
    try{
      const rows = parseCSV(e.target.result);
      processData(rows);
    }catch(err){
      showError('Could not parse file: ' + err.message);
    }
  };
  reader.onerror = () => showError('Could not read file.');
  reader.readAsText(file);
}

// Simple CSV parser handling quoted fields
function parseCSV(text){
  text = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines = [];
  let row = [], field = '', inQuotes = false;
  for(let i=0;i<text.length;i++){
    const c = text[i];
    if(inQuotes){
      if(c === '"'){
        if(text[i+1] === '"'){ field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else {
      if(c === '"') inQuotes = true;
      else if(c === ','){ row.push(field); field=''; }
      else if(c === '\n'){ row.push(field); lines.push(row); row=[]; field=''; }
      else field += c;
    }
  }
  if(field.length || row.length){ row.push(field); lines.push(row); }
  const filtered = lines.filter(r => r.some(c => c.trim() !== ''));
  if(filtered.length < 2) throw new Error('No data rows found.');

  const normalizeHeader = h => h.trim().toLowerCase().replace(/[()%]/g,'').replace(/[^a-z0-9]+/g,'_').replace(/^_+|_+$/g,'');
  const headerOriginal = filtered[0].map(h => String(h || '').trim());
  const headerRaw = filtered[0].map(normalizeHeader);
  const map = {
    client_name: ['client_name','company_name','company','account_name','account','customer_name','customer','client','client_company','organization','business_name','business','name'],
    project_name: ['project_name','project','name','project_title','order_name','job_name','description','product','item'],
    order_date: ['order_date','date','purchase_date','created_date'],
    revenue: ['revenue','amount','total','subtotal','order_value','sales','project_billed_margin_subtotal','booked_margin_subtotal'],
    margin: ['margin','margin_pct','booked_margin','booked_margin_amount','project_billed_margin','project_billed_margin_amount','profit'],
    margin_percent: ['margin_percent','booked_margin_percent','project_billed_margin_percent','booked_margin_','project_billed_margin_'],
    contact_name: ['contact_name','contact','contact_person','primary_contact','project_client_contact','client_contact'],
    contact_first: ['project_client_contact_first_name','contact_first_name','first_name'],
    contact_last: ['project_client_contact_last_name','contact_last_name','last_name'],
    contact_email: ['contact_email','project_client_contact_email','email','contact_email_address'],
    order_status: ['order_status','status'],
    order_tags: ['order_tags','tags'],
    client_tags: ['client_tags','account_tags'],
    ship_city: ['shipto_city','ship_city','city'],
    ship_state: ['shipto_state','ship_state','state']
  };
  const colIndex = {};
  const columnMappings = {};
  for(const key in map){
    for(const alt of map[key]){
      const idx = headerRaw.indexOf(alt);
      if(idx !== -1){
        colIndex[key] = idx;
        columnMappings[key] = { detected: headerOriginal[idx] || alt, normalized: alt };
        break;
      }
    }
  }
  const required = ['client_name'];
  for(const r of required){
    if(colIndex[r] === undefined) throw new Error('Could not identify a company/account column. Accepted names: client_name, company_name, company, account_name, account, customer_name, customer, client.');
  }
  const missingCols = [];
  ['project_name','order_date','revenue','margin','contact_name','contact_email'].forEach(k=>{
    if(colIndex[k] === undefined) missingCols.push(k);
  });

  const records = [];
  for(let i=1;i<filtered.length;i++){
    const r = filtered[i];
    const get = key => colIndex[key] !== undefined ? (r[colIndex[key]] || '').trim() : '';
    const revenueRaw = get('revenue').replace(/[^0-9.\-]/g,'');
    const marginRaw = get('margin').replace(/[^0-9.\-]/g,'');
    const dateStr = get('order_date');
    const d = new Date(dateStr);
    const projectName = colIndex.project_name !== undefined ? (get('project_name') || 'Unspecified') : 'Unspecified';
    const contactName = get('contact_name') || [get('contact_first'), get('contact_last')].filter(Boolean).join(' ');
    const clientName = get('client_name') || '';
    if(isLikelyInvalidAccountName(clientName)) continue;
    records.push({
      client: clientName || 'Unknown',
      project: projectName,
      category: inferPromoCategory(projectName + ' ' + get('order_tags') + ' ' + get('client_tags')),
      date: isNaN(d.getTime()) ? null : d,
      dateStr,
      revenue: parseFloat(revenueRaw) || 0,
      margin: marginRaw === '' ? null : parseFloat(marginRaw),
      contactName,
      contactEmail: get('contact_email'),
      status: get('order_status'),
      location: [get('ship_city'), get('ship_state')].filter(Boolean).join(', ')
    });
  }
  records.missingCols = missingCols;
  records.columnMappings = columnMappings;
  return records;
}

function inferPromoCategory(text){
  const t = String(text || '').toLowerCase();
  const rules = [
    ['Apparel', ['shirt','shirts','tee','t-shirt','polo','quarter zip','jacket','hoodie','sweatshirt','apparel','uniform','gear','vest','fleece']],
    ['Headwear', ['hat','hats','cap','caps','beanie','headwear']],
    ['Drinkware', ['coozie','koozie','tumbler','mug','bottle','drinkware','cup','can cooler']],
    ['Event / Giveaway', ['event','convention','giveaway','premiums','swag','launch','show','expo','booth','sales event']],
    ['Recognition / Awards', ['award','awards','recognition','excellence','anniversary','years','milestone','appreciation']],
    ['Print / Stationery', ['journal','notebook','set','card','print','sign','banner','table throw']],
    ['Onboarding / Recruiting', ['new hire','onboarding','welcome','recruiting','career','employee kit']],
    ['Safety', ['safety','ppe','hi-vis','vest','osha']]
  ];
  const hits = [];
  for(const [cat, words] of rules){
    if(words.some(w => t.includes(w))) hits.push(cat);
  }
  return hits[0] || 'Uncategorized';
}

function inferIndustry(client, projects){
  const t = (client + ' ' + projects.join(' ')).toLowerCase();
  if(/ford|toyota|honda|chevy|chevrolet|dealer|auto|used car|bronco|vehicle/.test(t)) return 'Automotive / Dealership';
  if(/dental|medical|health|hospital|clinic|physician|pharma/.test(t)) return 'Healthcare';
  if(/construction|saw|supply|industrial|manufactur|seating|steel|tool/.test(t)) return 'Manufacturing / Industrial';
  if(/investment|capital|financial|bank|credit|wealth/.test(t)) return 'Financial Services';
  if(/beverage|brew|beer|restaurant|food/.test(t)) return 'Food & Beverage';
  return 'General Business';
}

// Generate simulated business signals (v1)
function generateSimulatedSignals(a, meta){
  // v4: no fake business events. We only show verified external signals when a real signal source exists.
  // Historical purchase data can support expansion recommendations, but it must not invent hiring, events, launches, or expansions.
  return [];
}

// Render signal card HTML
function renderSignalCard(signal){
  const statusClass = signal.isReal ? 'status-real' : 'status-simulated';
  const statusText = signal.isReal ? '📡 Real Signal' : '📡 Simulated Signal';
  
  let metaHtml = '';
  if(signal.isReal && signal.sourceUrl){
    metaHtml = `
      <div class="signal-meta">
        <div class="signal-meta-label">Source</div>
        ${signal.sourceType || 'Unknown'} · <a href="${escapeHtml(signal.sourceUrl)}" target="_blank" style="color:var(--signal);">View</a>
      </div>
      <div class="signal-meta">
        <div class="signal-meta-label">Date Found</div>
        ${escapeHtml(signal.dateFound)}
      </div>
      <div class="signal-meta">
        <div class="signal-meta-label">Confidence</div>
        ${Math.round(signal.confidence * 100)}%
      </div>
    `;
  }

  return `
    <div class="signal-card">
      <div class="signal-icon">${signal.icon}</div>
      <div class="signal-type">${escapeHtml(signal.type)}</div>
      <div class="signal-title">${escapeHtml(signal.title)}</div>
      ${metaHtml}
      <div class="signal-status ${statusClass}">${statusText}</div>
    </div>
  `;
}



function accountDomId(name){
  return String(name || 'account').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'') || 'account';
}

function extractEmailDomain(email){
  const value = String(email || '').trim().toLowerCase();
  const match = value.match(/@([^\s>]+)$/);
  if(!match) return '';
  const domain = match[1].replace(/^www\./,'');
  if(/gmail\.com|yahoo\.com|hotmail\.com|outlook\.com|icloud\.com|aol\.com/.test(domain)) return '';
  return domain;
}

function isLikelyInvalidAccountName(name){
  const n = String(name || '').trim().toLowerCase();
  if(!n) return true;
  if(n.length < 2) return true;
  if(/^(end result|primary result|secondary result|close \d+ deal|\$?\d+k order total|\d+ meetings?|\d+ total touchpoints|over \d+ days?)$/i.test(n)) return true;
  if(/total touchpoints|order total|meetings$|result$/.test(n) && !/(inc|llc|corp|company|co\.|group|systems|technologies|manufacturing|medical|ford|dental|partners)/.test(n)) return true;
  return false;
}

function confidenceLabel(score){
  const pct = Math.round((score || 0.5) * 100);
  if(pct >= 75) return `High (${pct}%)`;
  if(pct >= 60) return `Medium (${pct}%)`;
  return `Low (${pct}%)`;
}

function renderVerifiedSignals(signals){
  const verified = (signals || []).filter(signal => signal && signal.isReal && signal.sourceUrl);
  if(!verified.length){
    return `<div class="no-signals-message">No verified external signals found.</div>`;
  }
  return verified.map(signal => {
    const valueRange = signal.estimatedValueRange?.label || 'Estimate requires account context';
    return `
      <div class="verified-signal-card">
        <div class="verified-signal-title">Verified Signal: ${escapeHtml(signal.signalDetail || signal.title || signal.signalType || signal.type || 'Business Signal')}</div>
        <div class="verified-signal-meta">
          <strong>Type:</strong> ${escapeHtml(signal.signalType || signal.type || 'Business Signal')} ·
          <strong>Source:</strong> ${escapeHtml(signal.sourceType || 'Public source')} ·
          <strong>Confidence:</strong> ${escapeHtml(signal.confidenceLevel || confidenceLabel(signal.confidence))} ·
          <a class="source-link" target="_blank" href="${escapeHtml(signal.sourceUrl)}">View source</a>
        </div>
        <div class="verified-signal-grid">
          <div><strong>Department:</strong><br>${escapeHtml(signal.affectedDepartment || 'Relevant department')}</div>
          <div><strong>Suggested contact:</strong><br>${escapeHtml(signal.suggestedContact || 'Relevant department lead')}</div>
          <div><strong>Opportunity category:</strong><br>${escapeHtml(signal.opportunityCategory || 'Promo opportunity')}</div>
          <div><strong>Value source:</strong><br>${escapeHtml(signal.valueSource || 'Signal Only')} · ${escapeHtml(valueRange)}</div>
        </div>
        <div class="verified-signal-evidence"><strong>Evidence:</strong> ${escapeHtml(signal.evidence || signal.description || 'Source-backed business activity found.')}</div>
        <div class="verified-opportunity">
          <strong>Why now:</strong> ${escapeHtml(signal.whyNow || 'A verified public signal creates a timely reason to reach out.')}<br>
          <strong>Opportunity explanation:</strong> ${escapeHtml(signal.opportunityExplanation || signal.promoOpportunity || 'This signal may create a timely reason to discuss branded merchandise.')}
        </div>
      </div>`;
  }).join('');
}

function addSignalDerivedOpportunities(account, signals){
  const existing = new Set((account.futureOpportunities || []).map(o => o.opportunity));
  (signals || []).filter(signal => signal && signal.isReal && signal.sourceUrl).forEach(signal => {
    const type = signal.signalType || signal.type || '';
    const name = signal.promoOpportunity || signal.opportunityCategory || `${type} Promo Opportunity`;
    const products = Array.isArray(signal.suggestedProducts) && signal.suggestedProducts.length
      ? signal.suggestedProducts
      : ['branded apparel', 'event giveaways', 'employee kits'];
    const contactTitle = signal.suggestedContact || 'Relevant department lead';
    const base = type.includes('Hiring') ? 78 : type.includes('Event') ? 76 : type.includes('Expansion') ? 78 : 74;

    if(!name || existing.has(name)) return;
    const opp = createOpportunity(account, name, contactTitle, products, [], base, true);
    const hasHistory = Number(account.revenue || 0) > 0 || Number(account.orderCount || 0) > 0;
    opp.isVerifiedSignalOpportunity = true;
    opp.signalTitle = signal.signalDetail || signal.title || type;
    opp.signalType = type;
    opp.sourceUrl = signal.sourceUrl;
    opp.whyNow = signal.whyNow || `Verified signal found: ${signal.signalDetail || signal.title || type}`;
    opp.valueSource = hasHistory ? 'Historical Orders + Verified Signal' : (signal.valueSource || 'Signal Only');
    opp.estimatedValueRange = signal.estimatedValueRange || null;
    opp.opportunityCategory = signal.opportunityCategory || 'Signal-Driven Opportunity';
    opp.reasonToReachOut = signal.reasonToReachOut || getReasonToReachOutTitle(opp);
    opp.conversationStarter = signal.conversationStarter || getConversationStarterText(opp);
    opp.commonPromoCategories = products;
    opp.affectedDepartment = signal.affectedDepartment || '';
    opp.evidence = [
      `Signal detail: ${signal.signalDetail || signal.title || type}`,
      `Opportunity category: ${signal.opportunityCategory || name}`,
      `Affected department: ${signal.affectedDepartment || 'Relevant department'}`,
      `Value source: ${opp.valueSource}${signal.estimatedValueRange?.label ? ' (' + signal.estimatedValueRange.label + ')' : ''}`,
      `Source type: ${signal.sourceType || 'Public source'}`,
      `Source URL: ${signal.sourceUrl}`,
      signal.evidence || 'External business activity detected',
      ...buildEvidence(account).slice(0,2)
    ];
    opp.businessSignals = [signal];
    opp.closeProbability = Math.min(95, Math.max(55, Math.round((signal.confidence || 0.72)*100) + (opp.relationshipStrength >= 40 ? 10 : 0)));
    opp.quickWinScore = getQuickWinScore(account, base, true);
    opp.confidence = opp.quickWinScore;
    opp.opportunityType = 'SIGNAL-DRIVEN';
    opp.relationshipMode = getRelationshipMode(account);
    account.futureOpportunities.unshift(opp);
    existing.add(name);
  });
}

async function researchAccountByName(accountName){
  const account = (window.accountRadarAccounts || []).find(a => a.name === accountName);
  if(!account) return;
  const panel = document.getElementById(`signals-${accountDomId(account.name)}`);
  if(panel) panel.innerHTML = `<div class="signal-loading">Researching ${escapeHtml(account.name)} across public sources...</div>`;
  try{
    const res = await fetch('/api/research-account', {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({
        accountName: account.name,
        industry: account.industry,
        cityState: account.purchases?.[0]?.location || '',
        emailDomain: extractEmailDomain(account.contactEmail),
        categories: [...(account.categoryTypes || [])],
        projects: account.projects || []
      })
    });
    const data = await res.json();
    if(!res.ok) throw new Error(data.error || 'Research failed');
    account.signals = data.signals || [];
    addSignalDerivedOpportunities(account, account.signals);
    if(panel) panel.innerHTML = renderVerifiedSignals(account.signals);
    refreshOpportunityViews();
  }catch(err){
    if(panel) panel.innerHTML = `<div class="no-signals-message">Research failed: ${escapeHtml(err.message)}. This account was not updated.</div>`;
  }
}

async function researchTopAccounts(){
  const btn = document.getElementById('researchTopBtn');
  if(btn){ btn.disabled = true; btn.textContent = 'Researching...'; }
  const accounts = (window.accountRadarAccounts || []).slice(0, 10);
  for(const account of accounts){
    await researchAccountByName(account.name);
  }
  if(btn){ btn.disabled = false; btn.textContent = 'Research Top Accounts'; }
}


function getWhyNowText(opp){
  if(!opp) return 'Review this account for a focused next step.';
  if(opp.whyNow) return opp.whyNow;
  if(opp.isVerifiedSignalOpportunity || opp.signalTitle || opp.sourceUrl){
    const title = opp.signalTitle || 'Verified external signal';
    return `Verified signal: ${title}`;
  }
  const rel = Number(opp.relationshipStrength || 0);
  const close = Number(opp.closeProbability || 0);
  const ev = Array.isArray(opp.evidence) ? opp.evidence.join(' ').toLowerCase() : String(opp.evidence || '').toLowerCase();
  if(rel >= 80 && close >= 75) return 'Strong existing relationship and a clear adjacent category to ask about.';
  if(ev.includes('recent activity') || ev.includes('last order')) return 'Recent account activity creates a natural reason to follow up now.';
  if(ev.includes('purchased categories') || ev.includes('relevant purchase history')) return 'Past buying behavior suggests a simple expansion opportunity.';
  if(rel >= 55) return 'Existing account history creates a warmer path than cold outreach.';
  return 'Ranked because the account has enough evidence to warrant review this week.';
}


function getReasonToReachOutTitle(opp){
  const type = String(opp.signalType || opp.opportunityCategory || opp.opportunityType || '').toLowerCase();
  const category = String(opp.opportunityCategory || opp.opportunity || 'account activity');
  if(opp.isVerifiedSignalOpportunity || opp.sourceUrl){
    if(type.includes('hiring')) return 'Hiring creates a timely reason to check in';
    if(type.includes('event') || type.includes('conference') || type.includes('trade show')) return 'Event activity creates a timely reason to check in';
    if(type.includes('expansion') || type.includes('location') || type.includes('facility')) return 'Growth activity creates a timely reason to check in';
    if(type.includes('award') || type.includes('recognition')) return 'Recognition creates a timely reason to check in';
    if(type.includes('leadership')) return 'Leadership change creates a timely reason to check in';
    if(type.includes('launch')) return 'Launch activity creates a timely reason to check in';
    return 'Verified signal creates a reason to reach out';
  }
  return `Past buying suggests a ${category.toLowerCase()} conversation`;
}

function getConversationStarterText(opp){
  const type = String(opp.signalType || opp.opportunityCategory || opp.opportunity || '').toLowerCase();
  const account = opp.account || 'this account';
  if(opp.conversationStarter) return opp.conversationStarter;
  if(type.includes('hiring') || type.includes('onboarding') || type.includes('new hire')){
    return 'Ask how they are handling onboarding, apparel, or employee experience for new hires.';
  }
  if(type.includes('event') || type.includes('trade show') || type.includes('conference') || type.includes('campaign')){
    return 'Ask whether any upcoming events or campaigns need staff apparel, attendee gifts, or customer-facing merch.';
  }
  if(type.includes('service') || type.includes('technician')){
    return 'Ask who handles apparel or onboarding gear for the service team.';
  }
  if(type.includes('safety')){
    return 'Ask whether safety milestones, recognition, or team incentives are already being supported.';
  }
  if(type.includes('appreciation') || type.includes('recognition')){
    return 'Ask whether they have any employee, customer, or team appreciation moments coming up.';
  }
  if(type.includes('expansion') || type.includes('facility') || type.includes('location')){
    return 'Ask whether the growth activity creates any need for launch merch, employee gear, or customer gifts.';
  }
  return `Ask a simple expansion question based on what ${account} already buys or what recently changed.`;
}

function getValueDisplay(opp){
  if(opp.estimatedValueRange && opp.estimatedValueRange.label){
    return escapeHtml(opp.estimatedValueRange.label);
  }
  return fmtMoney(opp.estimatedValue);
}

function getValueLabel(opp){
  if(opp.estimatedValueRange && opp.estimatedValueRange.label){
    return 'Estimated Range';
  }
  return 'Estimated Value';
}

function refreshOpportunityViews(){
  const accounts = window.accountRadarAccounts || [];
  const futureOpportunities = accounts.flatMap(account => account.futureOpportunities || []).sort((a,b)=>(b.quickWinScore||b.confidence) - (a.quickWinScore||a.confidence) || (b.closeProbability||0) - (a.closeProbability||0) || b.estimatedValue - a.estimatedValue);
  const displayedOpportunities = futureOpportunities.slice(0, 10);
  const grid = document.getElementById('opportunitiesGrid');
  const resultCount = document.getElementById('resultCount');
  if(resultCount) resultCount.innerHTML = `<span>Showing top ${displayedOpportunities.length} of ${futureOpportunities.length} reasons to reach out from ${accounts.length} accounts</span>`;
  if(grid){
    grid.innerHTML = `<div class="limit-note">Showing the top 10 ranked reasons to reach out only. Verified external signals are prioritized when found.</div>` + displayedOpportunities.map((opp) => {
      const tier = getPriorityTier(opp);
      return `
        <div class="opportunity-card">
          <div class="opp-card-header">
            <div class="opp-card-title">${escapeHtml(getReasonToReachOutTitle(opp))}</div>
            <div class="opp-card-account">${escapeHtml(opp.account)} · ${escapeHtml(opp.opportunity)}</div>
          </div>
          ${opp.isVerifiedSignalOpportunity ? '<div class="confidence-badge confidence-high">Verified External Signal</div>' : ''}
          <div class="confidence-badge ${tier.cls}">${tier.label} · ${Math.round(opp.confidence)}% Quick Win Score</div>
          <div class="opp-metrics"><div class="metric"><div class="metric-value">${getValueDisplay(opp)}</div><div class="metric-label">${getValueLabel(opp)}</div></div><div class="metric"><div class="metric-value">${Math.round(opp.confidence)}%</div><div class="metric-label">Score</div></div></div>
          <div class="opp-section"><div class="opp-label">Why Now</div><div class="opp-content">${escapeHtml(getWhyNowText(opp))}</div></div>
          ${opp.valueSource ? `<div class="opp-section"><div class="opp-label">Value Source</div><div class="opp-content">${escapeHtml(opp.valueSource)}${opp.estimatedValueRange?.label ? ` · ${escapeHtml(opp.estimatedValueRange.label)}` : ``}</div></div>` : ``}
          <div class="opp-section"><div class="opp-label">Evidence</div><div class="opp-content">${renderEvidenceList(opp.evidence)}<div class="evidence-note">Every opportunity must be supported by historical order evidence and/or a verified external signal.</div></div></div>
          <div class="opp-section"><div class="opp-label">Suggested Contact</div><div class="opp-content meta">${escapeHtml(opp.contactTitle || opp.contact || 'Unknown')}</div></div>
          <div class="opp-section"><div class="opp-label">Conversation Starter</div><div class="opp-content">${escapeHtml(getConversationStarterText(opp))}</div></div>
          <div class="opp-section"><div class="opp-label">Common Promo Categories</div><div class="opp-products">${(opp.commonPromoCategories || opp.suggestedProducts || []).map(p=>`<span class="product-badge">${escapeHtml(p)}</span>`).join('')}</div></div>
          <div class="opp-card-actions"><button class="btn btn-generate-play" onclick='createSalesPlayPanel(${JSON.stringify(opp).replace(/'/g, "&#39;")})'>Generate Sales Play</button></div>
        </div>`;
    }).join('');
  }
  const totalFutureValue = futureOpportunities.reduce((sum, o) => sum + (o.estimatedValue || 0), 0);
  document.getElementById('totalOppValue').textContent = fmtMoney(totalFutureValue);
  document.getElementById('highConfidenceCount').textContent = futureOpportunities.filter(o => o.confidence >= 70).length;
  document.getElementById('avgConfidence').textContent = Math.round(futureOpportunities.reduce((sum, o) => sum + o.confidence, 0) / Math.max(futureOpportunities.length, 1)) + '%';
  document.getElementById('topOppsList').innerHTML = futureOpportunities.slice(0,10).map(opp => `<div class="top-opp-item"><div class="top-opp-title">${escapeHtml(getReasonToReachOutTitle(opp))}</div><div class="top-opp-meta">${escapeHtml(opp.account)} · ${escapeHtml(opp.contactTitle)}</div><div class="top-opp-value">${getValueDisplay(opp)}</div></div>`).join('');
}

function estimateFutureValue(account, opportunityType){
  const revenue = account.revenue || 0;
  const orders = account.orderCount || 1;
  const categoryCount = account.categoryTypes ? account.categoryTypes.size : 1;

  const multipliers = {
    'Technician Onboarding Kits': 0.22,
    'Service Department Apparel Program': 0.30,
    'Customer Event / Campaign Kit': 0.28,
    'Customer Appreciation Program': 0.20,
    'Safety Recognition Program': 0.25,
    'Trade Show / Event Program': 0.24,
    'New Hire Welcome Kits': 0.22,
    'Employee Recognition Program': 0.20,
    'Recruiting Campaign Kit': 0.18,
    'Account Expansion Program': 0.18,
    'Multi-Department Expansion': 0.32
  };

  const multiplier = multipliers[opportunityType] || 0.18;
  const activityBoost = Math.min(orders * 250, 2500);
  const diversityBoost = Math.min(categoryCount * 600, 2400);
  const raw = (revenue * multiplier) + activityBoost + diversityBoost;

  return Math.round(Math.max(1500, Math.min(raw, 50000)));
}

function buildEvidence(account, categoriesNeeded=[]){
  const evidence = [];
  const cats = [...account.categoryTypes];

  if(account.orderCount > 1) evidence.push(`${account.orderCount} historical orders`);
  if(account.revenue > 0) evidence.push(`${fmtMoney(account.revenue)} historical spend`);
  if(cats.length) evidence.push(`Purchased categories: ${cats.join(', ')}`);
  if(account.mostRecentDate && account.mostRecentDate !== 'Unknown') evidence.push(`Recent activity: ${account.mostRecentDate}`);
  if(categoriesNeeded.length){
    const matching = cats.filter(c => categoriesNeeded.includes(c));
    if(matching.length) evidence.push(`Relevant purchase history: ${matching.join(', ')}`);
  }
  return evidence.slice(0, 5);
}

function confidenceForOpportunity(account, base=55, bonusCategories=[]){
  let score = base;
  score += Math.min(account.orderCount * 4, 16);
  score += account.revenue > 10000 ? 12 : account.revenue > 3000 ? 6 : 0;
  score += account.categoryTypes ? Math.min(account.categoryTypes.size * 4, 16) : 0;
  bonusCategories.forEach(cat => { if(account.categoryTypes.has(cat)) score += 5; });
  score += account.subscores.recency > 0.7 ? 8 : account.subscores.recency > 0.4 ? 4 : 0;
  return Math.max(35, Math.min(Math.round(score), 96));
}

function fmtMoney(n){
  return '$' + Number(n || 0).toLocaleString('en-US', {maximumFractionDigits:0});
}


function clampScore(n){
  return Math.max(0, Math.min(100, Math.round(Number(n) || 0)));
}

function getRelationshipStrength(account){
  const orderCount = Number(account.orderCount || 0);
  const revenue = Number(account.revenue || 0);
  const categoryCount = account.categoryTypes ? account.categoryTypes.size : 0;
  const hasContact = !!(account.contactName || account.contactEmail);
  const recency = Number(account.subscores?.recency || 0) * 100;

  const orderScore = Math.min(orderCount / 6, 1) * 30;
  const revenueScore = Math.min(revenue / 30000, 1) * 25;
  const categoryScore = Math.min(categoryCount / 4, 1) * 15;
  const contactScore = hasContact ? 15 : 0;
  const recencyScore = Math.min(recency, 100) * 0.15;

  return clampScore(orderScore + revenueScore + categoryScore + contactScore + recencyScore);
}

function getRelationshipMode(account){
  const strength = getRelationshipStrength(account);
  const recency = Number(account.subscores?.recency || 0) * 100;
  if(strength >= 75 && recency >= 45) return 'Warm';
  if(strength >= 40 || Number(account.orderCount || 0) > 0) return 'Lukewarm';
  return 'Cold';
}

function getOpportunityType(account, signalBased=false){
  if(signalBased) return 'SIGNAL-DRIVEN';
  const strength = getRelationshipStrength(account);
  const recency = Number(account.subscores?.recency || 0) * 100;
  if(strength >= 75 && recency >= 50) return 'QUICK WIN';
  if(Number(account.orderCount || 0) > 0 && recency < 35) return 'REACTIVATION';
  if(Number(account.orderCount || 0) > 0) return 'EXPANSION';
  return 'SIGNAL-DRIVEN';
}

function getCloseProbability(account, baseConfidence=55, signalBased=false){
  const relationship = getRelationshipStrength(account);
  const recency = Number(account.subscores?.recency || 0) * 100;
  const hasContact = !!(account.contactName || account.contactEmail);
  const frequency = Number(account.subscores?.frequency || 0) * 100;
  const categoryExpansion = Number(account.subscores?.diversity || 0) * 100;
  const signalBoost = signalBased ? 18 : 0;

  // Close probability prioritizes "can this turn into a real conversation this month?"
  // over giant theoretical account size.
  return clampScore(
    relationship * 0.42 +
    recency * 0.20 +
    frequency * 0.12 +
    categoryExpansion * 0.10 +
    (hasContact ? 8 : 0) +
    signalBoost +
    baseConfidence * 0.08
  );
}

function getQuickWinScore(account, baseConfidence=55, signalBased=false){
  const closeProbability = getCloseProbability(account, baseConfidence, signalBased);
  const relationship = getRelationshipStrength(account);
  const revenuePotential = Math.min(Number(account.revenue || 0) / 30000, 1) * 100;
  const signal = signalBased ? 100 : 0;
  return clampScore(
    closeProbability * 0.45 +
    relationship * 0.30 +
    revenuePotential * 0.15 +
    signal * 0.10
  );
}

function relationshipLabelFromScore(score){
  if(score >= 75) return 'Warm Relationship';
  if(score >= 40) return 'Lukewarm Relationship';
  return 'Cold / Low History';
}

function salesPlayModeFromOpp(opp){
  if(opp.relationshipMode) return opp.relationshipMode;
  const score = Number(opp.relationshipStrength || 0);
  if(score >= 75) return 'Warm';
  if(score >= 40) return 'Lukewarm';
  return 'Cold';
}

function createOpportunity(account, name, contactTitle, products, evidenceCats=[], baseConfidence=55, signalBased=false){
  const value = estimateFutureValue(account, name);
  const relationshipStrength = getRelationshipStrength(account);
  const closeProbability = getCloseProbability(account, baseConfidence, signalBased);
  const quickWinScore = getQuickWinScore(account, baseConfidence, signalBased);
  const opportunityType = getOpportunityType(account, signalBased);
  const relationshipMode = getRelationshipMode(account);

  return {
    account: account.name,
    industry: account.industry,
    opportunity: name,
    opportunityName: name,
    estimatedValue: value,
    confidence: quickWinScore,
    quickWinScore,
    relationshipStrength,
    closeProbability,
    opportunityType,
    relationshipMode,
    contact: account.contactName || contactTitle,
    contactTitle,
    email: account.contactEmail,
    evidence: buildEvidence(account, evidenceCats),
    suggestedProducts: products,
    historicalPurchaseData: account.purchases.map(p => ({
      project: p.project,
      category: p.category,
      revenue: p.revenue,
      date: p.dateStr
    })),
    businessSignals: account.signals || []
  };
}

function generateFutureOpportunities(account){
  const cats = account.categoryTypes || new Set();
  const industry = account.industry;
  const opps = [];

  if(industry === 'Automotive / Dealership'){
    if(cats.has('Apparel') || cats.has('Headwear')){
      opps.push(createOpportunity(
        account,
        'Service Department Apparel Program',
        'Service Director',
        ['Technician shirts', 'outerwear', 'service hats', 'name-badge ready apparel'],
        ['Apparel','Headwear'],
        64
      ));
      opps.push(createOpportunity(
        account,
        'Technician Onboarding Kits',
        'Service Director / HR Manager',
        ['welcome kit', 'branded backpack', 'drinkware', 'uniform starter pack'],
        ['Apparel','Headwear'],
        62
      ));
    }
    if(cats.has('Event / Giveaway')){
      opps.push(createOpportunity(
        account,
        'Customer Event / Campaign Kit',
        'Marketing Manager / General Manager',
        ['event giveaways', 'sales team apparel', 'customer gifts', 'signage'],
        ['Event / Giveaway','Print / Stationery','Apparel'],
        66
      ));
    }
    opps.push(createOpportunity(
      account,
      'Customer Appreciation Program',
      'Marketing Manager',
      ['thank-you gifts', 'test-drive giveaways', 'service customer gifts'],
      ['Event / Giveaway','Drinkware'],
      56
    ));
  } else if(industry === 'Manufacturing / Industrial'){
    opps.push(createOpportunity(
      account,
      'Safety Recognition Program',
      'Safety Manager / HR Manager',
      ['safety awards', 'hi-vis apparel', 'milestone gifts', 'team incentives'],
      ['Safety','Recognition / Awards','Apparel'],
      64
    ));
    opps.push(createOpportunity(
      account,
      'Trade Show / Event Program',
      'Marketing Manager / Sales Manager',
      ['booth giveaways', 'table throws', 'staff apparel', 'lead-gen gifts'],
      ['Event / Giveaway','Print / Stationery','Apparel'],
      58
    ));
    opps.push(createOpportunity(
      account,
      'New Hire Welcome Kits',
      'HR Manager',
      ['welcome box', 'branded apparel', 'drinkware', 'notebooks'],
      ['Apparel','Onboarding / Recruiting'],
      55
    ));
  } else if(industry === 'Healthcare'){
    opps.push(createOpportunity(
      account,
      'Employee Recognition Program',
      'HR Manager / Practice Manager',
      ['staff appreciation gifts', 'apparel', 'drinkware', 'milestone awards'],
      ['Recognition / Awards','Apparel','Drinkware'],
      62
    ));
    opps.push(createOpportunity(
      account,
      'New Provider Onboarding Kits',
      'Practice Manager / HR Manager',
      ['welcome kits', 'branded apparel', 'desk items', 'drinkware'],
      ['Onboarding / Recruiting','Apparel'],
      56
    ));
  } else if(industry === 'Financial Services'){
    opps.push(createOpportunity(
      account,
      'Client Appreciation Program',
      'Marketing Director / Client Experience Lead',
      ['premium gifts', 'event kits', 'notebooks', 'drinkware'],
      ['Event / Giveaway','Print / Stationery'],
      60
    ));
    opps.push(createOpportunity(
      account,
      'Investor / Alumni Event Kit',
      'Events Manager / Marketing Director',
      ['attendee gifts', 'premium apparel', 'event signage', 'notebooks'],
      ['Event / Giveaway','Print / Stationery','Apparel'],
      58
    ));
  } else if(industry === 'Food & Beverage'){
    opps.push(createOpportunity(
      account,
      'Retail / Customer Giveaway Program',
      'Marketing Manager',
      ['coozies', 'drinkware', 'caps', 'event merch'],
      ['Drinkware','Headwear','Event / Giveaway'],
      60
    ));
    opps.push(createOpportunity(
      account,
      'Staff Apparel Refresh',
      'Operations Manager',
      ['staff shirts', 'hats', 'outerwear', 'aprons'],
      ['Apparel','Headwear'],
      56
    ));
  } else {
    if(account.categoryTypes.size >= 3 || account.orderCount >= 3){
      opps.push(createOpportunity(
        account,
        'Multi-Department Expansion',
        'Marketing Manager / HR Manager',
        ['employee apparel', 'recognition gifts', 'event kits', 'onboarding items'],
        [...account.categoryTypes],
        62
      ));
    }
    opps.push(createOpportunity(
      account,
      'Employee Recognition Program',
      'HR Manager',
      ['appreciation gifts', 'milestone awards', 'apparel', 'drinkware'],
      ['Recognition / Awards','Apparel','Drinkware'],
      54
    ));
    opps.push(createOpportunity(
      account,
      'Event / Campaign Merch Program',
      'Marketing Manager',
      ['giveaways', 'event apparel', 'signage', 'premium gifts'],
      ['Event / Giveaway','Print / Stationery'],
      54
    ));
  }

  // Remove duplicate opportunity names and keep best 4 per account
  const unique = [];
  const seen = new Set();
  for(const opp of opps.sort((a,b)=>(b.quickWinScore||b.confidence) - (a.quickWinScore||a.confidence) || (b.closeProbability||0) - (a.closeProbability||0) || b.estimatedValue - a.estimatedValue)){
    if(!seen.has(opp.opportunity)){
      seen.add(opp.opportunity);
      unique.push(opp);
    }
  }
  return unique.slice(0, 4);
}

function renderEvidenceList(evidence){
  if(!evidence || !evidence.length) return 'Historical purchase pattern supports this recommendation.';
  return `<ul style="padding-left:18px; margin:0;">${evidence.map(e=>`<li>${escapeHtml(e)}</li>`).join('')}</ul>`;
}

function getPriorityTier(opp){
  if(opp.confidence >= 80 || opp.estimatedValue >= 15000) return {label:'Immediate Action', cls:'confidence-high'};
  if(opp.confidence >= 60) return {label:'Monitor', cls:'confidence-medium'};
  return {label:'Low Priority', cls:'confidence-low'};
}

// Sales Play Generator - reason-to-reach-out and relationship-aware
window.createSalesPlayPanel = function(opp){
  const account = opp.account || 'this account';
  const contactName = opp.contactName || opp.contact || '';
  const mode = salesPlayModeFromOpp(opp);
  const relationshipStrength = Math.round(opp.relationshipStrength || 0);
  const closeProbability = Math.round(opp.closeProbability || 0);
  const firstName = contactName && !contactName.includes('/') ? contactName.split(' ')[0] : 'there';
  const reasonTitle = getReasonToReachOutTitle(opp);
  const whyNow = getWhyNowText(opp);
  const conversationStarter = getConversationStarterText(opp);
  const categories = (opp.commonPromoCategories || opp.suggestedProducts || ['apparel', 'giveaways', 'recognition items']).slice(0,4);
  const categoryText = categories.join(', ');
  const sourceLabel = opp.sourceUrl ? 'verified public signal' : 'account history';
  const relationshipLine = relationshipStrength >= 75
    ? 'This is a warm account. Keep the ask casual and relationship-led.'
    : relationshipStrength >= 40
      ? 'This is a lukewarm account. Reopen the conversation with a specific reason, not a generic check-in.'
      : 'This is a low-history account. Lead with the signal and ask for the right person.';

  let subject, email, callOpen, questions, nextStep;

  if(mode === 'Warm'){
    subject = `Quick question for ${account}`;
    email = `Hey ${firstName},\n\nHope all is well.\n\nAppreciate being able to help with the branded merch work so far. I had one quick adjacent thought for you.\n\n${conversationStarter}\n\nThe reason I ask: ${whyNow}\n\nIf it would be helpful, I can send a few simple ideas around ${categoryText}.\n\nWorth a quick look?`;
    callOpen = `“Hey ${firstName}, appreciate the work we've been able to help with. I had one quick related question based on what you're already doing.”`;
    questions = [
      conversationStarter,
      'Is that handled by you, or does another department own it?',
      'Are different teams ordering this kind of merch separately today?',
      'Would it help if I sent a quick good / better / best option set?'
    ];
    nextStep = 'Send a short relationship-based note. Goal: earn a reply or referral, not pitch a full program.';
  } else if(mode === 'Lukewarm'){
    subject = `Quick idea for ${account}`;
    email = `Hey ${firstName},\n\nIt's been a bit since we've connected, but I was looking back at ${account} and had a specific reason to reach out.\n\n${conversationStarter}\n\nWhy now: ${whyNow}\n\nIf this is already covered, no worries. If not, I can send over a few practical ideas around ${categoryText}.\n\nIs this worth revisiting?`;
    callOpen = `“Hey ${firstName}, we haven't connected in a bit, but I had a specific idea for ${account} — not just a generic check-in.”`;
    questions = [
      conversationStarter,
      'Is this still relevant for the team?',
      'Has ownership for branded merch changed internally?',
      'Who would be the right person to include if we explored it?'
    ];
    nextStep = 'Use this as a reactivation touch. Ask for direction first, then offer a few examples.';
  } else {
    subject = `${account} question`;
    email = `Hi ${firstName},\n\nI noticed something timely about ${account} and had a quick question.\n\n${conversationStarter}\n\nWhy now: ${whyNow}\n\nWe help teams turn moments like that into practical branded merchandise ideas — usually around ${categoryText}.\n\nIf you're not the right person, who usually owns that internally?`;
    callOpen = `“Hi ${firstName}, I noticed something timely about ${account} and wanted to find the right person to ask.”`;
    questions = [
      conversationStarter,
      'Who typically owns employee, event, customer, or department merch programs?',
      'Is there an upcoming timing or initiative this would need to support?',
      'Would it be useful to see a few examples?'
    ];
    nextStep = 'Lead with the reason to reach out. Confirm ownership and timing before discussing products.';
  }

  const html = `
    <div class="sales-play-modal" onclick="if(event.target.className==='sales-play-modal') this.remove()">
      <div class="sales-play-modal-content">
        <div class="sales-play-header">
          <div>
            <h2>Sales Play</h2>
            <div class="sales-play-subheader">${escapeHtml(account)} · ${escapeHtml(reasonTitle)} <span class="relationship-badge">${escapeHtml(mode)} Play</span></div>
          </div>
          <button class="sales-play-close" onclick="this.closest('.sales-play-modal').remove()">×</button>
        </div>
        <div class="sales-play-output">
          <div class="sales-play-section">
            <h3>Quick-Win Read</h3>
            <div class="section-content">
              <strong>Reason to reach out:</strong> ${escapeHtml(reasonTitle)}<br>
              <strong>Relationship Strength:</strong> ${relationshipStrength}/100<br>
              <strong>Estimated Close Probability:</strong> ${closeProbability}%<br>
              <strong>Source:</strong> ${escapeHtml(sourceLabel)}<br>
              <strong>Rep guidance:</strong> ${escapeHtml(relationshipLine)}
            </div>
          </div>
          <div class="sales-play-section">
            <h3>Why Now</h3>
            <div class="section-content">${escapeHtml(whyNow)}</div>
          </div>
          <div class="sales-play-section">
            <h3>Conversation Starter</h3>
            <div class="section-content">${escapeHtml(conversationStarter)}</div>
          </div>
          <div class="sales-play-section">
            <h3>Common Promo Categories</h3>
            <div class="section-content">${escapeHtml(categoryText)}</div>
          </div>
          <div class="sales-play-section">
            <h3>Subject Line</h3>
            <div class="section-content subject-line">${escapeHtml(subject)}</div>
          </div>
          <div class="sales-play-section">
            <h3>Outreach Email</h3>
            <div class="section-content sales-play-email-body">${escapeHtml(email)}</div>
          </div>
          <div class="sales-play-section">
            <h3>Call Script</h3>
            <div class="section-content">
              <div class="script-section"><div class="script-label">Open</div><div class="script-text">${escapeHtml(callOpen)}</div></div>
              <div class="script-section"><div class="script-label">Reason</div><div class="script-text">“${escapeHtml(whyNow)}”</div></div>
              <div class="script-section"><div class="script-label">Ask</div><div class="script-text">“${escapeHtml(conversationStarter)}”</div></div>
            </div>
          </div>
          <div class="sales-play-section">
            <h3>Discovery Questions</h3>
            <div class="section-content"><ul class="discovery-list">${questions.map(q=>`<li>${escapeHtml(q)}</li>`).join('')}</ul></div>
          </div>
          <div class="sales-play-section">
            <h3>Recommended Next Step</h3>
            <div class="section-content next-step">${escapeHtml(nextStep)}</div>
          </div>
        </div>
      </div>
    </div>`;
  document.body.insertAdjacentHTML('beforeend', html);
}

function isClosedHistoricalRecord(record){
  const status = String(record.status || '').toLowerCase();
  const project = String(record.project || '').toLowerCase();
  // Commonsku exports often show successful estimate-originated work as "Converted".
  // Treat converted/invoiced/billed/closed work as historical proof.
  if(/converted|invoiced|ready to be invoiced|billed|closed|complete|completed|paid|in production/.test(status)) return true;
  // Guardrail: obvious active estimates/pending work are not historical revenue.
  if(/open|draft|pending|presented|estimate|quote|proposal|cancelled|canceled|lost/.test(status)) return false;
  // If status is missing, treat as historical only if the project name doesn't look like an estimate.
  return !/estimate|quote|proposal/.test(project);
}

function isActivePipelineRecord(record){
  const status = String(record.status || '').toLowerCase();
  const project = String(record.project || '').toLowerCase();
  return /open|draft|pending|presented|estimate|quote|proposal/.test(status) || /estimate|quote|proposal/.test(project);
}

function hasOrderHistoryEvidence(record){
  const project = String(record.project || '').trim().toLowerCase();
  const revenue = Number(record.revenue || 0);
  const status = String(record.status || '').trim();
  const hasProject = project && project !== 'unspecified';
  return revenue > 0 || hasProject || !!status || !!record.dateStr;
}

function sumRevenue(records){
  return records.reduce((sum, o) => sum + (Number(o.revenue) || 0), 0);
}

function renderPipelineTable(records){
  if(!records || !records.length) return '';
  const total = sumRevenue(records);
  return `
    <div class="section-title">🟡 Active Pipeline — Excluded From Revenue Found</div>
    <div class="pipeline-note">These records appear to be open estimates or active pipeline. They are useful context, but they are not counted as historical revenue or hidden opportunity found.</div>
    <table class="projects-table">
      <thead><tr><th>Estimate / Project</th><th>Category</th><th>Value</th><th>Status</th><th>Date</th></tr></thead>
      <tbody>
        ${records.map(p => `<tr><td>${escapeHtml(p.project)}</td><td>${escapeHtml(p.category)}</td><td>${fmtMoney(p.revenue)}</td><td>${escapeHtml(p.status || 'Open')}</td><td>${escapeHtml(p.dateStr || '')}</td></tr>`).join('')}
      </tbody>
    </table>
    <div class="pipeline-total">Active pipeline shown: ${fmtMoney(total)}</div>
  `;
}

function processData(records){
  // Group by client
  const clients = {};

  records.forEach(record => {
    if(!clients[record.client]) clients[record.client] = [];
    clients[record.client].push(record);
  });

  // Closed/converted records are historical proof. Open estimates are active pipeline only.
  const closedRevenueByClient = Object.values(clients).map(orders => {
    const closed = orders.filter(isClosedHistoricalRecord).filter(hasOrderHistoryEvidence);
    return sumRevenue(closed);
  });
  const minRev = Math.min(...closedRevenueByClient, 0);
  const maxRev = Math.max(...closedRevenueByClient, 1);
  const revRange = maxRev - minRev || 1;

  const accounts = [];
  for(const clientName in clients){
    const allOrders = clients[clientName];
    const closedOrders = allOrders.filter(isClosedHistoricalRecord);
    const activePipeline = allOrders.filter(o => hasOrderHistoryEvidence(o) && (!isClosedHistoricalRecord(o) || isActivePipelineRecord(o)));
    // Account-list-only uploads are valid. A row with only client_name should create an account,
    // but it should not be treated as historical order evidence.
    const scoringOrders = closedOrders.filter(hasOrderHistoryEvidence);
    const totalRevenue = sumRevenue(scoringOrders);
    const activePipelineValue = sumRevenue(activePipeline);
    const orderCount = scoringOrders.length;
    const categories = new Set(scoringOrders.map(o => o.category).filter(Boolean));
    const projects = [...new Set(scoringOrders.map(o => o.project).filter(Boolean))];
    const allProjects = [...new Set(allOrders.map(o => o.project).filter(Boolean))];

    const now = new Date();
    const mostRecentDate = scoringOrders.filter(o => o.date).sort((a, b) => b.date - a.date)[0]?.date;
    const daysSinceLast = mostRecentDate ? Math.floor((now - mostRecentDate) / (1000 * 60 * 60 * 24)) : 999;

    const revScore = (totalRevenue - minRev) / revRange;
    const freqScore = Math.min(orderCount / 10, 1);
    const recencyScore = Math.max(1 - (daysSinceLast / 365), 0);
    const diversityScore = Math.min(categories.size / 4, 1);

    const totalScore = orderCount > 0 ? (revScore * 0.4 + freqScore * 0.2 + recencyScore * 0.25 + diversityScore * 0.15) : 0;
    const confidence = Math.min(totalScore * 100, 100);

    const industry = inferIndustry(clientName, allProjects);
    const firstRecord = scoringOrders[0] || allOrders[0] || {};
    const account = {
      name: clientName,
      industry,
      revenue: totalRevenue,
      activePipelineValue,
      orderCount,
      activePipelineCount: activePipeline.length,
      confidence: confidence,
      subscores: { revenue: revScore, frequency: freqScore, recency: recencyScore, diversity: diversityScore },
      categoryTypes: categories,
      projects,
      allProjects,
      contactName: firstRecord.contactName || '',
      contactEmail: firstRecord.contactEmail || '',
      purchases: scoringOrders,
      activePipeline,
      allRecords: allOrders,
      mostRecentDate: mostRecentDate ? mostRecentDate.toLocaleDateString() : 'Unknown'
    };

    account.relationshipStrength = getRelationshipStrength(account);
    account.relationshipMode = getRelationshipMode(account);
    account.signals = generateSimulatedSignals(account, {});
    account.futureOpportunities = orderCount > 0 ? generateFutureOpportunities(account) : [];
    accounts.push(account);
  }

  accounts.sort((a, b) => b.confidence - a.confidence || b.revenue - a.revenue || b.activePipelineValue - a.activePipelineValue);
  window.accountRadarAccounts = accounts;

  // Future opportunities only. Historical orders are evidence, not opportunities.
  const futureOpportunities = accounts.flatMap(account => account.futureOpportunities || []).sort((a,b)=>(b.quickWinScore||b.confidence) - (a.quickWinScore||a.confidence) || (b.closeProbability||0) - (a.closeProbability||0) || b.estimatedValue - a.estimatedValue);
  const displayedOpportunities = futureOpportunities.slice(0, 10);

  // Render opportunities grid
  const grid = document.getElementById('opportunitiesGrid');
  const resultCount = document.getElementById('resultCount');
  const accountListOnlyCount = accounts.filter(a => a.orderCount === 0 && a.activePipelineCount === 0).length;
  resultCount.innerHTML = `<span>Showing top ${displayedOpportunities.length} of ${futureOpportunities.length} reasons to reach out from ${accounts.length} accounts${accountListOnlyCount ? ` · ${accountListOnlyCount} account-list-only records` : ''}</span>`;

  const noOpportunitiesMessage = displayedOpportunities.length === 0 ? `<div class="no-signals-message">No order-history-based reasons to reach out found yet. Use <strong>Research Top Accounts</strong> to scan public sources for verified signals.</div>` : '';
  grid.innerHTML = `<div class="limit-note">Showing the top 10 ranked reasons to reach out only. Historical closed/converted orders are evidence. Open estimates are shown as active pipeline and excluded from Revenue Found.</div>` + noOpportunitiesMessage + displayedOpportunities.map((opp, idx) => {
    const tier = getPriorityTier(opp);
    return `
      <div class="opportunity-card">
        <div class="opp-card-header">
          <div class="opportunity-type">${escapeHtml(opp.opportunityType || 'EXPANSION')}</div>
          <div class="opp-card-title">${escapeHtml(getReasonToReachOutTitle(opp))}</div>
          <div class="opp-card-account">${escapeHtml(opp.account)} · ${escapeHtml(opp.opportunity)} · ${escapeHtml(relationshipLabelFromScore(opp.relationshipStrength || 0))}</div>
        </div>
        <div class="confidence-badge ${tier.cls}">
          ${tier.label} · ${Math.round(opp.confidence)}% Quick Win Score
        </div>
        <div class="opp-metrics">
          <div class="metric">
            <div class="metric-value">${getValueDisplay(opp)}</div>
            <div class="metric-label">${getValueLabel(opp)}</div>
          </div>
          <div class="metric">
            <div class="metric-value">${Math.round(opp.closeProbability || opp.confidence)}%</div>
            <div class="metric-label">Close Probability</div>
          </div>
        </div>
        <div class="quickwin-breakdown">
          <div class="quickwin-mini"><div class="num">${Math.round(opp.relationshipStrength || 0)}</div><div class="lbl">Relationship</div></div>
          <div class="quickwin-mini"><div class="num">${Math.round(opp.closeProbability || 0)}%</div><div class="lbl">Close Prob.</div></div>
          <div class="quickwin-mini"><div class="num">${Math.round(opp.confidence || 0)}</div><div class="lbl">Quick Win</div></div>
        </div>
        <div class="opp-section">
          <div class="opp-label">Why Now</div>
          <div class="opp-content">${escapeHtml(getWhyNowText(opp))}</div>
        </div>
        <div class="opp-section">
          <div class="opp-label">Evidence</div>
          <div class="opp-content">${renderEvidenceList(opp.evidence)}<div class="evidence-note">Shown because purchase history supports this adjacent opportunity. No open estimates are counted as historical revenue.</div></div>
        </div>
        <div class="opp-section">
          <div class="opp-label">Suggested Contact</div>
          <div class="opp-content meta">${escapeHtml(opp.contactTitle || opp.contact || 'Unknown')}</div>
        </div>
        <div class="opp-section">
          <div class="opp-label">Conversation Starter</div>
          <div class="opp-content">${escapeHtml(getConversationStarterText(opp))}</div>
        </div>
        <div class="opp-section">
          <div class="opp-label">Common Promo Categories</div>
          <div class="opp-products">${(opp.commonPromoCategories || opp.suggestedProducts || []).map(p=>`<span class="product-badge">${escapeHtml(p)}</span>`).join('')}</div>
        </div>
        <div class="opp-card-actions"><button class="btn btn-generate-play" onclick='createSalesPlayPanel(${JSON.stringify(opp).replace(/'/g, "&#39;")})'>Generate Sales Play</button></div>
      </div>`;
  }).join('');

  const closedHistoricalRevenue = accounts.reduce((sum, a) => sum + (a.revenue || 0), 0);
  const activePipelineTotal = accounts.reduce((sum, a) => sum + (a.activePipelineValue || 0), 0);
  const totalFutureValue = futureOpportunities.reduce((sum, o) => sum + (o.estimatedValue || 0), 0);

  document.getElementById('totalAccounts').textContent = accounts.length;
  document.getElementById('totalOppValue').textContent = fmtMoney(totalFutureValue);
  document.getElementById('highConfidenceCount').textContent = futureOpportunities.filter(o => o.confidence >= 70).length;
  document.getElementById('avgConfidence').textContent = Math.round(futureOpportunities.reduce((sum, o) => sum + o.confidence, 0) / Math.max(futureOpportunities.length, 1)) + '%';

  // Render top opportunities
  document.getElementById('topOppsList').innerHTML = futureOpportunities.slice(0,10).map(opp => `<div class="top-opp-item"><div class="top-opp-title">${escapeHtml(getReasonToReachOutTitle(opp))}</div><div class="top-opp-meta">${escapeHtml(opp.account)} · ${escapeHtml(opp.contactTitle)}</div><div class="top-opp-value">${getValueDisplay(opp)}</div></div>`).join('');

  const notice = document.getElementById('notice');
  if(notice){
    const noticeMessages = [];
    const clientMapping = records.columnMappings && records.columnMappings.client_name;
    if(clientMapping && clientMapping.normalized !== 'client_name'){
      noticeMessages.push(`Detected company/account column: <strong>${escapeHtml(clientMapping.detected)}</strong> → <strong>client_name</strong>.`);
    }
    if(activePipelineTotal > 0){
      noticeMessages.push(`Active pipeline detected: ${fmtMoney(activePipelineTotal)} in open estimates was excluded from historical revenue and Estimated Revenue Opportunity.`);
    }
    notice.style.display = noticeMessages.length ? 'block' : 'none';
    notice.innerHTML = noticeMessages.join('<br>');
  }

  // Render detailed account cards. Keep the screen useful for large uploads by showing the top 10.
  // The full account set still exists in memory for Research Top Accounts and future features.
  const accountList = document.getElementById('accountList');
  const detailedAccounts = accounts.slice(0, 10);
  accountList.innerHTML = `${accounts.length > 10 ? `<div class="limit-note">Showing the top 10 account views from ${accounts.length} uploaded accounts. Research Top Accounts scans the top 10 first so large uploads stay manageable.</div>` : ''}` + detailedAccounts.map((a, idx) => `
    <div class="account-card">
      <div class="account-head" onclick="this.nextElementSibling.classList.toggle('open')">
        <div class="rank">#${idx + 1}</div>
        <div>
          <div class="acct-name">${escapeHtml(a.name)}</div>
          <div class="acct-meta">${escapeHtml(a.industry)} · ${a.orderCount} historical orders · ${a.futureOpportunities.length} reasons to reach out${a.activePipelineCount ? ` · ${a.activePipelineCount} active estimate(s)` : ''}</div>
        </div>
        <div class="score-block">
          <div class="score">${Math.round(a.confidence)}</div>
          <div class="score-label">Overall</div>
        </div>
        <div class="score-block">
          <div class="score-bar-wrap"><div class="score-bar"><div class="score-bar-fill" style="width:${a.subscores.revenue * 100}%"></div></div></div><div class="score-label">Revenue</div>
        </div>
        <div class="score-block">
          <div class="score-bar-wrap"><div class="score-bar"><div class="score-bar-fill" style="width:${a.subscores.recency * 100}%"></div></div></div><div class="score-label">Recency</div>
        </div>
      </div>
      <div class="account-body">
        <div class="breakdown">
          <div class="bd-item"><div class="lbl">Closed Historical Revenue</div><div class="val">${fmtMoney(a.revenue)}</div></div>
          <div class="bd-item"><div class="lbl">Historical Orders</div><div class="val">${a.orderCount}</div></div>
          <div class="bd-item"><div class="lbl">Relationship Strength</div><div class="val">${Math.round(a.relationshipStrength || 0)}</div></div>
          <div class="bd-item"><div class="lbl">Active Pipeline</div><div class="val">${fmtMoney(a.activePipelineValue)}</div></div>
          <div class="bd-item"><div class="lbl">Last Closed Order</div><div class="val">${a.mostRecentDate}</div></div>
        </div>
        <div class="section-title">🎯 Reasons To Reach Out</div>
        <ul class="opps">
          ${(a.futureOpportunities || []).map(o => `<li><strong>${escapeHtml(getReasonToReachOutTitle(o))}</strong> — ${escapeHtml(o.opportunity)} · ${getValueDisplay(o)} · ${Math.round(o.confidence)}% quick-win score</li>`).join('') || '<li>No reasons to reach out generated from closed historical orders.</li>'}
        </ul>
        <div class="section-title">📄 Historical Orders Used As Evidence</div>
        ${a.purchases.length ? `<table class="projects-table"><thead><tr><th>Order / Project</th><th>Category</th><th>Revenue</th><th>Date</th><th>Status</th></tr></thead><tbody>${a.purchases.map(p => `<tr><td>${escapeHtml(p.project)}</td><td>${escapeHtml(p.category)}</td><td>${fmtMoney(p.revenue)}</td><td>${escapeHtml(p.dateStr || '')}</td><td>${escapeHtml(p.status || 'Historical')}</td></tr>`).join('')}</tbody></table>` : '<div class="no-signals-message">No closed/converted historical orders found for this account.</div>'}
        ${renderPipelineTable(a.activePipeline)}
        <div class="section-title">📡 Verified Business Signals</div>
        <button class="btn btn-secondary" type="button" onclick="researchAccountByName('${escapeHtml(a.name).replace(/'/g, "\\'")}')">Research Account</button>
        <span class="research-note">Only externally sourced signals appear here. No signal means no invented hiring, launch, expansion, leadership, or event claim.</span>
        <div class="signal-research-panel" id="signals-${accountDomId(a.name)}">${renderVerifiedSignals(a.signals)}</div>
        ${a.contactEmail ? `<div class="contact">Contact: <a href="mailto:${escapeHtml(a.contactEmail)}">${escapeHtml(a.contactName)}</a></div>` : ''}
      </div>
    </div>
  `).join('');

  document.getElementById('results').style.display = 'block';
  const exampleOpportunity = document.getElementById('exampleOpportunity');
  if(exampleOpportunity) exampleOpportunity.style.display = 'none';

  const betaCta = document.getElementById('betaCta');
  if(betaCta) betaCta.style.display = 'block';
  lastAnalysisSummary = {
    accountCount: accounts.length,
    closedHistoricalRevenue,
    activePipelineTotal,
    futureOpportunityCount: futureOpportunities.length,
    futureOpportunityValue: totalFutureValue
  };
}

function escapeHtml(text){
  const map = {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'};
  return String(text || '').replace(/[&<>"']/g, m => map[m]);
}
