// Vercel Serverless Function: verified public signal research.
// Uses public search plus optional OpenAI qualification when OPENAI_API_KEY is configured.
// Returns only source-backed signals.
// Endpoint: POST /api/research-account

const USER_AGENT = 'Mozilla/5.0 (compatible; HouseAccountsBot/0.3; +https://house-accounts.vercel.app)';

function clean(text = '') {
  return String(text)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeUrl(url) {
  try {
    if (!url) return '';
    const u = new URL(url, 'https://duckduckgo.com');
    const uddg = u.searchParams.get('uddg');
    return uddg ? decodeURIComponent(uddg) : u.href;
  } catch {
    return url || '';
  }
}

function classifySource(url = '', title = '') {
  const t = `${url} ${title}`.toLowerCase();
  if (/linkedin\.com/.test(t)) return 'LinkedIn / public company profile';
  if (/facebook\.com|instagram\.com|x\.com|twitter\.com/.test(t)) return 'Public social post';
  if (/indeed\.com|ziprecruiter\.com|glassdoor\.com|bebee\.com|jobs|career|careers/.test(t)) return 'Careers / job posting';
  if (/press|news|release|announcement|blog/.test(t)) return 'News / press source';
  if (/event|conference|expo|show|summit/.test(t)) return 'Event source';
  if (/\.gov|chamber|businesswire|prnewswire/.test(t)) return 'Public / press listing';
  return 'Public web source';
}

function cleanSourceName(url = '') {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '');
    return host || 'public source';
  } catch {
    return 'public source';
  }
}

function cleanSignalSummary(result = {}, max = 150) {
  const rawTitle = stripBadFragments(result.title || '');
  const rawSnippet = stripBadFragments(result.snippet || '');
  if (isBadSearchText(`${rawTitle} ${rawSnippet}`)) return '';
  const title = rawTitle.replace(/\s*[|•-]\s*.*$/, '').trim();
  const preferred = title && title.length >= 8 ? title : rawSnippet;
  const cleaned = compactSentence(preferred, max);
  return cleaned || '';
}

function extractPublicationDate(text = '') {
  const raw = clean(text);
  const iso = raw.match(/\b20\d{2}-\d{2}-\d{2}\b/);
  if (iso) return iso[0];
  const month = raw.match(/\b(January|February|March|April|May|June|July|August|September|October|November|December|Jan\.?|Feb\.?|Mar\.?|Apr\.?|Jun\.?|Jul\.?|Aug\.?|Sep\.?|Sept\.?|Oct\.?|Nov\.?|Dec\.?)\s+\d{1,2},?\s+20\d{2}\b/i);
  if (month) return month[0].replace(/\s+/g, ' ');
  const year = raw.match(/\b(20\d{2})\b/);
  return year ? year[1] : '';
}

function sourceQualityScore(sourceType = '', url = '') {
  const t = `${sourceType} ${url}`.toLowerCase();
  if (/businesswire|prnewswire|press release|news|press/.test(t)) return 0.90;
  if (/careers|job posting|jobs|career/.test(t)) return 0.82;
  if (/event|conference|expo|show|summit/.test(t)) return 0.80;
  if (/linkedin/.test(t)) return 0.70;
  if (/community|csr|award|blog/.test(t)) return 0.72;
  return 0.58;
}

function recencyScoreFromText(text = '') {
  const t = String(text || '').toLowerCase();
  if (/today|yesterday|this week|newly|recently|now hiring|current|upcoming/.test(t)) return 0.90;
  if (/2026|january|february|march|april|may|june|july|august|september|october|november|december/.test(t)) return 0.78;
  if (/2025/.test(t)) return 0.55;
  return 0.45;
}

function combinedConfidenceScore({ sourceType = '', url = '', text = '', aiScore = 0.68, multiSource = false } = {}) {
  const source = sourceQualityScore(sourceType, url);
  const recency = recencyScoreFromText(text);
  const multi = multiSource ? 0.85 : 0.45;
  return Math.min(0.94, Math.max(0.35, (source * 0.35) + (recency * 0.30) + (aiScore * 0.20) + (multi * 0.15)));
}

function confidenceLabelFromScore(score = 0.66) {
  if (score >= 0.78) return 'High';
  if (score >= 0.58) return 'Medium';
  return 'Low';
}

function sourceConfidence(sourceType, title = '', snippet = '', url = '') {
  const text = `${title} ${snippet} ${url}`.toLowerCase();
  let score = combinedConfidenceScore({ sourceType, url, text, aiScore: 0.66, multiSource: false });
  if (/(hiring|open positions|new facility|grand opening|announced|event|conference|launch|careers|jobs|award|recognized|expansion)/i.test(text)) score += 0.04;
  if (isBadSearchText(text)) score -= 0.20;
  return Math.min(0.90, Math.max(0.35, score));
}

async function fetchText(url, timeoutMs = 6500) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, 'Accept': 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8' },
      redirect: 'follow',
      signal: controller.signal
    });
    if (!res.ok) return '';
    const contentType = res.headers.get('content-type') || '';
    if (!/text|html|xml|json/i.test(contentType)) return '';
    return await res.text();
  } catch {
    return '';
  } finally {
    clearTimeout(timer);
  }
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
    return compactSentence(text, 1800);
  } catch { return ''; }
}

async function enrichCandidatesWithFirecrawl(candidates = [], limit = 8) {
  if (!process.env.FIRECRAWL_API_KEY) return { candidates, scrapedCount: 0 };
  const selected = [];
  const seen = new Set();
  for (const c of candidates) {
    if (selected.length >= limit) break;
    if (!c.url || /linkedin\.com|facebook\.com|instagram\.com|x\.com|twitter\.com|pdf/i.test(c.url)) continue;
    const key = c.url.split('#')[0].toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    selected.push(c);
  }
  const scraped = await mapLimit(selected, 5, async c => ({ key: c.url.split('#')[0].toLowerCase(), content: await firecrawlScrape(c.url) }));
  const contentMap = new Map((scraped || []).filter(x => x && x.content).map(x => [x.key, x.content]));
  let scrapedCount = 0;
  const enriched = candidates.map(c => {
    const content = contentMap.get((c.url || '').split('#')[0].toLowerCase());
    if (!content) return c;
    scrapedCount++;
    return { ...c, pageContent: content, snippet: compactSentence(`${c.snippet || ''}

Page content: ${content}`, 2200), provider: `${c.provider || c.discoverySource || 'search'}+firecrawl` };
  });
  return { candidates: enriched, scrapedCount };
}

