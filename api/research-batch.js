// Vercel Serverless Function: AI-first Opportunity Discovery Engine for House Accounts.
// Endpoint: POST /api/research-batch
// Purpose: research a ranked set of accounts and return only high-confidence business signals
// that create a legitimate reason for a promotional-products sales rep to start a conversation.

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
  if (/hiring|job|career|recruit|talent|staff/.test(t)) return 'Hiring';
  if (/trade|expo|conference|summit|event|open house|webinar|show/.test(t)) return 'Trade Show / Event';
  if (/award|recognition|recognized|winner|milestone|anniversary|ranking/.test(t)) return 'Award / Recognition';
  if (/expansion|facility|location|office|opening|growth|building|plant|warehouse/.test(t)) return 'Expansion';
  if (/leadership|appoint|promot|named|ceo|president|director|vp|chief/.test(t)) return 'Leadership Change';
  if (/launch|product|service|rollout|release|new offering/.test(t)) return 'Product Launch';
  if (/acquisition|merger|funding|investment|raise|capital/.test(t)) return 'Acquisition / Funding';
  if (/partner|partnership|customer win|contract|government/.test(t)) return 'Partnership / Contract';
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
  return 65;
}

function confidenceLabel(score) {
  if (score >= 80) return 'High';
  if (score >= 65) return 'Medium';
  return 'Low';
}

function safeArray(value, max = 5) {
  if (Array.isArray(value)) return value.map(clean).filter(Boolean).slice(0, max);
  return String(value || '').split(/[;|\n]/).map(clean).filter(Boolean).slice(0, max);
}

