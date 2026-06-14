// Vercel Serverless Function: free public signal research, no OpenAI, no paid APIs.
// Endpoint: POST /api/research-account

const USER_AGENT = 'Mozilla/5.0 (compatible; AccountRadarBot/0.1; +https://example.com)';

function clean(text = '') {
  return String(text).replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
}

function decodeDuckUrl(url) {
  try {
    if (!url) return '';
    const u = new URL(url, 'https://duckduckgo.com');
    const uddg = u.searchParams.get('uddg');
    return uddg ? decodeURIComponent(uddg) : url;
  } catch { return url || ''; }
}

async function ddgSearch(query) {
  const url = `https://duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
  if (!res.ok) return [];
  const html = await res.text();
  const results = [];
  const regex = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
  let m;
  while ((m = regex.exec(html)) && results.length < 6) {
    results.push({
      url: decodeDuckUrl(m[1]),
      title: clean(m[2]),
      snippet: clean(m[3])
    });
  }
  // fallback when snippets are absent
  if (!results.length) {
    const simple = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
    while ((m = simple.exec(html)) && results.length < 6) {
      results.push({ url: decodeDuckUrl(m[1]), title: clean(m[2]), snippet: '' });
    }
  }
  return results;
}

function signalFromResult(result, accountName, industry) {
  const text = `${result.title} ${result.snippet}`.toLowerCase();
  const today = new Date().toISOString().slice(0, 10);

  const make = (signalType, title, promoOpportunity, suggestedContact, confidence = 0.68) => ({
    signalType,
    type: signalType,
    title,
    evidence: `${result.title}${result.snippet ? ' — ' + result.snippet : ''}`.slice(0, 450),
    sourceUrl: result.url,
    sourceType: 'Public web search',
    dateFound: today,
    confidence,
    isReal: true,
    promoOpportunity,
    suggestedContact
  });

  if (/(career|careers|hiring|jobs|join our team|open position|technician|sales consultant|recruit)/i.test(text)) {
    const isAuto = /dealership|ford|automotive|service|technician/.test(text) || /Automotive/.test(industry || '');
    return make(
      'Hiring Activity',
      `${accountName} hiring / careers activity`,
      isAuto ? 'Technician or sales team onboarding merchandise program' : 'New hire onboarding and recruiting merchandise program',
      isAuto ? 'Service Director / HR Manager' : 'HR Manager / Department Lead',
      0.74
    );
  }
  if (/(event|conference|expo|show|summit|festival|webinar|open house)/i.test(text)) {
    return make(
      'Events / Conferences',
      `${accountName} event or conference activity`,
      'Event merchandise, attendee gifts, booth giveaways, and staff apparel',
      'Marketing Manager / Events Lead',
      0.70
    );
  }
  if (/(new location|expansion|expands|opening|grand opening|new facility|renovation|relocation)/i.test(text)) {
    return make(
      'Expansion / New Location',
      `${accountName} expansion or location activity`,
      'Grand opening kits, location apparel, employee welcome kits, and customer gifts',
      'Operations Manager / Marketing Manager',
      0.72
    );
  }
  if (/(launch|new product|announces|unveils|release|model|lineup)/i.test(text)) {
    return make(
      'Product Launches',
      `${accountName} launch or announcement activity`,
      'Launch merchandise, customer giveaways, sales team apparel, and campaign kits',
      'Marketing Manager / Sales Manager',
      0.66
    );
  }
  if (/(award|recognized|winner|honor|best of|certified|ranked)/i.test(text)) {
    return make(
      'Awards / Recognition',
      `${accountName} award or recognition activity`,
      'Employee recognition gifts, customer announcement mailers, and celebration merchandise',
      'Marketing Manager / HR Manager',
      0.62
    );
  }
  if (/(appoints|promotes|named|ceo|president|director|manager|leadership)/i.test(text)) {
    return make(
      'Leadership Changes',
      `${accountName} leadership activity`,
      'New leader welcome package, team announcement gifts, and internal culture merchandise',
      'Executive Assistant / HR Manager',
      0.58
    );
  }
  return null;
}

function dedupeSignals(signals) {
  const seen = new Set();
  return signals.filter(s => {
    const key = `${s.signalType}|${s.sourceUrl}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 6);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  try {
    const { accountName, industry, cityState } = req.body || {};
    if (!accountName) return res.status(400).json({ error: 'Missing accountName' });

    const location = cityState ? ` ${cityState}` : '';
    const queries = [
      `"${accountName}" careers${location}`,
      `"${accountName}" hiring jobs${location}`,
      `"${accountName}" news press release`,
      `"${accountName}" event conference`,
      `"${accountName}" expansion new location`,
      `"${accountName}" product launch announcement`
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
      message: signals.length ? `${signals.length} public signals found.` : 'No recent public business signals found.'
    });
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Research failed' });
  }
}
