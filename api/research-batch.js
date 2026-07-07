// Vercel Serverless Function: v38 Unified Signal Intelligence Engine.
// Endpoint: POST /api/research-batch
// Purpose: Google-AI-style business signal discovery for House Accounts.
// Pipeline: targeted search operators -> candidate snippets -> LLM synthesis -> high-value promo reasons to reach out.

function clean(text = '') {
  return String(text || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function compact(text = '', max = 240) {
  const t = clean(text);
  if (!t) return '';
  return t.length > max ? t.slice(0, max).replace(/\s+\S*$/, '') + '…' : t;
}

function parseJsonLoose(text = '') {
  if (!text) return null;
  try { return JSON.parse(text); } catch {}
  const fenced = String(text).match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) { try { return JSON.parse(fenced[1]); } catch {} }
  const arrayMatch = String(text).match(/\[[\s\S]*\]/);
  if (arrayMatch) { try { return { signals: JSON.parse(arrayMatch[0]) }; } catch {} }
  const objMatch = String(text).match(/\{[\s\S]*\}/);
  if (objMatch) { try { return JSON.parse(objMatch[0]); } catch {} }
  return null;
}

function sourceDomain(url = '') {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
}

async function firecrawlScrape(url) {
  const apiKey = process.env.FIRECRAWL_API_KEY;
  if (!apiKey || !url) return '';
  try {
    const resp = await fetch('https://api.firecrawl.dev/v2/scrape', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, formats: ['markdown'], onlyMainContent: true, timeout: 12000 })
    });
    if (!resp.ok) return '';
    const data = await resp.json();
    const text = data?.data?.markdown || data?.markdown || data?.data?.text || data?.text || '';
    return compact(text, 1800);
  } catch { return ''; }
}

async function enrichCandidatesWithFirecrawl(candidates = [], perAccountLimit = 4, totalLimit = 80) {
  if (!process.env.FIRECRAWL_API_KEY) return { candidates, scrapedCount: 0 };
  const byAccount = new Map();
  const selectedKeys = new Set();
  const selected = [];
  for (const c of candidates) {
    const acct = c.accountName || 'unknown';
    const count = byAccount.get(acct) || 0;
    if (count >= perAccountLimit || selected.length >= totalLimit) continue;
    if (!c.url || /linkedin\.com|facebook\.com|instagram\.com|x\.com|twitter\.com|pdf/i.test(c.url)) continue;
    const key = c.url.split('#')[0].toLowerCase();
    if (selectedKeys.has(key)) continue;
    selectedKeys.add(key);
    byAccount.set(acct, count + 1);
    selected.push(c);
  }
  const scraped = await mapLimit(selected, 8, async c => ({ key: c.url.split('#')[0].toLowerCase(), content: await firecrawlScrape(c.url) }));
  const contentMap = new Map((scraped || []).filter(x => x && x.content).map(x => [x.key, x.content]));
  let scrapedCount = 0;
  const enriched = candidates.map(c => {
    const content = contentMap.get((c.url || '').split('#')[0].toLowerCase());
    if (!content) return c;
    scrapedCount++;
    return { ...c, pageContent: content, snippet: compact(`${c.snippet || ''}

Page content: ${content}`, 2200), provider: `${c.provider || 'search'}+firecrawl` };
  });
  return { candidates: enriched, scrapedCount };
}

function safeArray(value, max = 6) {
  if (Array.isArray(value)) return value.map(clean).filter(Boolean).slice(0, max);
  return String(value || '').split(/[;|\n,]/).map(clean).filter(Boolean).slice(0, max);
}

function normalizeSignalType(type = '') {
  const t = String(type || '').toLowerCase();
  if (/predictable|seasonal|fallback|timing/.test(t)) return 'Predictable Timing';
  if (/hiring|job|career|recruit|talent|staff/.test(t)) return 'Hiring';
  if (/trade|expo|conference|summit|event|open house|webinar|show/.test(t)) return 'Trade Show / Event';
  if (/award|recognition|recognized|winner|milestone|anniversary|ranking|inc\.? 5000|best places/.test(t)) return 'Award / Recognition';
  if (/expansion|facility|location|office|opening|growth|building|plant|warehouse/.test(t)) return 'Expansion';
  if (/leadership|appoint|promot|named|ceo|president|director|vp|chief/.test(t)) return 'Leadership Change';
  if (/launch|product|service|rollout|release|new offering|unveil/.test(t)) return 'Product Launch';
  if (/acquisition|merger|funding|investment|raise|capital|acquired|merged/.test(t)) return 'Acquisition / Funding';
  if (/partner|partnership|customer win|contract|government|client win/.test(t)) return 'Partnership / Contract';
  if (/community|charity|fundrais|sponsor|csr|sustainability|volunteer/.test(t)) return 'Community / CSR';
  if (/rebrand|brand|logo|identity/.test(t)) return 'Rebrand';
  return 'Business Activity';
}

function confidenceNumber(conf) {
  if (typeof conf === 'number') return Math.max(0, Math.min(100, conf > 1 ? conf : conf * 100));
  const n = String(conf || '').match(/\d{1,3}/);
  if (n) return Math.max(0, Math.min(100, Number(n[0])));
  if (/high/i.test(String(conf))) return 86;
  if (/low/i.test(String(conf))) return 45;
  return 70;
}

function confidenceLabel(score) {
  if (score >= 80) return 'High';
  if (score >= 65) return 'Medium';
  return 'Low';
}

function isJunkText(text = '') {
  const t = String(text || '').toLowerCase();
  return !t ||
    /javascript disabled|enable javascript|cookies|privacy policy|terms of use|site map|contact us|skip to content|all rights reserved|page not found|access denied|robot|captcha/.test(t) ||
    t.length < 18;
}

function classifySource(url = '', title = '') {
  const t = `${url} ${title}`.toLowerCase();
  if (/careers|career|jobs|greenhouse|lever|workable|indeed|ziprecruiter|glassdoor/.test(t)) return 'careers';
  if (/news|press|release|announcement|businesswire|prnewswire|globenewswire|mainebiz|inc\.com/.test(t)) return 'news/press';
  if (/event|events|conference|expo|summit|webinar|booth|exhibitor/.test(t)) return 'events';
  if (/award|awards|recognition|best places|inc 5000|fastest growing/.test(t)) return 'awards';
  if (/community|csr|sustainability|charity|fundraising|sponsor|volunteer/.test(t)) return 'community/csr';
  if (/leadership|team|executive|appointed|named|promoted/.test(t)) return 'leadership';
  if (/linkedin/.test(t)) return 'linkedin';
  return 'web';
}

