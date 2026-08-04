// Vercel Serverless Function: v38 Unified Signal Intelligence Engine.
// Endpoint: POST /api/research-batch
// Purpose: Google-AI-style business signal discovery for House Accounts.
// Pipeline: intent plan -> normalized candidates -> verification/clustering -> AI enrichment -> ranked opportunities.

import {
  buildQueryPlan,
  normalizeCandidate as normalizeSharedCandidate,
  clusterCandidates,
  classifySignalFamily,
  displaySignalType,
  normalizeOpportunity,
  validateOpportunity,
  dedupeOpportunities,
  resolveEventType,
  displayLabelForEventType,
  extractEventDate
} from './signal-intelligence.js';
import { createHash, timingSafeEqual } from 'crypto';

// Phase 2A implementation-review item 5 — instrumentation privacy. Normal
// production logs use counts and hashed identifiers only; raw customer/
// account names and full event_fingerprint strings (which embed a
// normalized company name — see eventFingerprint()/resolveEvents() in
// signal-intelligence.js) are withheld by default. Set the server-side
// (never client-controllable) env var HA_DEBUG_INSTRUMENTATION=true to
// include full identifiers for QA/debugging.
const DEBUG_INSTRUMENTATION = String(process.env.HA_DEBUG_INSTRUMENTATION || '').toLowerCase() === 'true';
function shortHash(value = '') {
  return createHash('sha256').update(String(value || '')).digest('hex').slice(0, 12);
}

// Priority 0 (reliability): no maxDuration override existed here before this
// fix (confirmed by repo-wide grep). Verified in the Vercel dashboard: this
// project runs Fluid Compute (Pro plan, 300s project default), so the real
// risk this override addresses is not "might exceed a tiny Hobby ceiling" —
// it's the nested-invocation cancellation gap: aborting the caller's
// (api/weekly-scan.js) client-side fetch does not reliably cancel this
// function's own already-dispatched invocation, which can keep running
// server-side and keep spending external API calls (OpenAI, web search)
// after nobody is listening for the result. This endpoint writes nothing to
// the database itself (verified — no supabase()/ha_signals calls anywhere in
// this file), so a response that arrives after the caller gave up is
// discarded, not persisted; the exposure is wasted compute/API spend, not
// data inconsistency. Capping this function's maxDuration to strictly below
// the caller's per-chunk AbortController timeout (60s, api/weekly-scan.js)
// means the platform itself ends a hung invocation before the caller would
// even give up, rather than after — minimizing that orphaned-spend window
// instead of leaving it open-ended.
//
// The actual override lives in vercel.json's "functions" block (this project
// is zero-config/framework-less; current Vercel guidance for that project
// type is to configure duration there), not as an in-file `export const
// config` — precedence between the two mechanisms when both are present is
// not clearly documented, so this file intentionally does not also export
// one. vercel.json's value for this path must be kept at or below
// api/weekly-scan.js's RESEARCH_FETCH_TIMEOUT_MS by hand.


// Constant-time-ish secret comparison: equal-length secrets are compared via
// crypto.timingSafeEqual (no early-exit on byte mismatch); a length mismatch
// short-circuits to false since Node's timingSafeEqual throws on unequal
// lengths and there is no secret-dependent information to protect in a
// length check alone. Never logs either input. Kept as a local copy (rather
// than imported from weekly-scan.js) so this independently-deployed
// serverless function has no build-time dependency on another one.
function safeSecretEqual(provided, expected) {
  const providedBuf = Buffer.from(String(provided || ''), 'utf8');
  const expectedBuf = Buffer.from(String(expected || ''), 'utf8');
  if (providedBuf.length !== expectedBuf.length) return false;
  return timingSafeEqual(providedBuf, expectedBuf);
}

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

async function enrichCandidatesWithFirecrawl(candidates = [], perAccountLimit = 6, totalLimit = 100) {
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

function normalizeSignalType(type = '', evidence = '') {
  if (/predictable|seasonal|fallback|timing/i.test(String(type || ''))) return 'Predictable Timing';
  const family = classifySignalFamily(`${type || ''} ${evidence || ''}`);
  return displaySignalType(family);
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
  if (/community|csr|sustainability|charity|fundraising|sponsor|festival|volunteer/.test(t)) return 'community/csr';
  if (/event|events|conference|expo|summit|webinar|booth|exhibitor/.test(t)) return 'events';
  if (/award|awards|recognition|best places|inc 5000|fastest growing/.test(t)) return 'awards';
  if (/leadership|team|executive|appointed|named|promoted/.test(t)) return 'leadership';
  if (/linkedin/.test(t)) return 'linkedin';
  return 'web';
}

function queryTemplates(company, context = {}, mode = 'ranked') {
  const loc = context.location ? ` ${context.location}` : '';
  const industry = context.industry ? ` ${context.industry}` : '';
  const quoted = `"${company}"`;
  const domain = String(context.website || '').replace(/^https?:\/\//,'').replace(/^www\./,'').split('/')[0] || '';

  if (mode === 'prospect-intelligence' || mode === 'warm-account') {
    // Prospect Intelligence must attempt an intent-driven buying-moment search chain
    // before creating Predictable Timing fallback opportunities. Keep searches surgical:
    // the goal is to find concrete reasons to contact the company now, not summarize it.
    const industryLower = String(context.industry || '').toLowerCase();
    const industryEventTerms =
      /packaging|manufactur|industrial|automation|food|beverage|consumer goods/.test(industryLower) ? `"PACK EXPO" OR "Battery Show" OR "MD&M" OR "CES"` :
      /medical|health|device|biotech|pharma/.test(industryLower) ? `"MD&M" OR "BIO International" OR "AACC" OR "HIMSS"` :
      /software|technology|electronics|robotics|ai|data/.test(industryLower) ? `"CES" OR "TechCrunch" OR "AWS re:Invent" OR "SaaStr"` :
      '';

    return [
      // A. Growth / Launch / Corporate Change
      `${quoted} AND ("subsidiary" OR "launch" OR "spin-off" OR acquired OR merger OR rebrand)`,
      `${quoted} AND ("new facility" OR expansion OR "ribbon cutting" OR headquarters OR "manufacturing plant" OR "new location" OR "distribution center")`,

      // B. Events / Conferences / Trade Shows
      `${quoted} AND (exhibitor OR booth OR conference OR expo OR "trade show" OR summit OR "open house" OR "customer event" OR webinar)`,
      industryEventTerms ? `${quoted} AND (${industryEventTerms})` : '',

      // C. Hiring / People / Culture
      `${quoted} AND (hiring OR careers OR jobs OR "now hiring")`,
      `${quoted} AND ("employee experience" OR "talent acquisition" OR "people operations" OR HR OR onboarding)`,
      `${quoted} AND ("event coordinator" OR "field marketing" OR "trade show manager" OR "marketing manager")`,
      `${quoted} AND (appointed OR promoted OR "named president" OR "named CEO" OR "named vice president" OR "joins as" OR "new executive" OR "leadership change")`,
      context.contactName ? `"${context.contactName}" "${company}" (appointed OR promoted OR promotion OR "new role" OR "joins" OR "named" OR "new company")` : '',

      // D. Community / Sponsorship / CSR
      `${quoted} AND (sponsor OR "community event" OR charity OR volunteer OR "golf tournament" OR "5K")`,
      `${quoted} AND (school OR STEM OR foundation OR donation OR fundraiser)`,

      // E. Awards / Milestones / Recognition
      `${quoted} AND (award OR recognized OR anniversary OR milestone)`,
      `${quoted} AND ("safety milestone" OR "years without" OR "lost-time accident")`,

      // F. Operational Friction / Internal Morale. These are only usable when handled with care.
      `${quoted} AND (lawsuit OR "legal dispute" OR court OR town OR "power outage" OR "facility issue")`,

      // G. Media / Trade Publication Coverage
      `${quoted} AND ("featured in" OR interview OR magazine OR profile)`,

      // Owned-site intent pages. Firecrawl enrichment will prioritize these later.
      domain ? `site:${domain} (news OR press OR "press release" OR blog OR careers OR jobs OR events OR community OR locations OR sustainability)` : '',
      domain ? `site:${domain} ("trade show" OR conference OR booth OR exhibitor OR "open house" OR webinar OR event OR summit)` : '',
      domain ? `site:${domain} ("new facility" OR "new location" OR expansion OR "ribbon cutting" OR anniversary OR award OR launch OR partnership)` : '',
      context.oneOffResearch && context.contactName ? `"${context.contactName}" "${company}" (interview OR podcast OR webinar OR conference OR speaker OR award OR promoted OR promotion OR article OR quoted OR patent OR LinkedIn)` : '',
      context.oneOffResearch && context.contactName ? `"${context.contactName}" "${company}" (community OR volunteer OR anniversary OR launch OR event OR initiative)` : ''
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
    `${quoted}${loc} (CEO OR president OR "vice president" OR appointed OR named OR promoted OR leadership OR joins OR "new executive")`,
    context.contactName ? `"${context.contactName}" "${company}" (appointed OR promoted OR promotion OR "new role" OR joins OR named OR "new company")` : '',
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
  let httpStatus = 0;
  try {
    const resp = await fetch('https://google.serper.dev/search', {
      method: 'POST',
      headers: { 'X-API-KEY': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ q: query, num: 8 })
    });
    httpStatus = resp.status;
    if (!resp.ok) {
      return [{
        title: '',
        snippet: '',
        url: '',
        source: '',
        date: '',
        provider: 'serper',
        query,
        httpStatus,
        searchError: `Serper returned HTTP ${httpStatus}`
      }];
    }
    const data = await resp.json();
    return [...(data.organic || []), ...(data.news || [])].map(r => ({
      title: clean(r.title),
      snippet: clean(r.snippet || r.description || ''),
      url: r.link || r.url || '',
      source: r.source || sourceDomain(r.link || r.url || ''),
      date: r.date || '',
      provider: 'serper',
      query,
      httpStatus
    })).filter(r => r.url || r.title).slice(0, 10);
  } catch (error) {
    return [{
      title: '',
      snippet: '',
      url: '',
      source: '',
      date: '',
      provider: 'serper',
      query,
      httpStatus,
      searchError: error?.message || 'Serper request failed'
    }];
  }
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
  // Prospect Intelligence uses Serper as the configured search provider.
  // Do not require Tavily or Brave for targeted search.
  return await serperSearch(query);
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
  if (/community event|charity|fundraiser|sponsorship|sponsor|festival|volunteer|philanthropy/.test(t)) score += 18;

  // Generic versions still count, but less.
  if (/hiring|jobs|careers|now hiring|open positions|recruiting/.test(t)) score += 12;
  if (/launch|unveiled|rollout|new product|new division|rebrand/.test(t)) score += 10;
  if (/expansion|new office|new location|facility|headquarters|warehouse|manufacturing/.test(t)) score += 12;
  if (/acquired|acquisition|merger|funding|investment|partnership|customer win|contract/.test(t)) score += 10;
  if (/2026|2025|today|yesterday|this week|recently|announced|upcoming|now/.test(t)) score += 10;
  if (/layoff|downsizing|bankruptcy|plant closure|closure|recall|scandal|investigation/.test(t)) score -= 40;
  if (/lawsuit|legal dispute|court|town|power outage|facility issue|operational disruption/.test(t)) score += 10;
  if (/contact us|privacy|terms|map|directions|mission statement|history/.test(t)) score -= 20;
  return Math.max(0, score);
}

function normalizedCandidateUrl(value = '') {
  try {
    const u = new URL(value);
    u.hash = '';
    // Remove common tracking parameters so the same article is not treated as new evidence.
    ['utm_source','utm_medium','utm_campaign','utm_term','utm_content','gclid','fbclid'].forEach(k => u.searchParams.delete(k));
    return `${u.hostname.replace(/^www\./, '').toLowerCase()}${u.pathname.replace(/\/$/, '')}${u.search}`;
  } catch {
    return String(value || '').split('#')[0].toLowerCase();
  }
}

function normalizedCandidateTitle(value = '') {
  return clean(value)
    .toLowerCase()
    .replace(/\b(press release|news release|breaking news|updated)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter(w => w.length > 2)
    .slice(0, 14)
    .join(' ');
}

function dedupeCandidates(candidates = []) {
  const seenUrls = new Set();
  const seenStories = new Set();
  const out = [];
  for (const c of candidates) {
    const urlKey = normalizedCandidateUrl(c.url || '');
    const titleKey = normalizedCandidateTitle(c.title || c.snippet || '');
    const storyKey = `${String(c.accountName || '').toLowerCase()}|${titleKey}`;
    if ((urlKey && seenUrls.has(urlKey)) || (titleKey && seenStories.has(storyKey))) continue;
    if (urlKey) seenUrls.add(urlKey);
    if (titleKey) seenStories.add(storyKey);
    out.push(c);
  }
  return out;
}

function prospectDebugLog(label, payload = {}) {
  try {
    console.log(`[Prospect Research] ${label}`, JSON.stringify(payload, null, 2));
  } catch {
    console.log(`[Prospect Research] ${label}`, payload);
  }
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
    repeatPatterns: Array.isArray(a.repeatPatterns) ? a.repeatPatterns.slice(0, 5) : [],
    intelligenceMode: clean(a.intelligenceMode || ''),
    assignedRep: clean(a.assignedRep || '')
  }));
}

async function discoverCandidatesForAccounts(accounts = [], mode = 'ranked') {
  const sourceCoverage = {};
  const allCandidates = [];
  const samples = [];
  const diagnostics = [];
  const perAccount = await mapLimit(accounts, Math.max(1, Math.min(Number(process.env.RESEARCH_ACCOUNT_CONCURRENCY || 4), 8)), async account => {
    const accountStartedAt = Date.now();
    const accountMode = clean(account.intelligenceMode).toLowerCase();
    const effectiveMode = (accountMode === 'warm' || accountMode === 'mixed') ? 'warm-account' : mode;
    const sharedPlan = buildQueryPlan(account.name, account);
    const sharedQueries = sharedPlan.map(item => item.query);
    const allQueries = [...sharedQueries, ...queryTemplates(account.name, account, effectiveMode)]
      .filter((q, index, arr) => q && arr.indexOf(q) === index);
    // Prospect mode remains deepest, while existing-customer research now receives
    // enough coverage to find multiple distinct public buying moments per account.
    const deepResearch = effectiveMode === 'prospect-intelligence' || effectiveMode === 'warm-account';
    const queryLimit = Math.max(6, Math.min(Number(process.env.RESEARCH_QUERIES_PER_ACCOUNT || (deepResearch ? 12 : 10)), 18));
    const queries = allQueries.slice(0, queryLimit);
    const resultSets = await Promise.all(queries.map(runSearch));
    const rawSearchResults = resultSets.flat();
    let raw = rawSearchResults.filter(r => r && (r.url || r.title));
    if (deepResearch) raw = raw.concat(priorityOwnedPages(account));

    const scored = raw.map(r => {
      const queryPlanItem = sharedPlan.find(item => item.query === r.query);
      const legacyScore = scoreCandidate(r, account.name);
      const normalized = normalizeSharedCandidate({
        ...r,
        accountName: account.name,
        intendedSignalFamily: queryPlanItem?.signalFamily || '',
        sourceType: classifySource(r.url, r.title)
      }, account, queryPlanItem?.signalFamily || '');
      return {
        ...normalized,
        sourceType: classifySource(r.url, r.title),
        score: Math.round((legacyScore * 0.45) + ((normalized.candidateScore || 0) * 0.55))
      };
    });

    const ranked = clusterCandidates(dedupeCandidates(scored
      .filter(r => r.entityVerification?.level !== 'rejected')
      .filter(r => r.score >= (deepResearch ? 10 : 12))
      .sort((a,b) => b.score - a.score)))
      .slice(0, deepResearch ? 30 : 24);

    const liveCandidateCount = ranked.filter(r => (r.provider || '') !== 'owned-site' && r.score >= 18).length;
    const highIntentCandidateCount = ranked.filter(r => r.score >= 28).length;
    const queriesWithResults = queries.map((q, i) => {
      const set = resultSets[i] || [];
      const realResults = set.filter(r => r && (r.url || r.title));
      const statuses = [...new Set(set.map(r => r.httpStatus).filter(Boolean))];
      const errors = set.map(r => r.searchError).filter(Boolean);
      return {
        query: q,
        provider: 'serper',
        serperHttpStatus: statuses.length ? statuses.join(',') : (process.env.SERPER_API_KEY ? 'no-status' : 'not-configured'),
        resultsReturned: realResults.length,
        error: errors[0] || ''
      };
    });

    diagnostics.push({
      companyName: account.name,
      targetedQueriesRun: queries.length,
      queries: queriesWithResults,
      sourcesReturned: raw.length,
      rankedCandidates: ranked.length,
      topSources: ranked.slice(0, 5).map(r => ({
        title: r.title,
        url: r.url,
        domain: sourceDomain(r.url),
        sourceType: r.sourceType,
        score: r.score,
        query: r.query
      })),
      liveSignalCandidateFound: liveCandidateCount > 0,
      highIntentCandidateFound: highIntentCandidateCount > 0,
      fallbackEligibleAfterSearch: highIntentCandidateCount === 0,
      uniqueCandidateUrls: new Set(ranked.map(r => normalizedCandidateUrl(r.url)).filter(Boolean)).size,
      enrichedPages: ranked.filter(r => r.pageContent).length,
      status: 'processed',
      elapsedMs: Date.now() - accountStartedAt
    });

    if (mode === 'prospect-intelligence' || mode === 'warm-account') {
      prospectDebugLog('Targeted search complete', {
        company: account.name,
        queriesRun: queries,
        queryResultCounts: queriesWithResults,
        resultsReturned: raw.length,
        rankedCandidates: ranked.length,
        topResults: ranked.slice(0, 3).map(r => ({
          title: r.title,
          url: r.url,
          sourceType: r.sourceType,
          score: r.score,
          query: r.query
        })),
        liveSignalCandidateFound: liveCandidateCount > 0,
        highIntentCandidateFound: highIntentCandidateCount > 0,
        fallbackEligibleAfterSearch: highIntentCandidateCount === 0
      });
    }

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
      sourceType: r.sourceType,
      query: r.query
    })));
    allCandidates.push(...ranked);
    return ranked;
  });
  return { candidates: allCandidates, perAccount, sourceCoverage, samples, diagnostics };
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

