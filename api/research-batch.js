// Vercel Serverless Function: batch AI web research for business activity signals.
// Endpoint: POST /api/research-batch
// Purpose: mimic the higher-quality "Google AI style" research pass across a whole account list.
// It uses OpenAI Responses API + hosted web_search when OPENAI_API_KEY is configured.

function clean(text = '') {
  return String(text || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function compact(text = '', max = 220) {
  const t = clean(text);
  if (!t) return '';
  return t.length > max ? t.slice(0, max).replace(/\s+\S*$/, '') + '…' : t;
}

function parseJsonLoose(text = '') {
  if (!text) return null;
  try { return JSON.parse(text); } catch {}
  const fenced = String(text).match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) {
    try { return JSON.parse(fenced[1]); } catch {}
  }
  const match = String(text).match(/\{[\s\S]*\}/);
  if (match) {
    try { return JSON.parse(match[0]); } catch {}
  }
  return null;
}

function sourceDomain(url = '') {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
}

function normalizeSignalType(type = '') {
  const t = String(type || '').toLowerCase();
  if (/hiring|job|career|recruit|talent/.test(t)) return 'Hiring Activity';
  if (/event|conference|trade|expo|summit|open house|webinar/.test(t)) return 'Events / Conferences';
  if (/award|recognition|recognized|winner|milestone|anniversary/.test(t)) return 'Awards / Recognition';
  if (/expansion|facility|location|office|opening|growth/.test(t)) return 'Expansion / New Location';
  if (/leadership|appoint|promot|named|ceo|president|director|vp/.test(t)) return 'Leadership Changes';
  if (/launch|product|service|rollout|release/.test(t)) return 'Product / Service Launch';
  if (/acquisition|merger|funding|partnership|customer win/.test(t)) return 'Partnership / Acquisition';
  if (/community|charity|fundrais|sponsor|csr|sustainability/.test(t)) return 'Community / CSR';
  return 'Business Activity';
}

function confidenceNumber(conf) {
  if (typeof conf === 'number') return Math.max(0.35, Math.min(0.98, conf > 1 ? conf / 100 : conf));
  const n = String(conf || '').match(/\d{1,3}/);
  if (n) return Math.max(0.35, Math.min(0.98, Number(n[0]) / 100));
  if (/high/i.test(String(conf))) return 0.84;
  if (/low/i.test(String(conf))) return 0.48;
  return 0.68;
}

function confidenceLabel(score) {
  if (score >= 0.75) return 'High';
  if (score >= 0.58) return 'Medium';
  return 'Low';
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

function makeSignal(raw = {}) {
  const accountName = clean(raw.accountName || raw.account || raw.company || '');
  if (!accountName) return null;
  const sourceUrl = clean(raw.sourceUrl || raw.url || '');
  const score = confidenceNumber(raw.confidence);
  const type = normalizeSignalType(raw.signalType || raw.type);
  const title = compact(raw.signalTitle || raw.headline || raw.title || `${accountName} business activity`, 140);
  const summary = compact(raw.shortSummary || raw.summary || raw.signalDetail || raw.details || title, 180);
  const why = compact(raw.whyReachOut || raw.whyItMatters || raw.why || 'Recent public business activity creates a timely reason to check in.', 200);
  const opener = compact(raw.suggestedOpener || raw.conversationStarter || raw.likelyConversation || 'Saw some recent activity and wanted to check in — anything coming up where support would be helpful?', 220);
  const conversations = Array.isArray(raw.likelyConversations)
    ? raw.likelyConversations.map(clean).filter(Boolean).slice(0, 5)
    : String(raw.likelyConversation || raw.conversationAngle || '').split(/[;|,]/).map(clean).filter(Boolean).slice(0, 5);

  return {
    accountName,
    isReal: true,
    signalLayerType: 'Business Activity Signal',
    type,
    signalType: type,
    title,
    signalDetail: summary,
    shortSummary: summary,
    signalSnippet: summary,
    evidence: `${sourceDomain(sourceUrl) || clean(raw.sourceName || 'public source')}: ${summary}`,
    sourceUrl,
    sourceType: clean(raw.sourceType || raw.sourceName || sourceDomain(sourceUrl) || 'Public source'),
    sourceAuthority: clean(raw.sourceType || raw.sourceName || sourceDomain(sourceUrl) || 'Public source'),
    cleanSourceName: clean(raw.sourceName || sourceDomain(sourceUrl) || ''),
    publishedDate: clean(raw.publicationDate || raw.publishedDate || raw.date || ''),
    dateFound: new Date().toISOString(),
    detectedAt: new Date().toISOString(),
    confidence: score,
    confidenceLevel: confidenceLabel(score),
    reasonToReachOut: why,
    whyNow: why,
    conversationStarter: opener,
    suggestedOpener: opener,
    suggestedContact: clean(raw.suggestedContact || raw.contactRole || 'Relevant department lead'),
    affectedDepartment: clean(raw.likelyDepartment || raw.department || ''),
    likelyConversations: conversations.length ? conversations : [compact(raw.likelyConversation || raw.conversationAngle || why, 80)].filter(Boolean),
    opportunityCategory: compact(raw.opportunityCategory || raw.likelyConversation || raw.conversationAngle || 'Business activity conversation', 80),
    opportunityExplanation: compact(raw.whyItMatters || why, 200),
    valueSource: 'AI web research',
    aiQualified: true,
    source: 'openai-web-search'
  };
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
        notes: clean(a.notes || ''),
        website: clean(a.website || ''),
        categories: Array.isArray(a.categories) ? a.categories.slice(0, 8) : [],
        relationship: Number(a.orderCount || 0) > 0 ? `${a.orderCount || 0} historical orders` : 'no order history provided'
      }));

    if (!safeAccounts.length) return res.status(400).json({ error: 'No accounts provided' });

    const prompt = `You are the Business Signal Intelligence layer for House Accounts, a tool for promotional products distributors.

Research the following companies for current public business signals that would create a legitimate reason for a promotional-products sales rep to reach out within the next 90 days.

This is NOT a company summary. Find useful, specific triggers.

Prioritize signals such as:
- hiring or recruiting activity
- trade shows, conferences, summits, expos, open houses, webinars, events
- awards, recognition, milestones, anniversaries
- expansion, new facility, new location, manufacturing growth, office opening
- product/service launches, major customer wins, partnerships
- acquisitions, funding, corporate integration
- leadership changes
- community involvement, sponsorships, charity, fundraising, CSR, sustainability, employee initiatives

Reject generic descriptions, homepage/about/contact text, map/location snippets, and anything that does not create a real reason to contact the account.

For each accepted signal, explain it in sales-rep language. The output should help a rep answer: "Who should I contact today, and why?"

Return strict JSON only. Do not include markdown.

JSON shape:
{
  "signals": [
    {
      "accountName": "exact account name from list",
      "signalType": "Hiring | Event | Award | Expansion | Leadership Change | Product Launch | Partnership | Acquisition | Community Initiative | Major Initiative",
      "signalTitle": "short useful headline",
      "shortSummary": "one specific sentence, no raw web scrape text",
      "whyReachOut": "one clear sentence explaining why this creates a reason to reach out",
      "likelyConversation": "natural conversation theme, not a product pitch",
      "likelyConversations": ["optional", "short", "themes"],
      "suggestedOpener": "casual sentence a rep could say or email",
      "suggestedContact": "likely role to contact",
      "likelyDepartment": "likely department/team involved",
      "sourceName": "source/domain/publication",
      "sourceUrl": "best available source URL",
      "publicationDate": "date if visible, otherwise empty string",
      "confidence": 0-100
    }
  ]
}

Accounts:
${JSON.stringify(safeAccounts, null, 2)}`;

    const model = process.env.OPENAI_SEARCH_MODEL || process.env.OPENAI_MODEL || 'gpt-4.1-mini';
    const body = {
      model,
      input: prompt,
      tools: [{ type: 'web_search' }],
      temperature: 0.1,
      max_output_tokens: 5000
    };

    const resp = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    });

    if (!resp.ok) {
      const errText = await resp.text().catch(() => '');
      return res.status(502).json({
        error: `OpenAI Responses API failed: ${resp.status}`,
        detail: errText.slice(0, 500),
        diagnostics: { elapsedMs: Date.now() - startedAt, model, mode }
      });
    }

    const data = await resp.json();
    const text = responseOutputText(data);
    const parsed = parseJsonLoose(text) || {};
    const rawSignals = Array.isArray(parsed.signals) ? parsed.signals : [];
    const validAccountNames = new Set(safeAccounts.map(a => a.name.toLowerCase()));
    const signals = dedupeSignals(rawSignals
      .map(makeSignal)
      .filter(Boolean)
      .filter(s => validAccountNames.has(String(s.accountName || '').toLowerCase()))
    ).slice(0, 60);

    const byAccount = {};
    for (const sig of signals) {
      if (!byAccount[sig.accountName]) byAccount[sig.accountName] = [];
      byAccount[sig.accountName].push(sig);
    }

    return res.status(200).json({
      signals,
      byAccount,
      diagnostics: {
        elapsedMs: Date.now() - startedAt,
        model,
        accountsReceived: accounts.length,
        accountsResearched: safeAccounts.length,
        rawSignals: rawSignals.length,
        signalsReturned: signals.length,
        webSearchEnabled: true,
        mode
      }
    });
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Batch research failed', diagnostics: { elapsedMs: Date.now() - startedAt } });
  }
}