function queryTemplates(company, context = {}, mode = 'ranked') {
  const loc = context.location ? ` ${context.location}` : '';
  const industry = context.industry ? ` ${context.industry}` : '';
  const quoted = `"${company}"`;
  const domain = String(context.website || '').replace(/^https?:\/\//,'').replace(/^www\./,'').split('/')[0] || '';

  if (mode === 'prospect-intelligence') {
    // Prospect Intelligence is buying-moment driven. Keep this list surgical so search pulls
    // events that create timely promo conversations instead of generic company summaries.
    return [
      `${quoted}${loc} ("facility expansion" OR "new facility" OR "new location" OR "ribbon cutting" OR "new office" OR "distribution center" OR warehouse OR plant)`,
      `${quoted}${loc} ("trade show" OR exhibitor OR booth OR conference OR expo OR summit OR webinar OR "open house" OR "customer event" OR "dealer meeting" OR "sales meeting")`,
      `${quoted}${loc} ("product launch" OR unveiled OR introduces OR rollout OR rebrand OR merger OR acquisition)`,
      `${quoted}${loc} ("hiring HR" OR "hiring marketing" OR "event manager" OR "field marketing" OR "employee experience" OR "talent acquisition" OR onboarding)`,
      `${quoted}${loc} ("contract win" OR "major contract" OR partnership OR "customer win" OR awarded OR selected)`,
      `${quoted}${loc} ("safety milestone" OR anniversary OR award OR recognition OR "best places to work" OR "Inc. 5000")`,
      `${quoted}${loc} ("community event" OR sponsorship OR sponsor OR fundraiser OR philanthropy OR volunteer OR CSR)`,
      `${quoted}${loc} ("career fair" OR recruiting OR "now hiring" OR "open positions" OR careers)`,
      domain ? `site:${domain} (news OR press OR "press release" OR blog OR careers OR jobs OR events OR community OR locations OR sustainability)` : '',
      domain ? `site:${domain} ("trade show" OR conference OR booth OR exhibitor OR "open house" OR webinar OR event)` : '',
      domain ? `site:${domain} ("new facility" OR "new location" OR expansion OR "ribbon cutting" OR anniversary OR award OR launch)` : ''
    ].filter(Boolean);
  }

  // Existing customer/house account workflows keep the original broader research strategy.
  return [
    `${quoted}${loc}${industry}`,
    `${quoted}${loc} (acquired OR acquisition OR merger OR merged OR funding OR investment OR "private equity" OR partnership OR "customer win" OR contract)`,
    `${quoted}${loc} (hiring OR jobs OR careers OR "now hiring" OR recruiting OR "open positions" OR "join our team")`,
    `${quoted}${loc} (summit OR conference OR expo OR exhibitor OR booth OR webinar OR event OR sponsor OR sponsorship)`,
    `${quoted}${loc} (award OR "Inc. 5000" OR "fastest growing" OR "best places to work" OR recognition OR milestone OR anniversary)`,
    `${quoted}${loc} (launch OR unveiled OR rollout OR "new product" OR "new division" OR rebrand OR "new service")`,
    `${quoted}${loc} (expansion OR "new office" OR "new location" OR facility OR headquarters OR warehouse OR manufacturing OR "new building")`,
    `${quoted}${loc} (community OR charity OR fundraiser OR sponsorship OR sustainability OR volunteer OR donation OR nonprofit)`,
    `${quoted}${loc} (CEO OR president OR "vice president" OR appointed OR named OR promoted OR leadership OR joins)`,
    `site:${domain} (${quoted} OR news OR press OR careers OR events OR awards OR community OR leadership)`,
    `${quoted}${loc} ("trade show" OR "annual meeting" OR "open house" OR "customer event" OR "sales kickoff")`,
    `${quoted}${loc} ("safety" OR "employee engagement" OR "recognition program" OR "recruiting campaign")`
  ].filter(q => !q.startsWith('site: '));
}

function priorityOwnedPages(account = {}) {
  const website = clean(account.website || '');
  if (!website) return [];
  let origin = '';
  try { origin = new URL(website.startsWith('http') ? website : `https://${website}`).origin; } catch { return []; }
  const paths = ['/news','/press','/press-releases','/blog','/careers','/jobs','/events','/community','/about','/sustainability','/locations'];
  return paths.map(path => ({
    title: `${account.name} ${path.replace('/', '') || 'site'} page`,
    snippet: `Owned website page targeted for buying moments: ${path}`,
    url: `${origin}${path}`,
    source: sourceDomain(origin),
    date: '',
    provider: 'owned-site',
    query: 'priority-owned-page',
    accountName: account.name,
    sourceType: 'owned-page',
    score: 18
  }));
}

function parseSignalDate(dateText = '') {
  const t = String(dateText || '').trim();
  if (!t) return null;
  const d = new Date(t);
  if (!isNaN(d.getTime())) return d;
  const y = t.match(/\b(20\d{2})\b/);
  if (y) return new Date(`${y[1]}-06-15T00:00:00Z`);
  return null;
}

function freshnessScore(dateText = '') {
  const t = String(dateText || '').toLowerCase();
  if (/today|yesterday|this week|recently|now|upcoming|current/.test(t)) return 100;
  const d = parseSignalDate(dateText);
  if (!d) return 55;
  const days = Math.max(0, Math.round((Date.now() - d.getTime()) / 86400000));
  if (days <= 30) return 100;
  if (days <= 90) return 88;
  if (days <= 180) return 74;
  if (days <= 365) return 58;
  if (days <= 730) return 28;
  return 5;
}

function sourceQualityScore(url = '', sourceType = '') {
  const t = `${url} ${sourceType}`.toLowerCase();
  if (/company|careers|job posting|news\/press|businesswire|prnewswire|globenewswire|press release/.test(t)) return 95;
  if (/mainebiz|inc\.com|forbes|industry|association|mereda|chamber|conference|expo/.test(t)) return 82;
  if (/linkedin/.test(t)) return 72;
  if (/facebook|instagram|x\.com|twitter/.test(t)) return 50;
  return 64;
}

function adjustedConfidence(raw = {}, sourceUrl = '', sourceType = '') {
  const ai = confidenceNumber(raw.confidence || raw.opportunityScore || raw.score || 70);
  const fresh = freshnessScore(raw.publicationDate || raw.publishedDate || raw.date || '');
  const source = sourceQualityScore(sourceUrl || raw.sourceUrl || '', sourceType || raw.sourceType || raw.sourceName || '');
  const multi = Array.isArray(raw.sources) && raw.sources.length > 1 ? 100 : 55;
  return Math.round(Math.max(0, Math.min(100, (source * 0.35) + (fresh * 0.30) + (ai * 0.25) + (multi * 0.10))));
}

async function serperSearch(query) {
  const apiKey = process.env.SERPER_API_KEY;
  if (!apiKey) return [];
  try {
    const resp = await fetch('https://google.serper.dev/search', {
      method: 'POST',
      headers: { 'X-API-KEY': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ q: query, num: 8 })
    });
    if (!resp.ok) return [];
    const data = await resp.json();
    return [...(data.organic || []), ...(data.news || [])].map(r => ({
      title: clean(r.title),
      snippet: clean(r.snippet || r.description || ''),
      url: r.link || r.url || '',
      source: r.source || sourceDomain(r.link || r.url || ''),
      date: r.date || '',
      provider: 'serper',
      query
    })).filter(r => r.url || r.title).slice(0, 8);
  } catch { return []; }
}

async function tavilySearch(query) {
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) return [];
  try {
    const resp = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ api_key: apiKey, query, search_depth: 'advanced', max_results: 8, include_answer: false })
    });
    if (!resp.ok) return [];
    const data = await resp.json();
    return (data.results || []).map(r => ({
      title: clean(r.title),
      snippet: clean(r.content || r.snippet || ''),
      url: r.url || '',
      source: sourceDomain(r.url || ''),
      date: r.published_date || '',
      provider: 'tavily',
      query
    })).filter(r => r.url || r.title).slice(0, 8);
  } catch { return []; }
}