For accounts marked intelligenceMode="warm", treat them as known or assigned relationships without uploaded order history. Use uploaded contacts first when they align with the opportunity. Do not describe them as cold prospects and do not invent historical purchases.

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

Leadership and contact-change rules:
- Treat executive appointments, promotions, known-contact role changes, and known-contact company changes as Leadership Change only when the person, company, and new role are supported by a credible public source.
- Preserve the person's name, exact new title, company, and announcement date when available.
- A leadership change is not automatically high priority. Rank it against facility expansion, acquisitions, launches, events, hiring initiatives, seasonal buying windows, and other opportunities using the same ABD / Why Now logic.
- Penalize stale, weakly sourced, or role-only leadership mentions. Do not infer a promotion or company change from an undated directory listing alone.

Potential Contacts rules:
- Include potential_contacts only when a public source or uploaded contact supports the person and role.
- If a user supplied a contact name, attempt to verify that person first and prefer them when the evidence supports their company and role.
- Return at most 2 contacts.
- Never invent names, titles, email addresses, phone numbers, LinkedIn URLs, or contact pages.
- For each verified public contact, return only public details actually present in the supplied research: linkedin, email, direct_phone, company_phone, contact_page, confidence, and sources_used.
- Research confidence describes verification quality, not buying intent. Use High only when name, title, and company are verified; Medium when name/company are verified but title is inferred or incomplete; Low for department-only recommendations.

Return JSON only with shape: {"signals":[{"company_name":"","accountName":"","signal_type":"","signalType":"","concrete_trigger":"","buying_moment":"","signalTitle":"","whatChanged":"","event_date":"","location":"","source_url":"","source_name":"","business_context":"","businessContext":"","why_this_matters":"","whyItMattersForPromo":"","recommended_buying_team":[""],"recommendedBuyingTeam":[""],"potential_contacts":[{"name":"","title":"","reason":"","sourceUrl":"","linkedin":"","email":"","direct_phone":"","company_phone":"","contact_page":"","confidence":"High|Medium|Low","sources_used":[{"name":"","url":""}]}],"potentialContacts":[{"name":"","title":"","reason":"","sourceUrl":"","linkedin":"","email":"","directPhone":"","companyPhone":"","contactPage":"","confidence":"High|Medium|Low","sourcesUsed":[{"name":"","url":""}]}],"why_these_contacts":"","whyTheseContacts":"","promo_categories":[""],"likelyProducts":[""],"suggested_opener":"","suggestedOpener":"","actionability_score":0,"budget_score":0,"deadline_score":0,"why_now_score":0,"confidence":0,"sourceName":"","sourceUrl":"","sources":[{"name":"","url":""}],"publicationDate":""}]}.

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

function contextToPromoWhy(context = '', type = '', ground = {}) {
  const c = clean(context);
  const accountName = clean(ground.accountName || '');
  if (!c) return accountName ? `Recent public activity from ${accountName} creates a timely reason to start a conversation.` : 'Recent public business activity creates a timely reason to start a conversation.';
  if (/specific growth driver is not yet clear/i.test(c)) return 'Hiring creates a practical reason to ask who owns onboarding, recruiting, and employee engagement support.';
  return compact(`${c} That creates a practical reason to ask about onboarding, employee engagement, events, apparel, recognition, or brand support tied to the change.`, 280);
}

// Paid-beta grounded outreach (Priority 2): when there isn't enough factual
// context to name a specific reason to reach out, this is a transparent
// limited state -- it says plainly that the detail is thin -- rather than
// inventing urgency or implying a merch program that doesn't exist.
function honestLimitedOpener(accountName = '') {
  return accountName
    ? `We found public activity for ${accountName}, but not enough detail yet to point to one specific reason to reach out. Worth a quick check-in to see what's changing internally.`
    : "We found public activity for this account, but not enough detail yet to point to one specific reason to reach out. Worth a quick check-in to see what's changing internally.";
}

function contextToOpener(context = '', type = '', ground = {}) {
  const c = clean(context);
  const accountName = clean(ground.accountName || '');
  const who = accountName ? `${accountName} is` : "you're";
  if (/specific growth driver is not yet clear/i.test(c) || /hiring/i.test(type)) {
    return `I noticed ${who} growing the team recently. Is anything changing internally that your team is planning around?`;
  }
  if (!c) return honestLimitedOpener(accountName);
  if (/event|conference|expo|trade show/i.test(`${c} ${type}`)) return `Saw ${accountName || 'the'} event activity and had a quick question — who handles branded materials or attendee follow-up?`;
  if (/funding|capital|investment|growth/i.test(c)) return `Saw ${accountName ? `${accountName}'s` : 'the'} recent growth news and had a quick question — has that changed any hiring, onboarding, or brand initiatives?`;
  if (/facility|location|distribution center|production capacity/i.test(c)) return `Saw ${accountName ? `${accountName}'s` : 'the'} expansion activity and had a quick question — who supports team onboarding, apparel, or site launch needs?`;
  return honestLimitedOpener(accountName);
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
  if (/community|sponsor|festival|fundraiser|philanthropy|volunteer|csr/.test(t)) return 'Community / Sponsorship Event';
  if (/facility|new location|ribbon cutting|plant|warehouse|distribution center|headquarters/.test(t)) return 'Facility / Location Expansion';
  if (/trade show|exhibitor|booth|conference|expo|summit|open house|customer event|dealer meeting|webinar/.test(t)) return 'Event / Trade Show';
  if (/product launch|new product|rollout|unveil/.test(t)) return 'Product Launch';
  if (/rebrand|merger|acquisition|integrat/.test(t)) return 'Brand / Business Change';
  if (/contract|customer win|partnership|awarded|selected/.test(t)) return 'Contract / Partnership Win';
  if (/hiring|recruit|talent|employee experience|field marketing|event manager|onboarding/.test(t)) return 'Hiring / Team Growth';
  if (/award|recognition|anniversary|milestone|safety/.test(t)) return 'Recognition / Milestone';
  return normalizeSignalType(type || trigger || 'Business Activity');
}

function promoCategoriesForMoment(moment = '', type = '', context = '') {
  const t = clean(`${moment} ${type} ${context}`).toLowerCase();
  if (/community|sponsor|festival|fundraiser|philanthropy|volunteer/.test(t)) return ['Event Giveaways','Volunteer Apparel','Banners','Community Gifts'];
  if (/facility|location|plant|warehouse|operations|expansion|ribbon/.test(t)) return ['Employee Apparel','Onboarding Kits','Safety Items','Opening-Day Gifts'];
  if (/trade show|event|conference|expo|booth|summit|webinar|open house/.test(t)) return ['Event Kits','Booth Giveaways','Branded Apparel','Follow-Up Gifts'];
  if (/hiring|recruit|talent|onboarding|employee/.test(t)) return ['Onboarding Items','Recruiting Materials','Employee Apparel','Recognition Gifts'];
  if (/product launch|launch|rebrand/.test(t)) return ['Launch Kits','Customer Gifts','Event Giveaways','Branded Apparel'];
  if (/award|recognition|anniversary|milestone|safety/.test(t)) return ['Recognition Gifts','Awards','Employee Apparel','Celebration Kits'];
  if (/contract|partnership|customer win|sales/.test(t)) return ['Customer Appreciation','Sales Kits','Executive Gifts','Event Giveaways'];
  return ['Employee Apparel','Event Kits','Customer Appreciation','Recognition Gifts'];
}

// Grounds the "why this matters" text in the department the signal already
// points at and one real historical-order fact, when either is available --
// without inventing a merch program or claiming anything is already planned.
function groundedWhySuffix(ground = {}) {
  const dept = clean((ground.recommendedBuyingTeam || [])[0] || '');
  const historical = clean(ground.historicalFact || '');
  if (historical) return ` ${dept ? `${dept} ` : ''}may already be worth a note, since ${historical}.`;
  if (dept) return ` ${dept} is the most likely owner of a need like this.`;
  return '';
}

