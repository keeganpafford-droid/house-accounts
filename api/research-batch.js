// Vercel Serverless Function: v36 targeted-search Opportunity Discovery Engine.
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

function queryTemplates(company, context = {}) {
  const loc = context.location ? ` ${context.location}` : '';
  const quoted = `"${company}"`;
  return [
    `${quoted}${loc} (acquired OR acquisition OR merger OR merged OR funding OR investment OR partnership OR "customer win")`,
    `${quoted}${loc} (hiring OR jobs OR careers OR "now hiring" OR recruiting OR "open positions")`,
    `${quoted}${loc} (summit OR conference OR expo OR exhibitor OR booth OR webinar OR event OR sponsor)`,
    `${quoted}${loc} (award OR "Inc. 5000" OR "fastest growing" OR "best places to work" OR recognition OR milestone)`,
    `${quoted}${loc} (launch OR unveiled OR rollout OR "new product" OR "new division" OR rebrand)`,
    `${quoted}${loc} (expansion OR "new office" OR "new location" OR facility OR headquarters OR warehouse OR manufacturing)`,
    `${quoted}${loc} (community OR charity OR fundraiser OR sponsorship OR sustainability OR volunteer OR donation)`,
    `${quoted}${loc} (CEO OR president OR "vice president" OR appointed OR named OR leadership)`
  ];
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
  if (/hiring|jobs|careers|now hiring|open positions|recruiting/.test(t)) score += 18;
  if (/summit|conference|expo|exhibitor|booth|event|sponsor|webinar/.test(t)) score += 20;
  if (/award|recognized|inc\.? 5000|fastest growing|best places to work|winner/.test(t)) score += 18;
  if (/launch|unveiled|rollout|new product|new division|rebrand/.test(t)) score += 18;
  if (/expansion|new office|new location|facility|headquarters|warehouse|manufacturing/.test(t)) score += 20;
  if (/acquired|acquisition|merger|funding|investment|partnership|customer win|contract/.test(t)) score += 18;
  if (/community|charity|fundraiser|sustainability|volunteer|donation/.test(t)) score += 14;
  if (/2026|2025|today|yesterday|this week|recently|announced|upcoming|now/.test(t)) score += 10;
  if (/contact us|about us|privacy|terms|map|directions/.test(t)) score -= 20;
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

async function discoverCandidatesForAccounts(accounts = []) {
  const sourceCoverage = {};
  const allCandidates = [];
  const samples = [];
  const perAccount = await mapLimit(accounts, 5, async account => {
    const queries = queryTemplates(account.name, account).slice(0, 8);
    const resultSets = await Promise.all(queries.map(runSearch));
    const raw = resultSets.flat();
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
  const prompt = `Research the following companies for business signals related to buying promotional products: ${accounts.map(a => a.name).join(', ')}.

For each company, look for recent public developments: acquisitions, hiring, events, summits, conferences, awards, Inc. 5000 or fastest-growing lists, product launches, partnerships, expansion, new offices, funding, community initiatives, customer wins, or leadership changes.

Then identify whether each development creates a legitimate reason for a promotional products salesperson to start a conversation. Return JSON only with this shape: {"signals":[{"accountName":"","signalType":"","signalTitle":"","whatChanged":"","whyItMattersForPromo":"","likelyBuyers":[""],"likelyProducts":[""],"likelyConversations":[""],"suggestedOpener":"","sourceName":"","sourceUrl":"","sources":[{"name":"","url":""}],"publicationDate":"","confidence":0}]}. Return no signal for generic company descriptions.`;
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

function makeSignal(raw = {}) {
  const accountName = clean(raw.accountName || raw.account || raw.company || '');
  if (!accountName) return null;
  const confidencePct = confidenceNumber(raw.confidence || raw.opportunityScore || raw.score);
  if (confidencePct < 72) return null; // Still gated, but lets medium-confidence evidence appear for testing.
  const sourceUrl = clean(raw.sourceUrl || raw.url || raw.sources?.[0]?.url || '');
  const type = normalizeSignalType(raw.signalType || raw.opportunityType || raw.type);
  const title = compact(raw.signalTitle || raw.headline || raw.title || `${accountName} business activity`, 140);
  const summary = compact(raw.whatChanged || raw.shortSummary || raw.summary || raw.signalDetail || raw.details || title, 220);
  const why = compact(raw.whyItMattersForPromo || raw.whyReachOut || raw.whyItMatters || raw.why || 'Recent public business activity creates a timely reason to check in.', 260);
  const opener = compact(raw.suggestedOpener || raw.conversationStarter || raw.likelyConversation || 'Saw some recent activity and wanted to check in — anything coming up where support would be helpful?', 240);
  const buyers = safeArray(raw.likelyBuyers || raw.suggestedContacts || raw.suggestedContact || raw.contactRole, 4);
  const products = safeArray(raw.likelyProducts || raw.promoCategories || raw.commonPromoCategories || raw.likelyProductCategories, 6);
  const conversations = safeArray(raw.likelyConversations || raw.conversationThemes || raw.likelyConversation || raw.conversationAngle, 5);
  const sources = Array.isArray(raw.sources) ? raw.sources.map(s => ({ name: clean(s.name || s.sourceName || sourceDomain(s.url || '')), url: clean(s.url || s.sourceUrl || '') })).filter(s => s.url || s.name).slice(0, 4) : [];
  if (sourceUrl && !sources.some(s => s.url === sourceUrl)) sources.unshift({ name: clean(raw.sourceName || sourceDomain(sourceUrl) || 'Public source'), url: sourceUrl });
  return {
    accountName,
    isReal: true,
    signalLayerType: 'Business Activity Signal',
    type,
    signalType: type,
    opportunityType: type.toUpperCase().replace(/[^A-Z0-9]+/g, '_'),
    title,
    signalDetail: summary,
    shortSummary: summary,
    signalSnippet: summary,
    whatChanged: summary,
    evidence: `${sources[0]?.name || sourceDomain(sourceUrl) || clean(raw.sourceName || 'public source')}: ${summary}`,
    sourceUrl: sourceUrl || sources[0]?.url || '',
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
    reasonToReachOut: why,
    whyNow: why,
    whyItMattersForPromo: why,
    conversationStarter: opener,
    suggestedOpener: opener,
    suggestedContact: buyers[0] || clean(raw.suggestedContact || raw.contactRole || 'Relevant department lead'),
    likelyBuyers: buyers.length ? buyers : [clean(raw.suggestedContact || 'Relevant department lead')],
    affectedDepartment: clean(raw.likelyDepartment || raw.department || buyers[0] || ''),
    likelyConversations: conversations.length ? conversations : [compact(raw.likelyConversation || raw.conversationAngle || why, 90)].filter(Boolean),
    likelyProducts: products,
    commonPromoCategories: products,
    opportunityCategory: compact(raw.opportunityCategory || conversations[0] || type, 90),
    opportunityExplanation: compact(raw.whyItMattersForPromo || raw.whyItMatters || why, 260),
    valueSource: 'AI Opportunity Discovery',
    aiQualified: true,
    source: 'targeted-search-ai'
  };
}

function dedupeSignals(signals = []) {
  const seen = new Set();
  const out = [];
  for (const sig of signals) {
    if (!sig || !sig.accountName) continue;
    const key = `${sig.accountName}|${sig.signalType}|${sourceDomain(sig.sourceUrl || '')}|${clean(sig.signalDetail || sig.title || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').slice(0, 90)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(sig);
  }
  return out;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const startedAt = Date.now();
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return res.status(400).json({ error: 'OPENAI_API_KEY not configured' });

  try {
    const { accounts = [], mode = 'ranked' } = req.body || {};
    const safeAccounts = (Array.isArray(accounts) ? accounts : [])
      .filter(a => a && a.name)
      .slice(0, 50)
      .map((a, idx) => ({
        id: String(idx),
        name: clean(a.name),
        industry: clean(a.industry || ''),
        location: clean(a.cityState || a.location || ''),
        cityState: clean(a.cityState || a.location || ''),
        notes: clean(a.notes || ''),
        website: clean(a.website || ''),
        categories: Array.isArray(a.categories) ? a.categories.slice(0, 10) : [],
        contacts: Array.isArray(a.contacts) ? a.contacts.slice(0, 6) : [],
        recentOrderDates: Array.isArray(a.recentOrderDates) ? a.recentOrderDates.slice(0, 5) : [],
        repeatPatterns: Array.isArray(a.repeatPatterns) ? a.repeatPatterns.slice(0, 5) : [],
        existingSignals: Array.isArray(a.existingSignals) ? a.existingSignals.slice(0, 5) : [],
        relationshipStrength: a.relationshipStrength || a.relationshipScore || '',
        quickWinScore: a.quickWinScore || '',
        revenue: Number(a.revenue || 0),
        orderCount: Number(a.orderCount || 0)
      }));
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
      const discovered = await discoverCandidatesForAccounts(safeAccounts);
      candidates = discovered.candidates;
      sourceCoverage = discovered.sourceCoverage;
      candidateSamples = discovered.samples.slice(0, 16);
      const enriched = await enrichCandidatesWithFirecrawl(candidates);
      candidates = enriched.candidates;
      if (enriched.scrapedCount) sourceCoverage.firecrawl = enriched.scrapedCount;
    }

    let parsed = null;
    if (candidates.length) {
      const synthesisPrompt = `You are the Opportunity Discovery Engine for House Accounts, a tool for promotional products distributors.

You are given account context plus targeted public web search snippets. Your job is to identify only legitimate business signals that create a reason for a promo salesperson to contact the account in the next 90 days.

Think like a senior promotional products account executive. Do not summarize companies. Do not invent facts. Use the provided snippets and URLs.

Return only strong opportunities. Good triggers include: event marketing, trade shows, summits, conferences, awards, fastest-growing lists, hiring/recruiting, product launches, rebrands, expansion, new locations, partnerships, customer wins, funding, acquisitions, community initiatives, safety initiatives, employee engagement, and leadership changes.

Also apply this red-flag filter: if the company was acquired by a large parent and buying power likely moved to corporate, downgrade or disqualify unless there is still a local promo reason.

For each opportunity, translate the business signal into promo sales language: likely buyers, likely products/categories, and a natural conversation starter.

Return strict JSON only with shape {"signals":[...]}.

Accounts:
${JSON.stringify(accountPromptContext(safeAccounts), null, 2)}

Candidate snippets:
${JSON.stringify(candidates.slice(0, 140).map(c => ({accountName:c.accountName, title:c.title, snippet:c.snippet, pageContent:c.pageContent || '', url:c.url, sourceType:c.sourceType, provider:c.provider, date:c.date, score:c.score})), null, 2)}

Each signal must include: accountName, signalType, signalTitle, whatChanged, whyItMattersForPromo, likelyBuyers, likelyProducts, likelyConversations, suggestedOpener, sourceName, sourceUrl, sources, publicationDate, confidence.`;
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

    const signals = dedupeSignals(fixedSignals.map(makeSignal).filter(Boolean).filter(s => validAccountNames.has(String(s.accountName || '').toLowerCase()))).slice(0, 80);
    const byAccount = {};
    for (const sig of signals) {
      if (!byAccount[sig.accountName]) byAccount[sig.accountName] = [];
      if (byAccount[sig.accountName].length < 2) byAccount[sig.accountName].push(sig);
    }
    const finalSignals = Object.values(byAccount).flat();
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
        highConfidenceOpportunities: finalSignals.length,
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