async function braveSearch(query) {
  const apiKey = process.env.BRAVE_SEARCH_API_KEY;
  if (!apiKey) return [];
  try {
    const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=8&freshness=py`;
    const resp = await fetch(url, { headers: { 'X-Subscription-Token': apiKey, 'Accept': 'application/json' } });
    if (!resp.ok) return [];
    const data = await resp.json();
    return (data.web?.results || []).map(r => ({
      title: clean(r.title),
      snippet: clean(r.description || ''),
      url: r.url || '',
      source: sourceDomain(r.url || ''),
      date: r.age || '',
      provider: 'brave',
      query
    })).filter(r => r.url || r.title).slice(0, 8);
  } catch { return []; }
}

async function runSearch(query) {
  // Prefer purpose-built search APIs. They return clean snippets and are much more reliable than scraping.
  let results = [];
  results = results.concat(await serperSearch(query));
  results = results.concat(await tavilySearch(query));
  results = results.concat(await braveSearch(query));
  return results;
}

function scoreCandidate(r, accountName) {
  const text = `${r.title} ${r.snippet} ${r.url}`;
  const t = text.toLowerCase();
  if (isJunkText(text)) return 0;
  let score = 0;
  if (t.includes(accountName.toLowerCase().split(' ')[0])) score += 8;

  // High-intent buying moments get priority over generic company activity.
  if (/facility expansion|new facility|ribbon cutting|new location|distribution center|warehouse|plant opening|headquarters opening/.test(t)) score += 34;
  if (/trade show|exhibitor|booth|conference|expo|summit|open house|customer event|dealer meeting|sales meeting|webinar/.test(t)) score += 32;
  if (/product launch|unveiled|rollout|new product|new division|rebrand|merger|acquisition/.test(t)) score += 28;
  if (/contract win|major contract|customer win|partnership|awarded|selected by|major deal/.test(t)) score += 27;
  if (/hiring hr|hiring marketing|event manager|field marketing|employee experience|talent acquisition|people operations|onboarding/.test(t)) score += 26;
  if (/safety milestone|anniversary|award|recognized|inc\.? 5000|fastest growing|best places to work|winner/.test(t)) score += 20;
  if (/community event|charity|fundraiser|sponsorship|sponsor|volunteer|philanthropy/.test(t)) score += 18;

  // Generic versions still count, but less.
  if (/hiring|jobs|careers|now hiring|open positions|recruiting/.test(t)) score += 12;
  if (/launch|unveiled|rollout|new product|new division|rebrand/.test(t)) score += 10;
  if (/expansion|new office|new location|facility|headquarters|warehouse|manufacturing/.test(t)) score += 12;
  if (/acquired|acquisition|merger|funding|investment|partnership|customer win|contract/.test(t)) score += 10;
  if (/2026|2025|today|yesterday|this week|recently|announced|upcoming|now/.test(t)) score += 10;
  if (/layoff|downsizing|bankruptcy|lawsuit|closure|recall|scandal|investigation/.test(t)) score -= 40;
  if (/contact us|privacy|terms|map|directions|mission statement|history/.test(t)) score -= 20;
  return Math.max(0, score);
}

function dedupeCandidates(candidates = []) {
  const seen = new Set();
  const out = [];
  for (const c of candidates) {
    const key = (c.url || `${c.accountName}|${c.title}`).split('#')[0].toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return out;
}

async function mapLimit(items, limit, mapper) {
  const results = new Array(items.length);
  let idx = 0;
  async function worker() {
    while (idx < items.length) {
      const current = idx++;
      try { results[current] = await mapper(items[current], current); }
      catch (e) { results[current] = null; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

function accountPromptContext(accounts) {
  return accounts.map((a, idx) => ({
    id: String(idx),
    name: clean(a.name),
    industry: clean(a.industry || ''),
    location: clean(a.cityState || a.location || ''),
    website: clean(a.website || ''),
    notes: clean(a.notes || ''),
    historicalRevenue: a.revenue || 0,
    orderCount: a.orderCount || 0,
    relationshipScore: a.relationshipStrength || a.relationshipScore || '',
    quickWinScore: a.quickWinScore || '',
    historicalCategoriesPurchased: Array.isArray(a.categories) ? a.categories.slice(0, 10) : [],
    recentOrderDates: Array.isArray(a.recentOrderDates) ? a.recentOrderDates.slice(0, 5) : [],
    knownContacts: Array.isArray(a.contacts) ? a.contacts.slice(0, 6) : [],
    existingSignals: Array.isArray(a.existingSignals) ? a.existingSignals.slice(0, 5) : [],
    repeatPatterns: Array.isArray(a.repeatPatterns) ? a.repeatPatterns.slice(0, 5) : []
  }));
}

async function discoverCandidatesForAccounts(accounts = [], mode = 'ranked') {
  const sourceCoverage = {};
  const allCandidates = [];
  const samples = [];
  const perAccount = await mapLimit(accounts, 5, async account => {
    const queries = queryTemplates(account.name, account, mode).slice(0, mode === 'prospect-intelligence' ? 11 : 12);
    const resultSets = await Promise.all(queries.map(runSearch));
    let raw = resultSets.flat();
    if (mode === 'prospect-intelligence') raw = raw.concat(priorityOwnedPages(account));
    const ranked = dedupeCandidates(raw.map(r => ({
      ...r,
      accountName: account.name,
      sourceType: classifySource(r.url, r.title),
      score: scoreCandidate(r, account.name)
    })).filter(r => r.score >= 14).sort((a,b) => b.score - a.score)).slice(0, 12);

    for (const r of ranked) {
      sourceCoverage[r.provider || 'search'] = (sourceCoverage[r.provider || 'search'] || 0) + 1;
      sourceCoverage[r.sourceType || 'web'] = (sourceCoverage[r.sourceType || 'web'] || 0) + 1;
    }
    samples.push(...ranked.slice(0, 3).map(r => ({
      accountName: account.name,
      status: 'candidate',
      reason: `score ${r.score}`,
      title: r.title,
      domain: sourceDomain(r.url),
      sourceType: r.sourceType
    })));
    allCandidates.push(...ranked);
    return ranked;
  });
  return { candidates: allCandidates, perAccount, sourceCoverage, samples };
}

function responseOutputText(data = {}) {
  if (typeof data.output_text === 'string') return data.output_text;
  const chunks = [];
  for (const item of data.output || []) {
    for (const part of item.content || []) {
      if (part.type === 'output_text' && part.text) chunks.push(part.text);
      if (part.text && typeof part.text === 'string') chunks.push(part.text);
    }
  }
  return chunks.join('\n');
}

async function callOpenAIJson({ apiKey, model, prompt }) {
  const resp = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      input: prompt,
      temperature: 0.1,
      max_output_tokens: 9000
    })
  });
  if (!resp.ok) throw new Error(await resp.text().catch(() => `OpenAI error ${resp.status}`));
  const data = await resp.json();
  return responseOutputText(data);
}

async function callOpenAIWebSearch({ apiKey, model, accounts }) {
  const prompt = `Research these companies for public buying moments that create timely reasons for a promotional-products salesperson to start a conversation.

House Accounts is not trying to summarize companies. It is trying to answer: "Why should I contact this company today?"

Use the account context below, including any uploaded contacts. Research each company once. If uploaded contacts align with the recommended buying team, they may be used as potentialContacts. Do not invent people.

Accounts:
${JSON.stringify(accountPromptContext(accounts), null, 2)}

Extract concrete buying moments from the last 18 months when possible. Prioritize: facility expansion, new location, ribbon cutting, trade show/exhibitor participation, booth/conference/summit/webinar/customer event, product launch, hiring with HR/marketing/event/employee-experience context, community event/sponsorship, corporate philanthropy, safety milestone, company anniversary, major award actively promoted, partnership/contract win, rebrand, merger, acquisition, open house, dealer meeting, sales meeting.

Do not summarize companies. Do not return generic company descriptions. Suppress clearly negative or irrelevant signals such as layoffs, downsizing, restructuring, bankruptcy, lawsuits, plant closures, investigations, recalls, or scandals. Do not use generic sustainability claims unless tied to a concrete event, certification, award, facility, deadline, campaign, partnership, or active program.

Preserve the concrete trigger. Do not reduce "New Facility Inauguration in Virginia" to "Expansion" or "Hosting FTC Scrimmage at headquarters" to "Community engagement." Use concrete_trigger and signalTitle to name the specific event.

For each accepted signal, answer both: what happened and why it likely happened. Add a short businessContext. For hiring signals, identify whether hiring appears tied to growth, expansion, new facility, product launch, seasonal ramp, contract demand, leadership change, or increased production demand. If the driver is not clear, say that naturally and lower confidence rather than omitting a meaningful signal.

Score every signal using ABD:
- actionability_score: how clear is the reason to reach out?
- budget_score: does this usually create promotional spend?
- deadline_score: is there a timely reason to act now?

Openers must reference the concrete trigger and suggest a specific promotional play, then ask for a simple next step. Example: "Saw [Company] is opening its new Virginia facility. For plant rollouts, teams usually balance employee onboarding, local PR, and opening-day gifts. I had a few ideas around durable branded apparel and launch kits — worth sending over?"

Recommended Buying Team rules:
- Always include recommended_buying_team with 1 to 3 departments inferred from the signal and context.
- Examples: HR / People, Talent Acquisition, Marketing, Events, Operations, Community Relations, Product Marketing, Sales.

Potential Contacts rules:
- Include potential_contacts only when a public source or uploaded contact supports the person and role.
- Return at most 2 contacts.
- Never invent names, placeholder people, or generic departments as contacts.

Return JSON only with shape: {"signals":[{"company_name":"","accountName":"","signal_type":"","signalType":"","concrete_trigger":"","buying_moment":"","signalTitle":"","whatChanged":"","event_date":"","location":"","source_url":"","source_name":"","business_context":"","businessContext":"","why_this_matters":"","whyItMattersForPromo":"","recommended_buying_team":[""],"recommendedBuyingTeam":[""],"potential_contacts":[{"name":"","title":"","reason":"","sourceUrl":""}],"potentialContacts":[{"name":"","title":"","reason":"","sourceUrl":""}],"why_these_contacts":"","whyTheseContacts":"","promo_categories":[""],"likelyProducts":[""],"suggested_opener":"","suggestedOpener":"","actionability_score":0,"budget_score":0,"deadline_score":0,"why_now_score":0,"confidence":0,"sourceName":"","sourceUrl":"","sources":[{"name":"","url":""}],"publicationDate":""}]}.

Confidence must be 0-100. Return nothing only for clear duplicates, spam, unverifiable items, or signals with no meaningful sales relevance.`;
  const body = {
    model,
    input: prompt,
    tools: [{ type: process.env.OPENAI_WEB_SEARCH_TOOL || 'web_search_preview' }],
    max_output_tokens: 9000
  };
  const resp = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!resp.ok) throw new Error(await resp.text().catch(() => `OpenAI web search error ${resp.status}`));
  const data = await resp.json();
  return responseOutputText(data);
}


function buildBusinessContext(raw = {}, type = '', summary = '', accountName = '') {
  const explicit = compact(raw.businessContext || raw.companyContext || raw.strategicContext || raw.whyItHappened || raw.growthDriver || raw.businessDriver || '', 260);
  if (explicit) return explicit;

  const text = clean(`${raw.whatChanged || ''} ${raw.signalTitle || ''} ${raw.title || ''} ${raw.summary || ''} ${raw.signalDetail || ''} ${raw.whyItMattersForPromo || ''}`).toLowerCase();
  const company = accountName || 'The company';

  if (/new facility|facility opening|opens? (a )?new|distribution center|warehouse|plant|manufacturing site/.test(text)) {
    return `${company} appears to be expanding physical operations through a new facility or location, which can create onboarding, apparel, signage, and internal communication needs.`;
  }
  if (/contract|customer win|awarded|selected by|major deal|agreement/.test(text)) {
    return `${company} appears to be supporting new customer or contract demand, which can lead to hiring, production ramp-up, and customer-facing brand needs.`;
  }
  if (/funding|investment|raised|series [abc]|capital|private equity/.test(text)) {
    return `${company} appears to have new capital available for growth, which may support hiring, marketing, onboarding, or expansion initiatives.`;
  }
  if (/acquisition|acquired|merger|integrat/.test(text)) {
    return `${company} appears to be going through a business change that may require internal alignment, employee communication, and brand consistency.`;
  }
  if (/launch|new product|unveils|introduces|rollout/.test(text)) {
    return `${company} appears to be bringing a new product or initiative to market, creating a timely reason to ask about launch support and brand visibility.`;
  }
  if (/seasonal|temporary|peak season|holiday ramp/.test(text)) {
    return `${company} appears to be preparing for a seasonal ramp, which can create short-term needs around recruiting, onboarding, uniforms, and recognition.`;
  }
  if (/second shift|third shift|production capacity|capacity|ramp up|increased demand/.test(text)) {
    return `${company} appears to be increasing production capacity, which can create timely needs around team apparel, safety programs, and employee engagement.`;
  }
  if (/hiring|jobs|careers|recruit|open position|now hiring|headcount/.test(text) || /hiring/i.test(type)) {
    return `The company is actively hiring, although the specific business initiative driving the hiring could not be determined from public information.`;
  }
  if (/event|conference|expo|trade show|summit|open house/.test(text)) {
    return `${company} appears to be preparing for a public event or industry presence, which can create needs around booth materials, attendee gifts, apparel, and follow-up campaigns.`;
  }
  if (/award|recognition|honor|winner|best of|milestone|anniversary/.test(text)) {
    return `${company} has a recognition or milestone moment that can create a natural conversation around employee appreciation, customer gifts, or branded celebration items.`;
  }
  if (/leadership|appoint|promot|named|joins as|new ceo|president|vp|director/.test(text)) {
    return `${company} appears to have leadership changes that may signal new priorities, team-building needs, or upcoming internal communication initiatives.`;
  }
  return compact(summary || 'Recent public business activity creates a timely reason to learn what is changing inside the company.', 240);
}

function contextToPromoWhy(context = '', type = '') {
  const c = clean(context);
  if (!c) return 'Recent public business activity creates a timely reason to start a conversation.';
  if (/specific growth driver is not yet clear/i.test(c)) return 'Hiring creates a practical reason to ask who owns onboarding, recruiting, and employee engagement support.';
  return compact(`${c} That creates a practical reason to ask about onboarding, employee engagement, events, apparel, recognition, or brand support tied to the change.`, 280);
}

function contextToOpener(context = '', type = '') {
  const c = clean(context);
  if (/specific growth driver is not yet clear/i.test(c) || /hiring/i.test(type)) {
    return "I noticed you're growing your team recently. Is anything changing internally that your team is planning around?";
  }
  if (/event|conference|expo|trade show/i.test(`${c} ${type}`)) return 'Saw the event activity and had a quick question — who handles branded materials or attendee follow-up?';
  if (/funding|capital|investment|growth/i.test(c)) return 'Saw the recent growth news and had a quick question — has that changed any hiring, onboarding, or brand initiatives?';
  if (/facility|location|distribution center|production capacity/i.test(c)) return 'Saw the expansion activity and had a quick question — who supports team onboarding, apparel, or site launch needs?';
  return 'Saw some recent company activity and had a quick question — who would be best to ask about related internal or brand needs?';
}

function buildConcreteTrigger(raw = {}, type = '', accountName = '') {
  const direct = compact(raw.concrete_trigger || raw.concreteTrigger || raw.buying_moment || raw.buyingMoment || raw.signalTitle || raw.title || raw.whatChanged || '', 150);
  if (direct && !/^(business activity|recent activity|expansion|hiring|community engagement|recognition)$/i.test(direct)) return direct;
  const text = clean(`${raw.signalTitle || ''} ${raw.whatChanged || ''} ${raw.summary || ''} ${raw.signalDetail || ''} ${raw.sourceName || ''}`).trim();
  if (text) return compact(text, 120);
  return `${accountName || 'Company'} ${type || 'Business Activity'}`;
}

function inferBuyingMoment(raw = {}, type = '', trigger = '', context = '') {
  const explicit = compact(raw.buying_moment || raw.buyingMoment || raw.opportunityCategory || '', 90);
  if (explicit) return explicit;
  const t = clean(`${type} ${trigger} ${context}`).toLowerCase();
  if (/facility|new location|ribbon cutting|plant|warehouse|distribution center|headquarters/.test(t)) return 'Facility / Location Expansion';
  if (/trade show|exhibitor|booth|conference|expo|summit|open house|customer event|dealer meeting|webinar/.test(t)) return 'Event / Trade Show';
  if (/product launch|new product|rollout|unveil/.test(t)) return 'Product Launch';
  if (/rebrand|merger|acquisition|integrat/.test(t)) return 'Brand / Business Change';
  if (/contract|customer win|partnership|awarded|selected/.test(t)) return 'Contract / Partnership Win';
  if (/hiring|recruit|talent|employee experience|field marketing|event manager|onboarding/.test(t)) return 'Hiring / Team Growth';
  if (/community|sponsor|fundraiser|philanthropy|volunteer|csr/.test(t)) return 'Community / Sponsorship Event';
  if (/award|recognition|anniversary|milestone|safety/.test(t)) return 'Recognition / Milestone';
  return normalizeSignalType(type || trigger || 'Business Activity');
}

function promoCategoriesForMoment(moment = '', type = '', context = '') {
  const t = clean(`${moment} ${type} ${context}`).toLowerCase();
  if (/facility|location|plant|warehouse|operations|expansion|ribbon/.test(t)) return ['Employee Apparel','Onboarding Kits','Safety Items','Opening-Day Gifts'];
  if (/trade show|event|conference|expo|booth|summit|webinar|open house/.test(t)) return ['Event Kits','Booth Giveaways','Branded Apparel','Follow-Up Gifts'];
  if (/hiring|recruit|talent|onboarding|employee/.test(t)) return ['Onboarding Items','Recruiting Materials','Employee Apparel','Recognition Gifts'];
  if (/product launch|launch|rebrand/.test(t)) return ['Launch Kits','Customer Gifts','Event Giveaways','Branded Apparel'];
  if (/community|sponsor|fundraiser|philanthropy|volunteer/.test(t)) return ['Event Giveaways','Volunteer Apparel','Banners','Community Gifts'];
  if (/award|recognition|anniversary|milestone|safety/.test(t)) return ['Recognition Gifts','Awards','Employee Apparel','Celebration Kits'];
  if (/contract|partnership|customer win|sales/.test(t)) return ['Customer Appreciation','Sales Kits','Executive Gifts','Event Giveaways'];
  return ['Employee Apparel','Event Kits','Customer Appreciation','Recognition Gifts'];
}

function salesReadyWhy(trigger = '', context = '', moment = '', type = '') {
  const t = clean(`${trigger} ${context} ${moment} ${type}`).toLowerCase();
  if (/facility|location|plant|warehouse|ribbon|expansion/.test(t)) return 'Facility launches usually create needs around employee apparel, onboarding materials, safety items, local PR giveaways, and opening-day gifts.';
  if (/trade show|conference|expo|booth|summit|open house|customer event|webinar/.test(t)) return 'Events usually require booth giveaways, attendee gifts, team apparel, signage, and follow-up items that help the sales or marketing team stay memorable.';
  if (/hiring|recruit|talent|onboarding|employee experience/.test(t)) return 'Hiring and onboarding create practical needs around recruiting materials, new-hire kits, employee apparel, and internal engagement.';
  if (/product launch|launch|rollout|unveil/.test(t)) return 'Launches often need sales samples, customer gifts, launch kits, event materials, and branded touchpoints for internal and external audiences.';
  if (/community|sponsor|fundraiser|philanthropy|volunteer|csr/.test(t)) return 'Community programs often need volunteer apparel, banners, giveaways, sponsor gifts, and simple branded items for attendees or partners.';
  if (/award|recognition|anniversary|milestone|safety/.test(t)) return 'Recognition moments create a natural reason to discuss employee gifts, awards, celebration kits, safety incentives, or customer-facing thank-you items.';
  if (/contract|partnership|customer win/.test(t)) return 'Major wins can create needs around employee communication, customer appreciation, launch support, and brand visibility with new stakeholders.';
  return contextToPromoWhy(context, type);
}

function salesReadyOpener(trigger = '', context = '', moment = '', type = '') {
  const specific = compact(trigger || moment || 'the recent activity', 90);
  const t = clean(`${specific} ${context} ${moment} ${type}`).toLowerCase();
  if (/facility|location|plant|warehouse|ribbon|expansion/.test(t)) return `Saw ${specific}. For site launches, teams usually balance employee onboarding, local PR, safety gear, and opening-day gifts. I had a few practical ideas around apparel and launch kits — worth sending over?`;
  if (/trade show|conference|expo|booth|summit|open house|customer event|webinar/.test(t)) return `Saw ${specific}. Events like that usually need booth giveaways, team apparel, attendee gifts, and follow-up items. Want me to send over a few ideas?`;
  if (/hiring|recruit|talent|onboarding|employee experience/.test(t)) return `Saw ${specific}. When teams are growing, onboarding kits, recruiting materials, and employee apparel usually become timely. Is there someone I should ask about that?`;
  if (/product launch|launch|rollout|unveil/.test(t)) return `Saw ${specific}. Launches usually need internal hype, sales support, and customer-facing branded items. I had a few simple launch-kit ideas — worth sending over?`;
  if (/community|sponsor|fundraiser|philanthropy|volunteer|csr/.test(t)) return `Saw ${specific}. Community events usually need volunteer apparel, banners, giveaways, and thank-you gifts. Want me to send over a few ideas that could fit?`;
  if (/award|recognition|anniversary|milestone|safety/.test(t)) return `Saw ${specific}. Moments like that are a good chance to recognize employees or thank customers. Would a few branded celebration or recognition ideas be useful?`;
  if (/contract|partnership|customer win/.test(t)) return `Saw ${specific}. Wins like that often create internal and customer-facing communication needs. I had a few ideas around team apparel and thank-you kits — worth sending over?`;
  return contextToOpener(context, type);
}


function inferRecommendedBuyingTeam(type = '', context = '', summary = '', raw = {}) {
  const explicit = safeArray(raw.recommendedBuyingTeam || raw.buyingTeam || raw.likelyBuyingTeam || raw.likelyBuyers, 4);
  const text = clean(`${type} ${context} ${summary} ${explicit.join(' ')}`).toLowerCase();
  let team = [];
  if (/hiring|recruit|talent|onboarding|employee|people|best places|workforce|headcount/.test(text)) {
    team = ['HR / People', 'Talent Acquisition'];
  } else if (/trade show|conference|expo|event|summit|booth|sponsor|launch|rebrand|brand awareness|community|csr|charity|fundraiser/.test(text)) {
    team = ['Marketing', /community|csr|charity|fundraiser|sponsor/.test(text) ? 'Community Relations' : 'Events'];
  } else if (/product launch|new product|rollout|new service|unveil/.test(text)) {
    team = ['Marketing', 'Product Marketing'];
  } else if (/facility|warehouse|plant|manufacturing|production|capacity|second shift|safety|distribution center|operations/.test(text)) {
    team = ['Operations', 'HR / People'];
  } else if (/funding|investment|capital|acquisition|merger|integration|leadership|new ceo|president|vp/.test(text)) {
    team = ['Marketing', 'HR / People'];
  } else if (/award|recognition|milestone|anniversary/.test(text)) {
    team = ['Marketing', 'HR / People'];
  } else if (/contract|customer win|partnership|major deal/.test(text)) {
    team = ['Marketing', 'Sales'];
  }
  for (const item of explicit) {
    if (!team.some(t => t.toLowerCase() === item.toLowerCase())) team.push(item);
  }
  if (!team.length) team = ['Marketing', 'HR / People'];
  return team.map(t => t.replace(/human resources/i, 'HR / People').replace(/people operations/i, 'HR / People')).filter(Boolean).slice(0, 3);
}

function normalizePotentialContacts(value, max = 2) {
  const items = Array.isArray(value) ? value : [];
  return items.map(c => {
    if (typeof c === 'string') {
      const parts = c.split(/\s+[-–—]\s+/);
      return { name: clean(parts[0]), title: clean(parts.slice(1).join(' — ')), reason: '' };
    }
    return {
      name: clean(c?.name || c?.fullName || c?.person || ''),
      title: clean(c?.title || c?.role || c?.jobTitle || ''),
      reason: clean(c?.reason || c?.whyRelevant || c?.relevance || c?.why || ''),
      sourceUrl: clean(c?.sourceUrl || c?.url || '')
    };
  }).filter(c => c.name && !/unknown|n\/a|not available|team|department/i.test(c.name)).slice(0, max);
}

function contactText(contact = {}) {
  return clean(`${contact.name || ''} ${contact.title || ''} ${contact.role || ''} ${contact.email || ''} ${contact.linkedin || ''}`).toLowerCase();
}

function buyingTeamKeywords(team = []) {
  const text = clean(team.join(' ')).toLowerCase();
  const keywords = new Set();
  if (/hr|human resources|people|talent|recruit|onboard|employee/.test(text)) {
    ['hr','human resources','people','talent','recruit','recruiting','recruitment','onboarding','employee','culture','workforce'].forEach(k => keywords.add(k));
  }
  if (/marketing|brand|product marketing|event|events|community|relations|csr/.test(text)) {
    ['marketing','marketer','marcomm','communications','brand','branding','events','event','community','relations','csr','partnerships','sponsorship','product marketing'].forEach(k => keywords.add(k));
  }
  if (/operations|production|manufacturing|warehouse|facility|safety|distribution/.test(text)) {
    ['operations','operation','production','manufacturing','plant','facility','facilities','warehouse','distribution','safety','ehs','supply chain'].forEach(k => keywords.add(k));
  }
  if (/sales|business development|customer/.test(text)) {
    ['sales','business development','customer','account'].forEach(k => keywords.add(k));
  }
  return [...keywords];
}

function contactMatchesBuyingTeam(contact = {}, team = []) {
  const txt = contactText(contact);
  if (!txt) return false;
  const keywords = buyingTeamKeywords(team);
  return keywords.some(k => txt.includes(k));
}

function normalizeUploadedContacts(contacts = []) {
  const seen = new Set();
  return safeArray(contacts, 12).map(c => {
    if (typeof c === 'string') return { name: clean(c), title: '', email: '', linkedin: '', source: 'Uploaded CSV' };
    return {
      name: clean(c?.name || c?.contactName || c?.fullName || ''),
      title: clean(c?.title || c?.role || c?.jobTitle || ''),
      email: clean(c?.email || c?.contactEmail || ''),
      linkedin: clean(c?.linkedin || c?.linkedIn || c?.linkedinUrl || ''),
      reason: clean(c?.reason || ''),
      source: clean(c?.source || 'Uploaded CSV')
    };
  }).filter(c => c.name || c.email).filter(c => {
    const key = `${c.name}|${c.email}|${c.title}`.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function selectUploadedContactsForTeam(contacts = [], team = [], max = 2) {
  return normalizeUploadedContacts(contacts)
    .filter(c => contactMatchesBuyingTeam(c, team))
    .slice(0, max)
    .map(c => ({
      name: c.name || c.email,
      title: c.title,
      email: c.email,
      linkedin: c.linkedin,
      reason: c.reason || 'Uploaded contact aligns with the recommended buying team for this opportunity.',
      source: 'Uploaded CSV'
    }));
}

function mergePotentialContacts(uploaded = [], publicContacts = [], max = 2) {
  const out = [];
  const seen = new Set();
  for (const c of [...uploaded, ...publicContacts]) {
    if (!c || !c.name) continue;
    const key = `${c.name}|${c.email || ''}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
    if (out.length >= max) break;
  }
  return out;
}

