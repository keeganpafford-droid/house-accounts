// Vercel Serverless Function: verified public signal research.
// No OpenAI, no paid APIs. Returns only source-backed signals.
// Endpoint: POST /api/research-account

const USER_AGENT = 'Mozilla/5.0 (compatible; HouseAccountsBot/0.2; +https://house-accounts.vercel.app)';

function clean(text = '') {
  return String(text)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

function decodeDuckUrl(url) {
  try {
    if (!url) return '';
    const u = new URL(url, 'https://duckduckgo.com');
    const uddg = u.searchParams.get('uddg');
    return uddg ? decodeURIComponent(uddg) : url;
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
  if (/Careers|job posting/i.test(sourceType)) score = 0.74;
  if (/News|press|Public \/ press/i.test(sourceType)) score = 0.70;
  if (/Event/i.test(sourceType)) score = 0.68;
  if (/Public social/i.test(sourceType)) score = 0.64;
  if (/LinkedIn/i.test(sourceType)) score = 0.62;
  if (/(today|yesterday|2026|2025|june|july|august|september|october|november|december|spring|summer|fall|winter)/i.test(text)) score += 0.06;
  if (/(hiring|open positions|new facility|grand opening|announced|event|conference|launch)/i.test(text)) score += 0.06;
  return Math.min(0.88, score);
}

async function ddgSearch(query) {
  const url = `https://duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
  if (!res.ok) return [];
  const html = await res.text();
  const results = [];
  const regex = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?(?:<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>|<div[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/div>)/g;
  let m;
  while ((m = regex.exec(html)) && results.length < 8) {
    const sourceUrl = decodeDuckUrl(m[1]);
    const title = clean(m[2]);
    const snippet = clean(m[3] || m[4] || '');
    if (!sourceUrl || /duckduckgo\.com/.test(sourceUrl)) continue;
    results.push({ url: sourceUrl, title, snippet });
  }
  if (!results.length) {
    const simple = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
    while ((m = simple.exec(html)) && results.length < 8) {
      const sourceUrl = decodeDuckUrl(m[1]);
      if (!sourceUrl || /duckduckgo\.com/.test(sourceUrl)) continue;
      results.push({ url: sourceUrl, title: clean(m[2]), snippet: '' });
    }
  }
  return results;
}

function makeSignal(result, accountName, signalType, title, opportunityExplanation, suggestedContact, confidenceBoost = 0) {
  const sourceType = classifySource(result.url, result.title);
  const confidence = Math.min(0.92, sourceConfidence(sourceType, result.title, result.snippet) + confidenceBoost);
  return {
    signalType,
    type: signalType,
    title,
    evidence: `${result.title}${result.snippet ? ' — ' + result.snippet : ''}`.slice(0, 650),
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
  const isMfg = /manufactur|industrial|factory|plant|safety|facility/.test(text) || /Manufacturing/.test(industry || '');

  if (/(career|careers|hiring|jobs|join our team|open position|openings|technician|sales consultant|recruit|now hiring)/i.test(text)) {
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

  if (/(event|conference|expo|show|summit|festival|webinar|open house|monthly sales event|customer event)/i.test(text)) {
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

  if (/(new location|expansion|expands|opening|grand opening|new facility|renovation|relocation|moved to|opens)/i.test(text)) {
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

  if (/(launch|new product|announces|unveils|release|model|lineup|new service|new program)/i.test(text)) {
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

  if (/(award|recognized|winner|honor|best of|certified|ranked|achievement|milestone)/i.test(text)) {
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

  if (/(appoints|promotes|named|joins as|ceo|president|director|manager|leadership|new general manager)/i.test(text)) {
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

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  try {
    const { accountName, industry, cityState } = req.body || {};
    if (!accountName) return res.status(400).json({ error: 'Missing accountName' });

    const location = cityState ? ` ${cityState}` : '';
    const queries = [
      `"${accountName}" careers hiring jobs${location}`,
      `"${accountName}" open positions recruiting${location}`,
      `"${accountName}" news press release announcement`,
      `"${accountName}" event conference open house`,
      `"${accountName}" expansion new location grand opening`,
      `"${accountName}" product launch new service`,
      `"${accountName}" award recognized leadership`
    ];

    const allResults = [];
    for (const q of queries) {
      const results = await ddgSearch(q);
      allResults.push(...results);
    }

    const signals = dedupeSignals(
      allResults
        .map(r => signalFromResult(r, accountName, industry))
        .filter(Boolean)
    );

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
