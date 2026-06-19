// Vercel Serverless Function: verified public signal research.
// No OpenAI by default. No paid APIs required.
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

function sourceConfidence(sourceType, title = '', snippet = '') {
  const text = `${title} ${snippet}`.toLowerCase();
  let score = 0.58;
  if (/Careers|job posting/i.test(sourceType)) score = 0.76;
  if (/News|press|Public \/ press/i.test(sourceType)) score = 0.72;
  if (/Event/i.test(sourceType)) score = 0.70;
  if (/Public social/i.test(sourceType)) score = 0.64;
  if (/LinkedIn/i.test(sourceType)) score = 0.62;
  if (/(today|yesterday|2026|2025|june|july|august|september|october|november|december|spring|summer|fall|winter)/i.test(text)) score += 0.06;
  if (/(hiring|open positions|new facility|grand opening|announced|event|conference|launch|careers|jobs)/i.test(text)) score += 0.06;
  return Math.min(0.92, score);
}

async function fetchText(url) {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, 'Accept': 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8' },
      redirect: 'follow'
    });
    if (!res.ok) return '';
    const contentType = res.headers.get('content-type') || '';
    if (!/text|html|xml|json/i.test(contentType)) return '';
    return await res.text();
  } catch {
    return '';
  }
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

function makeSignal(result, accountName, signalType, title, opportunityExplanation, suggestedContact, confidenceBoost = 0) {
  const sourceType = classifySource(result.url, result.title);
  const confidence = Math.min(0.94, sourceConfidence(sourceType, result.title, result.snippet) + confidenceBoost);
  return {
    signalType,
    type: signalType,
    title,
    evidence: `${result.title}${result.snippet ? ' — ' + result.snippet : ''}`.slice(0, 750),
    sourceUrl: result.url,
    sourceType,
    dateFound: new Date().toISOString().slice(0, 10),
    confidence,
    isReal: true,
    opportunityExplanation,
    promoOpportunity: opportunityExplanation,
    suggestedContact
  };
}

function signalFromResult(result, accountName, industry = '') {
  if (!result || !result.url) return null;
  const text = `${result.title} ${result.snippet} ${result.url}`.toLowerCase();
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
      0.04
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
      0.03
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
      0.04
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
      0.02
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
      0
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
      -0.02
    );
  }

  return null;
}

function dedupeSignals(signals) {
  const seen = new Set();
  return signals
    .filter(s => s && s.isReal && s.sourceUrl)
    .filter(s => {
      const key = `${s.signalType}|${s.sourceUrl}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => (b.confidence || 0) - (a.confidence || 0))
    .slice(0, 6);
}

function domainFromEmailDomain(emailDomain = '') {
  const d = String(emailDomain || '').trim().toLowerCase().replace(/^www\./,'');
  if (!d || /gmail\.com|yahoo\.com|hotmail\.com|outlook\.com|icloud\.com|aol\.com/.test(d)) return '';
  return d;
}

async function domainProbeSignals(domain, accountName, industry) {
  if (!domain) return [];
  const paths = ['', '/', '/careers', '/career', '/jobs', '/about', '/news', '/press', '/events', '/blog'];
  const candidates = [];
  for (const path of paths) {
    candidates.push(`https://${domain}${path}`);
    if (path) candidates.push(`https://www.${domain}${path}`);
  }

  const results = [];
  const seen = new Set();
  for (const url of candidates) {
    const normalized = url.replace(/\/+$/,'/');
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    const html = await fetchText(url);
    if (!html) continue;
    const text = clean(html).slice(0, 2000);
    const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const title = clean(titleMatch ? titleMatch[1] : `${accountName} ${url}`);
    results.push({ url, title, snippet: text });
    if (results.length >= 10) break;
  }
  return results.map(r => signalFromResult(r, accountName, industry)).filter(Boolean);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  try {
    const { accountName, industry, cityState, emailDomain } = req.body || {};
    if (!accountName) return res.status(400).json({ error: 'Missing accountName' });

    const location = cityState ? ` ${cityState}` : '';
    const domain = domainFromEmailDomain(emailDomain);
    const queries = [
      `"${accountName}" careers hiring jobs${location}`,
      `"${accountName}" open positions recruiting${location}`,
      `"${accountName}" news press release announcement`,
      `"${accountName}" event conference open house`,
      `"${accountName}" expansion new location grand opening`,
      `"${accountName}" product launch new service`,
      `"${accountName}" award recognized leadership`
    ];
    if (domain) {
      queries.unshift(`site:${domain} careers jobs hiring`);
      queries.unshift(`site:${domain} news press events expansion`);
    }

    const allResults = [];
    const domainSignals = await domainProbeSignals(domain, accountName, industry);
    for (const q of queries) {
      const results = await ddgSearch(q);
      allResults.push(...results);
    }

    const signals = dedupeSignals([
      ...domainSignals,
      ...allResults.map(r => signalFromResult(r, accountName, industry)).filter(Boolean)
    ]);

    return res.status(200).json({
      accountName,
      researchedAt: new Date().toISOString(),
      signals,
      message: signals.length ? `${signals.length} verified public signal(s) found.` : 'No verified external signals found.'
    });
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Research failed' });
  }
}