async function mapLimit(items, limit, mapper) {
  const results = new Array(items.length);
  let idx = 0;
  async function worker() {
    while (idx < items.length) {
      const current = idx++;
      try { results[current] = await mapper(items[current], current); }
      catch { results[current] = null; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}


async function ddgSearch(query) {
  const urls = [
    `https://duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
    `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`
  ];

  const results = [];
  for (const searchUrl of urls) {
    const html = await fetchText(searchUrl);
    if (!html) continue;

    let m;

    // Standard DuckDuckGo HTML result format.
    const rich = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?(?:<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>|<div[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/div>)/g;
    while ((m = rich.exec(html)) && results.length < 10) {
      const sourceUrl = normalizeUrl(m[1]);
      if (!sourceUrl || /duckduckgo\.com/.test(sourceUrl)) continue;
      results.push({ url: sourceUrl, title: clean(m[2]), snippet: clean(m[3] || m[4] || '') });
    }

    // Lite DuckDuckGo format often just uses result-link anchors.
    const lite = /<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
    while ((m = lite.exec(html)) && results.length < 10) {
      const sourceUrl = normalizeUrl(m[1]);
      const title = clean(m[2]);
      if (!sourceUrl || /duckduckgo\.com|javascript:|^#/.test(sourceUrl)) continue;
      if (!title || title.length < 4) continue;
      results.push({ url: sourceUrl, title, snippet: '' });
    }

    if (results.length) break;
  }

  // Dedupe URLs.
  const seen = new Set();
  return results.filter(r => {
    const key = r.url.split('#')[0];
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 8);
}



async function serperSearch(query) {
  const apiKey = process.env.SERPER_API_KEY;
  if (!apiKey) return [];
  try {
    const res = await fetch('https://google.serper.dev/search', {
      method: 'POST',
      headers: { 'X-API-KEY': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ q: query, num: 8 })
    });
    if (!res.ok) return [];
    const data = await res.json();
    return [...(data.organic || []), ...(data.news || [])].map(item => ({
      url: item.link || item.url || '',
      title: clean(item.title || ''),
      snippet: clean(item.snippet || item.description || ''),
      provider: 'serper'
    })).filter(r => r.url && (r.title || r.snippet)).slice(0, 8);
  } catch { return []; }
}

async function braveSearch(query) {
  const apiKey = process.env.BRAVE_SEARCH_API_KEY;
  if (!apiKey) return [];
  try {
    const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=8&freshness=py`;
    const res = await fetch(url, {
      headers: {
        'X-Subscription-Token': apiKey,
        'Accept': 'application/json'
      }
    });
    if (!res.ok) return [];
    const data = await res.json();
    const items = data?.web?.results || [];
    return items.map(item => ({
      url: item.url,
      title: clean(item.title || ''),
      snippet: clean(item.description || item.extra_snippets?.join(' ') || ''),
      provider: 'brave'
    })).filter(r => r.url && r.title).slice(0, 8);
  } catch {
    return [];
  }
}

async function tavilySearch(query) {
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) return [];
  try {
    const res = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: apiKey,
        query,
        search_depth: 'basic',
        max_results: 8,
        include_answer: false,
        include_raw_content: false
      })
    });
    if (!res.ok) return [];
    const data = await res.json();
    const items = data?.results || [];
    return items.map(item => ({
      url: item.url,
      title: clean(item.title || ''),
      snippet: clean(item.content || ''),
      provider: 'tavily'
    })).filter(r => r.url && (r.title || r.snippet)).slice(0, 8);
  } catch {
    return [];
  }
}

async function webSearch(query) {
  // Paid search APIs are optional but far more reliable than scraping search-result pages.
  // Priority: Brave/Tavily if configured, then DuckDuckGo fallback.
  const [serper, brave, tavily] = await Promise.all([serperSearch(query), braveSearch(query), tavilySearch(query)]);
  const paid = dedupeCandidates([...serper, ...brave, ...tavily]);
  if (paid.length) return paid;
  return ddgSearch(query);
}


function compactSentence(text = '', max = 220) {
  const cleaned = clean(text).replace(/\s+/g, ' ').trim();
  if (!cleaned) return '';
  return cleaned.length > max ? cleaned.slice(0, max).replace(/\s+\S*$/, '') + '…' : cleaned;
}

function isBadSearchText(text = '') {
  const t = clean(text).toLowerCase();
  if (!t) return true;
  return /javascript disabled|enable javascript|unsupported browser|does not support|map contact saved|saved saved|access denied|captcha|cookies disabled|privacy preferences|robot check|are you a robot/.test(t);
}

function stripBadFragments(text = '') {
  let t = clean(text);
  t = t.replace(/[-–—>\s]*You have JavaScript disabled or are viewing the site on a device that does not support[^.]*\.?/ig, ' ');
  t = t.replace(/[-–—>\s]*Press\s*-\s*/ig, ' ');
  t = t.replace(/\bContact Saved Saved\b/ig, ' ');
  t = t.replace(/\bMap Contact Saved\b/ig, ' ');
  t = t.replace(/\s+/g, ' ').trim();
  return t;
}

function hostPath(url = '') {
  try {
    const u = new URL(url);
    return `${u.hostname.replace(/^www\./,'')}${u.pathname || ''}`.toLowerCase();
  } catch { return ''; }
}

function looksLikeGenericHomepage(result = {}, accountName = '') {
  const path = hostPath(result.url || '');
  const title = clean(result.title || '').toLowerCase();
  const snippet = clean(result.snippet || '').toLowerCase();
  const acct = clean(accountName).toLowerCase();
  const shallowPath = /\.(com|net|org|io|co|biz)\/?$/.test(path) || /\/(about|contact|locations?)\/?$/.test(path);
  const genericTitle = acct && title && title.includes(acct) && !/(career|job|hiring|news|press|event|conference|expo|award|recognized|expansion|opening|launch|announces|leadership)/.test(title);
  const genericSnippet = /(home|contact us|hours|directions|map|phone|sales|service|parts)/.test(snippet) && !/(career|job|hiring|open position|news|press|event|conference|expo|award|recognized|expansion|opening|launch|announces|appoints|promotes)/.test(snippet);
  return shallowPath && (genericTitle || genericSnippet);
}

function hasStrongSignalContext(text = '', url = '') {
  const t = `${text} ${url}`.toLowerCase();
  return /(career|careers|hiring|jobs|join our team|open position|openings|recruit|now hiring|apply now|event|conference|expo|trade show|summit|open house|sponsorship|new location|expansion|grand opening|new facility|renovation|relocation|award|recognized|winner|honor|best of|milestone|anniversary|appoints|promotes|named|joins as|new ceo|new president|new director|launch|new product|new service|announces|unveils)/.test(t);
}

function extractHiringRole(text = '', industry = '') {
  const t = `${text} ${industry}`.toLowerCase();
  if (/technician|mechanic|service advisor|service department/.test(t)) return 'technicians or service roles';
  if (/sales consultant|sales rep|business development|account executive/.test(t)) return 'sales roles';
  if (/production|operator|machinist|cnc|assembly|warehouse|plant|manufacturing/.test(t)) return 'production or operations roles';
  if (/engineer|engineering/.test(t)) return 'engineering roles';
  if (/nurse|provider|clinical|dental assistant|hygienist/.test(t)) return 'clinical or practice roles';
  return '';
}

function signalConfidenceLabel(signalType = '', result = {}, count = null) {
  const raw = `${result.title || ''} ${result.snippet || ''} ${result.url || ''}`;
  const sourceType = classifySource(result.url, result.title);
  let level = 'Medium';
  if (count || /press release|businesswire|prnewswire|event|conference|expo|open positions|job posting|careers|new facility|grand opening|award|winner|appointed/i.test(raw)) level = 'High';
  if (/Public web source/i.test(sourceType) && !count) level = 'Medium';
  if (isBadSearchText(raw) || looksLikeGenericHomepage(result)) level = 'Low';
  return level;
}