function buildWhyTheseContacts(contacts = [], team = [], type = '', context = '') {
  const explicit = contacts.map(c => c.reason).filter(Boolean).join(' ');
  if (explicit) return compact(explicit, 220);
  if (!contacts.length) return '';
  const c = clean(`${type} ${context} ${team.join(' ')}`).toLowerCase();
  if (/hiring|recruit|talent|onboarding|people|hr/.test(c)) return 'These roles appear closest to recruiting, onboarding, or employee engagement tied to this opportunity.';
  if (/event|conference|expo|community|csr|sponsor/.test(c)) return 'These roles appear closest to the event, community, or brand initiative behind this opportunity.';
  if (/product|launch|marketing|rebrand/.test(c)) return 'These roles appear closest to the marketing or launch initiative behind this opportunity.';
  if (/operations|facility|production|safety|warehouse/.test(c)) return 'These roles appear closest to the operational change creating the outreach opportunity.';
  return 'These contacts appear to be the most relevant public starting points for this opportunity.';
}


function hasNegativeOrIrrelevantContext(text = '') {
  const t = clean(text).toLowerCase();
  return /layoff|laid off|downsizing|restructuring|bankruptcy|lawsuit|litigation|plant closure|closing plant|closure|investigation|recall|scandal|fraud|settlement|data breach|fined|penalty|strike|labor dispute/.test(t);
}

