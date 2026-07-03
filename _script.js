
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
        houseAccounts: document.getElementById('houseAccounts').value,
        crmErp: document.getElementById('leadCrmErp').value
      };
      if(!lead.name || !lead.email || !lead.company || !lead.role || !lead.houseAccounts || !lead.crmErp){
        showError('Please complete all access fields.');
        return;
      }
      currentLead = lead;
      localStorage.setItem('houseAccountsLead', JSON.stringify(lead));
      await captureLead('report_gate', {lead});
      setLeadGateState();
      clearError();
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
    showError('This file type is not supported yet. Please choose the customer list you exported from your sales system.');
    return;
  }
  const reader = new FileReader();
  reader.onload = e => {
    try{
      const rows = parseCSV(e.target.result);
      processData(rows);
    }catch(err){
      showError('We could not read that customer list. Please check the file and try again.');
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
    revenue: ['revenue','amount','total','subtotal','order_value','order_amount','sales','project_billed_margin_subtotal','booked_margin_subtotal'],
    margin: ['margin','margin_pct','booked_margin','booked_margin_amount','project_billed_margin','project_billed_margin_amount','profit'],
    margin_percent: ['margin_percent','booked_margin_percent','project_billed_margin_percent','booked_margin_','project_billed_margin_'],
    contact_name: ['contact_name','contact','contact_person','primary_contact','project_client_contact','client_contact'],
    category: ['category','product_category','item_category','project_category','order_category','type'],
    quantity: ['quantity','qty','units'],
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
    const explicitCategory = get('category');
    const projectName = colIndex.project_name !== undefined
      ? (get('project_name') || explicitCategory || 'Unspecified')
      : (explicitCategory ? `${explicitCategory} order` : 'Unspecified');
    const contactName = get('contact_name') || [get('contact_first'), get('contact_last')].filter(Boolean).join(' ');
    const clientName = get('client_name') || '';
    if(isLikelyInvalidAccountName(clientName)) continue;
    const categoryText = [explicitCategory, projectName, get('order_tags'), get('client_tags')].filter(Boolean).join(' ');
    records.push({
      client: clientName || 'Unknown',
      project: projectName,
      category: explicitCategory ? inferPromoCategory(categoryText) : inferPromoCategory(categoryText),
      rawCategory: explicitCategory,
      quantity: parseFloat(String(get('quantity') || '').replace(/[^0-9.\-]/g,'')) || null,
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
    ['Print / Stationery', ['journal','notebook','office','stationery','set','card','print','sign','banner','table throw']],
    ['Onboarding / Recruiting', ['new hire','onboarding','welcome','recruiting','career','employee kit']],
    ['Safety', ['safety','ppe','hi-vis','vest','osha']],
    ['Wellness / Employee Engagement', ['wellness','health fair','employee engagement','wellbeing']],
    ['Client Gifts', ['client gifts','client gift','customer gifts','premium gifts']],
    ['Sales Incentive', ['sales incentive','incentive','spiff']]
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

function signalLayerLabel(opp){
  if(opp.signalLayerType) return normalizeSignalLayerType(opp.signalLayerType);
  if(opp.isVerifiedSignalOpportunity || opp.sourceUrl) return 'Business Activity Signal';
  if(isRecentAccountActivity(opp)) return 'Follow-Up Signal';
  return 'Repeat / Pattern Signal';
}

function isRecentAccountActivity(opp){
  const ev = Array.isArray(opp.evidence) ? opp.evidence.join(' ').toLowerCase() : String(opp.evidence || '').toLowerCase();
  return /recent activity|last closed order|recent order|last order|delivered|completed/.test(ev) || Number(opp.closeProbability || 0) >= 65;
}

function confidenceWord(opp){
  const n = Number(opp.confidence || opp.quickWinScore || opp.closeProbability || 0);
  if(n >= 70) return 'High';
  if(n >= 45) return 'Medium';
  return 'Low';
}

function sourceDomain(url){
  try { return new URL(url).hostname.replace(/^www\./,''); } catch { return ''; }
}

function shortText(text, max=145){
  const cleaned = String(text || '').replace(/\s+/g,' ').trim();
  if(!cleaned) return '';
  return cleaned.length > max ? cleaned.slice(0,max).replace(/\s+\S*$/,'') + '…' : cleaned;
}

function signalBadgeMeta(opp){
  const layer = signalLayerLabel(opp);
  if(layer === 'Follow-Up Signal') return { cls:'follow-up', label:'Follow-Up Signal', icon:'●' };
  if(layer === 'Repeat / Pattern Signal') return { cls:'repeat-pattern', label:'Repeat Pattern', icon:'●' };
  return { cls:'business-activity', label:'Business Activity', icon:'●' };
}

function parseMaybeDate(value){
  if(!value) return null;
  if(value instanceof Date && !isNaN(value)) return value;
  const d = new Date(value);
  return isNaN(d) ? null : d;
}

function formatSignalAge(opp){
  const raw = opp.signalDate || opp.detectedAt || opp.dateFound || opp.lastActivityDate || opp.orderDate || '';
  const d = parseMaybeDate(raw);
  if(!d) return '';
  const now = new Date();
  const days = Math.max(0, Math.floor((now - d) / (1000*60*60*24)));
  if(days === 0) return 'Detected today';
  if(days === 1) return 'Detected 1 day ago';
  if(days <= 30) return `Detected ${days} days ago`;
  return `Detected ${d.toLocaleDateString(undefined, {month:'short', day:'numeric'})}`;
}


function cleanBusinessText(text){
  let t = String(text || '').replace(/\s+/g,' ').trim();
  t = t.replace(/[-–—>\s]*You have JavaScript disabled or are viewing the site on a device that does not support[^.]*\.?/ig, ' ');
  t = t.replace(/[-–—>\s]*Press\s*-\s*/ig, ' ');
  t = t.replace(/\bContact Saved Saved\b/ig, ' ');
  t = t.replace(/\bMap Contact Saved\b/ig, ' ');
  t = t.replace(/\s+/g,' ').trim();
  if(/javascript disabled|unsupported browser|does not support|saved saved|captcha|access denied/i.test(t)) return '';
  return t;
}

function businessSignalKind(opp){
  const raw = `${opp.signalType || ''} ${opp.opportunityCategory || ''} ${opp.opportunity || ''} ${opp.signalTitle || ''} ${opp.signalSummary || ''}`.toLowerCase();
  if(/hiring|career|job|recruit|new hire|technician|production|operator/.test(raw)) return 'hiring';
  if(/event|conference|expo|trade show|open house|campaign|sponsorship/.test(raw)) return 'event';
  if(/expansion|new location|facility|opening|grand opening|growth/.test(raw)) return 'expansion';
  if(/award|recognition|milestone|anniversary|honor|winner/.test(raw)) return 'recognition';
  if(/leadership|appoint|promote|named|joins/.test(raw)) return 'leadership';
  if(/launch|new product|new service/.test(raw)) return 'launch';
  return 'business';
}

function businessSignalPlainSummary(opp){
  const account = opp.account || 'this account';
  const detail = cleanBusinessText(opp.signalDetail || opp.signalTitle || opp.signalSummary || opp.shortSummary || '');
  const kind = businessSignalKind(opp);
  if(detail && detail.length > 12 && !/^Ford Dealer|^Dentist Exeter|^Careers with/i.test(detail)) return shortText(detail, 150);
  if(kind === 'hiring') return `${account} has public hiring or careers activity worth checking on.`;
  if(kind === 'event') return `${account} has public event, campaign, or community activity worth checking on.`;
  if(kind === 'expansion') return `${account} has public growth or expansion activity worth checking on.`;
  if(kind === 'recognition') return `${account} has public recognition or milestone activity worth checking on.`;
  if(kind === 'leadership') return `${account} has public leadership or team-change activity worth checking on.`;
  if(kind === 'launch') return `${account} has public product, service, or campaign activity worth checking on.`;
  return `Recent public activity gives a timely reason to reconnect with ${account}.`;
}

function businessSuggestedOpener(opp){
  const contact = opp.contact && !String(opp.contact).includes('/') ? String(opp.contact).split(' ')[0] : 'there';
  const kind = businessSignalKind(opp);
  if(kind === 'hiring') return `Hey ${contact} — noticed some hiring activity on your end. Is anything changing around onboarding, recruiting, or employee experience that would be worth planning for?`;
  if(kind === 'event') return `Hey ${contact} — noticed some event or community activity on your end. Is there anything coming up where it would help to think through merch, attendee gifts, or staff gear?`;
  if(kind === 'expansion') return `Hey ${contact} — saw some growth activity on your end. Is that creating any internal or customer-facing needs we should be thinking about?`;
  if(kind === 'recognition') return `Hey ${contact} — saw some recognition activity around the team. Anything coming up where employee or customer appreciation would be useful?`;
  if(kind === 'leadership') return `Hey ${contact} — noticed some team or leadership activity. Is there anything new internally that would be worth supporting from a brand or employee-experience standpoint?`;
  if(kind === 'launch') return `Hey ${contact} — noticed some launch activity on your end. Is there anything customer-facing or sales-team related that would be worth planning around?`;
  return `Hey ${contact} — saw some recent activity on your end and thought it was worth checking in. Anything coming up that we should be thinking about?`;
}

function getRepFriendlyWhy(opp){
  const layer = signalLayerLabel(opp);
  const oppName = String(opp.opportunity || opp.opportunityName || '').toLowerCase();
  const categories = (opp.commonPromoCategories || opp.suggestedProducts || []).map(x => String(x).toLowerCase());
  if(layer === 'Follow-Up Signal'){
    if(oppName.includes('apparel') || categories.some(c=>/apparel|shirt|uniform|hat|headwear/.test(c))){
      return 'A recent apparel project is fresh enough for a simple check-in on fit, feedback, and any follow-up needs.';
    }
    if(oppName.includes('event') || categories.some(c=>/event|giveaway|booth|campaign/.test(c))){
      return 'A recent event or giveaway project gives the rep a natural reason to ask how it performed.';
    }
    if(oppName.includes('welcome') || oppName.includes('onboarding') || categories.some(c=>/welcome|onboarding|employee/.test(c))){
      return 'A recent employee-facing order creates an easy check-in around how the team received it.';
    }
    return 'Recent project activity creates a simple reason to check in while the order is still fresh.';
  }
  if(layer === 'Repeat / Pattern Signal'){
    if(oppName.includes('apparel') || categories.some(c=>/apparel|shirt|uniform|hat|headwear/.test(c))){
      return 'Past apparel buying suggests it is worth asking whether another run or refresh is coming up.';
    }
    if(oppName.includes('event') || categories.some(c=>/event|giveaway|booth|campaign/.test(c))){
      return 'A previous event or campaign pattern suggests there may be another program worth checking on.';
    }
    return 'Historical buying behavior suggests a possible repeat need worth asking about now.';
  }
  return businessSignalPlainSummary(opp);
}

function getRepEvidenceBullets(opp){
  const layer = signalLayerLabel(opp);
  const out = [];
  if(layer === 'Business Activity Signal'){
    if(opp.sourceUrl) out.push(`Source: ${sourceDomain(opp.sourceUrl) || 'public web source'}`);
    if(opp.signalDate && !String(opp.signalDate).includes('T')) out.push(`Published: ${opp.signalDate}`);
    const cleanSummary = businessSignalPlainSummary(opp);
    if(cleanSummary) out.push(shortText(cleanSummary, 130));
    if(opp.affectedDepartment) out.push(`Likely team: ${opp.affectedDepartment}`);
  } else {
    const ev = Array.isArray(opp.evidence) ? opp.evidence : [];
    const recent = ev.find(e => /recent activity|last order|last closed order/i.test(e));
    const orders = ev.find(e => /historical orders/i.test(e));
    const cats = ev.find(e => /purchased categories|relevant purchase history/i.test(e));
    if(recent) out.push(recent);
    if(orders) out.push(orders);
    if(cats) out.push(shortText(cats, 130));
  }
  if(!out.length && Array.isArray(opp.evidence)) out.push(...opp.evidence.slice(0,3).map(e => shortText(e, 130)));
  return out.filter(Boolean).slice(0,3);
}

function getSuggestedOpener(opp){
  const contact = opp.contact && !String(opp.contact).includes('/') ? String(opp.contact).split(' ')[0] : 'there';
  const layer = signalLayerLabel(opp);
  const oppName = String(opp.opportunity || opp.opportunityName || '').toLowerCase();
  const categories = (opp.commonPromoCategories || opp.suggestedProducts || []).map(x => String(x).toLowerCase());
  if(layer === 'Follow-Up Signal'){
    if(oppName.includes('apparel') || categories.some(c=>/apparel|shirt|uniform|hat|headwear/.test(c))){
      return `Hey ${contact} — quick check-in on the recent apparel project. How did everything turn out?`;
    }
    if(oppName.includes('event') || categories.some(c=>/event|giveaway|booth|campaign/.test(c))){
      return `Hey ${contact} — wanted to check in on the recent event/giveaway project. How did it go?`;
    }
    if(oppName.includes('welcome') || oppName.includes('onboarding') || categories.some(c=>/welcome|onboarding|employee/.test(c))){
      return `Hey ${contact} — quick check-in on the recent employee-facing order. How was it received?`;
    }
    return `Hey ${contact} — quick check-in on the recent project. How was everything received?`;
  }
  if(layer === 'Repeat / Pattern Signal'){
    if(oppName.includes('apparel') || categories.some(c=>/apparel|shirt|uniform|hat|headwear/.test(c))){
      return `Hey ${contact} — looks like we helped with apparel around this time before. Are you planning another run this year?`;
    }
    if(oppName.includes('event') || categories.some(c=>/event|giveaway|booth|campaign/.test(c))){
      return `Hey ${contact} — are you planning that event or campaign again this year? Happy to help if useful.`;
    }
    return `Hey ${contact} — looks like we helped with something similar around this time before. Is that coming up again?`;
  }
  return businessSuggestedOpener(opp);
}

function mailtoHref(email){
  const e = String(email || '').trim();
  if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) return '';
  return `mailto:${e.replace(/"/g,'')}`;
}

function renderRepOpportunityCard(opp){
  const badge = signalBadgeMeta(opp);
  const bullets = getRepEvidenceBullets(opp).slice(0,3);
  const tier = getPriorityTier(opp);
  const age = formatSignalAge(opp);
  const emailLink = mailtoHref(opp.email || opp.contactEmail);
  return `
    <div class="opportunity-card daily-reason-card">
      <div class="opp-card-header">
        <div class="signal-badge ${badge.cls}"><span>${badge.icon}</span>${escapeHtml(badge.label)}</div>
        ${age ? `<div class="signal-age">${escapeHtml(age)}</div>` : ''}
        <div class="opp-card-title">${escapeHtml(opp.account)}</div>
        <div class="opp-card-account">${escapeHtml(opp.contactTitle || opp.contact || 'Suggested contact TBD')}</div>
      </div>
      <div class="confidence-badge ${tier.cls}">${escapeHtml(confidenceWord(opp))} confidence</div>
      <div class="opp-section"><div class="opp-label">Why reach out</div><div class="opp-content">${escapeHtml(getRepFriendlyWhy(opp) || dailyReasonSummary(opp))}</div></div>
      <div class="opp-section"><div class="opp-label">Suggested opener</div><div class="opp-content suggested-opener">“${escapeHtml(getSuggestedOpener(opp))}”</div></div>
      ${bullets.length ? `<div class="opp-section"><div class="opp-label">Evidence</div><div class="opp-content"><ul style="padding-left:18px; margin:0;">${bullets.map(b=>`<li>${escapeHtml(b)}</li>`).join('')}</ul></div></div>` : ''}
      ${(opp.commonPromoCategories || opp.suggestedProducts || []).length ? `<div class="opp-section"><div class="opp-label">Common promo categories</div><div class="opp-products">${(opp.commonPromoCategories || opp.suggestedProducts || []).slice(0,4).map(p=>`<span class="product-badge">${escapeHtml(p)}</span>`).join('')}</div></div>` : ''}
      <div class="opp-card-actions">
        ${emailLink ? `<a class="email-contact-link" href="${escapeHtml(emailLink)}">Email Contact</a>` : `<div class="email-contact-missing">No contact email in upload</div>`}
        <button class="btn btn-generate-play" onclick='createSalesPlayPanel(${JSON.stringify(opp).replace(/'/g, "&#39;")})'>Generate Sales Play</button>
      </div>
    </div>`;
}

function renderVerifiedSignals(signals){
  const verified = (signals || []).filter(signal => signal && signal.isReal && signal.sourceUrl);
  if(!verified.length){
    return `<div class="no-signals-message">No verified external signals found.</div>`;
  }
  return verified.map(signal => {
    const confidence = signal.confidenceLevel || confidenceLabel(signal.confidence);
    const published = signal.publishedDate || signal.signalDate || signal.dateFound || '';
    const conversations = Array.isArray(signal.likelyConversations) && signal.likelyConversations.length
      ? signal.likelyConversations
      : [signal.opportunityCategory || signal.conversationStarter || signal.whyNow || 'Relevant account conversation'];
    return `
      <div class="verified-signal-simple">
        <div class="verified-signal-simple-title">${escapeHtml(signal.signalDetail || signal.title || signal.signalType || 'Verified business signal')}</div>
        <div class="verified-signal-meta">
          ${escapeHtml(signal.signalType || signal.type || 'Business Activity')} · ${escapeHtml(confidence)} confidence${published ? ` · Published: ${escapeHtml(published)}` : ''} · <a class="source-link" target="_blank" href="${escapeHtml(signal.sourceUrl)}">${escapeHtml(sourceDomain(signal.sourceUrl) || 'View source')}</a>
        </div>
        <div class="verified-signal-row"><strong>Why it matters:</strong> ${escapeHtml(signal.whyNow || signal.reasonToReachOut || 'This creates a timely reason to reach out.')}</div>
        <div class="verified-signal-row"><strong>Likely conversations:</strong>
          <ul class="likely-conversation-list">${conversations.slice(0,4).map(c => `<li>${escapeHtml(c)}</li>`).join('')}</ul>
        </div>
        <div class="verified-signal-row"><strong>Suggested contact:</strong> ${escapeHtml(signal.suggestedContact || 'Relevant department lead')}</div>
      </div>`;
  }).join('');
}

function addSignalDerivedOpportunities(account, signals){
  const existing = new Set((account.futureOpportunities || []).map(o => o.opportunity));
  (signals || []).filter(signal => signal && signal.isReal && signal.sourceUrl).forEach(signal => {
    const type = signal.signalType || signal.type || '';
    const name = signal.promoOpportunity || signal.opportunityCategory || `${type} Promo Opportunity`;
    const products = Array.isArray(signal.likelyConversations) && signal.likelyConversations.length
      ? signal.likelyConversations
      : (Array.isArray(signal.suggestedProducts) && signal.suggestedProducts.length ? signal.suggestedProducts : ['employee onboarding', 'uniforms', 'recognition', 'event support']);
    const contactTitle = signal.suggestedContact || 'Relevant department lead';
    const businessSignalCount = (signals || []).filter(s => s && s.isReal && s.sourceUrl).length;
    const multiSignalBonus = businessSignalCount > 2 ? 10 : businessSignalCount > 1 ? 6 : 0;
    const base = (type.includes('Hiring') ? 82 : type.includes('Event') ? 80 : type.includes('Expansion') ? 83 : type.includes('Award') ? 78 : 76) + multiSignalBonus;

    if(!name || existing.has(name)) return;
    const opp = createOpportunity(account, name, contactTitle, products, [], base, true);
    const hasHistory = Number(account.revenue || 0) > 0 || Number(account.orderCount || 0) > 0;
    opp.isVerifiedSignalOpportunity = true;
    opp.signalLayerType = signal.signalLayerType || 'Business Activity Signal';
    opp.signalTitle = signal.signalDetail || signal.title || type;
    opp.signalSummary = cleanBusinessText(signal.signalDetail || signal.shortSummary || signal.signalSnippet || signal.evidence || signal.title || '');
    opp.shortSummary = cleanBusinessText(signal.shortSummary || signal.signalSnippet || '');
    opp.cleanSourceName = signal.cleanSourceName || '';
    opp.signalType = type;
    opp.signalDate = signal.publishedDate || signal.signalDate || signal.dateFound || signal.detectedAt || new Date().toISOString();
    opp.sourceUrl = signal.sourceUrl;
    opp.whyNow = signal.whyNow || `Verified signal found: ${signal.signalDetail || signal.title || type}`;
    opp.valueSource = hasHistory ? 'Historical Orders + Verified Signal' : (signal.valueSource || 'Signal Only');
    opp.estimatedValueRange = signal.estimatedValueRange || null;
    opp.opportunityCategory = signal.opportunityCategory || (Array.isArray(signal.likelyConversations) ? signal.likelyConversations[0] : '') || 'Signal-Driven Conversation';
    opp.reasonToReachOut = signal.reasonToReachOut || signal.whyNow || getReasonToReachOutTitle(opp);
    opp.conversationStarter = signal.conversationStarter || signal.suggestedOpener || getConversationStarterText(opp);
    opp.commonPromoCategories = products;
    opp.likelyConversations = signal.likelyConversations || products;
    opp.affectedDepartment = signal.affectedDepartment || '';
    opp.evidence = [
      `Source: ${signal.cleanSourceName || sourceDomain(signal.sourceUrl) || 'public source'}`,
      cleanBusinessText(signal.signalDetail || signal.shortSummary || signal.signalSnippet) || 'External business activity detected',
      signal.publishedDate ? `Published: ${signal.publishedDate}` : `Suggested contact: ${signal.suggestedContact || 'Relevant department lead'}`
    ];
    opp.businessSignals = [signal];
    opp.closeProbability = Math.min(96, Math.max(55, Math.round((signal.confidence || 0.72)*100) + (opp.relationshipStrength >= 40 ? 8 : 0) + multiSignalBonus));
    opp.quickWinScore = Math.min(98, getQuickWinScore(account, base, true) + multiSignalBonus);
    opp.confidence = opp.quickWinScore;
    opp.opportunityType = 'SIGNAL-DRIVEN';
    opp.relationshipMode = getRelationshipMode(account);
    account.futureOpportunities.unshift(opp);
    existing.add(name);
  });
}

function renderResearchDiagnostics(){
  const el = document.getElementById('researchDiagnostics');
  if(!el) return;
  const diagnostics = window.researchDiagnostics || [];
  if(!diagnostics.length){
    el.style.display = 'none';
    el.innerHTML = '';
    return;
  }
  const researched = diagnostics.length;
  const signals = diagnostics.reduce((sum, d) => sum + (d.signalsFound || 0), 0);
  const results = diagnostics.reduce((sum, d) => sum + (d.searchResultsFound || 0), 0);
  const acceptedSearch = diagnostics.reduce((sum, d) => sum + (d.acceptedSearchSignals || 0), 0);
  const domainSignals = diagnostics.reduce((sum, d) => sum + (d.domainSignalsFound || 0), 0);
  const aiAccepted = diagnostics.reduce((sum, d) => sum + (d.aiAcceptedSignals || 0), 0);
  const rejected = diagnostics.reduce((sum, d) => sum + (d.rejectedResults || 0), 0);
  const zeroSignalAccounts = diagnostics.filter(d => !d.signalsFound).slice(0, 8).map(d => escapeHtml(d.accountName)).join(', ');
  const samples = diagnostics.flatMap(d => (d.candidateSamples || []).map(c => ({...c, accountName:d.accountName}))).slice(0, 12);

  const sampleRows = samples.length ? `
    <details style="margin-top:8px;">
      <summary style="cursor:pointer;"><strong>Candidate result samples</strong> — use this to debug why Business Activity Signals are not appearing</summary>
      <div style="display:grid; gap:6px; margin-top:8px;">
        ${samples.map(c => `
          <div style="background:white; border:1px solid #cfe0ef; padding:8px; border-radius:6px;">
            <div><strong>${escapeHtml(c.accountName)}</strong> · ${escapeHtml(c.status || 'candidate')} · ${escapeHtml(c.reason || '')}</div>
            <div>${escapeHtml(c.title || '')}</div>
            <div style="color:var(--slate);">${escapeHtml(c.domain || '')}${c.sourceType ? ` · ${escapeHtml(c.sourceType)}` : ''}</div>
          </div>
        `).join('')}
      </div>
    </details>
  ` : '';

  el.style.display = 'block';
  el.innerHTML = `<strong>Research diagnostics:</strong> ${researched} accounts researched · ${results} candidate search results · ${signals} business activity signals accepted · ${aiAccepted} AI-qualified · ${acceptedSearch} accepted from search · ${domainSignals} accepted from direct domain scans · ${rejected} rejected as generic/low-signal${zeroSignalAccounts ? `<br><strong>No signal found for:</strong> ${zeroSignalAccounts}` : ''}${sampleRows}`;
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
    window.researchDiagnostics = window.researchDiagnostics || [];
    const diag = data.diagnostics || {};
    const existingDiagIndex = window.researchDiagnostics.findIndex(d => d.accountName === account.name);
    const nextDiag = {
      accountName: account.name,
      signalsFound: account.signals.length,
      searchResultsFound: diag.searchResultsFound || 0,
      acceptedSearchSignals: diag.acceptedSearchSignals || 0,
      domainSignalsFound: diag.domainSignalsFound || 0,
      rejectedResults: diag.rejectedResults || 0,
      queriesRun: diag.queriesRun || 0,
      domainProbes: diag.domainProbes || 0,
      domainUsed: diag.domainUsed || '',
      candidateSamples: diag.candidateSamples || [],
      aiEnabled: diag.aiEnabled,
      aiRawSignals: diag.aiRawSignals || 0,
      aiAcceptedSignals: diag.aiAcceptedSignals || 0,
      aiError: diag.aiError || ''
    };
    if(existingDiagIndex >= 0) window.researchDiagnostics[existingDiagIndex] = nextDiag;
    else window.researchDiagnostics.push(nextDiag);
    addSignalDerivedOpportunities(account, account.signals);
    if(panel) panel.innerHTML = renderVerifiedSignals(account.signals);
    refreshOpportunityViews();
  }catch(err){
    if(panel) panel.innerHTML = `<div class="no-signals-message">Research failed: ${escapeHtml(err.message)}. This account was not updated.</div>`;
  }
}

let researchInProgress = false;
let autoResearchStarted = false;

async function researchTopAccounts(options = {}){
  if(researchInProgress) return;
  researchInProgress = true;
  const btn = document.getElementById('researchTopBtn');
  const auto = options && options.auto;
  if(btn){ btn.disabled = true; btn.textContent = auto ? 'Scanning Top Accounts...' : 'Researching...'; }
  window.researchDiagnostics = [];
  renderResearchDiagnostics();
  const accounts = (window.accountRadarAccounts || []).slice(0, 10);
  for(const account of accounts){
    await researchAccountByName(account.name);
  }
  if(btn){ btn.disabled = false; btn.textContent = 'Research Top Accounts'; }
  researchInProgress = false;
}

function autoResearchTopAccountsOnce(){
  if(autoResearchStarted) return;
  const accounts = window.accountRadarAccounts || [];
  if(!accounts.length) return;
  autoResearchStarted = true;
  setTimeout(() => researchTopAccounts({auto:true}), 500);
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
  const futureOpportunities = sortDailyReasons(accounts.flatMap(account => account.futureOpportunities || []));
  const displayedOpportunities = prepareDailyReasons(futureOpportunities, 20);
  const grid = document.getElementById('opportunitiesGrid');
  const resultCount = document.getElementById('resultCount');
  if(resultCount) resultCount.innerHTML = `<span>Showing top ${displayedOpportunities.length} of ${futureOpportunities.length} reasons to reach out from ${accounts.length} accounts · ${feedSummary(displayedOpportunities)}</span>`;
  if(grid){
    grid.innerHTML = `<div class="limit-note">Today's Best Reasons To Reach Out ranks by actionability, freshness, and confidence — not projected revenue.</div>` + displayedOpportunities.map((opp) => renderRepOpportunityCard(opp)).join('');
  }
  const highConfidenceAccounts = new Set(futureOpportunities.filter(o => o.confidence >= 70).map(o => o.account));
  document.getElementById('totalOppValue').textContent = futureOpportunities.length;
  document.getElementById('highConfidenceCount').textContent = highConfidenceAccounts.size;
  document.getElementById('avgConfidence').textContent = Math.round(futureOpportunities.reduce((sum, o) => sum + o.confidence, 0) / Math.max(futureOpportunities.length, 1)) + '%';
  renderResearchDiagnostics();
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
  const followUpBoost = Number(account.subscores?.recency || 0) >= 0.55 ? 8 : 0;
  return clampScore(
    closeProbability * 0.45 +
    relationship * 0.30 +
    revenuePotential * 0.15 +
    signal * 0.10 +
    followUpBoost
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
  const signalLayerType = signalBased ? 'Business Activity Signal' : (Number(account.subscores?.recency || 0) >= 0.55 ? 'Follow-Up Signal' : 'Repeat / Pattern Signal');
  const reasonToReachOut = signalLayerType === 'Follow-Up Signal'
    ? 'Recent order delivered or completed'
    : 'Repeat or seasonal buying pattern';
  const conversationStarter = signalLayerType === 'Follow-Up Signal'
    ? 'Check in and ask how the recent order was received.'
    : 'Ask whether a similar program, order, or event is happening again.';

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
    signalLayerType,
    signalDate: account.mostRecentDate !== 'Unknown' ? account.mostRecentDate : '',
    reasonToReachOut,
    conversationStarter,
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


function monthNameFromDate(d){
  if(!d || isNaN(d.getTime())) return '';
  return d.toLocaleString('en-US', { month: 'long' });
}

function categoryProgramLabel(category){
  const c = String(category || 'Program').replace(/\s*\/\s*/g, ' / ');
  if(c === 'Event / Giveaway') return 'Event / Giveaway Program';
  if(c === 'Recognition / Awards') return 'Recognition / Awards Program';
  if(c === 'Onboarding / Recruiting') return 'Onboarding / Recruiting Program';
  if(c === 'Print / Stationery') return 'Print / Stationery Program';
  return `${c} Program`;
}

function averageRevenue(records){
  const values = (records || []).map(r => Number(r.revenue || 0)).filter(v => v > 0);
  if(!values.length) return 0;
  return values.reduce((a,b)=>a+b,0) / values.length;
}

function findRepeatPatternGroups(account){
  const orders = (account.purchases || []).filter(o => o && o.date && o.category && o.category !== 'Uncategorized');
  if(orders.length < 2) return [];
  const now = new Date();
  const thisMonth = now.getMonth();
  const groups = new Map();
  orders.forEach(o => {
    const key = o.category;
    if(!groups.has(key)) groups.set(key, []);
    groups.get(key).push(o);
  });

  const patterns = [];
  groups.forEach((catOrders, category) => {
    if(catOrders.length < 2) return;
    const years = new Set(catOrders.map(o => o.date.getFullYear()));
    const monthCounts = new Map();
    catOrders.forEach(o => monthCounts.set(o.date.getMonth(), (monthCounts.get(o.date.getMonth()) || 0) + 1));
    const strongestMonth = [...monthCounts.entries()].sort((a,b)=>b[1]-a[1])[0];
    const hasMultiYear = years.size >= 2;
    const hasSeasonalMonth = strongestMonth && strongestMonth[1] >= 2;
    const hasCurrentSeasonActivity = catOrders.some(o => Math.abs(o.date.getMonth() - thisMonth) <= 1 || Math.abs(o.date.getMonth() - thisMonth) >= 11);
    const hasEnoughVolume = catOrders.length >= 3;

    if(!(hasMultiYear || hasSeasonalMonth || hasEnoughVolume)) return;

    const sorted = [...catOrders].sort((a,b)=>b.date-a.date);
    const last = sorted[0];
    const monthLabel = strongestMonth ? new Date(2026, strongestMonth[0], 1).toLocaleString('en-US', {month:'long'}) : monthNameFromDate(last.date);
    const avg = averageRevenue(catOrders);
    const confidence = (hasMultiYear && hasSeasonalMonth) ? 82 : hasMultiYear ? 74 : 64;
    patterns.push({
      category,
      orders: catOrders,
      orderCount: catOrders.length,
      years: [...years].sort(),
      monthLabel,
      lastDate: last.date,
      lastDateStr: last.dateStr,
      avgRevenue: avg,
      confidence,
      hasCurrentSeasonActivity
    });
  });
  return patterns.sort((a,b)=>b.confidence-a.confidence || b.orderCount-a.orderCount || b.avgRevenue-a.avgRevenue).slice(0, 3);
}

function createRepeatPatternOpportunities(account){
  const patterns = findRepeatPatternGroups(account);
  return patterns.map(pattern => {
    const program = categoryProgramLabel(pattern.category);
    const contactTitle = pattern.category.includes('Event') ? 'Marketing Manager / Events Lead'
      : pattern.category.includes('Onboarding') ? 'HR Manager'
      : pattern.category.includes('Safety') ? 'Safety Manager / HR Manager'
      : pattern.category.includes('Client') ? 'Marketing Manager / Client Experience Lead'
      : 'Marketing Manager / HR Manager';
    const products = categoryToPromoSuggestions(pattern.category);
    const opp = createOpportunity(
      account,
      program,
      contactTitle,
      products,
      [pattern.category],
      pattern.confidence,
      false
    );
    const valueBasis = pattern.avgRevenue > 0 ? pattern.avgRevenue : Math.max(1500, (account.revenue || 0) / Math.max(account.orderCount || 1, 1));
    opp.estimatedValue = Math.round(valueBasis * 1.15);
    opp.signalLayerType = 'Repeat / Pattern Signal';
    opp.opportunityType = 'REPEAT PATTERN';
    opp.reasonToReachOut = `${program} may be coming up again`;
    opp.whyNow = `${account.name} has ordered ${pattern.category.toLowerCase()} ${pattern.orderCount} times${pattern.years.length > 1 ? ` across ${pattern.years.length} years` : ''}${pattern.monthLabel ? `, with activity around ${pattern.monthLabel}` : ''}.`;
    opp.conversationStarter = `Ask if the ${pattern.category.toLowerCase()} program is happening again this year.`;
    opp.signalDate = pattern.lastDate ? pattern.lastDate.toISOString() : '';
    opp.confidence = Math.max(opp.confidence || 0, pattern.confidence);
    opp.quickWinScore = Math.max(opp.quickWinScore || 0, pattern.confidence);
    opp.closeProbability = Math.max(opp.closeProbability || 0, pattern.confidence - 5);
    opp.evidence = [
      `${pattern.orderCount} ${pattern.category.toLowerCase()} orders found`,
      pattern.years.length > 1 ? `Purchase history spans ${pattern.years.join(', ')}` : `Repeated purchase pattern detected`,
      pattern.monthLabel ? `Most common timing: ${pattern.monthLabel}` : `Recent similar order: ${pattern.lastDateStr || 'recent history'}`
    ].filter(Boolean).slice(0,3);
    opp.commonPromoCategories = products;
    opp.likelyConversations = signal.likelyConversations || products;
    return opp;
  });
}

function categoryToPromoSuggestions(category){
  const c = String(category || '').toLowerCase();
  if(c.includes('apparel')) return ['apparel refresh', 'team shirts', 'outerwear', 'uniforms'];
  if(c.includes('headwear')) return ['caps', 'beanies', 'seasonal headwear', 'employee hats'];
  if(c.includes('event') || c.includes('trade')) return ['booth giveaways', 'staff apparel', 'attendee gifts', 'signage'];
  if(c.includes('recognition') || c.includes('award')) return ['recognition gifts', 'milestone awards', 'team incentives', 'drinkware'];
  if(c.includes('onboarding') || c.includes('recruiting')) return ['welcome kits', 'new hire apparel', 'recruiting giveaways', 'drinkware'];
  if(c.includes('safety')) return ['hi-vis apparel', 'safety awards', 'PPE-friendly gear', 'team incentives'];
  if(c.includes('drinkware')) return ['tumblers', 'bottles', 'mugs', 'drinkware sets'];
  if(c.includes('client')) return ['client gifts', 'premium gifts', 'thank-you items', 'event gifts'];
  if(c.includes('wellness')) return ['wellness kits', 'employee gifts', 'drinkware', 'challenge rewards'];
  return ['apparel', 'giveaways', 'recognition gifts', 'event kits'];
}

function generateFutureOpportunities(account){
  const cats = account.categoryTypes || new Set();
  const industry = account.industry;
  const opps = createRepeatPatternOpportunities(account);

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

function cleanSalesPlayText(value){
  return String(value || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function pickPrimaryPromoCategory(opp){
  const candidates = []
    .concat(Array.isArray(opp.commonPromoCategories) ? opp.commonPromoCategories : [])
    .concat(Array.isArray(opp.suggestedProducts) ? opp.suggestedProducts : [])
    .concat(Array.isArray(opp.productCategories) ? opp.productCategories : [])
    .concat(opp.category || opp.primaryCategory || opp.opportunity || '');
  const text = candidates.filter(Boolean).join(' ').toLowerCase();
  if(/hiring|onboard|welcome|recruit/.test(text)) return 'onboarding';
  if(/event|conference|trade show|expo|booth|campaign/.test(text)) return 'event';
  if(/recognition|award|gift|appreciation|milestone/.test(text)) return 'recognition';
  if(/apparel|shirt|uniform|hat|headwear|outerwear/.test(text)) return 'apparel';
  if(/print|stationery|notebook|signage/.test(text)) return 'print';
  return cleanSalesPlayText(candidates.find(Boolean) || 'promo');
}

function trimToWords(text, maxWords){
  const words = String(text || '').trim().split(/\s+/).filter(Boolean);
  if(words.length <= maxWords) return String(text || '').trim();
  return words.slice(0, maxWords).join(' ').replace(/[,.!?;:]+$/, '') + '...';
}

// Sales Play Generator - concise rep coaching card, reply-first promo outreach
window.createSalesPlayPanel = function(opp){
  const account = cleanSalesPlayText(opp.account || 'this account');
  const contactName = cleanSalesPlayText(opp.contactName || opp.contact || '');
  const firstName = contactName && !contactName.includes('/') ? contactName.split(' ')[0] : 'there';
  const mode = salesPlayModeFromOpp(opp);
  const reasonTitle = cleanSalesPlayText(getReasonToReachOutTitle(opp));
  const whyNow = cleanSalesPlayText(getRepFriendlyWhy(opp));
  const relationshipStrength = Math.round(Number(opp.relationshipStrength || 0));
  const sourceLabel = opp.sourceUrl ? 'verified public signal' : 'account history';
  const category = pickPrimaryPromoCategory(opp);
  const signalType = inferSalesPlaySignalType(opp, reasonTitle, whyNow, category);

  const play = buildConciseSalesPlay({
    account,
    firstName,
    mode,
    reasonTitle,
    whyNow,
    relationshipStrength,
    sourceLabel,
    category,
    signalType
  });

  const allText = formatSalesPlayClipboard(play, account, reasonTitle, mode);
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
          <div class="sales-play-grid">
            <div class="sales-play-section">
              <div class="sales-play-card">
                <h3><span class="section-icon">◎</span> Opportunity Summary</h3>
                <div class="section-content"><ul class="sales-play-list">${play.opportunitySummary.map(item=>`<li>${escapeHtml(item)}</li>`).join('')}</ul></div>
              </div>
            </div>
            <div class="sales-play-section">
              <div class="sales-play-card emphasis">
                <h3><span class="section-icon">☆</span> Best Next Move</h3>
                <div class="section-content">${escapeHtml(play.bestNextMove)}</div>
              </div>
            </div>
            <div class="sales-play-section full">
              <div class="sales-play-card subject-row">
                <h3 style="margin:0;"><span class="section-icon">✉</span> Email Subject</h3>
                <div class="subject-line">${escapeHtml(play.emailSubject)}</div>
                <button class="copy-mini" onclick="copySalesPlayField(this, ${JSON.stringify(play.emailSubject)})">Copy Subject</button>
              </div>
            </div>
            <div class="sales-play-section full">
              <div class="sales-play-card">
                <h3><span class="section-icon">✉</span> Copy & Paste Email</h3>
                <div class="sales-play-email-layout">
                  <div class="section-content sales-play-email-body">${escapeHtml(play.outreachEmail)}</div>
                  <div class="why-subject"><strong>Why this subject?</strong>${escapeHtml(play.subjectRationale)}</div>
                </div>
                <div style="margin-top:14px; text-align:right;"><button class="copy-mini" onclick="copySalesPlayField(this, ${JSON.stringify(play.outreachEmail)})">Copy Email</button></div>
              </div>
            </div>
            <div class="sales-play-section">
              <div class="sales-play-card">
                <h3><span class="section-icon">☎</span> Call Script</h3>
                <div class="section-content call-script-lines">${play.callScript.map(line=>`<div>${escapeHtml(line).replace(/&lt;strong&gt;/g, '<strong>').replace(/&lt;\/strong&gt;/g, '</strong>')}</div>`).join('')}</div>
              </div>
            </div>
            <div class="sales-play-section">
              <div class="sales-play-card">
                <h3><span class="section-icon">?</span> Questions to Ask</h3>
                <div class="section-content"><ul class="sales-play-list check-list">${play.questionsToAsk.map(q=>`<li>${escapeHtml(q)}</li>`).join('')}</ul></div>
              </div>
            </div>
            <div class="sales-play-section full">
              <div class="sales-play-card">
                <h3><span class="section-icon">⚑</span> Success Looks Like</h3>
                <div class="section-content"><ul class="sales-play-list check-list success-list">${play.successLooksLike.map(item=>`<li>${escapeHtml(item)}</li>`).join('')}</ul></div>
              </div>
            </div>
            <div class="sales-play-section full">
              <div class="sales-play-card coaching-card">
                <h3><span class="section-icon">♢</span> Coaching Note</h3>
                <div class="coaching-content">
                  <div class="section-content">${escapeHtml(play.coachingNote)}</div>
                  <button class="copy-mini" onclick="copySalesPlayField(this, ${JSON.stringify(allText)})">Copy All</button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>`;
  document.body.insertAdjacentHTML('beforeend', html);
}

function buildConciseSalesPlay(ctx){
  const isWarm = ctx.mode === 'Warm';
  const isHiring = ctx.signalType === 'hiring';
  const ownerPhrase = ownerPhraseForSignal(ctx);
  const triggerPhrase = triggerPhraseForSignal(ctx);

  const opportunitySummary = [
    `${triggerPhrase} creates a timely reason to reach out.`,
    isWarm ? 'Existing relationship can be used as a bridge.' : 'A specific business reason keeps this from feeling like a cold pitch.',
    'Goal is to earn a reply or referral before selling.'
  ];

  const bestNextMove = isWarm
    ? `Call or email ${ctx.firstName}. Mention ${triggerPhrase.toLowerCase()}. Ask who owns ${ownerPhrase}. Offer to send a few simple ideas if relevant.`
    : `Lead with ${triggerPhrase.toLowerCase()}. Ask for the person responsible for ${ownerPhrase}. Keep the ask small and referral-focused.`;

  const emailSubject = conciseSubject(ctx);
  const outreachEmail = trimToWords(buildReplyFirstEmail(ctx), 120);
  const callScript = buildNaturalCallScript(ctx);
  const questionsToAsk = questionsForSignal(ctx).slice(0, 3);
  const successLooksLike = ['Referral to the right person', 'Permission to send ideas', 'Meeting booked'];
  const coachingNote = isWarm
    ? 'You already have a relationship in the account. This approach asks for direction instead of business, which lowers resistance.'
    : 'Do not lead with product ideas yet. Use the signal to find the right person, then ask permission to follow up.';

  return {
    opportunitySummary,
    bestNextMove,
    emailSubject,
    subjectRationale: subjectRationale(ctx, emailSubject),
    outreachEmail,
    callScript,
    questionsToAsk,
    successLooksLike,
    coachingNote
  };
}

function buildReplyFirstEmail(ctx){
  const ownerPhrase = ownerPhraseForSignal(ctx);
  const trigger = triggerPhraseForSignal(ctx);

  if(ctx.mode === 'Warm'){
    return `Hey ${ctx.firstName},\n\nSaw ${trigger.toLowerCase()} at ${ctx.account} and thought of you.\n\nQuick question — does your team handle ${ownerPhrase}, or does that sit with someone else internally?\n\nIf there is a better person to ask, would you be open to pointing me in the right direction?\n\nIf helpful, I can send over a few simple ideas.\n\nBest,\n[Rep Name]`;
  }
  if(ctx.mode === 'Lukewarm'){
    return `Hey ${ctx.firstName},\n\nIt has been a bit, but ${trigger.toLowerCase()} felt like a relevant reason to reconnect.\n\nDo you know who usually owns ${ownerPhrase} at ${ctx.account}?\n\nI am not trying to force a pitch — just trying to see whether there is a useful conversation to have.\n\nHappy to send a few simple ideas if helpful.\n\nBest,\n[Rep Name]`;
  }
  return `Hi ${ctx.firstName},\n\nSaw ${trigger.toLowerCase()} at ${ctx.account}.\n\nDo you know who would be the best person to ask about ${ownerPhrase}?\n\nI work on branded merchandise programs and thought there may be a timely conversation, but I want to start with the right person.\n\nWould you be open to pointing me in the right direction?\n\nBest,\n[Rep Name]`;
}

function buildNaturalCallScript(ctx){
  const ownerPhrase = ownerPhraseForSignal(ctx);
  const trigger = triggerPhraseForSignal(ctx).toLowerCase();
  return [
    `<strong>Open:</strong> “Hey ${ctx.firstName}, quick question based on ${trigger}.”`,
    `<strong>Reason:</strong> “I wanted to understand whether ${ownerPhrase} is handled by your team or someone else.”`,
    `<strong>Ask:</strong> “Are you the best person to ask, or is there someone else I should connect with?”`
  ];
}

function questionsForSignal(ctx){
  const ownerPhrase = ownerPhraseForSignal(ctx);
  if(ctx.signalType === 'hiring'){
    return [
      'Who owns onboarding or recruiting merch?',
      'Is that handled centrally or by different teams?',
      'Would a few simple ideas be helpful right now?'
    ];
  }
  if(ctx.signalType === 'event'){
    return [
      'Who is responsible for event merch or attendee giveaways?',
      'What timing should vendors know about?',
      'Would it help to see a few simple ideas before planning gets too far along?'
    ];
  }
  if(ctx.signalType === 'expansion'){
    return [
      'Who coordinates branded materials for new locations or teams?',
      'Is there a launch date or internal milestone to support?',
      'Would a short idea list be useful for the planning team?'
    ];
  }
  return [
    `Who usually owns ${ownerPhrase}?`,
    'Is that handled by one team or different departments?',
    'Would a few simple ideas be helpful right now?'
  ];
}

function conciseSubject(ctx){
  if(ctx.signalType === 'hiring') return ctx.mode === 'Warm' ? `Hiring at ${ctx.account}?` : 'Quick question on onboarding';
  if(ctx.signalType === 'event') return ctx.reasonTitle && ctx.reasonTitle.length < 35 ? `Question about ${ctx.reasonTitle}` : 'Question about the event';
  if(ctx.signalType === 'expansion') return 'Saw the expansion';
  if(ctx.signalType === 'repeat') return ctx.mode === 'Warm' ? 'Thinking of you' : 'Quick follow-up';
  return ctx.mode === 'Warm' ? 'Thinking of you' : `Question for ${ctx.account}`;
}

function subjectRationale(ctx, subject){
  if(ctx.signalType === 'hiring') return 'It references a recent hiring trigger and opens the door to a quick conversation without pitching.';
  if(ctx.signalType === 'event') return 'It ties the note to timing and gives the recipient a clear reason to open it.';
  if(ctx.signalType === 'expansion') return 'It uses the business news as context while keeping the ask simple.';
  if(ctx.signalType === 'repeat') return 'It feels personal and works well when the account has prior order history.';
  return 'It is specific enough to avoid sounding like a generic account check-in.';
}

function ownerPhraseForSignal(ctx){
  if(ctx.signalType === 'hiring') return 'onboarding or recruiting merch';
  if(ctx.signalType === 'event') return 'event merch or giveaways';
  if(ctx.signalType === 'expansion') return 'launch materials or team gear';
  if(ctx.signalType === 'repeat') return 'repeat orders or upcoming merch needs';
  return ctx.category || 'branded merch';
}

function triggerPhraseForSignal(ctx){
  if(ctx.signalType === 'hiring') return 'recent hiring activity';
  if(ctx.signalType === 'event') return 'an upcoming event or campaign';
  if(ctx.signalType === 'expansion') return 'recent expansion news';
  if(ctx.signalType === 'repeat') return 'past ordering activity';
  if(ctx.whyNow) return ctx.whyNow.replace(/[.]+$/,'');
  return 'a timely account signal';
}

function inferSalesPlaySignalType(opp, reasonTitle, whyNow, category){
  const text = [reasonTitle, whyNow, category, opp.opportunityName, opp.opportunity, opp.signalType, opp.signalTitle, opp.evidence].join(' ').toLowerCase();
  if(/hiring|career|jobs|recruit|new hire|onboard/.test(text)) return 'hiring';
  if(/event|conference|trade show|expo|campaign|booth/.test(text)) return 'event';
  if(/expansion|opening|opened|new location|facility|branch/.test(text)) return 'expansion';
  if(/repeat|reorder|historical|past order|last year|annual/.test(text)) return 'repeat';
  return 'general';
}

function formatSalesPlayClipboard(play, account, reasonTitle, mode){
  return [
    `SALES PLAY: ${account} · ${reasonTitle} · ${mode} Play`,
    '',
    'OPPORTUNITY SUMMARY',
    ...play.opportunitySummary.map(item => `- ${item}`),
    '',
    'BEST NEXT MOVE',
    play.bestNextMove,
    '',
    'EMAIL SUBJECT',
    play.emailSubject,
    '',
    'COPY & PASTE EMAIL',
    play.outreachEmail,
    '',
    'CALL SCRIPT',
    ...play.callScript.map(line => line.replace(/<[^>]+>/g, '')),
    '',
    'QUESTIONS TO ASK',
    ...play.questionsToAsk.map(item => `- ${item}`),
    '',
    'SUCCESS LOOKS LIKE',
    ...play.successLooksLike.map(item => `- ${item}`),
    '',
    'COACHING NOTE',
    play.coachingNote
  ].join('\n');
}

window.copySalesPlayField = function(btn, text){
  navigator.clipboard.writeText(text).then(() => {
    const original = btn.textContent;
    btn.textContent = 'Copied!';
    setTimeout(() => btn.textContent = original, 1600);
  }).catch(() => alert('Could not copy to clipboard'));
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


function normalizeSignalLayerType(type){
  const t = String(type || '').toLowerCase();
  if(t.includes('follow')) return 'Follow-Up Signal';
  if(t.includes('repeat') || t.includes('pattern')) return 'Repeat / Pattern Signal';
  if(t.includes('business') || t.includes('web') || t.includes('verified') || t.includes('signal-driven')) return 'Business Activity Signal';
  return 'Business Activity Signal';
}

function signalTypePriority(type){
  const normalized = normalizeSignalLayerType(type);
  if(normalized === 'Follow-Up Signal') return 300;
  if(normalized === 'Repeat / Pattern Signal') return 200;
  return 100;
}

function confidenceRankFromWord(word){
  const w = String(word || '').toLowerCase();
  if(w.includes('high')) return 30;
  if(w.includes('medium')) return 20;
  return 10;
}

function getDailyReasonScore(opp){
  return signalTypePriority(opp.signalLayerType) +
    confidenceRankFromWord(confidenceWord(opp)) +
    Math.min(20, Math.round(Number(opp.closeProbability || opp.quickWinScore || opp.confidence || 0) / 10));
}

function sortDailyReasons(opps){
  return [...(opps || [])].sort((a,b)=>
    getDailyReasonScore(b) - getDailyReasonScore(a) ||
    Number(b.closeProbability || 0) - Number(a.closeProbability || 0) ||
    Number(b.quickWinScore || b.confidence || 0) - Number(a.quickWinScore || a.confidence || 0)
  );
}

function dailyReasonSummary(opp){
  const type = normalizeSignalLayerType(opp.signalLayerType);
  if(type === 'Follow-Up Signal') return 'Recent account activity creates a low-friction reason to check in.';
  if(type === 'Repeat / Pattern Signal') return 'Past buying pattern creates a simple reason to ask if the need is coming up again.';
  return 'Verified public business activity creates a timely reason to reach out.';
}


function followUpCollapseKey(opp){
  const account = String(opp.account || '').toLowerCase().trim();
  const layer = signalLayerLabel(opp);
  if(layer !== 'Follow-Up Signal') return `${account}|${layer}|${String(opp.opportunity || opp.opportunityName || '').toLowerCase()}`;
  return `${account}|Follow-Up Signal`;
}

function collapseDuplicateFollowUps(opps){
  const map = new Map();
  const passthrough = [];
  (opps || []).forEach(opp => {
    if(signalLayerLabel(opp) !== 'Follow-Up Signal'){
      passthrough.push(opp);
      return;
    }
    const key = followUpCollapseKey(opp);
    const existing = map.get(key);
    if(!existing || getDailyReasonScore(opp) > getDailyReasonScore(existing)){
      const merged = {...opp};
      const related = (opps || []).filter(o => followUpCollapseKey(o) === key);
      if(related.length > 1){
        merged.opportunity = 'Recent Project Follow-Up';
        merged.opportunityName = 'Recent Project Follow-Up';
        merged.reasonToReachOut = 'Multiple recent projects completed';
        merged.conversationStarter = 'Check in on how the recent projects were received.';
        merged.evidence = [
          `Multiple recent projects found (${related.length})`,
          ...(Array.isArray(opp.evidence) ? opp.evidence : [])
        ].slice(0,4);
      }
      map.set(key, merged);
    }
  });
  return [...map.values(), ...passthrough];
}

function limitReasonsPerAccount(opps, maxPerAccount=2){
  const counts = new Map();
  const selected = [];
  (opps || []).forEach(opp => {
    const key = String(opp.account || '').toLowerCase().trim();
    const count = counts.get(key) || 0;
    if(count < maxPerAccount){
      selected.push(opp);
      counts.set(key, count + 1);
    }
  });
  return selected;
}

function prepareDailyReasons(opps, limit=20){
  const collapsed = collapseDuplicateFollowUps(opps || []);
  const sorted = limitReasonsPerAccount(sortDailyReasons(collapsed), 2);

  // Keep follow-ups highest priority, but do not let them monopolize the feed.
  // If repeat/pattern or business signals exist, reserve room so reps can scan different kinds of reasons.
  const groups = {
    follow: sorted.filter(o => signalLayerLabel(o) === 'Follow-Up Signal'),
    repeat: sorted.filter(o => signalLayerLabel(o) === 'Repeat / Pattern Signal'),
    business: sorted.filter(o => signalLayerLabel(o) === 'Business Activity Signal')
  };
  const targets = {
    follow: groups.repeat.length || groups.business.length ? Math.min(8, limit) : limit,
    repeat: groups.repeat.length ? 7 : 0,
    business: groups.business.length ? 5 : 0
  };
  const selected = [];
  const used = new Set();
  function take(arr, n){
    for(const opp of arr){
      if(selected.length >= limit || n <= 0) break;
      const key = `${opp.account}|${opp.opportunity}|${opp.signalLayerType}|${opp.signalDate || ''}`;
      if(used.has(key)) continue;
      selected.push(opp);
      used.add(key);
      n--;
    }
  }
  take(groups.follow, targets.follow);
  take(groups.repeat, targets.repeat);
  take(groups.business, targets.business);
  take(sorted, limit - selected.length);
  return selected.slice(0, limit);
}

function feedSummary(opps){
  const items = opps || [];
  const follow = items.filter(o => signalLayerLabel(o) === 'Follow-Up Signal').length;
  const repeat = items.filter(o => signalLayerLabel(o) === 'Repeat / Pattern Signal').length;
  const business = items.filter(o => signalLayerLabel(o) === 'Business Activity Signal').length;
  return `${follow} follow-up · ${repeat} repeat/pattern · ${business} business activity`;
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
  const futureOpportunities = sortDailyReasons(accounts.flatMap(account => account.futureOpportunities || []));
  const displayedOpportunities = prepareDailyReasons(futureOpportunities, 20);

  // Render opportunities grid
  const grid = document.getElementById('opportunitiesGrid');
  const resultCount = document.getElementById('resultCount');
  const accountListOnlyCount = accounts.filter(a => a.orderCount === 0 && a.activePipelineCount === 0).length;
  resultCount.innerHTML = `<span>Showing top ${displayedOpportunities.length} of ${futureOpportunities.length} reasons to reach out from ${accounts.length} accounts · ${feedSummary(displayedOpportunities)}${accountListOnlyCount ? ` · ${accountListOnlyCount} account-list-only records` : ''}</span>`;

  const noOpportunitiesMessage = displayedOpportunities.length === 0 ? `<div class="no-signals-message">No order-history-based reasons to reach out found yet. Use <strong>Research Top Accounts</strong> to scan public sources for verified signals.</div>` : '';
  grid.innerHTML = `<div class="limit-note">Today's Best Reasons To Reach Out ranks by actionability: follow-ups first, repeat patterns second, and verified business activity third. Maximum 2 reasons per account so the feed stays scannable.</div>` + noOpportunitiesMessage + displayedOpportunities.map((opp) => renderRepOpportunityCard(opp)).join('');

  const closedHistoricalRevenue = accounts.reduce((sum, a) => sum + (a.revenue || 0), 0);
  const activePipelineTotal = accounts.reduce((sum, a) => sum + (a.activePipelineValue || 0), 0);
  const highConfidenceAccounts = new Set(futureOpportunities.filter(o => o.confidence >= 70).map(o => o.account));

  document.getElementById('totalAccounts').textContent = accounts.length;
  document.getElementById('totalOppValue').textContent = futureOpportunities.length;
  document.getElementById('highConfidenceCount').textContent = highConfidenceAccounts.size;
  document.getElementById('avgConfidence').textContent = Math.round(futureOpportunities.reduce((sum, o) => sum + o.confidence, 0) / Math.max(futureOpportunities.length, 1)) + '%';
  renderResearchDiagnostics();

  const notice = document.getElementById('notice');
  if(notice){
    const noticeMessages = [];
    const clientMapping = records.columnMappings && records.columnMappings.client_name;
    if(clientMapping && clientMapping.normalized !== 'client_name'){
      noticeMessages.push(`Detected company/account column: <strong>${escapeHtml(clientMapping.detected)}</strong> → <strong>client_name</strong>.`);
    }
    if(activePipelineTotal > 0){
      noticeMessages.push(`Active pipeline detected: ${fmtMoney(activePipelineTotal)} in open estimates was excluded from historical revenue and reasons-to-reach-out scoring.`);
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
  autoResearchTopAccountsOnce();
  const exampleOpportunity = document.getElementById('exampleOpportunity');
  if(exampleOpportunity) exampleOpportunity.style.display = 'none';

  lastAnalysisSummary = {
    accountCount: accounts.length,
    closedHistoricalRevenue,
    activePipelineTotal,
    futureOpportunityCount: futureOpportunities.length,
    reasonsToReachOut: futureOpportunities.length
  };
}

function escapeHtml(text){
  const map = {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'};
  return String(text || '').replace(/[&<>"']/g, m => map[m]);
}