function dedupeSignals(signals = []) {
  const seen = new Set();
  const out = [];
  for (const sig of signals) {
    if (!sig || !sig.accountName) continue;
    const key = `${sig.accountName}|${sig.signalType}|${sourceDomain(sig.sourceUrl || '')}|${clean(sig.signalDetail || sig.title || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').slice(0, 100)}`;
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
  const confidencePct = confidenceNumber(raw.confidence || raw.opportunityScore || raw.score);
  if (confidencePct < 80) return null; // trust gate: only show high-confidence business opportunities

  const type = normalizeSignalType(raw.signalType || raw.opportunityType || raw.type);
  const title = compact(raw.signalTitle || raw.headline || raw.title || `${accountName} business activity`, 130);
  const summary = compact(raw.whatChanged || raw.shortSummary || raw.summary || raw.signalDetail || raw.details || title, 190);
  const why = compact(raw.whyItMattersForPromo || raw.whyReachOut || raw.whyItMatters || raw.why || 'Recent public business activity creates a timely reason to check in.', 220);
  const opener = compact(raw.suggestedOpener || raw.conversationStarter || raw.likelyConversation || 'Saw some recent activity and wanted to check in — anything coming up where support would be helpful?', 220);
  const buyers = safeArray(raw.likelyBuyers || raw.suggestedContacts || raw.suggestedContact || raw.contactRole, 4);
  const products = safeArray(raw.likelyProducts || raw.promoCategories || raw.commonPromoCategories || raw.likelyProductCategories, 6);
  const conversations = safeArray(raw.likelyConversations || raw.conversationThemes || raw.likelyConversation || raw.conversationAngle, 5);
  const sources = Array.isArray(raw.sources)
    ? raw.sources.map(s => ({ name: clean(s.name || s.sourceName || sourceDomain(s.url || '')), url: clean(s.url || s.sourceUrl || '') })).filter(s => s.url || s.name).slice(0, 4)
    : [];
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
    opportunityCategory: compact(raw.opportunityCategory || conversations[0] || type, 80),
    opportunityExplanation: compact(raw.whyItMattersForPromo || raw.whyItMatters || why, 220),
    valueSource: 'AI Opportunity Discovery',
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

function accountPromptContext(accounts) {
  return accounts.map((a, idx) => ({
    id: String(idx),
    name: clean(a.name),
    industry: clean(a.industry || ''),
    location: clean(a.cityState || a.location || ''),
    website: clean(a.website || ''),
    notes: clean(a.notes || ''),
    relationship: clean(a.relationship || ''),
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

async function callOpenAIResponses({ apiKey, model, prompt, toolType }) {
  const body = {
    model,
    input: prompt,
    tools: [{ type: toolType }],
    temperature: 0.1,
    max_output_tokens: 9000
  };
  const resp = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });
  return resp;
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
        categories: Array.isArray(a.categories) ? a.categories.slice(0, 10) : [],
        contacts: Array.isArray(a.contacts) ? a.contacts.slice(0, 6) : [],
        recentOrderDates: Array.isArray(a.recentOrderDates) ? a.recentOrderDates.slice(0, 5) : [],
        repeatPatterns: Array.isArray(a.repeatPatterns) ? a.repeatPatterns.slice(0, 5) : [],
        existingSignals: Array.isArray(a.existingSignals) ? a.existingSignals.slice(0, 5) : [],
        relationshipStrength: a.relationshipStrength || a.relationshipScore || '',
        quickWinScore: a.quickWinScore || '',
        revenue: Number(a.revenue || 0),
        orderCount: Number(a.orderCount || 0),
        relationship: Number(a.orderCount || 0) > 0 ? `${a.orderCount || 0} historical orders` : 'no order history provided'
      }));

    if (!safeAccounts.length) return res.status(400).json({ error: 'No accounts provided' });

    const prompt = `You are the Opportunity Discovery Engine for House Accounts, a tool built for promotional products distributors.

Your job is NOT to summarize companies.
Your job is to think like an elite promotional-products sales rep and answer one question:

"If I sold promotional products, branded apparel, uniforms, awards, print, onboarding kits, trade-show materials, safety incentives, recognition programs, customer gifts, or corporate merchandise, is there anything happening at this company that creates a legitimate reason to start a conversation in the next 90 days?"

For each company, use public web information and the account context provided. First discover recent business developments. Then translate only the strongest developments into promo-relevant sales conversations.

Consider signals such as:
- Hiring or recruiting pushes
- Facility expansion, new offices, new locations, manufacturing investment, warehouse growth
- Trade shows, conferences, expos, open houses, webinars, customer events
- Awards, recognition, anniversaries, rankings, milestones
- Product/service launches, marketing campaigns, major customer wins, government contracts
- Partnerships, acquisitions, mergers, funding, investments
- Leadership changes or major team changes
- Community involvement, sponsorships, charity events, fundraising, CSR, sustainability, employee initiatives
- Safety, employee engagement, culture, recruiting, employer-branding initiatives

Reject weak signals:
- Generic company descriptions
- About pages
- Contact/location/map snippets
- SEO or navigation text
- Old or stale news with no obvious current sales angle
- Anything that does not create a natural reason to reach out

Important rules:
- Return at most 2 opportunities per company.
- Only return opportunities with confidence >= 80.
- If there is no strong opportunity, return nothing for that company.
- Do not invent facts. Use source URLs.
- Do not stop at "they are hiring". Translate why it matters to promo.
- The output must help a rep decide who to contact today and why.

Return strict JSON only. No markdown.

JSON shape:
{
  "signals": [
    {
      "accountName": "exact account name from list",
      "signalType": "Hiring | Expansion | New Facility | Trade Show | Conference | Award | Leadership Change | Product Launch | Partnership | Acquisition | Community Initiative | Government Contract | Funding | Rebrand | Major Initiative",
      "signalTitle": "short human-readable headline",
      "whatChanged": "one specific sentence about the public business development",
      "whyItMattersForPromo": "one clear sentence explaining why this creates a reason for a promo rep to reach out",
      "likelyBuyers": ["likely buyer roles such as HR Director, Operations Manager, Marketing Manager"],
      "likelyProducts": ["uniforms", "welcome kits", "trade show giveaways", "recognition gifts"],
      "likelyConversations": ["short conversation themes"],
      "suggestedOpener": "one natural sentence a rep could say or email",
      "sourceName": "source/domain/publication",
      "sourceUrl": "best source URL",
      "sources": [{"name":"source name", "url":"source URL"}],
      "publicationDate": "date if visible, otherwise empty string",
      "confidence": 0-100
    }
  ]
}

Accounts:
${JSON.stringify(accountPromptContext(safeAccounts), null, 2)}`;

    const model = process.env.OPENAI_SEARCH_MODEL || process.env.OPENAI_MODEL || 'gpt-4.1-mini';
    const toolPrefs = [];
    if (process.env.OPENAI_WEB_SEARCH_TOOL) toolPrefs.push(process.env.OPENAI_WEB_SEARCH_TOOL);
    toolPrefs.push('web_search_preview', 'web_search');

    let resp;
    let usedTool = '';
    let lastErr = '';
    for (const toolType of [...new Set(toolPrefs)]) {
      resp = await callOpenAIResponses({ apiKey, model, prompt, toolType });
      usedTool = toolType;
      if (resp.ok) break;
      lastErr = await resp.text().catch(() => '');
      // If the model/tool combo is invalid, try the next tool alias. Otherwise stop.
      if (!/web_search|tool|invalid|unsupported/i.test(lastErr)) break;
    }

    if (!resp || !resp.ok) {
      return res.status(502).json({
        error: `OpenAI Responses API failed: ${resp ? resp.status : 'no response'}`,
        detail: String(lastErr || '').slice(0, 700),
        diagnostics: { elapsedMs: Date.now() - startedAt, model, mode, usedTool }
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
    ).slice(0, 80);

    const byAccount = {};
    for (const sig of signals) {
      if (!byAccount[sig.accountName]) byAccount[sig.accountName] = [];
      if (byAccount[sig.accountName].length < 2) byAccount[sig.accountName].push(sig);
    }
    const finalSignals = Object.values(byAccount).flat();

    const avgConfidence = finalSignals.length
      ? Math.round(finalSignals.reduce((sum, s) => sum + Number(s.confidenceScore || (s.confidence || 0) * 100 || 0), 0) / finalSignals.length)
      : 0;

    return res.status(200).json({
      signals: finalSignals,
      byAccount,
      diagnostics: {
        elapsedMs: Date.now() - startedAt,
        model,
        usedTool,
        accountsReceived: accounts.length,
        accountsResearched: safeAccounts.length,
        rawSignals: rawSignals.length,
        signalsDiscovered: rawSignals.length,
        signalsRejected: Math.max(0, rawSignals.length - finalSignals.length),
        signalsReturned: finalSignals.length,
        highConfidenceOpportunities: finalSignals.length,
        avgConfidence,
        webSearchEnabled: true,
        mode
      }
    });
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Batch research failed', diagnostics: { elapsedMs: Date.now() - startedAt } });
  }
}