function confidenceNumberFromLabel(label = 'Medium') {
  if (/high/i.test(label)) return 0.82;
  if (/low/i.test(label)) return 0.48;
  return 0.66;
}

function cleanSignalDetailFromResult(result = {}, accountName = '', signalType = '', industry = '') {
  const rawTitle = stripBadFragments(result.title || '');
  const rawSnippet = stripBadFragments(result.snippet || '');
  const raw = `${rawTitle} ${rawSnippet}`;
  const count = extractCounts(raw);
  const role = extractHiringRole(raw, industry);
  const source = cleanSourceName(result.url);
  const acct = clean(accountName);

  if (/hiring/i.test(signalType)) {
    if (count && role) return `${acct} appears to be hiring ${count} ${role}.`;
    if (count) return `${acct} appears to be hiring or listing ${count} roles.`;
    if (role) return `${acct} has hiring activity tied to ${role}.`;
    return `${acct} has public careers or recruiting activity.`;
  }
  if (/event|conference/i.test(signalType)) {
    const title = compactSentence(rawTitle.replace(new RegExp(acct, 'ig'), '').trim(), 80);
    return title ? `${acct} has event or campaign activity: ${title}.` : `${acct} has public event or campaign activity.`;
  }
  if (/expansion|location/i.test(signalType)) return `${acct} has public growth, expansion, or location activity.`;
  if (/award|recognition/i.test(signalType)) return `${acct} has public recognition, award, or milestone activity.`;
  if (/leadership/i.test(signalType)) return `${acct} has public leadership or team-change activity.`;
  if (/launch/i.test(signalType)) return `${acct} has public product, service, or campaign-launch activity.`;

  const fallback = compactSentence(rawTitle || rawSnippet, 90);
  return fallback ? `${acct}: ${fallback}.` : `Public business activity found on ${source}.`;
}

function extractCounts(text = '') {
  const t = String(text || '');
  const matches = [...t.matchAll(/\b(\d{1,4})\s+(?:new\s+)?(?:employees|hires|openings|positions|jobs|roles|technicians|workers|associates|operators|engineers|sales consultants)\b/gi)]
    .map(m => Number(m[1]))
    .filter(n => Number.isFinite(n) && n > 0);
  return matches.length ? Math.max(...matches) : null;
}

function detectDepartment(text = '', industry = '') {
  const t = `${text} ${industry}`.toLowerCase();
  if (/technician|service advisor|service department|mechanic|parts/.test(t)) return 'Service / Operations';
  if (/production|manufactur|operator|machinist|cnc|warehouse|assembly|plant|facility|safety/.test(t)) return 'Operations / Production';
  if (/sales consultant|sales rep|business development|account executive/.test(t)) return 'Sales';
  if (/marketing|event|conference|expo|trade show|campaign/.test(t)) return 'Marketing / Events';
  if (/hr|people|talent|recruit|hiring|careers/.test(t)) return 'HR / People';
  if (/provider|doctor|nurse|clinical|dental|practice/.test(t)) return 'Clinical / Practice Operations';
  return 'Relevant department';
}

function contactForSignal(signalType = '', department = '', industry = '') {
  const combo = `${signalType} ${department} ${industry}`.toLowerCase();
  if (/service|technician|mechanic/.test(combo)) return 'Service Director / HR Manager';
  if (/production|operations|plant|safety|warehouse/.test(combo)) return 'Operations Manager / Safety Manager / HR Manager';
  if (/event|trade show|marketing|conference/.test(combo)) return 'Marketing Manager / Events Lead';
  if (/leadership|award|recognition/.test(combo)) return 'Marketing Manager / HR Manager';
  if (/sales/.test(combo)) return 'Sales Manager / HR Manager';
  if (/clinical|practice|provider/.test(combo)) return 'Practice Manager / HR Manager';
  return 'HR Manager / Department Lead';
}

function opportunityForSignal(signalType = '', department = '', industry = '') {
  const combo = `${signalType} ${department} ${industry}`.toLowerCase();
  if (/event|trade show|conference|expo|show/.test(combo)) {
    return {
      category: 'Trade Show / Event Support',
      name: 'Trade Show / Event Merchandise Program',
      products: ['booth giveaways', 'staff apparel', 'attendee gifts', 'signage'],
      explanation: 'A public event creates a timely reason to ask about booth traffic, staff presentation, attendee giveaways, and customer follow-up.',
      reasonToReachOut: 'Event activity creates a timely reason to check in',
      conversationStarter: 'Ask whether the upcoming event or campaign needs staff apparel, attendee gifts, or customer-facing merch.'
    };
  }
  if (/new location|expansion|facility|opening|grand opening/.test(combo)) {
    return {
      category: 'Facility / Location Launch',
      name: 'New Location Launch Kit',
      products: ['grand opening gifts', 'location-branded apparel', 'employee welcome kits', 'customer gifts'],
      explanation: 'Expansion or location activity creates a timely reason to ask about launch merchandise, employee gear, and customer-facing gifts.',
      reasonToReachOut: 'Growth activity creates a timely reason to check in',
      conversationStarter: 'Ask whether the growth activity creates any need for launch merch, employee gear, or customer gifts.'
    };
  }
  if (/award|recognized|recognition|milestone|anniversary/.test(combo)) {
    return {
      category: 'Recognition / Celebration',
      name: 'Recognition & Celebration Program',
      products: ['employee gifts', 'award apparel', 'thank-you kits', 'announcement mailers'],
      explanation: 'Recognition creates a natural opening to ask about employee celebration, customer announcements, and internal culture moments.',
      reasonToReachOut: 'Recognition creates a timely reason to check in',
      conversationStarter: 'Ask whether there are any employee, customer, or team appreciation moments coming up.'
    };
  }
  if (/leadership|appoint|promote|named|joins/.test(combo)) {
    return {
      category: 'Leadership Transition',
      name: 'New Leader Welcome / Team Culture Kit',
      products: ['welcome gifts', 'team apparel', 'executive gifts', 'internal announcement kits'],
      explanation: 'Leadership changes create a light-touch reason to ask about internal communication, team culture, or executive gifting.',
      reasonToReachOut: 'Leadership change creates a timely reason to check in',
      conversationStarter: 'Ask whether the leadership change connects to any team engagement, recognition, or internal brand moments.'
    };
  }
  if (/product|service launch|launch|unveil|release/.test(combo)) {
    return {
      category: 'Product / Service Launch',
      name: 'Product Launch Merchandise Kit',
      products: ['launch giveaways', 'sales team apparel', 'customer gifts', 'sample kits'],
      explanation: 'Launch activity creates a timely reason to ask about campaign merchandise, sales enablement, and customer-facing giveaways.',
      reasonToReachOut: 'Launch activity creates a timely reason to check in',
      conversationStarter: 'Ask whether the product or service launch needs any sales, customer, or campaign support.'
    };
  }
  if (/service|technician/.test(combo)) {
    return {
      category: 'Service Team Onboarding',
      name: 'Technician / Service Team Onboarding Program',
      products: ['uniform starter kits', 'service apparel', 'name-badge ready apparel', 'welcome kits'],
      explanation: 'Service hiring creates a practical reason to ask about uniforms, onboarding, and department apparel.',
      reasonToReachOut: 'Service team activity creates a timely reason to check in',
      conversationStarter: 'Ask who handles apparel or onboarding gear for the service team.'
    };
  }
  if (/production|operations|plant|safety|warehouse|manufactur/.test(combo)) {
    return {
      category: 'Workforce Onboarding / Safety',
      name: 'Production Team Onboarding & Safety Program',
      products: ['safety onboarding kits', 'department apparel', 'hi-vis items', 'recruiting giveaways'],
      explanation: 'Manufacturing or operations hiring creates a timely reason to ask about safety onboarding, apparel, and recruiting support.',
      reasonToReachOut: 'Workforce activity creates a timely reason to check in',
      conversationStarter: 'Ask how the team is handling onboarding, safety, or recruiting support for new employees.'
    };
  }
  return {
    category: 'Employee Onboarding',
    name: 'New Hire Onboarding Program',
    products: ['new hire welcome kits', 'employee apparel', 'drinkware', 'recruiting giveaways'],
    explanation: 'Hiring creates a timely reason to ask about onboarding, recruiting, and employee welcome programs.',
    reasonToReachOut: 'Hiring creates a timely reason to check in',
    conversationStarter: 'Ask how they are handling onboarding, apparel, or employee experience for new hires.'
  };
}