function isGenericSustainabilityOnly(text = '') {
  const t = clean(text).toLowerCase();
  return /sustainability|green|eco|environment|carbon|recycling|esg/.test(t) &&
    !/certification|certified|award|campaign|event|deadline|facility|initiative|volunteer|earth day|report launch|new program|partnership|donation|sponsor/.test(t);
}

function isWeakOldAward(raw = {}, text = '') {
  const t = clean(text).toLowerCase();
  if (!/award|recognition|honor|ranking|best places|top \d+|inc\.? 5000/.test(t)) return false;
  const fresh = freshnessScore(raw.publicationDate || raw.publishedDate || raw.date || '');
  return fresh < 35 && !/actively promoting|celebrat|anniversary|milestone|event|campaign|press release/.test(t);
}

function prospectKillRule(raw = {}, type = '', summary = '', businessContext = '') {
  const text = `${type} ${raw.signalType || ''} ${raw.signalTitle || ''} ${raw.title || ''} ${summary} ${businessContext} ${raw.whyItMattersForPromo || ''} ${raw.sourceName || ''} ${raw.sourceUrl || ''}`;
  if (hasNegativeOrIrrelevantContext(text)) return true;
  if (isGenericSustainabilityOnly(text)) return true;
  if (isWeakOldAward(raw, text)) return true;
  return false;
}

function abdScores(raw = {}, type = '', summary = '', businessContext = '') {
  const text = clean(`${type} ${raw.signalType || ''} ${raw.signalTitle || ''} ${raw.title || ''} ${summary} ${businessContext} ${raw.whyItMattersForPromo || ''}`).toLowerCase();
  let actionability = Number(raw.actionability_score || raw.actionabilityScore || 55);
  let budgetLikelihood = Number(raw.budget_score || raw.budgetScore || 50);
  let deadlineUrgency = Number(raw.deadline_score || raw.deadlineScore || raw.why_now_score || raw.whyNowScore || (freshnessScore(raw.publicationDate || raw.publishedDate || raw.date || raw.event_date || '') >= 80 ? 65 : 45));

  if (/new facility|facility opening|new location|plant|warehouse|distribution center|expansion|headquarters|ribbon cutting|rebrand|merger|acquisition|product launch|trade show|expo|conference|open house|customer event|anniversary|safety milestone|contract|customer win/.test(text)) actionability += 22;
  if (/hiring|recruit|onboarding|employee appreciation|recognition|event|trade show|facility|uniform|safety|sales kickoff|community event|sponsor|customer appreciation|holiday|booth|launch kit|opening-day/.test(text)) budgetLikelihood += 24;
  if (/upcoming|this month|this quarter|scheduled|opening|launching|event|conference|trade show|deadline|seasonal|hiring now|now hiring|new facility|ribbon cutting|event date/.test(text)) deadlineUrgency += 22;

  if (/generic sustainability|sustainability statement|mission statement|old award|vague community|general community/.test(text)) {
    actionability -= 18; budgetLikelihood -= 12; deadlineUrgency -= 12;
  }
  if (hasUnclearBusinessContext(businessContext)) {
    actionability -= 5; deadlineUrgency -= 4;
  }

  const clamp = n => Math.max(0, Math.min(100, Math.round(n)));
  return { actionability: clamp(actionability), budgetLikelihood: clamp(budgetLikelihood), deadlineUrgency: clamp(deadlineUrgency) };
}

function abdAdjustedConfidence(base = 0, raw = {}, type = '', summary = '', businessContext = '') {
  const abd = abdScores(raw, type, summary, businessContext);
  const abdTotal = Math.round((abd.actionability * 0.4) + (abd.budgetLikelihood * 0.35) + (abd.deadlineUrgency * 0.25));
  const blended = Math.round((Number(base || 0) * 0.62) + (abdTotal * 0.38));
  return { score: Math.max(0, Math.min(100, blended)), abd };
}

