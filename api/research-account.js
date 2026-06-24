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

function cleanSourceName(url = '') {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '');
    return host || 'public source';
  } catch {
    return 'public source';
  }
}

function cleanSignalSummary(result = {}, max = 150) {
  const rawTitle = clean(result.title || '');
  const rawSnippet = clean(result.snippet || '');
  const title = rawTitle.replace(/\s*[|•-]\s*.*$/, '').trim();
  const source = cleanSourceName(result.url);
  const preferred = title && title.length >= 6 ? title : rawSnippet;
  const cleaned = compactSentence(preferred, max);
  return cleaned || `Public source found on ${source}`;
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


function compactSentence(text = '', max = 220) {
  const cleaned = clean(text).replace(/\s+/g, ' ').trim();
  if (!cleaned) return '';
  return cleaned.length > max ? cleaned.slice(0, max).replace(/\s+\S*$/, '') + '…' : cleaned;
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

  let signalDetail = `${signalType} found via ${sourceName}`;
  if (/hiring/i.test(signalType)) {
    signalDetail = count
      ? `Hiring activity: ${count} role${count === 1 ? '' : 's'} or openings referenced`
      : 'Hiring or careers activity found';
  } else if (/event|conference/i.test(signalType)) {
    signalDetail = 'Event or campaign activity found';
  } else if (/expansion|location/i.test(signalType)) {
    signalDetail = 'Growth, expansion, or location activity found';
  } else if (/award|recognition/i.test(signalType)) {
    signalDetail = 'Award, recognition, or milestone activity found';
  } else if (/leadership/i.test(signalType)) {
    signalDetail = 'Leadership or team change found';
  } else if (/launch/i.test(signalType)) {
    signalDetail = 'Product, service, or campaign launch activity found';
  }

  const whyNow = `${signalDetail}. ${opp.conversationStarter}`;
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
  const confidence = Math.min(0.94, sourceConfidence(sourceType, result.title, result.snippet) + confidenceBoost);
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
    confidenceLevel: confidence >= 0.75 ? 'High' : confidence >= 0.60 ? 'Medium' : 'Low',
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