function valueRangeForSignal(signalType = '', count = null, sourceType = '') {
  const t = `${signalType} ${sourceType}`.toLowerCase();
  let low = 1000, high = 3000;
  if (/event|trade show|conference|expo/.test(t)) { low = 2500; high = 10000; }
  else if (/expansion|new location|facility/.test(t)) { low = 3000; high = 15000; }
  else if (/award|recognition|leadership/.test(t)) { low = 1500; high = 6000; }
  else if (/hiring|careers|job/.test(t)) {
    if (count && count >= 100) { low = 10000; high = 35000; }
    else if (count && count >= 25) { low = 4000; high = 15000; }
    else if (count && count >= 5) { low = 1500; high = 7500; }
    else { low = 1000; high = 5000; }
  }
  return { low, high, label: `$${low.toLocaleString()}–$${high.toLocaleString()}`, source: count ? 'Signal volume benchmark' : 'Industry benchmark range' };
}

function buildSignalIntelligence(result, accountName, signalType, industry = '') {
  const raw = `${result.title || ''} ${result.snippet || ''}`;
  const count = extractCounts(raw);
  const department = detectDepartment(raw, industry);
  const sourceType = classifySource(result.url, result.title);
  const sourceName = cleanSourceName(result.url);
  const opp = opportunityForSignal(signalType, department, industry);
  const valueRange = valueRangeForSignal(signalType, count, sourceType);
  const shortSummary = cleanSignalSummary(result, 150);

  const signalDetail = cleanSignalDetailFromResult(result, accountName, signalType, industry);
  const whyNow = `${signalDetail} ${opp.conversationStarter}`.trim();
  return {
    signalLayerType: 'Business Activity Signal',
    signalDetail,
    count,
    affectedDepartment: department,
    suggestedContact: contactForSignal(signalType, department, industry),
    opportunityCategory: opp.category,
    promoOpportunity: opp.name,
    suggestedProducts: opp.products,
    opportunityExplanation: opp.explanation,
    reasonToReachOut: opp.reasonToReachOut,
    conversationStarter: opp.conversationStarter,
    signalSnippet: shortSummary,
    shortSummary,
    cleanSourceName: sourceName,
    valueSource: 'Signal Only',
    estimatedValueRange: valueRange,
    whyNow,
    sourceAuthority: sourceType
  };
}

function makeSignal(result, accountName, signalType, title, opportunityExplanation, suggestedContact, confidenceBoost = 0, industry = '') {
  const sourceType = classifySource(result.url, result.title);
  const intelligence = buildSignalIntelligence(result, accountName, signalType, industry);
  const label = signalConfidenceLabel(signalType, result, intelligence.count);
  const confidence = Math.min(0.90, Math.max(0.35, confidenceNumberFromLabel(label) + confidenceBoost));
  return {
    signalType,
    type: signalType,
    title: intelligence.promoOpportunity || title,
    signalLayerType: intelligence.signalLayerType,
    signalDetail: intelligence.signalDetail,
    shortSummary: intelligence.shortSummary,
    cleanSourceName: intelligence.cleanSourceName,
    evidence: `${intelligence.cleanSourceName}: ${intelligence.shortSummary}`,
    sourceUrl: result.url,
    sourceType,
    sourceAuthority: intelligence.sourceAuthority || sourceType,
    dateFound: new Date().toISOString().slice(0, 10),
    confidence,
    confidenceLevel: label,
    isReal: true,
    affectedDepartment: intelligence.affectedDepartment,
    suggestedContact: intelligence.suggestedContact || suggestedContact,
    opportunityCategory: intelligence.opportunityCategory,
    opportunityExplanation: intelligence.opportunityExplanation || opportunityExplanation,
    promoOpportunity: intelligence.promoOpportunity || title,
    suggestedProducts: intelligence.suggestedProducts || [],
    valueSource: intelligence.valueSource || 'Signal Only',
    estimatedValueRange: intelligence.estimatedValueRange,
    reasonToReachOut: intelligence.reasonToReachOut,
    conversationStarter: intelligence.conversationStarter,
    signalSnippet: intelligence.signalSnippet,
    whyNow: intelligence.whyNow
  };
}