function currentPredictableTimingTheme(now = new Date()) {
  const month = now.getMonth() + 1;
  if ([1,2].includes(month)) return { trigger:'Predictable Timing: New Year Sales Kickoff / Annual Planning', context:'No major current public signal was found, but many companies use Q1 to plan sales kickoff, recruiting, recognition, and employee engagement programs.', opener:'I was thinking ahead to Q1 planning and sales kickoff needs. Are branded employee, customer, or event programs on your team’s radar right now?', categories:['Sales Kickoff Items','Employee Recognition','Recruiting Materials','Customer Gifts'], team:['Sales','Marketing','HR / People'] };
  if ([3,4].includes(month)) return { trigger:'Predictable Timing: Trade Show Season / Spring Events', context:'No major current public signal was found, but spring often brings trade shows, recruiting events, customer meetings, and community programs.', opener:'I was thinking ahead to spring events and customer-facing programs. Are there any trade shows, recruiting events, or community initiatives your team is preparing for?', categories:['Event Kits','Booth Giveaways','Employee Apparel','Customer Appreciation'], team:['Marketing','Events','Sales'] };
  if ([5,6].includes(month)) return { trigger:'Predictable Timing: Summer Intern Onboarding / Employee Engagement', context:'No major current public signal was found, but many companies plan summer onboarding, intern programs, employee appreciation, and recruiting activities around this period.', opener:'I was thinking about summer onboarding and employee engagement programs. Would a few simple ideas for interns, new hires, or team appreciation be useful?', categories:['Onboarding Items','Employee Apparel','Recognition Gifts','Recruiting Materials'], team:['HR / People','Talent Acquisition','Marketing'] };
  if ([7,8,9].includes(month)) return { trigger:'Predictable Timing: Employee Appreciation / Fall Planning', context:'No major current public signal was found, but this company may still have recurring promotional needs tied to employee engagement, recruiting, events, or customer appreciation.', opener:'I was thinking ahead to fall employee and customer programs and had a few timely ideas that may fit your team. Is this something you’re planning for now?', categories:['Employee Appreciation','Customer Appreciation','Event Kits','Branded Apparel'], team:['HR / People','Marketing','Events'] };
  return { trigger:'Predictable Timing: Holiday / Q4 Gifting', context:'No major current public signal was found, but Q4 is a common planning window for holiday gifting, customer appreciation, employee recognition, and year-end events.', opener:'I was thinking ahead to holiday gifting and year-end appreciation. Are customer gifts or employee recognition programs something your team is planning now?', categories:['Holiday Gifts','Customer Appreciation','Employee Recognition','Executive Gifts'], team:['Marketing','Sales','HR / People'] };
}

function makePredictableTimingSignal(account = {}) {
  const theme = currentPredictableTimingTheme();
  const accountName = clean(account.name || account.accountName || 'Target Account');
  const recommendedBuyingTeam = theme.team;
  const potentialContacts = selectUploadedContactsForTeam(account.contacts || [], recommendedBuyingTeam, 2);
  return {
    accountName,
    isReal: false,
    isFallbackOpportunity: true,
    signalLayerType: 'Predictable Timing',
    type: 'Predictable Timing',
    signalType: 'Predictable Timing',
    opportunityType: 'PREDICTABLE_TIMING',
    title: theme.trigger,
    signalTitle: theme.trigger,
    signalDetail: theme.trigger,
    shortSummary: theme.trigger,
    signalSnippet: theme.trigger,
    whatChanged: theme.trigger,
    businessContext: theme.context,
    companyContext: theme.context,
    evidence: 'Predictable promo buying cycle based on seasonal timing; no major live public signal found.',
    sourceUrl: '',
    sourceType: 'Predictable Timing',
    sourceAuthority: 'Predictable Timing',
    cleanSourceName: 'Predictable Timing',
    sources: [],
    publishedDate: '',
    dateFound: new Date().toISOString(),
    detectedAt: new Date().toISOString(),
    confidence: 0.52,
    confidenceScore: 52,
    confidenceLevel: 'Low',
    priority: 'Low',
    abdScores: { actionability: 55, budgetLikelihood: 66, deadlineUrgency: 45 },
    reasonToReachOut: 'Many companies plan branded merchandise around seasonal employee, customer, and event programs even when there is no public announcement.',
    whyNow: 'Many companies plan branded merchandise around seasonal employee, customer, and event programs even when there is no public announcement.',
    whyItMattersForPromo: 'Many companies plan branded merchandise around seasonal employee, customer, and event programs even when there is no public announcement.',
    conversationStarter: theme.opener,
    suggestedOpener: theme.opener,
    recommendedBuyingTeam,
    recommended_buying_team: recommendedBuyingTeam,
    buyingTeam: recommendedBuyingTeam,
    potentialContacts,
    potential_contacts: potentialContacts,
    uploadedContacts: normalizeUploadedContacts(account.contacts || []),
    whyTheseContacts: potentialContacts.length ? buildWhyTheseContacts(potentialContacts, recommendedBuyingTeam, 'Predictable Timing', theme.context) : '',
    suggestedContact: potentialContacts[0]?.name || recommendedBuyingTeam[0],
    likelyBuyers: recommendedBuyingTeam,
    affectedDepartment: recommendedBuyingTeam[0],
    likelyConversations: ['Seasonal program planning', 'Employee or customer appreciation', 'Upcoming events'],
    likelyProducts: theme.categories,
    commonPromoCategories: theme.categories,
    opportunityCategory: theme.trigger,
    opportunityExplanation: 'Predictable seasonal timing creates a lower-priority but still useful reason to start a planning conversation.',
    valueSource: 'Predictable Timing',
    aiQualified: true,
    source: 'predictable-timing'
  };
}

function hasUnclearBusinessContext(context = '') {
  return /specific business initiative driving|specific growth driver|not yet clear|could not be determined|unclear/i.test(clean(context));
}

function hasMeaningfulSignal(raw = {}, type = '', summary = '', businessContext = '') {
  const text = clean(`${type} ${raw.signalType || ''} ${raw.signalTitle || ''} ${raw.title || ''} ${summary} ${businessContext} ${raw.whyItMattersForPromo || ''} ${raw.sourceUrl || ''}`).toLowerCase();
  if (isJunkText(text)) return false;
  return /hiring|jobs|careers|recruit|open position|now hiring|expansion|facility|new office|new location|warehouse|plant|funding|investment|acquisition|merger|contract|customer win|partnership|event|conference|expo|trade show|summit|award|recognition|milestone|anniversary|leadership|appoint|promot|launch|new product|rebrand|community|charity|sponsor|sustainability|safety|employee engagement/.test(text);
}

function confidenceWithContextFloor(confidencePct = 0, raw = {}, type = '', summary = '', businessContext = '') {
  let score = Number(confidencePct || 0);
  if (hasUnclearBusinessContext(businessContext)) score = Math.max(55, score - 8);
  if (hasMeaningfulSignal(raw, type, summary, businessContext)) score = Math.max(score, hasUnclearBusinessContext(businessContext) ? 58 : 64);
  return Math.round(Math.max(0, Math.min(100, score)));
}