function salesReadyWhy(trigger = '', context = '', moment = '', type = '', ground = {}) {
  const t = clean(`${trigger} ${context} ${moment} ${type}`).toLowerCase();
  const suffix = groundedWhySuffix(ground);
  if (/community|sponsor|festival|fundraiser|philanthropy|volunteer|csr/.test(t)) return `Community programs often need volunteer apparel, banners, giveaways, sponsor gifts, and simple branded items for attendees or partners.${suffix}`;
  if (/facility|location|plant|warehouse|ribbon|expansion/.test(t)) return `Facility launches usually create needs around employee apparel, onboarding materials, safety items, local PR giveaways, and opening-day gifts.${suffix}`;
  if (/trade show|conference|expo|booth|summit|open house|customer event|webinar/.test(t)) return `Events usually require booth giveaways, attendee gifts, team apparel, signage, and follow-up items that help the sales or marketing team stay memorable.${suffix}`;
  if (/hiring|recruit|talent|onboarding|employee experience/.test(t)) return `Hiring and onboarding create practical needs around recruiting materials, new-hire kits, employee apparel, and internal engagement.${suffix}`;
  if (/product launch|launch|rollout|unveil/.test(t)) return `Launches often need sales samples, customer gifts, launch kits, event materials, and branded touchpoints for internal and external audiences.${suffix}`;
  if (/award|recognition|anniversary|milestone|safety/.test(t)) return `Recognition moments create a natural reason to discuss employee gifts, awards, celebration kits, safety incentives, or customer-facing thank-you items.${suffix}`;
  if (/contract|partnership|customer win/.test(t)) return `Major wins can create needs around employee communication, customer appreciation, launch support, and brand visibility with new stakeholders.${suffix}`;
  return contextToPromoWhy(context, type, ground);
}

// Builds the opener's lead sentence with an accurate tense: "coming up" only
// for a genuinely future, confidently-dated event; "recently had" (past
// tense) for an event-like signal within the 45-day follow-up window;
// tense-neutral possessive for ongoing business-change signals (which use
// publication recency, not an event date) and for anything with no
// actionability info supplied at all.
function leadSentence(accountName = '', specific = '', actionability = {}) {
  if (!accountName) return `Saw ${specific}.`;
  if (actionability.status === 'upcoming') return `Saw ${accountName} has ${specific} coming up.`;
  if (actionability.status === 'recent-past') return `Saw ${accountName} recently had ${specific}.`;
  return `Saw ${accountName}'s ${specific}.`;
}