function signalFromResult(result, accountName, industry = '') {
  if (!result || !result.url) return null;
  const rawText = `${result.title || ''} ${result.snippet || ''} ${result.url || ''}`;
  const text = rawText.toLowerCase();
  if (isBadSearchText(rawText)) return null;
  if (looksLikeGenericHomepage(result, accountName) && !hasStrongSignalContext(rawText, result.url)) return null;
  const isAuto = /dealership|ford|automotive|service|technician|vehicle|used car/.test(text) || /Automotive/.test(industry || '');
  const isHealthcare = /dental|medical|health|clinic|provider|practice/.test(text) || /Healthcare/.test(industry || '');
  const isMfg = /manufactur|industrial|factory|plant|safety|facility|production|assembly|engineering/.test(text) || /Manufacturing/.test(industry || '');

  if (/(career|careers|hiring|jobs|join our team|open position|openings|technician|sales consultant|recruit|now hiring|job opportunities|apply now)/i.test(text)) {
    return makeSignal(
      result,
      accountName,
      'Hiring Activity',
      `${accountName} hiring or careers activity`,
      isAuto
        ? 'Hiring creates a timely reason to pitch new-hire onboarding kits, sales or service apparel, and recruiting giveaways.'
        : isHealthcare
          ? 'Hiring creates a timely reason to pitch new-provider onboarding kits, staff apparel, and employee welcome gifts.'
          : isMfg
            ? 'Hiring creates a timely reason to pitch recruiting giveaways, department apparel, safety onboarding kits, and new-hire welcome gifts.'
            : 'Hiring creates a timely reason to pitch onboarding kits, recruiting giveaways, employee apparel, and welcome gifts.',
      isAuto ? 'HR Manager / Service Director / Sales Manager' : 'HR Manager / Department Lead',
      0.04,
      industry
    );
  }

  if (/(event|conference|expo|show|summit|festival|webinar|open house|customer event|sponsorship)/i.test(text)) {
    return makeSignal(
      result,
      accountName,
      'Events / Conferences',
      `${accountName} event or campaign activity`,
      'Events create a timely reason to pitch attendee gifts, booth giveaways, staff apparel, signage, and customer-facing promotional merchandise.',
      'Marketing Manager / Events Lead / Sales Manager',
      0.03,
      industry
    );
  }

  if (/(new location|expansion|expands|opening|grand opening|new facility|renovation|relocation|moved to|opens|capacity expansion)/i.test(text)) {
    return makeSignal(
      result,
      accountName,
      'Expansion / New Location',
      `${accountName} expansion or location activity`,
      'Expansion creates a timely reason to pitch grand opening kits, location-branded apparel, employee welcome kits, customer gifts, and local launch merchandise.',
      'Operations Manager / Marketing Manager / General Manager',
      0.04,
      industry
    );
  }

  if (/(launch|new product|announces|unveils|release|model|lineup|new service|new program|introduces)/i.test(text)) {
    return makeSignal(
      result,
      accountName,
      'Product / Service Launch',
      `${accountName} launch or announcement activity`,
      'Launch activity creates a timely reason to pitch campaign merchandise, customer giveaways, sales team apparel, and product-specific sales kits.',
      'Marketing Manager / Sales Manager',
      0.02,
      industry
    );
  }

  if (/(award|recognized|winner|honor|best of|certified|ranked|achievement|milestone|anniversary)/i.test(text)) {
    return makeSignal(
      result,
      accountName,
      'Awards / Recognition',
      `${accountName} award or recognition activity`,
      'Recognition creates a timely reason to pitch employee celebration gifts, customer announcement mailers, thank-you gifts, and internal culture merchandise.',
      'Marketing Manager / HR Manager',
      0,
      industry
    );
  }

  if (/(appoints|promotes|named|joins as|ceo|president|director|manager|leadership|new general manager|new vp)/i.test(text)) {
    return makeSignal(
      result,
      accountName,
      'Leadership Changes',
      `${accountName} leadership activity`,
      'Leadership changes create a reason to pitch new-leader welcome packages, internal announcement gifts, team culture merchandise, or executive client gifts.',
      'Executive Assistant / HR Manager / Marketing Manager',
      -0.02,
      industry
    );
  }

  return null;
}

function dedupeSignals(signals) {
  const seen = new Set();
  return signals
    .filter(s => s && s.isReal && s.sourceUrl)
    .filter(s => {
      const urlKey = canonicalUrlKey(s.sourceUrl || '');
      const summary = clean(`${s.signalType || ''} ${s.signalDetail || ''} ${s.shortSummary || ''} ${s.title || ''}`)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .split(' ')
        .filter(w => w.length > 3)
        .slice(0, 10)
        .join(' ');
      const key = `${s.signalType || s.type || 'signal'}|${urlKey}|${summary}`;
      const looseKey = `${s.signalType || s.type || 'signal'}|${urlKey}`;
      if (seen.has(key) || seen.has(looseKey)) return false;
      seen.add(key);
      seen.add(looseKey);
      return true;
    })
    .sort((a, b) => (b.confidence || 0) - (a.confidence || 0))
    .slice(0, 6);
}


function rejectionReason(result = {}, accountName = '') {
  const rawText = `${result.title || ''} ${result.snippet || ''} ${result.url || ''}`;
  if (isBadSearchText(rawText)) return 'Rejected: bad/generic browser or blocked-page text';
  if (looksLikeGenericHomepage(result, accountName) && !hasStrongSignalContext(rawText, result.url)) return 'Rejected: generic homepage/about/contact result';
  if (!hasStrongSignalContext(rawText, result.url)) return 'Rejected: no hiring/event/award/expansion/leadership/launch language';
  return 'Rejected: did not map cleanly to an accepted signal type';
}

function candidateSample(result = {}, accountName = '', signal = null) {
  return {
    title: compactSentence(result.title || result.snippet || 'Untitled result', 120),
    domain: cleanSourceName(result.url),
    sourceType: classifySource(result.url, result.title),
    status: signal ? `Accepted: ${signal.signalType || 'Business Activity Signal'}` : 'Rejected',
    reason: signal ? 'Accepted as business activity signal' : rejectionReason(result, accountName)
  };
}


function parseJsonLoose(text = '') {
  if (!text) return null;
  try { return JSON.parse(text); } catch {}
  const match = String(text).match(/\{[\s\S]*\}/);
  if (match) {
    try { return JSON.parse(match[0]); } catch {}
  }
  return null;
}

function safeCandidateForAI(result = {}, idx = 0) {
  const title = compactSentence(stripBadFragments(result.title || ''), 180);
  const snippet = compactSentence(stripBadFragments(result.snippet || ''), 1200);
  const pageContent = compactSentence(stripBadFragments(result.pageContent || ''), 1800);
  const url = result.url || '';
  const sourceType = classifySource(url, title);
  return {
    id: String(idx),
    title,
    snippet,
    pageContent,
    url,
    domain: cleanSourceName(url),
    sourceType,
    publicationDate: extractPublicationDate(`${title} ${snippet} ${pageContent}`)
  };
}

function signalTypeFromAI(type = '') {
  const t = String(type || '').toLowerCase();
  if (/hiring|job|career|recruit/.test(t)) return 'Hiring Activity';
  if (/event|conference|trade|expo|show|community|sponsor|fundrais/.test(t)) return 'Events / Conferences';
  if (/expansion|facility|location|growth|opening/.test(t)) return 'Expansion / New Location';
  if (/leader|ceo|president|director|appoint|promot|new hire/.test(t)) return 'Leadership Changes';
  if (/award|recognition|recognized|winner|milestone/.test(t)) return 'Awards / Recognition';
  if (/launch|product|service|announce/.test(t)) return 'Product / Service Launch';
  if (/acquisition|acquired|merger|funding/.test(t)) return 'Expansion / New Location';
  return 'Business Activity';
}

function confidenceFromAI(confidence = '') {
  if (typeof confidence === 'number') {
    const score = Math.max(0, Math.min(1, confidence > 1 ? confidence / 100 : confidence));
    return { label: confidenceLabelFromScore(score), score };
  }
  const c = String(confidence || '').toLowerCase();
  const n = c.match(/\d{1,3}/);
  if (n) {
    const score = Math.max(0, Math.min(1, Number(n[0]) / 100));
    return { label: confidenceLabelFromScore(score), score };
  }
  if (/high/.test(c)) return { label: 'High', score: 0.84 };
  if (/low/.test(c)) return { label: 'Low', score: 0.50 };
  return { label: 'Medium', score: 0.68 };
}