function makeSignal(raw = {}, account = {}, options = {}) {
  const accountName = clean(raw.accountName || raw.account || raw.company || '');
  if (!accountName) return null;
  const sourceUrl = clean(raw.sourceUrl || raw.url || raw.sources?.[0]?.url || '');
  const rawConfidencePct = adjustedConfidence(raw, sourceUrl, raw.sourceType || raw.sourceName || '');
  const type = normalizeSignalType(raw.signal_type || raw.signalType || raw.opportunityType || raw.type);
  const concreteTrigger = buildConcreteTrigger(raw, type, accountName);
  const buyingMoment = inferBuyingMoment(raw, type, concreteTrigger, raw.business_context || raw.businessContext || '');
  const title = compact(concreteTrigger || raw.signalTitle || raw.headline || raw.title || `${accountName} business activity`, 150);
  const summary = compact(raw.whatChanged || raw.shortSummary || raw.summary || raw.signalDetail || raw.details || title, 240);
  const businessContext = buildBusinessContext(raw, type, summary, accountName);
  if (options.enableProspectQuality && prospectKillRule(raw, type, summary, businessContext)) return null;
  const floorConfidencePct = confidenceWithContextFloor(rawConfidencePct, raw, type, summary, businessContext);
  const abd = options.enableProspectQuality ? abdAdjustedConfidence(floorConfidencePct, raw, type, summary, businessContext) : { score: floorConfidencePct, abd: null };
  const confidencePct = abd.score;
  if (confidencePct < 55 || !hasMeaningfulSignal(raw, type, summary, businessContext)) return null; // discard only junk, duplicates, or truly low-confidence signals.
  const why = compact(raw.why_this_matters || raw.whyItMattersForPromo || raw.whyReachOut || raw.whyItMatters || raw.why || salesReadyWhy(concreteTrigger, businessContext, buyingMoment, type), 300);
  const opener = compact(raw.suggested_opener || raw.suggestedOpener || raw.conversationStarter || raw.likelyConversation || salesReadyOpener(concreteTrigger, businessContext, buyingMoment, type), 280);
  const buyers = safeArray(raw.likelyBuyers || raw.suggestedContacts || raw.suggestedContact || raw.contactRole, 4);
  const products = safeArray(raw.promo_categories || raw.likelyProducts || raw.promoCategories || raw.commonPromoCategories || raw.likelyProductCategories || promoCategoriesForMoment(buyingMoment, type, businessContext), 6);
  const conversations = safeArray(raw.likelyConversations || raw.conversationThemes || raw.likelyConversation || raw.conversationAngle, 5);
  const recommendedBuyingTeam = inferRecommendedBuyingTeam(type, businessContext, `${summary} ${buyingMoment} ${concreteTrigger}`, raw);
  const uploadedContacts = selectUploadedContactsForTeam(account.contacts || raw.uploadedContacts || [], recommendedBuyingTeam, 2);
  const publicContacts = normalizePotentialContacts(raw.potential_contacts || raw.potentialContacts || raw.contacts || raw.recommendedContacts || raw.suggestedPeople, 2);
  const potentialContacts = mergePotentialContacts(uploadedContacts, publicContacts, 2);
  const whyTheseContacts = compact(raw.whyTheseContacts || raw.contactRationale || buildWhyTheseContacts(potentialContacts, recommendedBuyingTeam, type, businessContext), 220);
  const sources = Array.isArray(raw.sources) ? raw.sources.map(s => ({ name: clean(s.name || s.sourceName || sourceDomain(s.url || '')), url: clean(s.url || s.sourceUrl || '') })).filter(s => s.url || s.name).slice(0, 4) : [];
  if (sourceUrl && !sources.some(s => s.url === sourceUrl)) sources.unshift({ name: clean(raw.sourceName || sourceDomain(sourceUrl) || 'Public source'), url: sourceUrl });
  return {
    accountName,
    isReal: true,
    signalLayerType: 'Business Activity Signal',
    type,
    signalType: type,
    signal_type: type,
    concreteTrigger,
    concrete_trigger: concreteTrigger,
    buyingMoment,
    buying_moment: buyingMoment,
    eventDate: clean(raw.event_date || raw.eventDate || raw.publicationDate || raw.publishedDate || raw.date || ''),
    event_date: clean(raw.event_date || raw.eventDate || raw.publicationDate || raw.publishedDate || raw.date || ''),
    location: clean(raw.location || raw.eventLocation || raw.cityState || ''),
    opportunityType: type.toUpperCase().replace(/[^A-Z0-9]+/g, '_'),
    title,
    signalDetail: summary,
    shortSummary: summary,
    signalSnippet: summary,
    whatChanged: summary,
    businessContext,
    companyContext: businessContext,
    evidence: `${sources[0]?.name || sourceDomain(sourceUrl) || clean(raw.sourceName || 'public source')}: ${summary}`,
    sourceUrl: sourceUrl || sources[0]?.url || '',
    source_url: sourceUrl || sources[0]?.url || '',
    source_name: clean(raw.source_name || raw.sourceName || sourceDomain(sourceUrl) || sources[0]?.name || ''),
    sourceType: clean(raw.sourceType || raw.sourceName || sourceDomain(sourceUrl) || sources[0]?.name || 'Public source'),
    sourceAuthority: clean(raw.sourceType || raw.sourceName || sourceDomain(sourceUrl) || sources[0]?.name || 'Public source'),
    cleanSourceName: clean(raw.sourceName || sourceDomain(sourceUrl) || sources[0]?.name || ''),
    sources,
    publishedDate: clean(raw.publicationDate || raw.publishedDate || raw.date || ''),
    dateFound: new Date().toISOString(),
    detectedAt: new Date().toISOString(),
    confidence: confidencePct / 100,
    confidenceScore: confidencePct,
    confidenceLevel: confidenceLabel(confidencePct),
    priority: confidencePct >= 80 ? 'High' : confidencePct >= 60 ? 'Medium' : 'Low',
    abdScores: abd.abd || undefined,
    actionability_score: abd.abd?.actionability,
    budget_score: abd.abd?.budgetLikelihood,
    deadline_score: abd.abd?.deadlineUrgency,
    why_now_score: confidencePct,
    reasonToReachOut: why,
    whyNow: why,
    whyItMattersForPromo: why,
    conversationStarter: opener,
    suggestedOpener: opener,
    recommendedBuyingTeam,
    recommended_buying_team: recommendedBuyingTeam,
    buyingTeam: recommendedBuyingTeam,
    potentialContacts,
    potential_contacts: potentialContacts,
    uploadedContacts: normalizeUploadedContacts(account.contacts || []),
    whyTheseContacts,
    why_these_contacts: whyTheseContacts,
    suggestedContact: potentialContacts[0]?.name || recommendedBuyingTeam[0] || buyers[0] || clean(raw.suggestedContact || raw.contactRole || 'Relevant department lead'),
    likelyBuyers: recommendedBuyingTeam.length ? recommendedBuyingTeam : (buyers.length ? buyers : [clean(raw.suggestedContact || 'Relevant department lead')]),
    affectedDepartment: clean(raw.likelyDepartment || raw.department || recommendedBuyingTeam[0] || buyers[0] || ''),
    likelyConversations: conversations.length ? conversations : [compact(raw.likelyConversation || raw.conversationAngle || why, 90)].filter(Boolean),
    likelyProducts: products,
    promo_categories: products,
    commonPromoCategories: products,
    opportunityCategory: compact(raw.opportunityCategory || conversations[0] || type, 90),
    opportunityExplanation: compact(raw.whyItMattersForPromo || raw.whyItMatters || why, 280),
    valueSource: 'AI Opportunity Discovery',
    aiQualified: true,
    source: 'targeted-search-ai'
  };
}

function signalKeywordKey(text = '') {
  return clean(text).toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(' ').filter(w => w.length > 3 && !['company','business','activity','public','signal','recent','creates','reason','promo'].includes(w)).slice(0, 8).join(' ');
}

function dedupeSignals(signals = []) {
  const map = new Map();
  for (const sig of signals) {
    if (!sig || !sig.accountName) continue;
    const domain = sourceDomain(sig.sourceUrl || '');
    const topic = signalKeywordKey(`${sig.signalType || ''} ${sig.signalDetail || sig.title || ''}`);
    const key = `${sig.accountName.toLowerCase()}|${sig.signalType}|${topic || domain}`;
    const existing = map.get(key);
    if (!existing) {
      map.set(key, sig);
      continue;
    }
    const mergedSources = [...(existing.sources || []), ...(sig.sources || [])];
    if (sig.sourceUrl && !mergedSources.some(s => s.url === sig.sourceUrl)) mergedSources.push({ name: sig.cleanSourceName || sourceDomain(sig.sourceUrl), url: sig.sourceUrl });
    const better = Number(sig.confidenceScore || 0) > Number(existing.confidenceScore || 0) ? sig : existing;
    map.set(key, {
      ...better,
      sources: mergedSources.slice(0, 5),
      confidenceScore: Math.min(100, Math.max(Number(existing.confidenceScore || 0), Number(sig.confidenceScore || 0)) + (mergedSources.length > 1 ? 4 : 0)),
      confidenceLevel: confidenceLabel(Math.min(100, Math.max(Number(existing.confidenceScore || 0), Number(sig.confidenceScore || 0)) + (mergedSources.length > 1 ? 4 : 0)))
    });
  }
  return [...map.values()].sort((a,b) => Number(b.confidenceScore || 0) - Number(a.confidenceScore || 0));
}