function salesReadyOpener(trigger = '', context = '', moment = '', type = '', ground = {}) {
  const specific = compact(trigger || moment || '', 90);
  const accountName = clean(ground.accountName || '');
  if (!specific) return honestLimitedOpener(accountName);
  const lead = leadSentence(accountName, specific, ground.actionability || {});
  const dept = clean((ground.recommendedBuyingTeam || [])[0] || '');
  const deptAsk = dept ? ` Is ${dept} the right team to ask about that?` : '';
  const historicalNote = ground.historicalFact ? ` Since ${ground.historicalFact}, this seems worth a quick note.` : '';
  const t = clean(`${specific} ${context} ${moment} ${type}`).toLowerCase();
  if (/community|sponsor|festival|fundraiser|philanthropy|volunteer|csr/.test(t)) return `${lead} Community events usually need volunteer apparel, banners, giveaways, and thank-you gifts.${historicalNote} Want me to send over a few ideas that could fit?${deptAsk}`;
  if (/facility|location|plant|warehouse|ribbon|expansion/.test(t)) return `${lead} For site launches, teams usually balance employee onboarding, local PR, safety gear, and opening-day gifts.${historicalNote} I had a few practical ideas around apparel and launch kits — worth sending over?${deptAsk}`;
  if (/trade show|conference|expo|booth|summit|open house|customer event|webinar/.test(t)) return `${lead} Events like that usually need booth giveaways, team apparel, attendee gifts, and follow-up items.${historicalNote} Want me to send over a few ideas?${deptAsk}`;
  if (/hiring|recruit|talent|onboarding|employee experience/.test(t)) return `${lead} When teams are growing, onboarding kits, recruiting materials, and employee apparel usually become timely.${historicalNote}${deptAsk || ' Is there someone I should ask about that?'}`;
  if (/product launch|launch|rollout|unveil/.test(t)) return `${lead} Launches usually need internal hype, sales support, and customer-facing branded items.${historicalNote} I had a few simple launch-kit ideas — worth sending over?${deptAsk}`;
  if (/award|recognition|anniversary|milestone|safety/.test(t)) return `${lead} Moments like that are a good chance to recognize employees or thank customers.${historicalNote} Would a few branded celebration or recognition ideas be useful?${deptAsk}`;
  if (/contract|partnership|customer win/.test(t)) return `${lead} Wins like that often create internal and customer-facing communication needs.${historicalNote} I had a few ideas around team apparel and thank-you kits — worth sending over?${deptAsk}`;
  return contextToOpener(context, type, ground);
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
      return { name: clean(parts[0]), title: clean(parts.slice(1).join(' — ')), reason: '', confidence: 'Low', sourcesUsed: [] };
    }
    const sourcesUsed = safeArray(c?.sourcesUsed || c?.sources_used || c?.sources, 4).map(src => ({
      name: clean(src?.name || src?.sourceName || src?.title || sourceDomain(src?.url || src?.sourceUrl || '')),
      url: clean(src?.url || src?.sourceUrl || '')
    })).filter(src => src.name || src.url);
    const linkedin = clean(c?.linkedin || c?.linkedIn || c?.linkedinUrl || c?.linkedin_profile || '');
    const email = clean(c?.email || c?.companyEmail || c?.publicEmail || c?.directEmail || '');
    const directPhone = clean(c?.directPhone || c?.direct_phone || c?.phone || '');
    const companyPhone = clean(c?.companyPhone || c?.company_phone || '');
    const contactPage = clean(c?.contactPage || c?.contact_page || '');
    const sourceUrl = clean(c?.sourceUrl || c?.url || linkedin || contactPage || '');
    if (sourceUrl && !sourcesUsed.some(src => src.url === sourceUrl)) {
      sourcesUsed.unshift({ name: clean(c?.sourceName || sourceDomain(sourceUrl) || 'Public source'), url: sourceUrl });
    }
    let confidence = clean(c?.confidence || c?.researchConfidence || c?.research_confidence || '');
    if (!/^(high|medium|low)$/i.test(confidence)) {
      confidence = clean(c?.name) && clean(c?.title) && (linkedin || email || sourceUrl) ? 'High'
        : clean(c?.name) && (clean(c?.title) || linkedin || sourceUrl) ? 'Medium' : 'Low';
    }
    confidence = confidence.charAt(0).toUpperCase() + confidence.slice(1).toLowerCase();
    return {
      name: clean(c?.name || c?.fullName || c?.person || ''),
      title: clean(c?.title || c?.role || c?.jobTitle || ''),
      reason: clean(c?.reason || c?.whyRelevant || c?.relevance || c?.why || ''),
      sourceUrl, linkedin, email, directPhone, companyPhone, contactPage, confidence, sourcesUsed
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
    if (typeof c === 'string') return { name: clean(c), title: '', department: '', email: '', phone: '', linkedin: '', source: 'From your uploaded account list' };
    return {
      name: clean(c?.name || c?.contactName || c?.fullName || ''),
      title: clean(c?.title || c?.role || c?.jobTitle || ''),
      department: clean(c?.department || c?.contactDepartment || ''),
      email: clean(c?.email || c?.contactEmail || ''),
      phone: clean(c?.phone || c?.contactPhone || c?.directPhone || ''),
      linkedin: clean(c?.linkedin || c?.linkedIn || c?.linkedinUrl || ''),
      reason: clean(c?.reason || ''),
      source: clean(c?.source || 'From your uploaded account list')
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
      directPhone: c.phone,
      sourceType: 'uploaded',
      reason: c.reason || 'This uploaded contact aligns with the recommended buying team for this opportunity.',
      source: 'From your uploaded account list',
      sourcesUsed: [{ name: 'From your uploaded account list', url: '' }],
      confidence: c.title && (c.email || c.linkedin) ? 'High' : (c.title || c.email || c.linkedin ? 'Medium' : 'Low')
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


function buildSuggestedContact(potentialContacts = [], recommendedBuyingTeam = [], raw = {}) {
  const verified = potentialContacts[0];
  if (verified) {
    return {
      name: verified.name,
      title: verified.title || recommendedBuyingTeam[0] || '',
      whyThisContact: clean(verified.reason || raw.whyThisContact || raw.why_this_contact || 'This person appears aligned with the buying team most likely to own the detected initiative.'),
      linkedin: verified.linkedin || '',
      email: verified.email || '',
      directPhone: verified.directPhone || '',
      companyPhone: verified.companyPhone || '',
      contactPage: verified.contactPage || '',
      researchConfidence: verified.confidence || 'Medium',
      sourcesUsed: verified.sourcesUsed || [],
      sourceType: verified.sourceType || (String(verified.source || '').toLowerCase().includes('uploaded') ? 'uploaded' : 'public')
    };
  }
  return {
    name: '',
    title: recommendedBuyingTeam[0] || 'Relevant department lead',
    whyThisContact: clean(raw.whyThisContact || raw.why_this_contact || 'Start with the department most likely to own the detected initiative.'),
    linkedin: '', email: '', directPhone: '', companyPhone: '', contactPage: '',
    researchConfidence: 'Low',
    sourcesUsed: [],
    sourceType: 'department'
  };
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
    suggestedContactDetails,
    suggested_contact_details: suggestedContactDetails,
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

function leadershipVerificationAdjustment(raw = {}, type = '', summary = '', businessContext = '', sourceUrl = '') {
  if (!/leadership|appoint|promot|named|joins as|new executive|new ceo|new president|new vice president/i.test(`${type} ${raw.signalType || ''} ${raw.signalTitle || ''} ${summary} ${businessContext}`)) return 0;
  const text = clean(`${raw.signalTitle || ''} ${raw.title || ''} ${summary} ${businessContext}`);
  const hasNamedPerson = /[A-Z][a-z]+(?:\s+[A-Z][a-z.'-]+){1,3}/.test(text) || !!clean(raw.personName || raw.contactName || raw.executiveName || '');
  const hasRelevantTitle = /(ceo|chief|president|vice president|vp|director|head of|general manager|executive)/i.test(text);
  const hasDate = !!clean(raw.publicationDate || raw.publishedDate || raw.date || raw.event_date || '');
  const hasCredibleSource = !!sourceUrl || (Array.isArray(raw.sources) && raw.sources.some(s => clean(s?.url || s?.sourceUrl || '')));
  let adjustment = 0;
  if (!hasNamedPerson) adjustment -= 10;
  if (!hasRelevantTitle) adjustment -= 8;
  if (!hasDate) adjustment -= 5;
  if (!hasCredibleSource) adjustment -= 12;
  return adjustment;
}

function confidenceWithContextFloor(confidencePct = 0, raw = {}, type = '', summary = '', businessContext = '') {
  let score = Number(confidencePct || 0);
  if (hasUnclearBusinessContext(businessContext)) score = Math.max(55, score - 8);
  if (hasMeaningfulSignal(raw, type, summary, businessContext)) score = Math.max(score, hasUnclearBusinessContext(businessContext) ? 58 : 64);
  return Math.round(Math.max(0, Math.min(100, score)));
}

// Phase 2A / B3 — replaces the old normalizeSignalTypeFromEvidence(), which
// computed a content-derived classification via its own regex rules but only
// applied the correction when the AI's declared type was one of two generic
// fallback labels ('Business Activity' or a mismatched 'Hiring') — for any
// other specific-but-wrong declared label (the exact shape of the frozen
// Phase 1B mismatches on ranks 5, 8, 11, 14, 17) it silently discarded its
// own correctly-computed answer and returned the AI's original label
// unchanged. resolveCanonicalEventType() never consults the AI's declared
// type at all: it computes signal-intelligence.js's resolveEventType()
// (the same canonical, ALL_CAPS taxonomy that drives event_fingerprint) on
// the same evidence text, and that is the only classification used from
// here on for this signal, both for the display label and — carried via
// canonicalEventType on the returned object — for event resolution/
// fingerprinting downstream, so both are guaranteed to agree by
// construction rather than by coincidence.
function resolveCanonicalEventType(raw = {}) {
  const text = clean(`${raw.concrete_trigger || raw.concreteTrigger || ''} ${raw.buying_moment || raw.buyingMoment || ''} ${raw.signalTitle || raw.title || ''} ${raw.whatChanged || raw.summary || raw.signalDetail || ''} ${raw.business_context || raw.businessContext || ''}`);
  const family = classifySignalFamily(text);
  const { primaryType } = resolveEventType(text, family);
  return { eventType: primaryType, label: displayLabelForEventType(primaryType) };
}

// Paid-beta signal-date-truth (Priority 1): canonical types that describe a
// discrete, date-stamped occurrence -- something that either has a scheduled
// date or already happened on a specific day -- as opposed to an ongoing
// business state or trend that has no single event date to speak of.
// PRODUCT_LAUNCH is included because the review's "event-like" list names
// "launch event" specifically; the location-opening cluster
// (NEW_LOCATION_OPENING/LOCATION_REOPENING/RENOVATION_COMPLETION/
// LOCATION_EVENT_UNSPECIFIED) is included because those are exactly the
// "ribbon cutting" ceremony class. Everything else (hiring, facility
// expansion, rebrand, leadership change, acquisition, partnership, and any
// generic BUSINESS_ACTIVITY_* family) is treated as an ongoing business
// change and is never required to carry an event date.
const EVENT_LIKE_TYPES = new Set([
  'EVENT_TRADE_SHOW', 'EVENT_CONFERENCE', 'EVENT_AWARD', 'EVENT_COMMUNITY', 'PRODUCT_LAUNCH',
  'NEW_LOCATION_OPENING', 'LOCATION_REOPENING', 'RENOVATION_COMPLETION', 'LOCATION_EVENT_UNSPECIFIED'
]);

function signalEventCategory(canonicalEventType = '') {
  return EVENT_LIKE_TYPES.has(canonicalEventType) ? 'event-like' : 'ongoing';
}

// Resolves the signal's own event date -- distinct from publicationDate
// (the source article's date) and from discoveredAt/dateFound (when House
// Accounts' own pipeline first saw it) -- using the same extractEventDate()
// parser signal-intelligence.js's resolveEvents() already relies on, so a
// date is only ever assigned when the evidence text actually describes when
// the event happened or will happen. Publication date is never substituted.
function resolveSignalEventDate(raw = {}, concreteTrigger = '', title = '', businessContext = '', eventCategory = 'ongoing') {
  const directField = clean(raw.event_date || raw.eventDate || '');
  let result = extractEventDate(directField);
  if (result.dateConfidence === 'unknown') {
    result = extractEventDate(clean(`${concreteTrigger} ${title} ${businessContext} ${directField}`));
  }
  if (result.dateConfidence === 'unknown' && eventCategory === 'event-like') {
    // Trade show / conference / award names very commonly embed only a bare
    // year ("Natural Products Expo West 2023") with no month, so
    // extractEventDate() (which requires at least a month) never assigns a
    // date. This is a deliberately narrow, event-like-only fallback: a bare
    // year found in the signal's own title/trigger text (never in the wider
    // business-context prose, to avoid matching an unrelated nearby year) is
    // treated as an approximate mid-year date -- but ONLY when that year is
    // strictly in the past. A bare mention of the current (or a future)
    // year carries no real month information ("2026 Annual Golf
    // Tournament" could be any month of 2026, including one still ahead of
    // today), and guessing a mid-year date for it can wrongly push a
    // same-year event outside the 45-day follow-up window into "stale" --
    // exactly the regression this guard prevents. A definitively past year
    // has no such ambiguity: no month within it can still be upcoming.
    const yearMatch = clean(`${concreteTrigger} ${title}`).match(/\b(20[0-9]{2})\b/);
    if (yearMatch) {
      const year = Number(yearMatch[1]);
      if (year < new Date().getUTCFullYear()) {
        result = { eventDate: `${year}-06-15`, dateConfidence: 'approximate', year };
      }
    }
  }
  return result;
}

// Conservative paid-beta actionability rules (Priority 1, reconciliation
// items 1 and 2). Event-like signals require a confidently parsed event
// date to be treated as a current priority at all:
//   - future date            -> upcoming, fully actionable
//   - up to 45 days in the past -> still actionable, but as a follow-up,
//                                   and any generated copy must use past
//                                   tense (never "is hosting")
//   - more than 45 days past -> excluded from current priorities entirely
//   - date unknown            -> may still exist as a lower-confidence
//                                   research detail, but is never eligible
//                                   to be shown as a priority and must never
//                                   be labeled "upcoming"
// Ongoing business-change signals have no single event date to require, but
// they DO require a conservative recency ceiling on the source/publication
// date (reconciliation item 2) -- otherwise an old hiring/expansion/rebrand
// article can surface as if it were current:
//   - published within the last 180 days -> priority eligible
//   - published more than 180 days ago    -> research detail only
//   - no trustworthy publication date      -> research detail only
// discoveredAt/first_seen_at (when House Accounts' own pipeline found the
// signal) is never substituted for the source's own publication date here.
// In every branch, excludeFromPriorities is exactly !isPriorityEligible --
// a single flag downstream code can rely on to keep a signal out of
// priorities/"Newly Detected"/the weekly digest WITHOUT deleting it: the
// caller (makeSignal()) persists every non-null signal regardless of this
// flag, and only uses it to filter what's actionable.
const FOLLOW_UP_WINDOW_DAYS = 45;
const ONGOING_RECENCY_CEILING_DAYS = 180;

// Deliberately stricter than parseSignalDate() (which allows a bare-year
// fallback for event-date extraction from free text): a publication
// timestamp is only "trustworthy" here when it carries at least a real
// month/day, not just a bare 4-digit year, since a bare year gives no way
// to tell a signal published 179 days ago from one published 900 days ago.
function parseTrustworthyPublicationDate(dateText = '') {
  const t = clean(dateText);
  if (!t || /^20\d{2}$/.test(t)) return null;
  const d = new Date(t);
  return isNaN(d.getTime()) ? null : d;
}

// QA round 2, item 5: label text is the single canonical source for the 5
// honest, user-facing actionability states -- Upcoming / Recent event /
// Ongoing business change / Date unavailable / No longer current. The
// dashboard's signalDateAndActionabilityLine() appends the actual date onto
// this label rather than inventing separate wording.
function computeActionability({ eventCategory = 'ongoing', eventDate = null, dateConfidence = 'unknown', publicationDate = '', now = new Date() } = {}) {
  if (eventCategory === 'event-like') {
    if (eventDate && dateConfidence !== 'unknown') {
      const parsed = parseSignalDate(eventDate);
      if (parsed) {
        const diffDays = Math.round((parsed.getTime() - now.getTime()) / 86400000);
        // QA round 3, item 1: "Upcoming" requires an explicit (exact-
        // confidence) future date. An approximate/inferred one (e.g. a bare
        // "Month Year" mention, or the past-year-only bare-year fallback in
        // resolveSignalEventDate()) is not a strong enough basis to assert
        // something is definitely still to come -- it falls through to
        // Date unavailable instead of a confident future claim.
        if (diffDays > 0) {
          if (dateConfidence === 'exact') {
            return { status: 'upcoming', tense: 'future', isPriorityEligible: true, excludeFromPriorities: false, usesPublicationDate: false, label: 'Upcoming' };
          }
        } else if (diffDays >= -FOLLOW_UP_WINDOW_DAYS) {
          return { status: 'recent-past', tense: 'past', isPriorityEligible: true, excludeFromPriorities: false, usesPublicationDate: false, label: 'Recent event' };
        } else {
          return { status: 'stale', tense: 'past', isPriorityEligible: false, excludeFromPriorities: true, usesPublicationDate: false, label: 'No longer current' };
        }
      }
    }
    return { status: 'unknown-date', tense: 'unknown', isPriorityEligible: false, excludeFromPriorities: true, usesPublicationDate: false, label: 'Date unavailable' };
  }
  const parsedPub = parseTrustworthyPublicationDate(publicationDate);
  if (!parsedPub) {
    return { status: 'ongoing-undated', tense: 'ongoing', isPriorityEligible: false, excludeFromPriorities: true, usesPublicationDate: true, label: 'Date unavailable' };
  }
  const ageDays = Math.round((now.getTime() - parsedPub.getTime()) / 86400000);
  if (ageDays <= ONGOING_RECENCY_CEILING_DAYS) {
    return { status: 'ongoing', tense: 'ongoing', isPriorityEligible: true, excludeFromPriorities: false, usesPublicationDate: true, label: 'Ongoing business change' };
  }
  return { status: 'ongoing-stale', tense: 'ongoing', isPriorityEligible: false, excludeFromPriorities: true, usesPublicationDate: true, label: 'No longer current' };
}

// QA round 2, item 1: single canonical legacy-signal normalizer. A "legacy"
// signal is one persisted before actionabilityStatus/eventCategory existed
// (or with only a partial/untrustworthy version of them) -- most notably
// signals from before this whole signal-date-truth workstream, whose
// eventDate/event_date field may itself be the OLD bug's publication-date
// fallback rather than a real event date. This function is the ONLY place
// that re-derives actionability for such a signal; every reader (dashboard
// priorities feed, "Newly Detected", weekly digest eligibility, Prepare for
// Call) consumes its output rather than re-implementing any of this logic
// itself. It never mutates the stored row -- callers apply it to an
// in-memory copy at read time.
function hasTrustworthyActionabilityMetadata(payload = {}) {
  const status = payload.actionabilityStatus;
  return Boolean(
    status && typeof status === 'object' &&
    typeof status.status === 'string' && status.status &&
    typeof status.isPriorityEligible === 'boolean' &&
    payload.eventCategory
  );
}

// QA round 3, item 1: this is the single canonical read boundary every
// signal -- legacy, fresh, or partially normalized -- passes through before
// priority selection, "Newly Detected" counts, timeframe feeds, outreach
// tense, or digest eligibility ever see it. It NEVER trusts a stored
// canonicalEventType/eventCategory/actionabilityStatus directly; it always
// recomputes eventCategory and actionabilityStatus fresh from more
// primitive inputs (evidence text and, when present and not the old
// publication-date-fallback bug, the stored eventDate/eventDateConfidence).
// signalEventCategory()/computeActionability()/resolveCanonicalEventType()
// are pure functions of those inputs, so this is a genuine no-op for a
// signal that was already classified correctly, and a self-healing
// correction for one that wasn't (e.g. a classifier gap that has since been
// fixed, or any other internally inconsistent combination such as
// event-like content marked isPriorityEligible:true with no real date).
function classifyLegacySignalActionability(payload = {}) {
  const title = clean(payload.title || payload.signalTitle || '');
  const concreteTrigger = clean(payload.concreteTrigger || payload.concrete_trigger || '');
  const businessContext = clean(payload.businessContext || payload.companyContext || payload.signalDetail || payload.whatChanged || '');
  const canonicalEventType = resolveCanonicalEventType({
    concrete_trigger: concreteTrigger, signalTitle: title,
    whatChanged: businessContext, business_context: businessContext
  }).eventType;
  const eventCategory = signalEventCategory(canonicalEventType);
  // payload.publishedAt covers signals persisted through the weekly-scan
  // pipeline (resolveOpportunityEvents() in signal-intelligence.js), which
  // uses that field name instead of the dashboard path's publishedDate --
  // without it, every weekly-scan-sourced ongoing signal would be
  // misjudged as dateless regardless of its real, evidence-backed publish
  // date.
  const publicationDate = clean(payload.publicationDate || payload.publishedDate || payload.publishedAt || '');

  const storedEventField = payload.event_date || payload.eventDate || '';
  const storedConfidence = payload.eventDateConfidence || '';
  // A stored eventDate identical to the publication date is the fingerprint
  // of the old publication-date-fallback bug -- untrusted either way, same
  // as before. Otherwise: a stored dateConfidence (any value including
  // 'unknown') is trusted as-is rather than re-derived, because re-parsing
  // an already-resolved ISO date string through resolveSignalEventDate()
  // would risk silently upgrading a genuinely 'approximate' evidence-based
  // date to 'exact' merely because it is now ISO-formatted. Only a signal
  // with NO stored confidence at all (true legacy, pre-dating this field)
  // falls back to full text-based re-derivation.
  const looksLikeOldBug = Boolean(storedEventField) && storedEventField === publicationDate;
  let eventDate = looksLikeOldBug ? '' : storedEventField;
  let dateConfidence = storedConfidence;
  if (!dateConfidence) {
    const resolved = resolveSignalEventDate({ event_date: eventDate }, concreteTrigger, title, businessContext, eventCategory);
    eventDate = resolved.eventDate || '';
    dateConfidence = resolved.dateConfidence;
  } else if (looksLikeOldBug) {
    dateConfidence = 'unknown';
  }
  const actionabilityStatus = computeActionability({ eventCategory, eventDate, dateConfidence, publicationDate });
  return {
    eventCategory,
    actionabilityStatus,
    eventDate: eventDate || '',
    eventDateConfidence: dateConfidence,
    isUpcoming: actionabilityStatus.status === 'upcoming'
  };
}

function meaningfulWhyThisMatters(raw = {}, type = '', trigger = '', context = '', buyingMoment = '', ground = {}) {
  const supplied = compact(raw.why_this_matters || raw.whyItMattersForPromo || raw.whyReachOut || raw.whyItMatters || raw.why || '', 300);
  const norm = value => clean(value).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const repeated = supplied && [trigger, context, raw.signalTitle, raw.title].some(v => norm(v) && (norm(supplied) === norm(v) || norm(supplied).includes(norm(v)) && norm(supplied).length <= norm(v).length + 12));
  return supplied && !repeated ? supplied : compact(salesReadyWhy(trigger, context, buyingMoment, type, ground), 300);
}

// Paid-beta grounded outreach (Priority 2): one real, specific historical
// order fact for this account, when the upload actually has one -- never
// invented. Consumed by the opener/why fallback templates so they can
// reference real order history instead of staying generic.
function oneHistoricalOrderFact(account = {}) {
  const orderCount = Number(account.orderCount || 0);
  const categories = Array.isArray(account.categories) ? account.categories.filter(Boolean) : [];
  if (categories.length && orderCount) {
    return `you've ordered ${categories[0]} for them before (${orderCount} order${orderCount === 1 ? '' : 's'} on file)`;
  }
  if (categories.length) return `you've ordered ${categories[0]} for them before`;
  if (orderCount) return `you have ${orderCount} order${orderCount === 1 ? '' : 's'} on file with them`;
  return '';
}

function makeSignal(raw = {}, account = {}, options = {}) {
  const accountName = clean(raw.accountName || raw.account || raw.company || raw.company_name || raw.companyName || '');
  if (!accountName) return null;
  const sourceUrl = clean(raw.sourceUrl || raw.url || raw.sources?.[0]?.url || '');
  const rawConfidencePct = adjustedConfidence(raw, sourceUrl, raw.sourceType || raw.sourceName || '');
  // Phase 2A / B3: the canonical classification is computed once, here, from
  // the evidence text alone. raw.signal_type/raw.signalType/raw.opportunityType
  // (whatever the AI itself declared) are never consulted for this — an
  // independent AI-declared classification can no longer override it.
  const canonicalType = resolveCanonicalEventType(raw);
  const type = canonicalType.label;
  const concreteTrigger = buildConcreteTrigger(raw, type, accountName);
  const buyingMoment = inferBuyingMoment(raw, type, concreteTrigger, raw.business_context || raw.businessContext || '');
  const title = compact(concreteTrigger || raw.signalTitle || raw.headline || raw.title || `${accountName} business activity`, 150);
  const summary = compact(raw.whatChanged || raw.shortSummary || raw.summary || raw.signalDetail || raw.details || title, 240);
  const businessContext = buildBusinessContext(raw, type, summary, accountName);
  if (options.enableProspectQuality && prospectKillRule(raw, type, summary, businessContext)) return null;
  const floorConfidencePct = confidenceWithContextFloor(rawConfidencePct, raw, type, summary, businessContext);
  const abd = options.enableProspectQuality ? abdAdjustedConfidence(floorConfidencePct, raw, type, summary, businessContext) : { score: floorConfidencePct, abd: null };
  const leadershipAdjustment = leadershipVerificationAdjustment(raw, type, summary, businessContext, sourceUrl);
  const confidencePct = Math.max(0, Math.min(100, abd.score + leadershipAdjustment));
  if (confidencePct < 55 && !hasMeaningfulSignal(raw, type, summary, businessContext)) return null; // discard only junk, duplicates, or truly low-confidence signals.

  // Paid-beta signal-date truth (Priority 1). eventDate is resolved ONLY from
  // parseable evidence text (via extractEventDate()) -- it never falls back
  // to the source's publication date merely because the true event date is
  // absent, and publicationDate/discoveredAt stay separate fields throughout.
  const eventCategory = signalEventCategory(canonicalType.eventType);
  const { eventDate: resolvedEventDate, dateConfidence: eventDateConfidence } = resolveSignalEventDate(raw, concreteTrigger, title, businessContext, eventCategory);
  const publicationDate = clean(raw.publicationDate || raw.publishedDate || raw.date || '');
  const actionabilityStatus = computeActionability({ eventCategory, eventDate: resolvedEventDate, dateConfidence: eventDateConfidence, publicationDate });
  // Reconciliation item 1: a stale or undated event-like signal, or an
  // ongoing signal whose source is older than the recency ceiling (or has
  // no trustworthy publication date), is NOT discarded here. A valid,
  // sourced signal is never deleted solely because it's no longer
  // actionable -- it is still returned (and persisted) below, carrying
  // actionabilityStatus.excludeFromPriorities so the priorities feed,
  // "Newly Detected" counts, and the weekly digest can filter it out while
  // Research Details/account history keeps it visible, clearly labeled.
  // The unconditional discards above (missing account name, prospect kill
  // rule, low confidence with no meaningful signal) are unrelated to date
  // freshness and are unchanged.

  // Recommended department/contact role is computed before the opener/why
  // text below so both can reference it (Priority 2: grounded outreach).
  const recommendedBuyingTeam = inferRecommendedBuyingTeam(type, businessContext, `${summary} ${buyingMoment} ${concreteTrigger}`, raw);
  const historicalFact = oneHistoricalOrderFact(account);
  const ground = { accountName, actionability: actionabilityStatus, recommendedBuyingTeam, historicalFact };

  const why = meaningfulWhyThisMatters(raw, type, concreteTrigger, businessContext, buyingMoment, ground);
  const opener = compact(raw.suggested_opener || raw.suggestedOpener || raw.conversationStarter || raw.likelyConversation || salesReadyOpener(concreteTrigger, businessContext, buyingMoment, type, ground), 280);
  const buyers = safeArray(raw.likelyBuyers || raw.suggestedContacts || raw.suggestedContact || raw.contactRole, 4);
  const products = safeArray(raw.promo_categories || raw.likelyProducts || raw.promoCategories || raw.commonPromoCategories || raw.likelyProductCategories || promoCategoriesForMoment(buyingMoment, type, businessContext), 6);
  const conversations = safeArray(raw.likelyConversations || raw.conversationThemes || raw.likelyConversation || raw.conversationAngle, 5);
  const uploadedContacts = selectUploadedContactsForTeam(account.contacts || raw.uploadedContacts || [], recommendedBuyingTeam, 2);
  const publicContacts = normalizePotentialContacts(raw.potential_contacts || raw.potentialContacts || raw.contacts || raw.recommendedContacts || raw.suggestedPeople, 2);
  const potentialContacts = mergePotentialContacts(uploadedContacts, publicContacts, 2);
  const suggestedContactDetails = buildSuggestedContact(potentialContacts, recommendedBuyingTeam, raw);
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
    // Phase 2A / B3: canonicalEventType is the single source of truth carried
    // through to resolveOpportunityEvents()/resolveEvents() at persistence
    // time (api/signal-intelligence.js), which reuses it rather than
    // recomputing its own classification — this is what makes event_fingerprint
    // and signal_type/opportunityType guaranteed-consistent rather than
    // independently-derived. opportunityType is now a direct alias of the
    // canonical enum value, not a mechanical uppercasing of a display label.
    canonicalEventType: canonicalType.eventType,
    concreteTrigger,
    concrete_trigger: concreteTrigger,
    buyingMoment,
    buying_moment: buyingMoment,
    // Priority 1: eventDate is only ever set from resolveSignalEventDate()'s
    // parse of the actual evidence text -- never from publicationDate/date
    // merely because a true event date wasn't found. eventCategory and
    // actionabilityStatus (upcoming / recent-past / stale / unknown-date /
    // ongoing) are the fields the dashboard must consult before ever
    // printing "Upcoming" or excluding/downranking a signal.
    eventDate: resolvedEventDate || '',
    event_date: resolvedEventDate || '',
    eventDateConfidence,
    eventCategory,
    actionabilityStatus,
    isUpcoming: actionabilityStatus.status === 'upcoming',
    location: clean(raw.location || raw.eventLocation || raw.cityState || ''),
    opportunityType: canonicalType.eventType,
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
    publishedDate: publicationDate,
    publicationDate,
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
    suggestedContactDetails,
    suggested_contact_details: suggestedContactDetails,
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

function isFallbackSignal(sig = {}) {
  return !!(sig.isFallbackOpportunity || /predictable timing/i.test(`${sig.signalType || ''} ${sig.signal_type || ''} ${sig.type || ''} ${sig.concreteTrigger || sig.concrete_trigger || ''}`));
}

function signalDateText(sig = {}) {
  return clean(sig.publishedDate || sig.publicationDate || sig.eventDate || sig.event_date || sig.date || sig.dateFound || '');
}

function opportunityTypeBoost(sig = {}) {
  const text = `${sig.signalType || sig.signal_type || sig.type || ''} ${sig.buyingMoment || sig.buying_moment || ''} ${sig.concreteTrigger || sig.concrete_trigger || ''} ${sig.title || ''}`.toLowerCase();
  if (/expansion|facility|opening|new location|ribbon cutting|distribution center/.test(text)) return 20;
  if (/product launch|launch|released|sparkpnt|new product/.test(text)) return 18;
  if (/trade show|conference|expo|event|sponsor|sponsorship/.test(text)) return 17;
  if (/contract|partnership|acquisition|funding|rebrand/.test(text)) return 15;
  if (/hiring|recruit|onboarding|headcount/.test(text)) return 12;
  if (/award|recognition|milestone|anniversary/.test(text)) return 9;
  return 0;
}

function specificityBoost(sig = {}) {
  const text = `${sig.concreteTrigger || sig.concrete_trigger || ''} ${sig.title || ''} ${sig.businessContext || sig.business_context || sig.whatChanged || ''}`.toLowerCase();
  let score = 0;
  if (/(20\d{2}|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|q[1-4])/.test(text)) score += 6;
  if (/facility|launch|opening|event|conference|contract|hiring|award|sponsor|trade show|product/.test(text)) score += 6;
  if ((sig.sourceUrl || sig.source_url || '').trim()) score += 4;
  if ((sig.sources || []).length > 1) score += 3;
  return score;
}

function bestSignalScore(sig = {}) {
  if (!sig) return -999999;
  if (isFallbackSignal(sig)) return -10000 + Number(sig.confidenceScore || 0);
  const confidence = Number(sig.confidenceScore || sig.why_now_score || 0);
  const fresh = freshnessScore(signalDateText(sig));
  const abd = sig.abdScores || {};
  const actionability = Number(sig.actionability_score || abd.actionability || 0);
  const budget = Number(sig.budget_score || abd.budgetLikelihood || 0);
  const deadline = Number(sig.deadline_score || abd.deadlineUrgency || 0);
  const abdBlend = [actionability, budget, deadline].filter(Boolean).reduce((a,b)=>a+b,0) / Math.max(1, [actionability, budget, deadline].filter(Boolean).length);
  return confidence + (fresh * 0.35) + (abdBlend * 0.15) + opportunityTypeBoost(sig) + specificityBoost(sig);
}

function compareBestSignals(a = {}, b = {}) {
  const af = isFallbackSignal(a) ? 1 : 0;
  const bf = isFallbackSignal(b) ? 1 : 0;
  if (af !== bf) return af - bf;
  const delta = bestSignalScore(b) - bestSignalScore(a);
  if (Math.abs(delta) > 0.001) return delta;
  return Number(b.confidenceScore || 0) - Number(a.confidenceScore || 0);
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
    const better = compareBestSignals(sig, existing) < 0 ? sig : existing;
    const mergedConfidence = Math.min(100, Math.max(Number(existing.confidenceScore || 0), Number(sig.confidenceScore || 0)) + (mergedSources.length > 1 ? 4 : 0));
    map.set(key, {
      ...better,
      sources: mergedSources.slice(0, 5),
      confidenceScore: mergedConfidence,
      confidenceLevel: confidenceLabel(mergedConfidence)
    });
  }
  return [...map.values()].sort(compareBestSignals);
}


// ---------------------------------------------------------------------------
// Phase 2A implementation-review — server-owned research-run idempotency.
// Gated entirely on uploadId: a request with NO uploadId (checked below)
// never reaches any of this. api/weekly-scan.js's own call to this endpoint
// (mode:'weekly-monitoring') sends no uploadId/auth header at all and is
// completely unaffected -- it already has its own concurrency guard via
// ha_weekly_runs. Same for prospect_script.js's prospecting flow.
//
// ROUND 4 correction: a request that DOES send uploadId is no longer
// allowed to opt out of tracking by simply omitting attemptId. Every
// upload-bound caller -- the automatic batch call, every per-account
// fallback call, and the standalone single-account "Research Account"
// button -- now claims a real run/attempt first (see
// dashboard/index.html's claimAutomaticResearchRun()/researchAccountByName())
// and this endpoint rejects (400) any uploadId-bound request missing
// researchRunId/attemptId, rather than silently proceeding untracked.
//
// This endpoint still writes NOTHING to ha_signals/ha_accounts itself
// (unchanged invariant) -- the one narrow exception is bookkeeping rows in
// ha_research_runs, added specifically so a second tab or a page reload
// cannot launch an untracked, duplicate research execution against the same
// upload. See supabase-schema-migration-5-research-run-idempotency.sql.
// ---------------------------------------------------------------------------
function rbEnv() {
  const rawUrl = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!rawUrl || !key) throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  const url = String(rawUrl).trim().replace(/\/+$/, '').replace(/\/rest\/v1$/i, '');
  return { url, key };
}
async function rbSupabase(path, options = {}) {
  const { url, key } = rbEnv();
  const resp = await fetch(`${url}/rest/v1/${path}`, {
    ...options,
    headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Prefer: options.prefer || 'return=representation', ...(options.headers || {}) }
  });
  const text = await resp.text();
  let data = null;
  if (text) { try { data = JSON.parse(text); } catch { data = text; } }
  if (!resp.ok) {
    const msg = typeof data === 'string' ? data : (data?.message || data?.hint || JSON.stringify(data));
    const httpErr = new Error(`Supabase ${resp.status}: ${msg}`);
    httpErr.status = resp.status;
    // Postgres's sqlstate (e.g. '42501', '55P03'), when the response body is
    // a PostgREST-shaped RPC error. Lets callers branch on the actual
    // database error code rather than regex-matching a human message.
    httpErr.code = (data && typeof data === 'object') ? data.code : undefined;
    throw httpErr;
  }
  return data;
}

// Phase 2A implementation-review ROUND 2, item 2 — resolves identity for a
// request bound to a persisted upload (uploadId present). This is
// deliberately strict and has NO lead/email fallback of any kind:
//   - a valid Supabase auth Bearer token is required;
//   - the resolved ha_users row must actually own uploadId (verified against
//     ha_uploads.user_id, mirroring claim_ha_research_run()'s own ownership
//     check -- see supabase-schema-migration-5-research-run-idempotency.sql
//     §7);
//   - a nonexistent uploadId is treated identically to a wrong-owner
//     uploadId (reason: 'not-owner' either way) so this endpoint does not
//     leak whether an upload id exists, matching the RPC's own behavior.
// The previous round's resolveUserForResearchRun() fell back to a
// client-supplied lead.email when no auth token was present. That fallback
// is REMOVED, not narrowed: this function's only caller is the uploadId-
// bound branch of handler() below, which claims/mutates a persisted
// ha_research_runs row and (via the account snapshot RPC, elsewhere)
// eventually a persisted customer upload -- exactly the case the review
// flagged as unsafe for a client-supplied email to authenticate ("a spoofed
// lead email with another user's upload" must not be able to claim or read
// that user's research run). The pre-existing, unauthenticated prospecting
// flow (mode: 'prospect-intelligence' / warm-account with no uploadId) never
// calls this function at all -- see the `if (targetUploadId)` gate in
// handler() -- and is completely unaffected.
async function resolveAuthenticatedUploadOwner(req, uploadId) {
  const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  if (!token) return { user: null, reason: 'no-token' };
  let authUserId = '';
  try {
    const { url, key } = rbEnv();
    const authResp = await fetch(`${url}/auth/v1/user`, { headers: { apikey: key, Authorization: `Bearer ${token}` } });
    if (!authResp.ok) return { user: null, reason: 'invalid-token' };
    const authUser = await authResp.json();
    authUserId = authUser?.id || '';
  } catch {
    return { user: null, reason: 'invalid-token' };
  }
  if (!authUserId) return { user: null, reason: 'invalid-token' };
  const userRows = await rbSupabase(`ha_users?auth_user_id=eq.${encodeURIComponent(authUserId)}&select=id,email&limit=1`);
  const user = Array.isArray(userRows) ? userRows[0] : null;
  if (!user?.id) return { user: null, reason: 'invalid-token' };
  const uploadRows = await rbSupabase(`ha_uploads?id=eq.${encodeURIComponent(uploadId)}&select=id,user_id&limit=1`);
  const upload = Array.isArray(uploadRows) ? uploadRows[0] : null;
  if (!upload || upload.user_id !== user.id) return { user: null, reason: 'not-owner' };
  return { user, reason: null };
}

// Phase 2A implementation-review ROUND 2, items 3/4 — calls the atomic
// claim_ha_research_run() RPC (see
// supabase-schema-migration-5-research-run-idempotency.sql §7) and
// translates its {outcome, run} result (or a raised ownership/conflict
// exception) into a shape handler() can act on directly. This is the ONLY
// place a row is ever inserted or reclaimed in ha_research_runs -- neither
// the actual research call nor the fallback-loop's per-account calls claim
// anything themselves anymore (round 1's design had each of up to 4
// concurrent fallback-loop requests independently call claimResearchRun()
// with the SAME shared run id, which would have made 3 of the 4 immediately
// short-circuit as "already running" -- a real bug found during round-2
// review, fixed by claiming exactly once per logical
// researchTopAccounts() pass, before any of the actual research requests are
// made).
async function claimResearchRunAtomic({ userId, uploadId, researchRunId, leaseSeconds = 300 }) {
  try {
    const result = await rbSupabase('rpc/claim_ha_research_run', {
      method: 'POST',
      body: JSON.stringify({ p_user_id: userId, p_upload_id: uploadId, p_research_run_id: researchRunId, p_lease_seconds: leaseSeconds })
    });
    return { ok: true, outcome: result?.outcome, run: result?.run || {} };
  } catch (err) {
    if (err.code === '55P03') {
      return { ok: false, status: 409, body: { error: 'A different research run is already in progress for this upload.' } };
    }
    if (err.code === '42501') {
      // Should not normally happen -- handler() already verified ownership
      // via resolveAuthenticatedUploadOwner() before calling this. Kept as
      // defense in depth against a future application-code bug.
      return { ok: false, status: 403, body: { error: 'You do not have access to this upload.' } };
    }
    throw err;
  }
}

// Phase 2A implementation-review ROUND 2, item 4 — completion/failure is
// guarded by attempt_id: the PATCH only matches (and only takes effect on)
// the row that is STILL owned by this exact attempt. If a different, later
// attempt already reclaimed this run (the original attempt's Vercel
// invocation was killed before it could call this), the WHERE clause below
// matches zero rows, PostgREST returns an empty array, and `applied` comes
// back false -- the late result is silently discarded rather than
// overwriting the replacement attempt's state. See
// supabase-schema-migration-5-research-run-idempotency.sql §5 and
// scripts/test-research-run-idempotency.js's "old worker completes after
// lease takeover" case.
async function completeResearchRunAttempt({ uploadId, researchRunId, attemptId, resultSummary }) {
  const updated = await rbSupabase(
    `ha_research_runs?upload_id=eq.${encodeURIComponent(uploadId)}&research_run_id=eq.${encodeURIComponent(researchRunId)}&attempt_id=eq.${encodeURIComponent(attemptId)}`,
    { method: 'PATCH', prefer: 'return=representation', body: JSON.stringify({ status: 'completed', completed_at: new Date().toISOString(), result_summary: resultSummary || {} }) }
  );
  return { applied: Array.isArray(updated) && updated.length > 0 };
}
async function failResearchRunAttempt({ uploadId, researchRunId, attemptId, errorMessage }) {
  const updated = await rbSupabase(
    `ha_research_runs?upload_id=eq.${encodeURIComponent(uploadId)}&research_run_id=eq.${encodeURIComponent(researchRunId)}&attempt_id=eq.${encodeURIComponent(attemptId)}`,
    { method: 'PATCH', prefer: 'return=representation', body: JSON.stringify({ status: 'failed', completed_at: new Date().toISOString(), error_message: clean(errorMessage).slice(0, 2000) }) }
  );
  return { applied: Array.isArray(updated) && updated.length > 0 };
}

// Phase 2A implementation-review ROUND 3, items 1/2 — atomic lease renewal
// AND attempt-ownership verification via heartbeat_ha_research_run() (see
// supabase-schema-migration-5-research-run-idempotency.sql §7a). This one
// function serves two purposes used at different points below:
//   - as a GATE, called once at the very top of the actual research work,
//     BEFORE any OpenAI/Serper/Firecrawl call -- a stale/replaced attempt
//     fails here and the request is rejected with 409 before any provider
//     cost is incurred (item 2).
//   - as a periodic RENEWAL, called on an interval for the duration of a
//     single long-running batch request (item 1 -- the real Phase 1B
//     fallback execution ran ~12 minutes, well past a 300s lease).
// leaseSeconds is clamped here in JS (defense in depth) in addition to the
// RPC's own authoritative clamp -- a client cannot obtain an oversized
// lease by requesting one; MAX/MIN below match the RPC's [60, 900] bounds
// exactly so a legitimate request is never silently truncated below what it
// asked for within that range.
const HEARTBEAT_MIN_LEASE_SECONDS = 60;
const HEARTBEAT_MAX_LEASE_SECONDS = 900;
const HEARTBEAT_DEFAULT_LEASE_SECONDS = 300;
function clampLeaseSeconds(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return HEARTBEAT_DEFAULT_LEASE_SECONDS;
  return Math.max(HEARTBEAT_MIN_LEASE_SECONDS, Math.min(n, HEARTBEAT_MAX_LEASE_SECONDS));
}
async function heartbeatResearchRunAtomic({ userId, uploadId, researchRunId, attemptId, leaseSeconds }) {
  const result = await rbSupabase('rpc/heartbeat_ha_research_run', {
    method: 'POST',
    body: JSON.stringify({ p_user_id: userId, p_upload_id: uploadId, p_research_run_id: researchRunId, p_attempt_id: attemptId, p_lease_seconds: clampLeaseSeconds(leaseSeconds) })
  });
  return result || { ok: false, reason: 'unknown' };
}

// Starts a self-rescheduling (not overlapping) heartbeat loop for the
// duration of one long-running provider-work request, so a legitimate
// 12-20 minute fallback execution keeps renewing its own lease instead of
// losing ownership purely because of elapsed time. Uses setTimeout chaining
// rather than setInterval so a slow heartbeat call can never overlap with
// the next tick. Returns a stop() function that MUST be called from a
// finally block once the request's real work is done (success or error) --
// callers never leave a dangling timer past the response.
function startHeartbeatRenewalLoop({ userId, uploadId, researchRunId, attemptId }, intervalMs = 45000) {
  let stopped = false;
  let timer = null;
  async function tick() {
    if (stopped) return;
    try {
      const result = await heartbeatResearchRunAtomic({ userId, uploadId, researchRunId, attemptId, leaseSeconds: HEARTBEAT_DEFAULT_LEASE_SECONDS });
      if (!result.ok) {
        // This attempt has been superseded (reclaimed after an earlier
        // heartbeat/renewal gap, or the run was otherwise terminated).
        // Nothing further to do here -- the eventual complete/fail report
        // for THIS attempt will itself no-op (attempt_id-guarded), and the
        // in-flight provider work is allowed to finish naturally rather
        // than being forcibly aborted mid-call.
        console.warn('[research-batch] heartbeat renewal found this attempt is no longer current; will not retry', { uploadId, researchRunId });
        stopped = true;
        return;
      }
    } catch (err) {
      console.warn('[research-batch] heartbeat renewal tick failed (will retry on the next interval)', { message: err.message });
    }
    if (!stopped) timer = setTimeout(tick, intervalMs);
  }
  timer = setTimeout(tick, intervalMs);
  return { stop() { stopped = true; if (timer) clearTimeout(timer); } };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const startedAt = Date.now();
  const body = req.body || {};
  const targetUploadId = clean(body.uploadId || '');
  const requestMode = clean(body.mode || '');

  // Security hotfix (weekly-monitoring internal-caller authorization): the
  // weekly scan cron (api/weekly-scan.js) calls this endpoint with
  // mode:'weekly-monitoring' and NO uploadId, which meant it never reached
  // the resolveAuthenticatedUploadOwner() check below and ran fully
  // unauthenticated -- letting anyone POST mode:'weekly-monitoring' and
  // trigger paid provider research for arbitrary caller-supplied accounts.
  // This check is deliberately the very first thing the handler does for
  // this mode, before uploadId resolution, before researchRunAction
  // handling, before the OPENAI_API_KEY check, and before any account-array
  // processing -- and it applies whether or not a uploadId is also present,
  // so it cannot be bypassed by combining mode:'weekly-monitoring' with a
  // real or fake uploadId. The secret is accepted only via the
  // Authorization: Bearer header (never body, query string, or cookies) and
  // is never logged or echoed back. Every other mode (prospect-intelligence,
  // warm-account, ranked/default) is unaffected by this check.
  if (requestMode === 'weekly-monitoring') {
    const cronSecret = process.env.CRON_SECRET;
    if (!cronSecret) return res.status(503).json({ error: 'Service unavailable: not configured.' });
    const authHeader = req.headers.authorization || '';
    const bearerMatch = /^Bearer\s+(.+)$/i.exec(authHeader);
    const providedSecret = bearerMatch ? bearerMatch[1] : '';
    if (!providedSecret || !safeSecretEqual(providedSecret, cronSecret)) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
  }

  // Phase 2A implementation-review ROUND 2, item 2: ANY request bound to a
  // persisted upload (uploadId present) -- whether it is a run-control
  // action (claim/complete/fail, below) or an actual research call -- must
  // resolve to an authenticated ha_users record that verifiably owns that
  // upload. There is no lead/email fallback: see
  // resolveAuthenticatedUploadOwner() above. Requests with NO uploadId (the
  // pre-existing anonymous prospecting flow -- prospect_script.js,
  // prospects/index.html) never reach this check and are unaffected.
  let uploadOwner = null;
  if (targetUploadId) {
    const resolved = await resolveAuthenticatedUploadOwner(req, targetUploadId);
    if (!resolved.user) {
      const status = resolved.reason === 'not-owner' ? 403 : 401;
      const error = resolved.reason === 'not-owner'
        ? 'You do not have access to this upload.'
        : 'Login required to research an uploaded account list.';
      return res.status(status).json({ error });
    }
    uploadOwner = resolved.user;
  }

  // Run-control actions never call OpenAI or any search provider -- they
  // only read/write ha_research_runs via claim_ha_research_run() or an
  // attempt_id-guarded PATCH -- so they are handled and returned here,
  // before the OPENAI_API_KEY check below (which would otherwise be an
  // unrelated, misleading failure mode for a pure bookkeeping call).
  const researchRunAction = clean(body.researchRunAction || '');
  if (researchRunAction) {
    if (!targetUploadId) return res.status(400).json({ error: 'uploadId is required for researchRunAction requests.' });
    try {
      if (researchRunAction === 'claim') {
        const runIntent = clean(body.runIntent || 'auto');
        // Phase 2A implementation-review ROUND 2, item 3: run identity is
        // NEVER taken from the client. The automatic upload-research path
        // always claims the fixed literal research_run_id 'auto', scoped
        // uniquely by (user_id, upload_id) -- so a reload, a second tab, or
        // a client sending an arbitrary different string all resolve to the
        // exact same row. A genuinely new run identity is only ever minted
        // by THIS server, and only for the explicit, separately-authorized
        // 'manual-rerun' pathway (the "Research Top Accounts" button click
        // in dashboard/index.html when a run is not already in progress).
        const researchRunId = runIntent === 'manual-rerun'
          ? `manual-${new Date().toISOString()}-${Math.random().toString(36).slice(2, 8)}`
          : 'auto';
        const claim = await claimResearchRunAtomic({ userId: uploadOwner.id, uploadId: targetUploadId, researchRunId });
        if (!claim.ok) return res.status(claim.status).json(claim.body);
        const { outcome, run } = claim;
        if (outcome === 'completed') {
          // Reload / second tab / a stale client-generated id after the
          // automatic run already finished: return the cached outcome, do
          // not restart research.
          return res.status(200).json({ ok: true, outcome, researchRunId: run.research_run_id, resultSummary: run.result_summary || {}, completedAt: run.completed_at });
        }
        if (outcome === 'attached-active') {
          // Another attempt (a different tab, or this same tab's still-live
          // lease) currently owns this run. Do not launch a second
          // concurrent execution.
          return res.status(202).json({ ok: true, outcome, researchRunId: run.research_run_id, message: 'This research run is already in progress.' });
        }
        // claimed-new / reclaimed-after-failure / reclaimed-after-expired-lease.
        return res.status(200).json({ ok: true, outcome, researchRunId: run.research_run_id, attemptId: run.attempt_id, leaseExpiresAt: run.lease_expires_at });
      }
      if (researchRunAction === 'heartbeat') {
        const researchRunId = clean(body.researchRunId || '');
        const attemptId = clean(body.attemptId || '');
        if (!researchRunId || !attemptId) return res.status(400).json({ error: 'researchRunId and attemptId are required.' });
        const result = await heartbeatResearchRunAtomic({ userId: uploadOwner.id, uploadId: targetUploadId, researchRunId, attemptId, leaseSeconds: body.leaseSeconds });
        if (!result.ok) return res.status(409).json({ error: 'This attempt is no longer the active attempt for this research run.', reason: result.reason || 'not-current-attempt' });
        return res.status(200).json({ ok: true, leaseExpiresAt: result.run?.lease_expires_at });
      }
      if (researchRunAction === 'complete' || researchRunAction === 'fail') {
        const researchRunId = clean(body.researchRunId || '');
        const attemptId = clean(body.attemptId || '');
        if (!researchRunId || !attemptId) return res.status(400).json({ error: 'researchRunId and attemptId are required.' });
        const result = researchRunAction === 'complete'
          ? await completeResearchRunAttempt({ uploadId: targetUploadId, researchRunId, attemptId, resultSummary: body.resultSummary || {} })
          : await failResearchRunAttempt({ uploadId: targetUploadId, researchRunId, attemptId, errorMessage: body.errorMessage || '' });
        // applied:false is not an error -- it means a newer attempt already
        // took over this run (item 4: a late result from a
        // reclaimed/expired attempt must not overwrite the replacement
        // attempt's state).
        return res.status(200).json({ ok: true, applied: result.applied });
      }
      return res.status(400).json({ error: `Unknown researchRunAction "${researchRunAction}".` });
    } catch (err) {
      return res.status(500).json({ error: err.message || 'Research run tracking request failed.' });
    }
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return res.status(400).json({ error: 'OPENAI_API_KEY not configured' });

  // Declared outside the try block so the finally clause below can always
  // stop it, regardless of which return path is taken inside try (there are
  // several -- the no-accounts 400, the success 200, and the catch's 500).
  let heartbeatLoop = null;

  try {
    const { accounts = [], mode = 'ranked', researchRunId = '' } = body;

    // Phase 2A implementation-review ROUND 4, item 2: ANY request bound to
    // an existing upload (uploadId present) must carry a real,
    // server-issued researchRunId AND attemptId -- there is no more
    // untracked-but-uploadId-bound path. This applies uniformly to the
    // automatic batch call, every per-account fallback call, AND the
    // standalone single-account "Research Account" button, which now
    // claims its own manual research run before ever reaching this
    // endpoint (see dashboard/index.html's researchAccountByName()). The
    // only remaining untracked callers are ones that send NO uploadId at
    // all -- the anonymous prospecting flow (prospect_script.js) -- which
    // never reaches this block (see the `if (targetUploadId)` gate above).
    const attemptId = clean(body.attemptId || '');
    const rawResearchRunId = clean(researchRunId);
    if (targetUploadId) {
      if (!attemptId || !rawResearchRunId) {
        return res.status(400).json({ error: 'researchRunId and attemptId are required for any research request bound to an existing upload.' });
      }
    }
    const runId = rawResearchRunId || `unattributed-${startedAt}`;

    if (targetUploadId) {
      const gate = await heartbeatResearchRunAtomic({ userId: uploadOwner.id, uploadId: targetUploadId, researchRunId: runId, attemptId });
      if (!gate.ok) {
        // A stale/replaced attempt is rejected HERE -- before
        // discoverCandidatesForAccounts/callOpenAIJson/callOpenAIWebSearch
        // are ever reached below -- so no provider cost is incurred.
        return res.status(409).json({ error: 'This attempt is no longer the active research run; no provider request was made.', reason: gate.reason || 'not-current-attempt' });
      }
      // Item 1: renew the lease periodically for the duration of THIS
      // request's provider work, so a legitimate long-running batch call
      // (the real Phase 1B fallback ran ~12 minutes) does not lose
      // ownership purely because a fixed lease elapsed.
      heartbeatLoop = startHeartbeatRenewalLoop({ userId: uploadOwner.id, uploadId: targetUploadId, researchRunId: runId, attemptId });
    }

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
        oneOffResearch: a.oneOffResearch === true,
        contactName: clean(a.contactName || (Array.isArray(a.contacts) ? a.contacts[0]?.name : '') || ''),
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
      .slice(0, Math.max(1, Math.min(Number(process.env.RESEARCH_BATCH_MAX_ACCOUNTS || 250), 500)));
    if (!safeAccounts.length) return res.status(400).json({ error: 'No accounts provided' });

    const model = process.env.OPENAI_MODEL || 'gpt-4o-mini';
    let candidates = [];
    let sourceCoverage = {};
    let candidateSamples = [];
    let searchDiagnostics = [];
    let rawText = '';
    let providerMode = 'openai-web-search';

    // Prospect Intelligence uses Serper for intent-driven targeted search.
    // Tavily/Brave are intentionally not required for this beta workflow.
    const serperConfigured = !!process.env.SERPER_API_KEY;
    const targetedSearchEnabled = mode === 'prospect-intelligence' && serperConfigured;
    const hasSearchProvider = serperConfigured;
    if (mode === 'prospect-intelligence' || mode === 'warm-account') {
      prospectDebugLog('Request received', {
        mode,
        accountsReceived: accounts.length,
        uniqueAccountsResearched: safeAccounts.length,
        providerMode: hasSearchProvider ? 'serper-targeted-search' : 'openai-web-search',
        serperConfigured,
        targetedSearchEnabled,
        firecrawlConfigured: !!process.env.FIRECRAWL_API_KEY,
        supabaseReuse: 'none - /api/research-batch does not read cached prospect rows before researching'
      });
    }
    if (hasSearchProvider) {
      providerMode = 'targeted-search';
      const discovered = await discoverCandidatesForAccounts(safeAccounts, mode);
      candidates = discovered.candidates;
      sourceCoverage = discovered.sourceCoverage;
      candidateSamples = discovered.samples.slice(0, 16);
      searchDiagnostics = discovered.diagnostics || [];
      const enriched = await enrichCandidatesWithFirecrawl(candidates);
      candidates = enriched.candidates;
      if (enriched.scrapedCount) sourceCoverage.firecrawl = enriched.scrapedCount;
      if (mode === 'prospect-intelligence' || mode === 'warm-account') {
        prospectDebugLog('Firecrawl enrichment complete', {
          firecrawlCalled: !!process.env.FIRECRAWL_API_KEY && candidates.length > 0,
          candidatesSentToFirecrawl: candidates.length,
          scrapedCount: enriched.scrapedCount || 0
        });
      }
    } else if (mode === 'prospect-intelligence') {
      prospectDebugLog('Targeted search skipped', {
        mode,
        serperConfigured,
        targetedSearchEnabled,
        reason: 'SERPER_API_KEY is not configured. Prospect research will use OpenAI web-search fallback instead of Serper intent-driven query chains.'
      });
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

Return the strongest 0 to 4 distinct buying moments per account. Do not stop after the first strong signal when additional independently actionable opportunities are supported by different evidence or a meaningfully different event. Do not require perfect context. If a meaningful signal exists but the underlying driver is unclear, keep the signal, state the uncertainty clearly, and assign lower confidence.
Prefer a low or medium live buying moment over a generic Predictable Timing fallback when there is a real recent source with a reasonable promotional-products conversation.

Reject:
- generic company descriptions, mission/history/culture copy
- generic careers page existence unless evidence shows meaningful hiring or a recruiting push
- old or irrelevant awards unless active/currently promoted or tied to a clear sales angle
- vague community or sustainability copy unless tied to a concrete event, certification, deadline, award, partnership, facility, campaign, or active program
- clearly negative/irrelevant signals: layoffs, downsizing, restructuring, bankruptcy, plant closures, investigations, recalls, scandals. Operational friction such as lawsuits, town disputes, power outages, or facility issues may only be accepted when the angle is respectful internal morale, retention, plant pride, or employee support

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
- If a user supplied a contact name, verify and prefer that person when supported.
- Never invent names, titles, emails, phones, LinkedIn URLs, or contact pages.
- Include public contact fields only when they appear in the supplied evidence.
- Omit potential_contacts if no reliable person is found.

Leadership and contact-change rules:
- Accept executive appointments, promotions, known-contact role changes, and known-contact company changes only when the person, company, and new role are supported by a credible public source.
- Preserve the person's name, exact new title, company, and announcement date when available.
- Do not treat leadership changes as automatically high priority. They must compete with every other opportunity using the existing ABD / Why Now logic.
- Penalize stale, weakly sourced, or role-only mentions, and reject undated directory listings that do not establish a recent change.

Score concrete, high-intent buying moments higher:
Highest value signals generally include facility expansion/new location, rebrand/merger, trade show exhibitor participation, major product launch, contract win/partnership, major award actively promoted, safety milestone, and company anniversary. A verified recent HR or Marketing executive change may also rank strongly when it creates a clear, timely promotional-products conversation.
Lower value: generic sustainability copy, generic hiring without context, old awards, vague community posts, minor funding/grants, generic blog content, or stale leadership listings.

Return strict JSON only with shape:
{"signals":[{"company_name":"","accountName":"","signal_type":"Hiring|Expansion|Trade Show / Event|Award / Recognition|Leadership Change|Product Launch|Acquisition / Funding|Partnership / Contract|Community / CSR|Rebrand","signalType":"","concrete_trigger":"","buying_moment":"","signalTitle":"","whatChanged":"","event_date":"","location":"","source_url":"","source_name":"","business_context":"","businessContext":"","why_this_matters":"","whyItMattersForPromo":"","recommended_buying_team":[""],"recommendedBuyingTeam":[""],"potential_contacts":[{"name":"","title":"","reason":"","sourceUrl":"","linkedin":"","email":"","direct_phone":"","company_phone":"","contact_page":"","confidence":"High|Medium|Low","sources_used":[{"name":"","url":""}]}],"potentialContacts":[{"name":"","title":"","reason":"","sourceUrl":"","linkedin":"","email":"","directPhone":"","companyPhone":"","contactPage":"","confidence":"High|Medium|Low","sourcesUsed":[{"name":"","url":""}]}],"why_these_contacts":"","whyTheseContacts":"","promo_categories":[""],"likelyProducts":[""],"suggested_opener":"","suggestedOpener":"","actionability_score":0,"budget_score":0,"deadline_score":0,"why_now_score":0,"confidence":0,"sourceName":"","sourceUrl":"","sources":[{"name":"","url":""}],"publicationDate":""}]}

Accounts:
${JSON.stringify(accountPromptContext(safeAccounts), null, 2)}

Candidate snippets and clean page content:
${JSON.stringify(candidates.slice(0, 180).map(c => ({accountName:c.accountName, title:c.title, snippet:c.snippet, pageContent:c.pageContent || '', url:c.url, sourceType:c.sourceType, provider:c.provider, date:c.date, score:c.score, query:c.query, intendedSignalFamily:c.intendedSignalFamily, signalFamily:c.signalFamily, signalSubtype:c.signalSubtype, entityVerification:c.entityVerification, sourceAuthorityScore:c.sourceAuthorityScore, freshnessScore:c.freshnessScore, candidateScore:c.candidateScore, eventFingerprint:c.eventFingerprint, sources:c.sources})), null, 2)}`;
      rawText = await callOpenAIJson({ apiKey, model, prompt: synthesisPrompt });
      parsed = parseJsonLoose(rawText);
    } else {
      // Fallback: ask OpenAI's web search to do the batch research in the same style as Google AI.
      rawText = await callOpenAIWebSearch({ apiKey, model: process.env.OPENAI_SEARCH_MODEL || model, accounts: safeAccounts });
      parsed = parseJsonLoose(rawText);
      sourceCoverage['ai-web-search'] = safeAccounts.length;
    }

    const rawSignals = Array.isArray(parsed?.signals) ? parsed.signals : [];
    if (mode === 'prospect-intelligence' || mode === 'warm-account') {
      prospectDebugLog('LLM opportunity parser complete', {
        providerMode,
        candidateCountPassedToParser: candidates.length,
        rawSignalsReturned: rawSignals.length,
        rawSignalsByAccount: safeAccounts.map(a => ({
          company: a.name,
          rawSignals: rawSignals.filter(s => clean(s.accountName || s.account || s.company || s.company_name || s.companyName || '').toLowerCase().includes(a.name.toLowerCase()) || a.name.toLowerCase().includes(clean(s.accountName || s.account || s.company || s.company_name || s.companyName || '').toLowerCase())).length
        }))
      });
    }
    const validAccountNames = new Set(safeAccounts.map(a => a.name.toLowerCase()));
    const accountLookup = new Map(safeAccounts.map(a => [a.name.toLowerCase(), a.name]));
    const fixedSignals = rawSignals.map(s => {
      const name = clean(s.accountName || s.account || s.company || s.company_name || s.companyName || '');
      const exact = accountLookup.get(name.toLowerCase());
      if (exact) return { ...s, accountName: exact };
      // Fuzzy map if the model adds parentheticals or suffixes.
      const lower = name.toLowerCase();
      const found = safeAccounts.find(a => lower.includes(a.name.toLowerCase()) || a.name.toLowerCase().includes(lower));
      return found ? { ...s, accountName: found.name } : s;
    });

    const madeSignalsRaw = fixedSignals.map(s => {
      const account = safeAccounts.find(a => a.name.toLowerCase() === clean(s.accountName || s.account || s.company || s.company_name || s.companyName || '').toLowerCase()) || {};
      const accountMode = clean(account.intelligenceMode).toLowerCase();
      const mapped = makeSignal(s, account, { enableProspectQuality: mode === 'prospect-intelligence' || mode === 'warm-account' || accountMode === 'warm' || accountMode === 'mixed' });
      if (!mapped) return null;
      const accountCandidate = candidates.find(c => c.accountName === account.name && (
        (mapped.sourceUrl && c.url === mapped.sourceUrl) ||
        (mapped.eventFingerprint && c.eventFingerprint === mapped.eventFingerprint)
      )) || {};
      const normalized = normalizeOpportunity(mapped, account, accountCandidate);
      const validation = validateOpportunity(normalized);
      if (!validation.valid) {
        console.warn('[Signal Intelligence] opportunity rejected', { company: account.name, reasons: validation.reasons, title: normalized.signalTitle });
        return null;
      }
      return normalized;
    });
    const mappedSignals = madeSignalsRaw.filter(Boolean);
    const validMappedSignals = mappedSignals.filter(s => validAccountNames.has(String(s.accountName || '').toLowerCase()));
    const signals = dedupeOpportunities(dedupeSignals(validMappedSignals)).slice(0, 80);
    // Phase 2A / Correction 1 instrumentation — records the pipeline stage
    // counts requested for forensic classification of any future
    // accepted-vs-persisted discrepancy: raw model signals (what the AI
    // returned before any of this endpoint's own filtering), signals that
    // survived makeSignal()'s per-signal validation, signals confirmed
    // against a real requested account name, and the final accepted/deduped
    // count returned to the caller. Correlated by researchRunId so a single
    // logical research pass can be traced end-to-end alongside the
    // save-upload.instrumentation line this endpoint's caller is expected to
    // log against the same runId.
    console.log('[research-batch.instrumentation]', JSON.stringify({
      ts: new Date().toISOString(),
      runId,
      mode,
      accountsRequested: safeAccounts.length,
      rawModelSignals: rawSignals.length,
      mappedSignals: mappedSignals.length,
      validMappedSignals: validMappedSignals.length,
      acceptedSignals: signals.length,
      // Hashed by default -- an event_fingerprint embeds a normalized
      // company name (see eventFingerprint()/resolveEvents() in
      // signal-intelligence.js), so logging it verbatim would be logging a
      // customer/account identifier. The hash is still stable and joinable
      // against api/save-upload.js's own hashed instrumentation for the
      // same run, without needing the raw value in normal logs.
      acceptedEventFingerprintHashes: signals.map(s => s.eventFingerprint).filter(Boolean).map(shortHash),
      ...(DEBUG_INSTRUMENTATION ? { acceptedEventFingerprints: signals.map(s => s.eventFingerprint).filter(Boolean) } : {})
    }));
    if (mode === 'prospect-intelligence' || mode === 'warm-account') {
      prospectDebugLog('Signal filtering complete', {
        rawSignals: rawSignals.length,
        mappedSignals: mappedSignals.length,
        invalidAccountSignalsFiltered: Math.max(0, mappedSignals.length - validMappedSignals.length),
        dedupedSignals: signals.length,
        signalsByAccountBeforeFallback: safeAccounts.map(a => ({
          company: a.name,
          liveSignals: signals.filter(s => s.accountName === a.name).length
        }))
      });
      for (const account of safeAccounts) {
        if (/sparkfun/i.test(account.name)) {
          const rawForAccount = rawSignals.filter(s => clean(s.accountName || s.account || s.company || s.company_name || s.companyName || '').toLowerCase().includes(account.name.toLowerCase()) || account.name.toLowerCase().includes(clean(s.accountName || s.account || s.company || s.company_name || s.companyName || '').toLowerCase()));
          const filteredForAccount = signals.filter(s => s.accountName === account.name);
          prospectDebugLog('SparkFun LLM/filtering diagnostics', {
            mode,
            company: account.name,
            candidatesPassedToLLM: candidates.filter(c => c.accountName === account.name).length,
            llmOutput: rawForAccount.slice(0, 3),
            filteringResult: {
              rawSignalsForCompany: rawForAccount.length,
              liveSignalsAfterFiltering: filteredForAccount.length,
              liveSignalTitles: filteredForAccount.map(s => s.concreteTrigger || s.signalTitle || s.whatChanged || s.signalType)
            },
            fallbackWouldBeUsed: filteredForAccount.length === 0
          });
        }
      }
    }
    const byAccount = {};
    for (const sig of signals) {
      if (!byAccount[sig.accountName]) byAccount[sig.accountName] = [];
      if (byAccount[sig.accountName].length < 4) byAccount[sig.accountName].push(sig);
    }
    Object.keys(byAccount).forEach(name => {
      const ranked = byAccount[name].sort(compareBestSignals);
      byAccount[name] = ranked.slice(0, 4);
    });
    if (mode === 'prospect-intelligence') {
      for (const account of safeAccounts) {
        if (!byAccount[account.name] || !byAccount[account.name].length) {
          const accountDiag = searchDiagnostics.find(d => d.companyName === account.name) || {};
          const fallbackReason = !hasSearchProvider
            ? 'SERPER_API_KEY not configured; no live signal returned by OpenAI web search'
            : candidates.filter(c => c.accountName === account.name).length === 0
              ? 'targeted search completed but returned no ranked candidates above threshold'
              : 'targeted search candidates were passed to LLM but no valid live opportunity survived parsing/filtering';
          prospectDebugLog('Fallback used', {
            company: account.name,
            fallbackUsed: true,
            fallbackReason,
            targetedQueriesRun: accountDiag.targetedQueriesRun || 0,
            rankedCandidates: accountDiag.rankedCandidates || 0,
            topResults: accountDiag.topSources || []
          });
          byAccount[account.name] = [makePredictableTimingSignal(account)];
        } else {
          prospectDebugLog('Live opportunity generated', {
            company: account.name,
            fallbackUsed: false,
            liveOpportunityCount: byAccount[account.name].length,
            opportunities: byAccount[account.name].map(s => ({
              trigger: s.concreteTrigger || s.signalTitle || s.whatChanged || s.signalType,
              signalType: s.signalType,
              confidenceScore: s.confidenceScore,
              rankingScore: Math.round(bestSignalScore(s)),
              publishedDate: s.publishedDate || s.eventDate || s.event_date || '',
              sourceUrl: s.sourceUrl
            }))
          });
        }
      }
    }
    const finalSignals = Object.values(byAccount).flat().sort(compareBestSignals);
    const avgConfidence = finalSignals.length ? Math.round(finalSignals.reduce((sum, s) => sum + Number(s.confidenceScore || 0), 0) / finalSignals.length) : 0;

    // Note: this endpoint no longer marks any ha_research_runs row
    // completed/failed itself. Under the round-2 design (item 3/4), a
    // logical research run can span multiple requests to this endpoint (the
    // fallback loop makes up to 4 concurrent per-account calls under one
    // shared attempt), so only the orchestrator that made the 'claim' call
    // knows when the WHOLE run has finished -- see researchTopAccounts() in
    // dashboard/index.html, which calls researchRunAction:'complete'/'fail'
    // explicitly once the entire pass (batch call + any fallback loop) is
    // done.

    return res.status(200).json({
      signals: finalSignals,
      byAccount,
      researchRunId: runId,
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
        targetedSearchEnabled,
        mode,
        sourceCoverage,
        candidateSamples,
        searchDiagnostics,
        outputPreview: String(rawText || '').slice(0, 500),
        structuredSummary: {
          eligibleAccounts: safeAccounts.length,
          queuedAccounts: safeAccounts.length,
          processedAccounts: searchDiagnostics.filter(d => d.status === 'processed').length || safeAccounts.length,
          skippedAccounts: Math.max(0, accounts.length - safeAccounts.length),
          failedAccounts: searchDiagnostics.filter(d => d.status === 'failed').length,
          skipReasons: accounts.length > safeAccounts.length ? [{ reason: 'duplicate_or_invalid_account_name', count: accounts.length - safeAccounts.length }] : [],
          failureReasons: searchDiagnostics.filter(d => d.status === 'failed').map(d => ({ accountName: d.companyName, reason: d.error || 'unknown' })),
          queriesRun: searchDiagnostics.reduce((n, d) => n + Number(d.targetedQueriesRun || 0), 0),
          rawResults: searchDiagnostics.reduce((n, d) => n + Number(d.sourcesReturned || 0), 0),
          uniqueCandidates: candidates.length,
          enrichedPages: candidates.filter(c => c.pageContent).length,
          acceptedSignals: finalSignals.length,
          totalProcessingTimeMs: Date.now() - startedAt
        }
      }
    });
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Batch research failed', diagnostics: { elapsedMs: Date.now() - startedAt } });
  } finally {
    heartbeatLoop?.stop();
  }
}

// Named exports for testability (Phase 2A / B3 classification tests, and
// Phase 2A implementation-review round 2's run-claim/lease tests).
export {
  makeSignal, resolveCanonicalEventType, resolveAuthenticatedUploadOwner, claimResearchRunAtomic,
  completeResearchRunAttempt, failResearchRunAttempt, heartbeatResearchRunAtomic, clampLeaseSeconds, safeSecretEqual,
  signalEventCategory, resolveSignalEventDate, computeActionability, oneHistoricalOrderFact,
  salesReadyOpener, salesReadyWhy, EVENT_LIKE_TYPES,
  hasTrustworthyActionabilityMetadata, classifyLegacySignalActionability
};