function normalizeSuggestedContactDetails(raw = {}, fallbackRole = '', candidate = {}) {
  const c = raw && typeof raw === 'object' ? raw : {};
  const name = clean(c.name || c.fullName || '');
  const title = clean(c.title || c.role || fallbackRole || '');
  const linkedin = clean(c.linkedin || c.linkedinUrl || '');
  const email = clean(c.email || c.companyEmail || c.publicEmail || '');
  const directPhone = clean(c.directPhone || c.direct_phone || c.phone || '');
  const companyPhone = clean(c.companyPhone || c.company_phone || '');
  const contactPage = clean(c.contactPage || c.contact_page || '');
  const sourcesUsed = (Array.isArray(c.sourcesUsed || c.sources_used) ? (c.sourcesUsed || c.sources_used) : [])
    .map(x => ({ name: clean(x?.name || x?.title || cleanSourceName(x?.url || '')), url: clean(x?.url || '') }))
    .filter(x => x.name || x.url).slice(0, 4);
  const candidateUrl = clean(candidate.url || '');
  if (candidateUrl && name && !sourcesUsed.some(x => x.url === candidateUrl)) sourcesUsed.unshift({ name: cleanSourceName(candidateUrl), url: candidateUrl });
  let confidence = clean(c.researchConfidence || c.confidence || '');
  if (!/^(high|medium|low)$/i.test(confidence)) confidence = name && title && (linkedin || email || candidateUrl) ? 'High' : name ? 'Medium' : 'Low';
  confidence = confidence.charAt(0).toUpperCase() + confidence.slice(1).toLowerCase();
  return {
    name, title,
    whyThisContact: clean(c.whyThisContact || c.reason || (name ? 'This person appears aligned with the team most likely to own the detected initiative.' : 'Start with the team most likely to own the detected initiative.')),
    linkedin, email, directPhone, companyPhone, contactPage, researchConfidence: confidence, sourcesUsed
  };
}

function makeAISignal(aiSignal = {}, candidate = {}, accountName = '', industry = '', multiSource = false) {
  const signalType = signalTypeFromAI(aiSignal.signalType || aiSignal.type);
  const aiConfidence = confidenceFromAI(aiSignal.confidence);
  const sourceResult = {
    url: candidate.url || aiSignal.sourceUrl || '',
    title: candidate.title || aiSignal.title || '',
    snippet: candidate.snippet || aiSignal.summary || aiSignal.whyItMatters || ''
  };
  const base = makeSignal(
    sourceResult,
    accountName,
    signalType,
    aiSignal.signalTitle || aiSignal.headline || aiSignal.signalType || `${accountName} business activity`,
    aiSignal.whyItMatters || aiSignal.whyReachOut || 'Public business activity creates a timely reason to check in.',
    aiSignal.suggestedContact || '',
    0,
    industry
  );

  const cleanSummary = compactSentence(aiSignal.shortSummary || aiSignal.summary || aiSignal.headline || aiSignal.signalTitle || candidate.title || candidate.snippet || '', 170);
  const whyReachOut = compactSentence(aiSignal.whyReachOut || aiSignal.whyItMatters || base.reasonToReachOut || 'Recent business activity creates a timely reason to check in.', 190);
  const opener = compactSentence(aiSignal.suggestedOpener || aiSignal.likelyConversation || aiSignal.conversationAngle || base.conversationStarter || 'Saw some recent activity and wanted to check in — anything coming up where support would be helpful?', 200);
  const sourceText = `${candidate.title || ''} ${candidate.snippet || ''} ${aiSignal.publicationDate || ''}`;
  const confidenceScore = combinedConfidenceScore({
    sourceType: candidate.sourceType || base.sourceType,
    url: candidate.url || base.sourceUrl,
    text: sourceText,
    aiScore: aiConfidence.score,
    multiSource
  });
  const conversations = Array.isArray(aiSignal.likelyConversations)
    ? aiSignal.likelyConversations.filter(Boolean).slice(0, 5)
    : String(aiSignal.likelyConversation || aiSignal.conversationAngle || '').split(/[;|]/).map(x => x.trim()).filter(Boolean).slice(0, 5);
  const recommendedBuyingTeam = Array.isArray(aiSignal.recommendedBuyingTeam) && aiSignal.recommendedBuyingTeam.length
    ? aiSignal.recommendedBuyingTeam.filter(Boolean).slice(0, 3)
    : [aiSignal.likelyDepartment || base.affectedDepartment || aiSignal.suggestedContact || base.suggestedContact].filter(Boolean).slice(0, 3);
  const suggestedContactDetails = normalizeSuggestedContactDetails(aiSignal.suggestedContactDetails || aiSignal.suggested_contact_details, aiSignal.suggestedContact || base.suggestedContact, candidate);

  return {
    ...base,
    signalType,
    type: signalType,
    title: aiSignal.signalTitle || aiSignal.headline || base.title,
    signalDetail: cleanSummary || base.signalDetail,
    shortSummary: cleanSummary || base.shortSummary,
    signalSnippet: cleanSummary || base.signalSnippet,
    evidence: `${candidate.domain || cleanSourceName(candidate.url)}: ${cleanSummary || candidate.title || 'Public source'}`,
    sourceUrl: candidate.url || base.sourceUrl,
    sourceType: candidate.sourceType || base.sourceType,
    sourceAuthority: candidate.sourceType || base.sourceAuthority,
    publishedDate: aiSignal.publicationDate || candidate.publicationDate || extractPublicationDate(sourceText),
    confidence: confidenceScore,
    confidenceLevel: confidenceLabelFromScore(confidenceScore),
    reasonToReachOut: whyReachOut,
    conversationStarter: opener,
    whyNow: whyReachOut,
    suggestedContact: suggestedContactDetails.name || aiSignal.suggestedContact || base.suggestedContact,
    suggestedContactDetails,
    recommendedBuyingTeam,
    likelyBuyers: recommendedBuyingTeam,
    affectedDepartment: aiSignal.likelyDepartment || aiSignal.affectedDepartment || base.affectedDepartment,
    likelyConversations: conversations,
    opportunityCategory: aiSignal.opportunityCategory || (conversations[0] || base.opportunityCategory),
    opportunityExplanation: aiSignal.whyItMatters || base.opportunityExplanation,
    aiQualified: true,
    valueSource: 'AI-qualified public signal'
  };
}