export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const startedAt = Date.now();
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return res.status(400).json({ error: 'OPENAI_API_KEY not configured' });

  try {
    const { accounts = [], mode = 'ranked' } = req.body || {};
    const seenAccountKeys = new Set();
    const safeAccounts = (Array.isArray(accounts) ? accounts : [])
      .filter(a => a && a.name)
      .map((a, idx) => ({
        id: String(idx),
        name: clean(a.name),
        industry: clean(a.industry || ''),
        location: clean(a.cityState || a.location || ''),
        cityState: clean(a.cityState || a.location || ''),
        notes: clean(a.notes || ''),
        website: clean(a.website || ''),
        categories: Array.isArray(a.categories) ? a.categories.slice(0, 10) : [],
        contacts: Array.isArray(a.contacts) ? a.contacts.slice(0, 12) : [],
        recentOrderDates: Array.isArray(a.recentOrderDates) ? a.recentOrderDates.slice(0, 5) : [],
        repeatPatterns: Array.isArray(a.repeatPatterns) ? a.repeatPatterns.slice(0, 5) : [],
        existingSignals: Array.isArray(a.existingSignals) ? a.existingSignals.slice(0, 5) : [],
        relationshipStrength: a.relationshipStrength || a.relationshipScore || '',
        quickWinScore: a.quickWinScore || '',
        revenue: Number(a.revenue || 0),
        orderCount: Number(a.orderCount || 0)
      }))
      .filter(a => {
        const key = a.name.toLowerCase().replace(/\b(incorporated|inc|llc|ltd|limited|corp|corporation|co|company)\b\.?/g, '').replace(/[^a-z0-9]+/g, ' ').trim() || a.name.toLowerCase();
        if (seenAccountKeys.has(key)) return false;
        seenAccountKeys.add(key);
        return true;
      })
      .slice(0, 50);
    if (!safeAccounts.length) return res.status(400).json({ error: 'No accounts provided' });

    const model = process.env.OPENAI_MODEL || 'gpt-4o-mini';
    let candidates = [];
    let sourceCoverage = {};
    let candidateSamples = [];
    let rawText = '';
    let providerMode = 'openai-web-search';

    // If any dedicated search provider is configured, use targeted search operators first.
    const hasSearchProvider = !!(process.env.SERPER_API_KEY || process.env.TAVILY_API_KEY || process.env.BRAVE_SEARCH_API_KEY);
    if (hasSearchProvider) {
      providerMode = 'targeted-search';
      const discovered = await discoverCandidatesForAccounts(safeAccounts, mode);
      candidates = discovered.candidates;
      sourceCoverage = discovered.sourceCoverage;
      candidateSamples = discovered.samples.slice(0, 16);
      const enriched = await enrichCandidatesWithFirecrawl(candidates);
      candidates = enriched.candidates;
      if (enriched.scrapedCount) sourceCoverage.firecrawl = enriched.scrapedCount;
    }

    let parsed = null;
    if (candidates.length) {
      const synthesisPrompt = `You are House Accounts' Prospect Buying Moment Extraction Engine.

Act like a senior promotional products account executive doing prospect research for a sales rep. Your job is NOT to summarize companies. Your job is to extract buying moments that answer:

"Why should I contact this company today?"

Use ONLY the supplied account context, uploaded contacts, search snippets, URLs, and clean page content. Do not invent.

A buying moment is a concrete event that may create promotional products demand, such as:
- facility expansion, new location, ribbon cutting, new distribution center, manufacturing expansion
- trade show, exhibitor participation, booth, conference, summit, open house, customer event, dealer meeting, webinar
- product launch, rebrand, merger, acquisition, partnership, contract win
- hiring with HR, marketing, event, employee experience, field marketing, recruiting, or onboarding context
- community event, sponsorship, corporate philanthropy
- safety milestone, company anniversary, major award actively promoted by the company

Return the strongest 0, 1, or 2 buying moments per account. Do not require perfect context. If a meaningful signal exists but the underlying driver is unclear, keep the signal, state the uncertainty clearly, and assign lower confidence.

Reject:
- generic company descriptions, mission/history/culture copy
- generic careers page existence unless evidence shows meaningful hiring or a recruiting push
- old or irrelevant awards unless active/currently promoted or tied to a clear sales angle
- vague community or sustainability copy unless tied to a concrete event, certification, deadline, award, partnership, facility, campaign, or active program
- clearly negative/irrelevant signals: layoffs, downsizing, restructuring, bankruptcy, lawsuits, plant closures, investigations, recalls, scandals

Preserve concrete triggers. Do not generalize specific events. Examples:
- Bad: "Expansion". Better: "New Facility Inauguration in Virginia".
- Bad: "Community engagement". Better: "Hosting FTC Scrimmage at company headquarters".
- Bad: "Hiring". Better: "Hiring Field Marketing Manager responsible for trade shows".

For each accepted signal:
1. concrete_trigger: specific event phrased as a short label.
2. buying_moment: the category of buying moment.
3. business_context: what happened and why it likely happened.
4. why_this_matters: practical promo sales angle. Avoid generic lines like "may create opportunities for promotional products." Be specific: employee apparel, onboarding, safety programs, booth materials, launch kits, VIP gifts, customer appreciation, recognition, etc.
5. suggested_opener: reference the concrete trigger, suggest a relevant promotional play, and ask for a simple next step.
6. recommended_buying_team: 1 to 3 departments inferred from the signal and context.
7. potential_contacts: max 2 people only if supported by public evidence or uploaded contacts.
8. ABD scores: actionability_score, budget_score, deadline_score.

Recommended Buying Team examples:
- Hiring expansion → HR / People, Talent Acquisition
- Product launch → Marketing, Product Marketing
- Community event → Marketing, Community Relations
- Manufacturing expansion → Operations, HR / People
- Trade show → Marketing, Events, Sales

Potential Contacts rules:
- Use uploaded knownContacts if they align with the recommended buying team.
- Use public contacts only when the source supports the person and title.
- Never invent names or use generic departments as contacts.
- Omit potential_contacts if no reliable person is found.

Score concrete, high-intent buying moments higher:
Highest value: facility expansion/new location, rebrand/merger, trade show exhibitor participation, major product launch, HR/marketing executive change, contract win/partnership, major award actively promoted, safety milestone, company anniversary.
Lower value: generic sustainability copy, generic hiring without context, old awards, vague community posts, minor funding/grants, generic blog content.

Return strict JSON only with shape:
{"signals":[{"company_name":"","accountName":"","signal_type":"Hiring|Expansion|Trade Show / Event|Award / Recognition|Leadership Change|Product Launch|Acquisition / Funding|Partnership / Contract|Community / CSR|Rebrand","signalType":"","concrete_trigger":"","buying_moment":"","signalTitle":"","whatChanged":"","event_date":"","location":"","source_url":"","source_name":"","business_context":"","businessContext":"","why_this_matters":"","whyItMattersForPromo":"","recommended_buying_team":[""],"recommendedBuyingTeam":[""],"potential_contacts":[{"name":"","title":"","reason":"","sourceUrl":""}],"potentialContacts":[{"name":"","title":"","reason":"","sourceUrl":""}],"why_these_contacts":"","whyTheseContacts":"","promo_categories":[""],"likelyProducts":[""],"suggested_opener":"","suggestedOpener":"","actionability_score":0,"budget_score":0,"deadline_score":0,"why_now_score":0,"confidence":0,"sourceName":"","sourceUrl":"","sources":[{"name":"","url":""}],"publicationDate":""}]}

Accounts:
${JSON.stringify(accountPromptContext(safeAccounts), null, 2)}

Candidate snippets and clean page content:
${JSON.stringify(candidates.slice(0, 180).map(c => ({accountName:c.accountName, title:c.title, snippet:c.snippet, pageContent:c.pageContent || '', url:c.url, sourceType:c.sourceType, provider:c.provider, date:c.date, score:c.score, query:c.query})), null, 2)}`;
      rawText = await callOpenAIJson({ apiKey, model, prompt: synthesisPrompt });
      parsed = parseJsonLoose(rawText);
    } else {
      // Fallback: ask OpenAI's web search to do the batch research in the same style as Google AI.
      rawText = await callOpenAIWebSearch({ apiKey, model: process.env.OPENAI_SEARCH_MODEL || model, accounts: safeAccounts });
      parsed = parseJsonLoose(rawText);
      sourceCoverage['ai-web-search'] = safeAccounts.length;
    }

    const rawSignals = Array.isArray(parsed?.signals) ? parsed.signals : [];
    const validAccountNames = new Set(safeAccounts.map(a => a.name.toLowerCase()));
    const accountLookup = new Map(safeAccounts.map(a => [a.name.toLowerCase(), a.name]));
    const fixedSignals = rawSignals.map(s => {
      const name = clean(s.accountName || s.account || s.company || '');
      const exact = accountLookup.get(name.toLowerCase());
      if (exact) return { ...s, accountName: exact };
      // Fuzzy map if the model adds parentheticals or suffixes.
      const lower = name.toLowerCase();
      const found = safeAccounts.find(a => lower.includes(a.name.toLowerCase()) || a.name.toLowerCase().includes(lower));
      return found ? { ...s, accountName: found.name } : s;
    });

    const signals = dedupeSignals(fixedSignals.map(s => {
      const account = safeAccounts.find(a => a.name.toLowerCase() === clean(s.accountName || s.account || s.company || '').toLowerCase()) || {};
      return makeSignal(s, account, { enableProspectQuality: mode === 'prospect-intelligence' });
    }).filter(Boolean).filter(s => validAccountNames.has(String(s.accountName || '').toLowerCase()))).slice(0, 80);
    const byAccount = {};
    for (const sig of signals) {
      if (!byAccount[sig.accountName]) byAccount[sig.accountName] = [];
      if (byAccount[sig.accountName].length < 4) byAccount[sig.accountName].push(sig);
    }
    Object.keys(byAccount).forEach(name => { byAccount[name] = byAccount[name].sort((a,b)=>Number(b.confidenceScore||0)-Number(a.confidenceScore||0)).slice(0,2); });
    if (mode === 'prospect-intelligence') {
      for (const account of safeAccounts) {
        if (!byAccount[account.name] || !byAccount[account.name].length) {
          byAccount[account.name] = [makePredictableTimingSignal(account)];
        }
      }
    }
    const finalSignals = Object.values(byAccount).flat().sort((a,b) => {
      const af = a.isFallbackOpportunity ? 1 : 0;
      const bf = b.isFallbackOpportunity ? 1 : 0;
      if (af !== bf) return af - bf;
      return Number(b.confidenceScore || 0) - Number(a.confidenceScore || 0);
    });
    const avgConfidence = finalSignals.length ? Math.round(finalSignals.reduce((sum, s) => sum + Number(s.confidenceScore || 0), 0) / finalSignals.length) : 0;

    return res.status(200).json({
      signals: finalSignals,
      byAccount,
      diagnostics: {
        elapsedMs: Date.now() - startedAt,
        model,
        providerMode,
        accountsReceived: accounts.length,
        accountsResearched: safeAccounts.length,
        rankedCandidates: candidates.length,
        rawSignals: rawSignals.length,
        signalsDiscovered: rawSignals.length,
        signalsRejected: Math.max(0, rawSignals.length - finalSignals.length),
        signalsReturned: finalSignals.length,
        highConfidenceOpportunities: finalSignals.filter(s => !s.isFallbackOpportunity && Number(s.confidenceScore || 0) >= 80).length,
        mediumConfidenceOpportunities: finalSignals.filter(s => !s.isFallbackOpportunity && Number(s.confidenceScore || 0) >= 60 && Number(s.confidenceScore || 0) < 80).length,
        predictableTimingOpportunities: finalSignals.filter(s => s.isFallbackOpportunity).length,
        liveSignalsFound: finalSignals.filter(s => !s.isFallbackOpportunity).length,
        accountsWithSignals: new Set(finalSignals.filter(s => !s.isFallbackOpportunity).map(s => s.accountName)).size,
        accountsWithNoSignals: Math.max(0, safeAccounts.length - new Set(finalSignals.filter(s => !s.isFallbackOpportunity).map(s => s.accountName)).size),
        avgConfidence,
        webSearchEnabled: !hasSearchProvider,
        targetedSearchEnabled: hasSearchProvider,
        mode,
        sourceCoverage,
        candidateSamples,
        outputPreview: String(rawText || '').slice(0, 500)
      }
    });
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Batch research failed', diagnostics: { elapsedMs: Date.now() - startedAt } });
  }
}
