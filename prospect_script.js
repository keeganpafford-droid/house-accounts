
function escapeHtml(v){return String(v??'').replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));}
function clean(v){return String(v||'').trim();}
function sourceDomain(url=''){try{return new URL(url).hostname.replace(/^www\./,'')}catch{return ''}}
function getSavedLead(){try{return JSON.parse(localStorage.getItem('houseAccountsLead')||'null')}catch{return null}}
function saveLead(lead){try{localStorage.setItem('houseAccountsLead',JSON.stringify(lead))}catch{}}
function find(headers, names){for(const n of names){const i=headers.indexOf(n);if(i>=0)return i}return -1}
function normalizeCompanyName(name){return clean(name).toLowerCase().replace(/\b(incorporated|inc|llc|ltd|limited|corp|corporation|co|company)\b\.?/g,'').replace(/[^a-z0-9]+/g,' ').trim()}
function firstNonEmpty(...vals){return vals.map(clean).find(Boolean)||''}
function parseCSV(text){
  text=String(text||'').replace(/\r\n/g,'\n').replace(/\r/g,'\n');
  const rows=[];let row=[],field='',q=false;
  for(let i=0;i<text.length;i++){const c=text[i];if(q){if(c==='"'){if(text[i+1]==='"'){field+='"';i++}else q=false}else field+=c}else{if(c==='"')q=true;else if(c===','){row.push(field);field=''}else if(c==='\n'){row.push(field);rows.push(row);row=[];field=''}else field+=c}}
  if(field.length||row.length){row.push(field);rows.push(row)}
  const filtered=rows.filter(r=>r.some(c=>clean(c))); if(filtered.length<2) throw new Error('No data rows found.');
  const norm=h=>clean(h).toLowerCase().replace(/[^a-z0-9]+/g,'_').replace(/^_+|_+$/g,'');
  const headers=filtered[0].map(norm);
  const idx={
    name: find(headers,['company_name','company','account_name','account','customer_name','customer','client_name','client','organization','business_name','company']),
    website: find(headers,['website','url','domain','company_website','web_site']),
    industry: find(headers,['industry','vertical','market','sector']),
    location: find(headers,['location','city_state','city','state','region','headquarters','hq_location']),
    contactName: find(headers,['contact_name','contact','contact_full_name','full_name','person_name','name']),
    contactTitle: find(headers,['contact_title','title','job_title','role','position']),
    contactEmail: find(headers,['contact_email','email','email_address','work_email']),
    contactLinkedin: find(headers,['linkedin','linkedin_url','linked_in','contact_linkedin'])
  };
  if(idx.name<0) throw new Error('Could not identify a Company Name column.');
  const companies=new Map();
  filtered.slice(1).forEach(r=>{
    const companyName=clean(r[idx.name]); if(!companyName)return;
    const key=normalizeCompanyName(companyName)||companyName.toLowerCase();
    const rawData=Object.fromEntries(headers.map((h,i)=>[h,r[i]||'']));
    if(!companies.has(key)) companies.set(key,{name:companyName,companyName,website:'',industry:'',location:'',contacts:[],rawRows:[],rawData:{}});
    const company=companies.get(key);
    company.name=company.companyName=company.companyName||companyName;
    company.website=firstNonEmpty(company.website, idx.website>=0?r[idx.website]:'');
    company.industry=firstNonEmpty(company.industry, idx.industry>=0?r[idx.industry]:'');
    company.location=firstNonEmpty(company.location, idx.location>=0?r[idx.location]:'');
    company.rawRows.push(rawData);
    company.rawData=company.rawData||rawData;
    const contact={
      name: idx.contactName>=0 ? clean(r[idx.contactName]) : '',
      title: idx.contactTitle>=0 ? clean(r[idx.contactTitle]) : '',
      email: idx.contactEmail>=0 ? clean(r[idx.contactEmail]) : '',
      linkedin: idx.contactLinkedin>=0 ? clean(r[idx.contactLinkedin]) : ''
    };
    if(contact.name||contact.email){
      const contactKey=`${contact.name}|${contact.email}|${contact.title}`.toLowerCase();
      if(!company.contacts.some(c=>`${c.name}|${c.email}|${c.title}`.toLowerCase()===contactKey)) company.contacts.push(contact);
    }
  });
  return [...companies.values()].slice(0,50);
}
function signalHeadline(sig){
  const specific=clean(sig.concrete_trigger||sig.concreteTrigger||sig.signalTitle||sig.title||sig.whatChanged||sig.shortSummary||sig.signalDetail);
  if(specific && !/^business activity signal$/i.test(specific)) return specific;
  const t=`${sig.signalType||''} ${sig.title||''} ${sig.whatChanged||''} ${sig.whyNow||''}`.toLowerCase();
  if(/hiring|recruit|onboarding/.test(t)) return 'Hiring activity creates a timely opening';
  if(/event|conference|expo|trade show|sponsor/.test(t)) return 'Event activity creates a relevant reason to reach out';
  if(/expansion|new office|facility|growth|contract/.test(t)) return 'Specific growth activity creates a prospecting trigger';
  if(/funding|acquisition|investment|merger/.test(t)) return 'Business change creates a natural conversation';
  if(/award|recognition|milestone/.test(t)) return 'Recognition creates a timely reason to connect';
  return 'Recent business activity creates a reason to reach out';
}
function renderContact(c){
  const details=[c.title, c.email, c.linkedin].filter(Boolean).map(escapeHtml).join(' · ');
  return `<p><strong>${escapeHtml(c.name)}</strong>${details?` — ${details}`:''}</p>`;
}
function getScore(sig){return Math.round(Number(sig.confidenceScore||sig.why_now_score||sig.confidence*100||75))}
function isFallback(sig){return !!(sig.isFallbackOpportunity||/predictable timing/i.test(`${sig.signalType||''} ${sig.signal_type||''} ${sig.type||''} ${sig.concrete_trigger||sig.concreteTrigger||''}`))}
function getPriority(sig){const score=getScore(sig); if(score>=80)return 'High'; if(score>=60)return 'Medium'; return 'Lower'}
function signalDateMs(sig){const raw=clean(sig.publishedDate||sig.publicationDate||sig.eventDate||sig.event_date||sig.date||''); const ms=Date.parse(raw); return Number.isFinite(ms)?ms:0}
function recencyScore(sig){const ms=signalDateMs(sig); if(!ms)return 25; const days=(Date.now()-ms)/86400000; if(days<=45)return 100; if(days<=90)return 85; if(days<=180)return 65; if(days<=365)return 45; return 15}
function typeBoost(sig){const text=`${sig.signalType||sig.signal_type||sig.type||''} ${sig.buyingMoment||sig.buying_moment||''} ${sig.concreteTrigger||sig.concrete_trigger||''} ${sig.title||''}`.toLowerCase(); if(/expansion|facility|opening|new location|ribbon cutting|distribution center/.test(text))return 20; if(/product launch|launch|released|new product|sparkpnt/.test(text))return 18; if(/trade show|conference|expo|event|sponsor/.test(text))return 17; if(/contract|partnership|acquisition|funding|rebrand/.test(text))return 15; if(/hiring|recruit|onboarding/.test(text))return 12; if(/award|recognition|milestone/.test(text))return 9; return 0}
function specificityBoost(sig){const text=`${sig.concreteTrigger||sig.concrete_trigger||''} ${sig.title||''} ${sig.businessContext||sig.business_context||sig.whatChanged||''}`.toLowerCase(); let score=0; if(/\b(20\d{2}|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|q[1-4])\b/.test(text))score+=6; if(/facility|launch|opening|event|conference|contract|hiring|award|sponsor|trade show|product/.test(text))score+=6; if(clean(sig.sourceUrl||sig.source_url))score+=4; if((sig.sources||[]).length>1)score+=3; return score}
function bestSignalScore(sig){if(!sig)return-999999; if(isFallback(sig))return-10000+getScore(sig); return getScore(sig)+(recencyScore(sig)*0.35)+typeBoost(sig)+specificityBoost(sig)}
function compareBestSignals(a,b){const af=isFallback(a)?1:0,bf=isFallback(b)?1:0; if(af!==bf)return af-bf; const delta=bestSignalScore(b)-bestSignalScore(a); if(Math.abs(delta)>0.001)return delta; return getScore(b)-getScore(a)}
function sortSignals(signals){return [...signals].sort((a,b)=>compareBestSignals(a,b)||clean(a.accountName||a.account).localeCompare(clean(b.accountName||b.account)))}
function accountKey(sig){return normalizeCompanyName(sig.accountName||sig.account||sig.company||sig.company_name||sig.companyName||'')}
function selectBestSignalPerCompany(signals){const map=new Map(); for(const sig of sortSignals(signals)){const key=accountKey(sig); if(!key)continue; const existing=map.get(key); if(!existing||compareBestSignals(sig,existing)<0)map.set(key,sig)} return [...map.values()].sort((a,b)=>clean(a.accountName||a.account).localeCompare(clean(b.accountName||b.account))||compareBestSignals(a,b))}
function detailFields(sig){
  const sourceUrl=sig.sourceUrl||sig.source_url||'';
  const source=sourceUrl?`<a target="_blank" href="${escapeHtml(sourceUrl)}">${escapeHtml(sourceDomain(sourceUrl)||'View source')}</a>`:escapeHtml(sig.cleanSourceName||sig.sourceName||sig.source_name||'Public source');
  const trigger=sig.concrete_trigger||sig.concreteTrigger||sig.signalTitle||sig.title||signalHeadline(sig);
  const buyingMoment=sig.buying_moment||sig.buyingMoment||'';
  const businessContext=sig.businessContext||sig.business_context||sig.companyContext||sig.strategicContext||sig.whatChanged||'';
  const why=sig.why_this_matters||sig.whyNow||sig.whyItMattersForPromo||sig.reasonToReachOut||'Recent public business activity creates a timely reason to start a conversation.';
  const buyingTeam=(sig.recommendedBuyingTeam||sig.recommended_buying_team||sig.buyingTeam||sig.likelyBuyers||[]).filter(Boolean).slice(0,4);
  const contacts=(sig.potentialContacts||sig.potential_contacts||[]).filter(c=>c&&c.name).slice(0,3);
  const whyContacts=sig.whyTheseContacts||sig.why_these_contacts||'';
  const cats=(sig.commonPromoCategories||sig.promo_categories||sig.likelyProducts||[]).filter(Boolean).slice(0,6);
  return {source,sourceUrl,trigger,buyingMoment,businessContext,why,buyingTeam,contacts,whyContacts,cats};
}
function renderPreviewCard(sig,idx){
  const d=detailFields(sig);
  const team=d.buyingTeam.slice(0,3);
  const topContact=d.contacts[0];
  const signalType=sig.signalType||sig.signal_type||(isFallback(sig)?'Predictable Timing':'Business Activity');
  const preview=d.businessContext||d.why||'Review this account for a timely prospecting conversation.';
  const company=escapeHtml(sig.accountName||sig.account||'Target Account');
  return `<div class="opp-card compact"><div class="opp-top"><span class="badge">${escapeHtml(signalType)}</span><span class="score">Why Now ${getScore(sig)}</span></div><h3>${company}</h3><div class="headline">${escapeHtml(d.trigger)}</div><p class="preview-text">${escapeHtml(preview)}</p>${team.length?`<div class="chips">${team.map(t=>`<span class="chip">${escapeHtml(t)}</span>`).join('')}</div>`:''}${topContact?`<div class="contact-line"><strong>Top contact:</strong> ${escapeHtml(topContact.name)}${topContact.title?` — ${escapeHtml(topContact.title)}`:''}</div>`:''}<div class="mini-meta"><strong>Evidence:</strong> ${d.source}${sig.publishedDate||sig.event_date?` · ${escapeHtml(sig.publishedDate||sig.event_date)}`:''}</div><button class="card-cta" type="button" data-opp-index="${idx}">View Full Opportunity →</button></div>`;
}
function renderFullOpportunity(sig){
  const d=detailFields(sig);
  const contactsHtml=d.contacts.length?`<div class="section"><div class="label">Potential Contacts</div>${d.contacts.map(renderContact).join('')}</div>`:'';
  const whyContactsHtml=d.contacts.length&&d.whyContacts?`<div class="section"><div class="label">Why These Contacts</div><p>${escapeHtml(d.whyContacts)}</p></div>`:'';
  return `${d.trigger?`<div class="section"><div class="label">Business Trigger</div><p>${escapeHtml(d.trigger)}</p>${d.buyingMoment?`<p style="margin-top:6px;color:#6B7280">${escapeHtml(d.buyingMoment)}</p>`:''}</div>`:''}${d.businessContext?`<div class="section"><div class="label">Business Context</div><p>${escapeHtml(d.businessContext)}</p></div>`:''}<div class="section"><div class="label">Why This Matters</div><p>${escapeHtml(d.why)}</p></div>${d.buyingTeam.length?`<div class="section"><div class="label">Recommended Buying Team</div><div class="chips">${d.buyingTeam.map(t=>`<span class="chip">${escapeHtml(t)}</span>`).join('')}</div></div>`:''}${contactsHtml}${whyContactsHtml}<div class="section"><div class="label">Suggested Opener</div><div class="opener">“${escapeHtml(sig.suggested_opener||sig.suggestedOpener||sig.conversationStarter||'Saw some recent activity and wanted to ask who handles this kind of initiative.')}”</div></div><div class="section"><div class="label">Evidence</div><p class="source">${d.source}${sig.publishedDate||sig.event_date?` · ${escapeHtml(sig.publishedDate||sig.event_date)}`:''}</p></div>${d.cats.length?`<div class="section"><div class="label">Promo Categories</div><div class="chips">${d.cats.map(c=>`<span class="chip">${escapeHtml(c)}</span>`).join('')}</div></div>`:''}`;
}
function openOpportunity(idx){const sig=currentVisibleSignals[idx]; if(!sig)return; document.getElementById('modalTitle').textContent=sig.accountName||sig.account||'Target Account'; document.getElementById('modalBody').innerHTML=renderFullOpportunity(sig); document.getElementById('opportunityModal').classList.add('active'); document.body.classList.add('modal-open');}
function closeOpportunity(){document.getElementById('opportunityModal').classList.remove('active'); document.body.classList.remove('modal-open');}
function renderOpportunityList(){
  const results=document.getElementById('prospectResults');
  const controls=document.getElementById('prospectControls');
  const q=clean(document.getElementById('prospectSearch')?.value).toLowerCase();
  let visible=sortSignals(currentSignals).filter(sig=>{
    const score=getScore(sig); const fallback=isFallback(sig); const company=clean(sig.accountName||sig.account).toLowerCase();
    if(q && !company.includes(q)) return false;
    if(activeFilter==='live') return !fallback;
    if(activeFilter==='fallback') return fallback;
    if(activeFilter==='high') return !fallback && score>=80;
    if(activeFilter==='medium') return !fallback && score>=60 && score<80;
    return true;
  });
  currentVisibleSignals=visible;
  controls.classList.toggle('active', currentSignals.length>0);
  if(visible.length){results.className='cards';results.innerHTML=visible.map((sig,i)=>renderPreviewCard(sig,i)).join('');}
  else{results.className='empty';results.textContent=currentSignals.length?'No opportunities match the current filters.':'No high-confidence business signals found yet. Every uploaded company was researched; no current signals met the threshold.';}
}
function renderResearchSummary(summary){
  const el=document.getElementById('researchSummary');
  const items=[
    ['Companies uploaded',summary.companiesUploaded],
    ['Companies researched',summary.companiesResearched],
    ['Live signals found',summary.liveSignalsFound],
    ['Predictable timing opportunities',summary.predictableTimingOpportunities],
    ['Companies Without Live Signals',summary.companiesWithNoSignals],
    ['High priority',summary.highPriority],
    ['Medium priority',summary.mediumPriority]
  ].filter(([,v])=>v!==undefined&&v!==null&&v!=='');
  if(!items.length){el.className='research-summary';el.innerHTML='';return;}
  el.className='research-summary active';
  el.innerHTML=`<div class="label">Prospect Research Summary</div><div class="summary-grid">${items.map(([label,value])=>`<div class="summary-item"><strong>${escapeHtml(value)}</strong><span>${escapeHtml(label)}</span></div>`).join('')}</div>`;
}
let currentSignals=[]; let currentVisibleSignals=[]; let activeFilter='all';
const dz=document.getElementById('prospectDropzone'), file=document.getElementById('prospectFile'), browse=document.getElementById('prospectBrowse'), err=document.getElementById('prospectError'), notice=document.getElementById('prospectNotice'), progress=document.getElementById('prospectProgress');
const saved=getSavedLead(); if(saved){document.getElementById('prospectName').value=saved.name||'';document.getElementById('prospectEmail').value=saved.email||'';document.getElementById('prospectCompany').value=saved.company||'';}
function showErr(m){err.textContent=m;err.style.display='block'}function clearErr(){err.style.display='none';notice.style.display='none'}function setBusy(b){progress.classList.toggle('active',b);browse.disabled=b;browse.textContent=b?'Researching...':'Choose Target Account CSV'}
browse.addEventListener('click',e=>{e.stopPropagation();file.click()});dz.addEventListener('click',()=>file.click());['dragenter','dragover'].forEach(ev=>dz.addEventListener(ev,e=>{e.preventDefault();dz.classList.add('drag')}));['dragleave','drop'].forEach(ev=>dz.addEventListener(ev,e=>{e.preventDefault();dz.classList.remove('drag')}));dz.addEventListener('drop',e=>{if(e.dataTransfer.files.length)handle(e.dataTransfer.files[0])});file.addEventListener('change',e=>{if(e.target.files.length)handle(e.target.files[0])});
document.getElementById('prospectResults').addEventListener('click',e=>{const btn=e.target.closest('[data-opp-index]'); if(btn) openOpportunity(Number(btn.dataset.oppIndex));});
document.getElementById('modalClose').addEventListener('click',closeOpportunity); document.getElementById('opportunityModal').addEventListener('click',e=>{if(e.target.id==='opportunityModal') closeOpportunity();}); document.addEventListener('keydown',e=>{if(e.key==='Escape') closeOpportunity();});
document.querySelectorAll('.filter-btn').forEach(btn=>btn.addEventListener('click',()=>{document.querySelectorAll('.filter-btn').forEach(b=>b.classList.remove('active')); btn.classList.add('active'); activeFilter=btn.dataset.filter||'all'; renderOpportunityList();}));
document.getElementById('prospectSearch').addEventListener('input',renderOpportunityList);
async function handle(f){
  clearErr(); if(!f.name.toLowerCase().endsWith('.csv')) return showErr('Please choose a CSV file with target company names.');
  const lead={name:clean(document.getElementById('prospectName').value),email:clean(document.getElementById('prospectEmail').value).toLowerCase(),company:clean(document.getElementById('prospectCompany').value)};
  if(!lead.email) return showErr('Enter your work email before researching target accounts.'); saveLead(lead);
  const text=await f.text(); let accounts=[]; try{accounts=parseCSV(text)}catch(e){return showErr(e.message||'Could not read that CSV.')} if(!accounts.length)return showErr('No company names found.');
  currentSignals=[]; currentVisibleSignals=[]; document.getElementById('prospectControls').classList.remove('active'); setBusy(true); document.getElementById('accountCount').textContent=accounts.length; document.getElementById('signalCount').textContent='…'; renderResearchSummary({companiesUploaded:accounts.length,companiesResearched:'…'}); document.getElementById('prospectResults').className='empty'; document.getElementById('prospectResults').textContent='Researching public business signals...';
  try{
    const res=await fetch('/api/research-batch',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({mode:'prospect-intelligence',accounts:accounts.map(a=>({name:a.name,website:a.website,industry:a.industry,location:a.location,contacts:a.contacts}))})});
    const data=await res.json(); if(!res.ok) throw new Error(data.error||'Prospect research failed');
    const signals=selectBestSignalPerCompany(data.signals||[]); currentSignals=signals; document.getElementById('signalCount').textContent=signals.length;
    const byName={}; accounts.forEach(a=>byName[a.name]=[]); signals.forEach(s=>{(byName[s.accountName]||(byName[s.accountName]=[])).push(s)});
    const enriched=accounts.map(a=>({...a,signals:byName[a.name]||[],rawData:{...(a.rawData||{}),uploaded_contacts:a.contacts,raw_rows:a.rawRows}}));
    const liveSignals=signals.filter(s=>!s.isFallbackOpportunity);
    const fallbackSignals=signals.filter(s=>s.isFallbackOpportunity);
    const companiesWithLiveSignals=new Set(liveSignals.map(s=>s.accountName).filter(Boolean)).size;
    const summary={
      accountCount:accounts.length,
      companiesUploaded:accounts.length,
      companiesResearched:data.diagnostics?.accountsResearched ?? accounts.length,
      companiesWithSignals:companiesWithLiveSignals,
      companiesWithNoSignals:Math.max(0,accounts.length-companiesWithLiveSignals),
      businessSignals:liveSignals.length,
      liveSignalsFound:data.diagnostics?.liveSignalsFound ?? liveSignals.length,
      predictableTimingOpportunities:data.diagnostics?.predictableTimingOpportunities ?? fallbackSignals.length,
      highPriority:data.diagnostics?.highConfidenceOpportunities ?? liveSignals.filter(s=>Number(s.confidenceScore||0)>=80).length,
      mediumPriority:data.diagnostics?.mediumConfidenceOpportunities ?? liveSignals.filter(s=>Number(s.confidenceScore||0)>=60&&Number(s.confidenceScore||0)<80).length,
      savedAt:new Date().toISOString()
    };
    renderResearchSummary(summary);
    await fetch('/api/save-prospect-upload',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({lead,uploadName:f.name,stage:'researched',page:location.href,summary,accounts:enriched})}).catch(()=>{});
    const results=document.getElementById('prospectResults');
    renderOpportunityList();
    notice.textContent='Prospect research complete.';notice.style.display='block';
  }catch(e){showErr(e.message||'Prospect research failed.');document.getElementById('prospectResults').className='empty';document.getElementById('prospectResults').textContent='Upload a target account list to start prospect research.';document.getElementById('signalCount').textContent='0';renderResearchSummary({})}finally{setBusy(false)}
}