async function aiQualifyBusinessSignals(accountName, industry, candidates = [], suppliedContactName = '') {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey || !candidates.length) {
    return { enabled: Boolean(apiKey), signals: [], rawCount: 0, error: apiKey ? '' : 'OPENAI_API_KEY not configured' };
  }

  const safeCandidates = candidates
    .filter(c => c && c.url && !isBadSearchText(`${c.title} ${c.snippet}`))
    .slice(0, 12)
    .map(safeCandidateForAI);

  if (!safeCandidates.length) return { enabled: true, signals: [], rawCount: 0, error: 'No usable candidates for AI qualification' };

  const prompt = `You are the Opportunity Discovery Engine for House Accounts, a tool built for promotional products distributors.

Account: ${accountName}
Industry: ${industry || 'Unknown'}
User-supplied contact to verify first, if any: ${suppliedContactName || 'None'}

Your job is NOT to summarize the company.
Your job is to think like an elite promotional-products sales rep and answer one question:

"If I sold promotional products, branded apparel, uniforms, awards, print, onboarding kits, trade-show materials, safety incentives, recognition programs, customer gifts, or corporate merchandise, is there anything happening at this company that creates a legitimate reason to start a conversation in the next 90 days?"

Use the candidate public sources below. First identify what changed. Then translate only the strongest developments into promo-relevant sales conversations.

Consider signals such as hiring, expansion, new facilities, trade shows, conferences, awards, product launches, partnerships, acquisitions, funding, leadership changes, community initiatives, safety initiatives, sustainability, employee engagement, rebrands, major customer wins, and government contracts.

Reject generic About pages, Contact pages, homepages, SEO snippets, navigation text, stale news, and anything that does not create a natural reason to reach out.

Important rules:
- Return at most 2 opportunities.
- Only return opportunities with confidence >= 80.
- If there is no strong opportunity, return {"signals":[]}.
- Do not invent facts.
- Do not stop at "they are hiring". Translate why it matters to promo.
- If a user-supplied contact is provided, verify that person first and prefer them only when the sources support their company and role.
- Surface public contact information only when it appears in the supplied candidates or page content. Never invent emails, phone numbers, LinkedIn URLs, or contact pages.
- Research confidence describes verification quality, not buying intent.

Return strict JSON only with this shape:
{
  "signals": [
    {
      "candidateId": "0",
      "signalType": "Hiring | Expansion | New Facility | Trade Show | Conference | Award | Leadership Change | Product Launch | Partnership | Acquisition | Community Initiative | Government Contract | Funding | Rebrand | Major Initiative",
      "signalTitle": "short human-readable headline",
      "whatChanged": "one specific sentence about the public business development",
      "whyItMattersForPromo": "one clear sentence explaining why this creates a reason for a promo rep to reach out",
      "likelyBuyers": ["likely buyer roles"],
      "likelyProducts": ["uniforms", "welcome kits", "trade show giveaways"],
      "likelyConversations": ["short conversation themes"],
      "suggestedOpener": "one natural sentence a rep could say or email",
      "suggestedContact": "likely role to contact",
      "recommendedBuyingTeam": ["likely department/team"],
      "suggestedContactDetails": {
        "name": "verified public person name or empty string",
        "title": "verified public title or inferred title",
        "whyThisContact": "one short reason this person or role fits the signal",
        "linkedin": "verified public LinkedIn URL or empty string",
        "email": "verified public email or empty string",
        "directPhone": "verified public direct phone or empty string",
        "companyPhone": "verified public company phone or empty string",
        "contactPage": "verified public contact page or empty string",
        "researchConfidence": "High | Medium | Low",
        "sourcesUsed": [{"name":"source name","url":"source URL"}]
      },
      "likelyDepartment": "likely department/team involved",
      "publicationDate": "date if visible, otherwise empty string",
      "confidence": 0-100
    }
  ]
}

Candidates:
${JSON.stringify(safeCandidates, null, 2)}`;

  try {
    const resp = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
        messages: [
          { role: 'system', content: 'Return only valid JSON. Be strict: reject weak generic company descriptions. Think like a promotional-products rep looking for a real reason to contact the account.' },
          { role: 'user', content: prompt }
        ],
        temperature: 0.1,
        max_tokens: 1600,
        response_format: { type: 'json_object' }
      })
    });

    if (!resp.ok) {
      const errText = await resp.text().catch(() => '');
      return { enabled: true, signals: [], rawCount: 0, error: `OpenAI ${resp.status}: ${errText.slice(0, 180)}` };
    }

    const data = await resp.json();
    const content = data?.choices?.[0]?.message?.content || '';
    const parsed = parseJsonLoose(content) || {};
    const rawSignals = Array.isArray(parsed.signals) ? parsed.signals : [];
    const signals = rawSignals
      .map(sig => {
        const candidate = safeCandidates.find(c => String(c.id) === String(sig.candidateId)) || safeCandidates[0];
        if (!candidate || !candidate.url) return null;
        return makeAISignal(sig, candidate, accountName, industry, rawSignals.length > 1);
      })
      .filter(Boolean)
      .filter(signal => Number(signal.confidence || 0) >= 0.80)
      .slice(0, 2);

    return { enabled: true, signals, rawCount: rawSignals.length, error: '' };
  } catch (err) {
    return { enabled: true, signals: [], rawCount: 0, error: err.message || 'OpenAI qualification failed' };
  }
}

function domainFromEmailDomain(emailDomain = '') {
  const d = String(emailDomain || '').trim().toLowerCase().replace(/^www\./,'');
  if (!d || /gmail\.com|yahoo\.com|hotmail\.com|outlook\.com|icloud\.com|aol\.com/.test(d)) return '';
  return d;
}

async function domainProbeCandidates(domain, accountName, industry) {
  if (!domain) return [];
  const paths = [
    '/careers', '/career', '/jobs', '/join-our-team', '/employment',
    '/news', '/press', '/press-releases', '/media', '/announcements',
    '/events', '/event', '/trade-shows', '/conferences', '/open-house',
    '/blog', '/community', '/community-involvement', '/csr', '/sustainability',
    '/awards', '/recognition', '/about/leadership', '/leadership', '/team',
    '/investors', '/investor-relations'
  ];
  const urls = [];
  for (const path of paths) {
    urls.push(`https://${domain}${path}`);
    urls.push(`https://www.${domain}${path}`);
  }
  const seen = new Set();
  const uniqueUrls = urls.filter(url => {
    const key = url.replace(/\/+$|^https:\/\/www\./g, '').toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const pages = await mapLimit(uniqueUrls, 8, async (url) => {
    const html = await fetchText(url, 5200);
    if (!html) return null;
    const text = clean(html).slice(0, 3000);
    if (isBadSearchText(text)) return null;
    const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const title = clean(titleMatch ? titleMatch[1] : `${accountName} ${url}`);
    return { url, title, snippet: text, discoverySource: 'direct-domain' };
  });

  return pages
    .filter(Boolean)
    .filter(r => hasStrongSignalContext(`${r.title} ${r.snippet}`, r.url))
    .slice(0, 16);
}

function canonicalUrlKey(url = '') {
  try {
    const u = new URL(url);
    let host = u.hostname.replace(/^www\./, '').toLowerCase();
    let path = u.pathname.replace(/\/$/, '').toLowerCase();
    return `${host}${path}`;
  } catch { return String(url || '').toLowerCase().replace(/\/$/, ''); }
}

function dedupeCandidates(results = []) {
  const seen = new Set();
  return results.filter(r => {
    if (!r || !r.url) return false;
    if (isBadSearchText(`${r.title} ${r.snippet}`)) return false;
    const key = canonicalUrlKey(r.url);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function rankCandidateForAI(r = {}, accountName = '') {
  const text = `${r.title || ''} ${r.snippet || ''} ${r.url || ''}`.toLowerCase();
  let score = 0;
  if (/career|careers|hiring|jobs|open position|apply now|join our team/.test(text)) score += 35;
  if (/news|press|release|announcement|announces|unveils|launch/.test(text)) score += 34;
  if (/event|conference|expo|trade show|summit|open house|webinar/.test(text)) score += 32;
  if (/award|recognized|winner|milestone|anniversary|best/.test(text)) score += 30;
  if (/community|charity|sponsor|fundrais|csr|sustainability/.test(text)) score += 28;
  if (/expansion|new facility|new location|opening|grand opening|capacity/.test(text)) score += 36;
  if (/leadership|appoints|promotes|named|joins as|new ceo|president|director/.test(text)) score += 26;
  if (/2026|today|yesterday|this week|upcoming|recently|now/.test(text)) score += 12;
  if (looksLikeGenericHomepage(r, accountName)) score -= 25;
  if (!hasStrongSignalContext(`${r.title} ${r.snippet}`, r.url)) score -= 20;
  return score;
}

function sourceBucket(result = {}) {
  const t = `${result.url || ''} ${result.title || ''}`.toLowerCase();
  if (/career|jobs|employment|join-our-team/.test(t)) return 'careers';
  if (/news|press|release|announcement|media/.test(t)) return 'news/press';
  if (/event|conference|expo|trade-show|open-house/.test(t)) return 'events';
  if (/award|recognition|milestone/.test(t)) return 'awards';
  if (/community|charity|sponsor|csr|sustainability/.test(t)) return 'community/csr';
  if (/leadership|team|about/.test(t)) return 'leadership';
  if (/investor|acquisition|funding|partnership/.test(t)) return 'investor/partnership';
  return 'general';
}


export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const startedAt = Date.now();
  try {
    const { accountName, industry, cityState, emailDomain, notes, employees, contactName } = req.body || {};
    if (!accountName) return res.status(400).json({ error: 'Missing accountName' });

    const location = cityState ? ` ${cityState}` : '';
    const context = [industry, cityState, notes, employees ? `${employees} employees` : ''].filter(Boolean).join(' ');
    const domain = domainFromEmailDomain(emailDomain);

    const sourceQueries = [
      { bucket: 'careers', q: `"${accountName}" ${location} hiring jobs careers open positions ${context}` },
      { bucket: 'news/press', q: `"${accountName}" ${location} news press release announcement 2026 ${context}` },
      { bucket: 'expansion', q: `"${accountName}" ${location} expansion new facility new location grand opening ${context}` },
      { bucket: 'events', q: `"${accountName}" ${location} event conference expo trade show open house ${context}` },
      { bucket: 'awards', q: `"${accountName}" ${location} award recognized milestone anniversary ${context}` },
      { bucket: 'community/csr', q: `"${accountName}" ${location} community charity sponsorship fundraiser sustainability ${context}` },
      { bucket: 'leadership', q: `"${accountName}" ${location} leadership appoints names promotes new director ${context}` },
      { bucket: 'launch/partnership', q: `"${accountName}" ${location} product launch new service partnership acquisition ${context}` },
      { bucket: 'safety/employee', q: `"${accountName}" ${location} safety sustainability employee initiative ${context}` }
    ];
    if (domain) {
      sourceQueries.unshift({ bucket: 'domain-news', q: `site:${domain} news press release announcement expansion events awards community leadership` });
      sourceQueries.unshift({ bucket: 'domain-careers', q: `site:${domain} careers jobs hiring open positions` });
    }

    // Run search coverage in parallel. Ranking decides which accounts to research; research should be broad but fast.
    const [domainCandidates, searchBatches] = await Promise.all([
      domainProbeCandidates(domain, accountName, industry),
      Promise.allSettled(sourceQueries.map(async item => {
        const results = await webSearch(item.q);
        return results.map(r => ({ ...r, discoverySource: item.bucket, query: item.q }));
      }))
    ]);

    const allSearchResults = searchBatches
      .filter(x => x.status === 'fulfilled')
      .flatMap(x => x.value || []);

    let allCandidates = dedupeCandidates([...domainCandidates, ...allSearchResults])
      .map(r => ({ ...r, candidateRank: rankCandidateForAI(r, accountName) }))
      .sort((a, b) => b.candidateRank - a.candidateRank)
      .slice(0, 24);

    const firecrawlEnrichment = await enrichCandidatesWithFirecrawl(allCandidates);
    allCandidates = firecrawlEnrichment.candidates;

    const evaluatedSearchResults = allCandidates.map(r => ({ result: r, signal: signalFromResult(r, accountName, industry) }));
    const acceptedSearchSignals = evaluatedSearchResults.map(x => x.signal).filter(Boolean);

    // AI qualification is the business-signal moat: search finds candidates, AI decides whether they are meaningful.
    const aiQualification = await aiQualifyBusinessSignals(accountName, industry, allCandidates, clean(contactName || ''));

    const signals = dedupeSignals([
      ...aiQualification.signals,
      ...acceptedSearchSignals
    ]);

    const rejectedResults = Math.max(0, allCandidates.length - acceptedSearchSignals.length);
    const candidateSamples = evaluatedSearchResults
      .map(x => candidateSample(x.result, accountName, x.signal))
      .slice(0, 10);

    const sourceCoverage = allCandidates.reduce((acc, r) => {
      const bucket = r.discoverySource || sourceBucket(r);
      acc[bucket] = (acc[bucket] || 0) + 1;
      return acc;
    }, {});

    const acceptedByBucket = signals.reduce((acc, s) => {
      const bucket = sourceBucket({ url: s.sourceUrl, title: s.sourceType || s.title });
      acc[bucket] = (acc[bucket] || 0) + 1;
      return acc;
    }, {});

    return res.status(200).json({
      accountName,
      researchedAt: new Date().toISOString(),
      signals,
      diagnostics: {
        elapsedMs: Date.now() - startedAt,
        queriesRun: sourceQueries.length,
        searchProviders: [process.env.SERPER_API_KEY ? 'serper' : '', process.env.BRAVE_SEARCH_API_KEY ? 'brave' : '', process.env.TAVILY_API_KEY ? 'tavily' : '', process.env.FIRECRAWL_API_KEY ? 'firecrawl' : '', 'duckduckgo-fallback'].filter(Boolean),
        domainUsed: domain || '',
        domainProbes: domain ? 52 : 0,
        searchResultsFound: allCandidates.length,
        rawSearchResultsFound: allSearchResults.length,
        directDomainCandidates: domainCandidates.length,
        firecrawlPagesScraped: firecrawlEnrichment.scrapedCount || 0,
        acceptedSearchSignals: acceptedSearchSignals.length,
        domainSignalsFound: acceptedSearchSignals.filter(s => s && /direct-domain/.test(s.discoverySource || '')).length,
        aiEnabled: aiQualification.enabled,
        aiRawSignals: aiQualification.rawCount || 0,
        aiAcceptedSignals: aiQualification.signals.length,
        aiError: aiQualification.error || '',
        rejectedResults,
        signalsReturned: signals.length,
        sourceCoverage,
        acceptedByBucket,
        candidateSamples
      },
      message: signals.length ? `${signals.length} verified public signal(s) found.` : 'No verified external signals found.'
    });
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Research failed' });
  }
}
