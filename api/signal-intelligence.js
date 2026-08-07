// Shared deterministic signal-intelligence helpers.
// This module intentionally performs normalization, verification, classification,
// freshness/source scoring, and event clustering before/after AI enrichment.

const SIGNAL_FAMILIES = {
  growth: { label: 'Growth / Expansion', halfLifeDays: 240, weight: 88 },
  hiring: { label: 'Hiring / Workforce', halfLifeDays: 60, weight: 72 },
  leadership: { label: 'Leadership / Relationship', halfLifeDays: 75, weight: 68 },
  product: { label: 'Product / Service', halfLifeDays: 120, weight: 82 },
  events: { label: 'Events / Marketing', halfLifeDays: 60, weight: 86 },
  community: { label: 'Community / CSR', halfLifeDays: 75, weight: 80 },
  award: { label: 'Award / Milestone', halfLifeDays: 120, weight: 70 },
  financial: { label: 'Acquisition / Financial', halfLifeDays: 270, weight: 92 },
  partnership: { label: 'Partnership / Contract', halfLifeDays: 180, weight: 84 },
  rebrand: { label: 'Rebrand', halfLifeDays: 180, weight: 88 },
  unknown: { label: 'Business Activity', halfLifeDays: 75, weight: 45 }
};

function clean(value = '') {
  return String(value || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function normalizeCompany(value = '') {
  return clean(value).toLowerCase()
    .replace(/\b(incorporated|inc|llc|ltd|limited|corp|corporation|co|company|holdings?)\b\.?/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function normalizeUrl(value = '') {
  try {
    const u = new URL(value);
    u.hash = '';
    ['utm_source','utm_medium','utm_campaign','utm_term','utm_content','gclid','fbclid','mc_cid','mc_eid'].forEach(k => u.searchParams.delete(k));
    const query = [...u.searchParams.entries()].sort(([a],[b]) => a.localeCompare(b));
    u.search = '';
    query.forEach(([k,v]) => u.searchParams.append(k,v));
    return `${u.hostname.replace(/^www\./, '').toLowerCase()}${u.pathname.replace(/\/$/, '')}${u.search}`;
  } catch {
    return clean(value).toLowerCase().split('#')[0].replace(/\/$/, '');
  }
}

function normalizeTitle(value = '') {
  return clean(value).toLowerCase()
    .replace(/\b(press release|news release|breaking news|updated|update|announces?|announcement)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function sourceDomain(url = '') {
  try { return new URL(url).hostname.replace(/^www\./, '').toLowerCase(); } catch { return ''; }
}

function classifySignalFamily(input = '', intendedFamily = '') {
  const text = `${intendedFamily} ${input}`.toLowerCase();
  // Classification describes the event, never the buyer.
  if (/acquisition|acquired|merger|merged|funding|investment|capital raise|ipo|public market|earnings|major contract|contract win/.test(text)) return 'financial';
  if (/rebrand|new brand|brand identity|new logo|brand refresh/.test(text)) return 'rebrand';
  if (/new facility|new office|new branch|new location|relocat|renovat|reopen|ribbon cutting|grand opening|distribution center|manufacturing expansion|plant expansion|headquarters|capacity expansion/.test(text)) return 'growth';
  if (/trade show|tradeshow|conference|expo|summit|webinar|workshop|seminar|training session|panel discussion|roundtable|open house|customer event|dealer meeting|sales meeting|booth|exhibitor|grand opening event|festival/.test(text)) return 'events';
  if (/product launch|service launch|launches|launched|introduc|unveil|new offering|new program|campaign launch/.test(text)) return 'product';
  if (/strategic partnership|partnership|distribution agreement|supplier agreement|customer contract|award contract|selected by|collaboration/.test(text)) return 'partnership';
  if (/appoint|promot|joins as|named ceo|named president|named vice president|new director|new executive|leadership change|role change/.test(text)) return 'leadership';
  if (/award|recognition|recognized|winner|anniversary|milestone|best workplace|top employer|safety milestone/.test(text)) return 'award';
  if (/hiring|recruit|workforce growth|seasonal hiring|onboarding initiative|jobs|open positions|talent acquisition/.test(text)) return 'hiring';
  if (/community|charity|fundrais|sponsor|volunteer|csr|foundation|donation|golf tournament|5k|chamber/.test(text)) return 'community';
  return SIGNAL_FAMILIES[intendedFamily] ? intendedFamily : 'unknown';
}

function signalSubtype(text = '', family = classifySignalFamily(text)) {
  const t = clean(text).toLowerCase();
  const tests = [
    ['Acquisition', /acquisition|acquired/], ['Merger', /merger|merged/], ['Funding / Investment', /funding|investment|capital raise/],
    ['Major Contract', /contract win|major contract|selected by|award contract/], ['New Facility', /new facility|new plant|manufacturing plant/],
    ['Branch Reopening', /reopen|renovat.*branch|branch.*renovat/], ['New Location', /new location|new branch|new office/],
    ['Trade Show Participation', /trade show|tradeshow|expo|booth|exhibitor/], ['Conference / Summit', /conference|summit/],
    ['Webinar', /webinar/], ['Workshop / Training', /workshop|seminar|training session|panel discussion|roundtable/], ['Product Launch', /product launch|launches|launched|unveil/], ['Executive Appointment', /appoint|named ceo|named president|joins as/],
    ['Promotion', /promot/], ['Hiring Initiative', /hiring initiative|workforce growth|recruiting campaign|now hiring/],
    ['Company Anniversary', /anniversary/], ['Safety Milestone', /safety milestone|years without|lost-time/], ['Award / Recognition', /award|recognition|winner/],
    ['Community Event', /community event|golf tournament|5k|fundraiser|charity event|festival/], ['Sponsorship', /sponsor/], ['Rebrand', /rebrand|brand identity|new logo/]
  ];
  return (tests.find(([,r]) => r.test(t)) || [SIGNAL_FAMILIES[family]?.label || 'Business Activity'])[0];
}

function sourceAuthority(url = '', title = '') {
  const domain = sourceDomain(url);
  const text = `${domain} ${title}`.toLowerCase();
  if (!domain) return 25;
  if (/sec\.gov|\.gov$/.test(domain)) return 98;
  if (/businesswire|prnewswire|globenewswire/.test(domain)) return 86;
  if (/linkedin\.com/.test(domain)) return 58;
  if (/indeed|ziprecruiter|glassdoor|careerbuilder/.test(domain)) return 38;
  if (/medium\.com|blogspot|wordpress\.com/.test(domain)) return 35;
  if (/news|press|investor|events|association|chamber/.test(text)) return 72;
  return 60;
}

function parseDate(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isFinite(d.getTime()) ? d : null;
}

function freshnessScore(dateValue, family = 'unknown', now = new Date()) {
  const d = parseDate(dateValue);
  if (!d) return 48;
  const ageDays = Math.max(0, (now.getTime() - d.getTime()) / 86400000);
  const halfLife = SIGNAL_FAMILIES[family]?.halfLifeDays || SIGNAL_FAMILIES.unknown.halfLifeDays;
  return Math.max(5, Math.min(100, Math.round(100 * Math.pow(0.5, ageDays / halfLife))));
}

function entityMatch(candidate = {}, account = {}) {
  const company = normalizeCompany(account.name || account.companyName || candidate.companyName || candidate.accountName || '');
  if (!company) return { level: 'uncertain', score: 35, reasons: ['missing company name'] };
  const titleText = normalizeCompany(`${candidate.title || ''} ${candidate.snippet || ''} ${candidate.rawContent || candidate.pageContent || ''}`);
  const domain = clean(account.website || account.domain || '').replace(/^https?:\/\//,'').replace(/^www\./,'').split('/')[0].toLowerCase();
  const candidateDomain = sourceDomain(candidate.url || '');
  let score = 0;
  const reasons = [];
  if (titleText.includes(company)) { score += 58; reasons.push('company named in source'); }
  const compactCompany = company.replace(/\s+/g,'');
  if (!titleText.includes(company) && compactCompany.length > 5 && titleText.replace(/\s+/g,'').includes(compactCompany)) { score += 45; reasons.push('normalized company match'); }
  if (domain && (candidateDomain === domain || candidateDomain.endsWith(`.${domain}`))) { score += 38; reasons.push('verified company domain'); }
  const location = clean(account.location || account.cityState || '').toLowerCase();
  if (location && clean(`${candidate.title} ${candidate.snippet}`).toLowerCase().includes(location)) { score += 8; reasons.push('location match'); }
  score = Math.min(100, score);
  return { level: score >= 75 ? 'verified' : score >= 50 ? 'probable' : score >= 30 ? 'uncertain' : 'rejected', score, reasons };
}

// Signal-to-account evidence grounding (Sprint 1, shared by both live-research
// endpoints -- api/research-batch.js's multi-account pipeline and
// api/research-account.js's single-account pipeline). Reproduced production
// failure: a Gallagher research request returned an opportunity whose
// underlying evidence was actually about Avidia Bank. entityMatch() above
// already provides a reliable full-phrase/normalized-form company check, but
// on its own it cannot handle a company legitimately referred to by only its
// most distinctive word (a surname or coined name, e.g. "Gallagher" for
// "Arthur J. Gallagher & Co.") -- that requires a fallback, and the fallback
// is exactly where an ungoverned implementation would risk false positives
// on a bare generic industry word ("bank", "group", "insurance") shared
// between two unrelated companies. GENERIC_COMPANY_WORDS bounds that risk to
// a short, fixed list rather than a general stopword system.
const GENERIC_COMPANY_WORDS = new Set([
  'group', 'holdings', 'holding', 'company', 'companies', 'corporation', 'corp',
  'incorporated', 'partners', 'partnership', 'services', 'solutions', 'systems',
  'industries', 'enterprises', 'international', 'global', 'capital', 'financial',
  'insurance', 'bank', 'banking', 'bancorp', 'trust', 'associates'
]);

// Uses normalizeCompany() (this module's own normalizer, the same one
// entityMatch() uses for its own company-vs-source comparison) rather than a
// second, independently-tuned normalizer, so a company name's distinctive
// tokens are always derived under the identical stripping rules entityMatch()
// itself already applied.
function distinctiveCompanyTokens(companyName = '') {
  return normalizeCompany(companyName)
    .split(/\s+/)
    .filter(token => token.length >= 4 && !GENERIC_COMPANY_WORDS.has(token));
}

// Narrow fallback for legitimate shortened/surname-only company references
// that entityMatch()'s full-phrase check does not catch. Deliberately
// ANY-token, not ALL-token -- a company legitimately referred to by only its
// most distinctive word should still match. Tokens are pre-filtered to
// length>=4 and not in the bounded generic-word list above specifically so
// this cannot fire on a bare "bank"/"group" mention that merely happens to
// share an industry-generic word with the account name (the reproduced
// Avidia-Bank-generic-banking-text case).
function hasDistinctiveNameFallbackMatch(companyName = '', text = '') {
  const tokens = distinctiveCompanyTokens(companyName);
  if (!tokens.length) return false;
  const normalizedText = normalizeCompany(text);
  if (!normalizedText) return false;
  return tokens.some(token => new RegExp(`\\b${token}\\b`).test(normalizedText));
}

// Company-grounding check, scoped to ONLY the candidate's query-scoped
// title+snippet -- never pageContent/rawContent (Firecrawl's full,
// relevance-agnostic page scrape, which is where the reproduced Avidia
// contamination actually lived). entityMatch() itself is reused unmodified;
// only the object passed to it is scoped down to title+snippet+url.
//
// Explicit scope: this proves the candidate's query-scoped evidence
// credibly identifies the requested company. It does NOT prove event-local
// provenance -- a candidate whose title and snippet genuinely identify the
// right company, but whose separately-fetched pageContent also contains an
// unrelated company's story elsewhere on the same page, remains a residual
// gap (see each endpoint's grounding regression tests). Closing that would
// require a fuzzy event-local excerpt/fingerprint primitive this module does
// not implement and this sprint does not build.
function verifyCandidateCompanyGrounding(candidate = {}, account = {}) {
  const scopedCandidate = { title: candidate.title || candidate.headline || '', snippet: candidate.snippet || '', url: candidate.url || '' };
  const entity = entityMatch(scopedCandidate, account);
  if (entity.level !== 'rejected') return { grounded: true, reasons: entity.reasons };
  const companyName = account.name || account.companyName || '';
  const scopedText = `${scopedCandidate.title} ${scopedCandidate.snippet}`;
  if (hasDistinctiveNameFallbackMatch(companyName, scopedText)) {
    return { grounded: true, reasons: ['distinctive company name matched in source'] };
  }
  return { grounded: false, reasons: entity.reasons };
}

function eventFingerprint(candidate = {}, familyOverride = '') {
  const text = `${candidate.title || ''} ${candidate.snippet || ''} ${candidate.rawContent || candidate.pageContent || ''}`;
  const family = familyOverride || candidate.signalFamily || classifySignalFamily(text, candidate.intendedSignalFamily);
  const subtype = signalSubtype(text, family);
  const company = normalizeCompany(candidate.companyName || candidate.accountName || '');
  const date = parseDate(candidate.eventDate || candidate.publishedAt || candidate.date || candidate.publicationDate);
  const month = date ? `${date.getUTCFullYear()}-${String(date.getUTCMonth()+1).padStart(2,'0')}` : 'unknown';
  const normalized = normalizeTitle(text);
  let eventEntity = '';
  const acquisitionMatch = normalized.match(/(?:acquire[sd]?|acquisition of)\s+([a-z0-9 ]{3,80})/i);
  const appointmentMatch = normalized.match(/(?:appoints?|names?|promotes?)\s+([a-z0-9 ]{3,80})/i);
  const locationMatch = normalized.match(/(?:facility|branch|office|location|plant)\s+(?:in|at)\s+([a-z0-9 ]{3,60})/i);
  if (acquisitionMatch) eventEntity = acquisitionMatch[1].split(/\b(?:and|which|that|to)\b/i)[0];
  else if (appointmentMatch) eventEntity = appointmentMatch[1];
  else if (locationMatch) eventEntity = locationMatch[1];
  const stop = new Set(['company','announced','announces','recently','business','official','press','release','arthur','gallagher','safe','professionals','expands','expanding','services']);
  const namedTokens = normalizeTitle(eventEntity || normalized).split(' ')
    .filter(w => w.length > 2 && !stop.has(w))
    .slice(0, 6).join('-');
  return `${company}|${family}|${subtype.toLowerCase()}|${month}|${namedTokens || subtype.toLowerCase()}`;
}

function commercialScore(candidate = {}, account = {}) {
  const text = `${candidate.title || ''} ${candidate.snippet || ''} ${candidate.rawContent || candidate.pageContent || ''}`;
  const family = candidate.signalFamily || classifySignalFamily(text, candidate.intendedSignalFamily);
  const entity = candidate.entityVerification || entityMatch(candidate, account);
  const authority = candidate.sourceAuthorityScore ?? sourceAuthority(candidate.url, candidate.title);
  const fresh = candidate.freshnessScore ?? freshnessScore(candidate.publishedAt || candidate.date || candidate.publicationDate, family);
  const specificity = /new facility|acquisition|ribbon cutting|trade show|conference|product launch|anniversary|award|appointed|promoted|contract|funding|reopening/i.test(text) ? 88 : 55;
  const commercialWeight = SIGNAL_FAMILIES[family]?.weight || 45;
  const negative = /layoff|bankruptcy|lawsuit|recall|scandal|plant closure|investigation/i.test(text) ? 35 : 0;
  const score = Math.max(0, Math.min(100, Math.round(
    entity.score * 0.25 + authority * 0.16 + fresh * 0.18 + commercialWeight * 0.25 + specificity * 0.16 - negative
  )));
  return { score, breakdown: { entity: entity.score, authority, freshness: fresh, commercialWeight, specificity, negativePenalty: negative } };
}

function normalizeCandidate(raw = {}, account = {}, intendedSignalFamily = '') {
  const headline = clean(raw.headline || raw.title || '');
  const snippet = clean(raw.snippet || raw.description || '');
  const url = clean(raw.url || raw.link || '');
  const signalFamily = classifySignalFamily(`${headline} ${snippet} ${raw.pageContent || raw.rawContent || ''}`, intendedSignalFamily || raw.intendedSignalFamily || '');
  const candidate = {
    ...raw,
    companyId: account.id || raw.companyId || null,
    companyName: clean(account.name || account.companyName || raw.companyName || raw.accountName || ''),
    companyDomain: clean(account.website || account.domain || raw.companyDomain || ''),
    headline,
    snippet,
    url,
    normalizedUrl: normalizeUrl(url),
    sourceName: clean(raw.sourceName || sourceDomain(url)),
    sourceDomain: sourceDomain(url),
    publishedAt: clean(raw.publishedAt || raw.publicationDate || raw.date || ''),
    discoveredAt: clean(raw.discoveredAt || new Date().toISOString()),
    matchedQuery: clean(raw.matchedQuery || raw.query || ''),
    intendedSignalFamily: intendedSignalFamily || raw.intendedSignalFamily || '',
    rawContent: clean(raw.rawContent || raw.pageContent || ''),
    signalFamily
  };
  candidate.sourceAuthorityScore = sourceAuthority(candidate.url, candidate.headline);
  candidate.freshnessScore = freshnessScore(candidate.publishedAt, signalFamily);
  candidate.entityVerification = entityMatch(candidate, account);
  const scored = commercialScore(candidate, account);
  candidate.candidateScore = scored.score;
  candidate.scoreBreakdown = scored.breakdown;
  candidate.eventFingerprint = eventFingerprint(candidate, signalFamily);
  candidate.diagnostics = {
    entityLevel: candidate.entityVerification.level,
    entityReasons: candidate.entityVerification.reasons,
    scoreBreakdown: scored.breakdown
  };
  return candidate;
}

function choosePrimaryCandidate(group = []) {
  return [...group].sort((a,b) => (b.candidateScore || 0) - (a.candidateScore || 0))[0];
}

function clusterCandidates(candidates = []) {
  const groups = new Map();
  for (const c of candidates) {
    if (!c) continue;
    const key = c.eventFingerprint || eventFingerprint(c);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(c);
  }
  return [...groups.entries()].map(([fingerprint, group]) => {
    const primary = choosePrimaryCandidate(group);
    const sources = [];
    const seen = new Set();
    group.sort((a,b) => (b.sourceAuthorityScore || 0) - (a.sourceAuthorityScore || 0)).forEach(c => {
      const key = c.normalizedUrl || normalizeUrl(c.url);
      if (!key || seen.has(key)) return;
      seen.add(key);
      sources.push({ name: c.sourceName || c.sourceDomain || 'Public source', url: c.url, publishedAt: c.publishedAt || '' });
    });
    return { ...primary, eventFingerprint: fingerprint, corroboratingCandidates: group.length, sources };
  }).sort((a,b) => (b.candidateScore || 0) - (a.candidateScore || 0));
}

function displaySignalType(family, subtype = '') {
  if (subtype && subtype !== SIGNAL_FAMILIES[family]?.label) return subtype;
  const map = {
    growth: 'Expansion / New Location', hiring: 'Hiring Activity', leadership: 'Leadership Change', product: 'Product / Service Launch',
    events: 'Trade Show / Event', community: 'Community / CSR', award: 'Award / Recognition', financial: 'Acquisition / Funding',
    partnership: 'Partnership / Contract', rebrand: 'Rebrand', unknown: 'Business Activity'
  };
  return map[family] || 'Business Activity';
}

function materiallyRepeats(a = '', b = '') {
  const aa = new Set(normalizeTitle(a).split(' ').filter(w => w.length > 3));
  const bb = new Set(normalizeTitle(b).split(' ').filter(w => w.length > 3));
  if (!aa.size || !bb.size) return false;
  let overlap = 0; aa.forEach(w => { if (bb.has(w)) overlap++; });
  return overlap / Math.min(aa.size, bb.size) >= 0.75;
}

function normalizeOpportunity(raw = {}, account = {}, candidate = {}) {
  const evidenceText = `${raw.whatChanged || raw.concrete_trigger || raw.concreteTrigger || raw.signalTitle || raw.headline || ''} ${raw.businessContext || raw.business_context || ''} ${candidate.headline || ''} ${candidate.snippet || ''}`;
  const family = classifySignalFamily(evidenceText, raw.signalFamily || raw.signal_family || candidate.signalFamily || '');
  const subtype = signalSubtype(evidenceText, family);
  // Phase 2A / B3: when the caller already attached a canonical classification
  // (research-batch.js's makeSignal() does this via canonicalEventType), reuse
  // its display label for signalType instead of recomputing an independent one
  // here. Before this change, this function silently overwrote makeSignal()'s
  // already-correct signal_type/signalType agreement — signal_type (snake_case)
  // survived the {...raw} spread below untouched, but signalType (camelCase,
  // which api/save-upload.js actually persists as the signal_type DB column)
  // did not, reintroducing exactly the disagreement this whole workstream
  // exists to remove. Falls back to the family/subtype classifier unchanged
  // for any caller that has no canonical type to reuse.
  const canonicalSignalType = raw.canonicalEventType ? displayLabelForEventType(raw.canonicalEventType) : null;
  const headline = clean(raw.signalTitle || raw.headline || raw.concreteTrigger || raw.concrete_trigger || candidate.headline || subtype);
  const whatChanged = clean(raw.whatChanged || raw.summary || raw.shortSummary || raw.businessContext || candidate.snippet || headline);
  let whyThisMatters = clean(raw.whyThisMatters || raw.why_this_matters || raw.whyItMattersForPromo || raw.opportunityExplanation || '');
  if (!whyThisMatters || materiallyRepeats(whyThisMatters, whatChanged)) whyThisMatters = '';
  const sources = Array.isArray(raw.sources) && raw.sources.length ? raw.sources : (candidate.sources || (candidate.url ? [{ name: candidate.sourceName || candidate.sourceDomain || 'Public source', url: candidate.url, publishedAt: candidate.publishedAt || '' }] : []));
  const fingerprint = raw.eventFingerprint || candidate.eventFingerprint || eventFingerprint({ ...candidate, companyName: account.name || raw.companyName, title: headline, snippet: whatChanged }, family);
  return {
    ...raw,
    companyId: account.id || raw.companyId || null,
    companyName: clean(account.name || raw.companyName || raw.accountName || ''),
    accountName: clean(account.name || raw.accountName || raw.companyName || ''),
    signalFamily: family,
    signalSubtype: subtype,
    signalType: canonicalSignalType || displaySignalType(family, subtype),
    signal_type: raw.canonicalEventType ? (canonicalSignalType || displaySignalType(family, subtype)) : (raw.signal_type ?? raw.signalType),
    headline,
    signalTitle: headline,
    whatChanged,
    businessContext: clean(raw.businessContext || raw.business_context || whatChanged),
    whyThisMatters,
    whyItMattersForPromo: whyThisMatters,
    eventDate: clean(raw.eventDate || raw.event_date || ''),
    publishedAt: clean(raw.publishedAt || raw.publicationDate || candidate.publishedAt || ''),
    discoveredAt: clean(raw.discoveredAt || raw.detectedAt || new Date().toISOString()),
    sources,
    sourceUrl: clean(raw.sourceUrl || raw.source_url || sources[0]?.url || candidate.url || ''),
    sourceName: clean(raw.sourceName || raw.source_name || sources[0]?.name || candidate.sourceName || ''),
    eventFingerprint: fingerprint,
    commercialScore: Number(raw.commercialScore || candidate.candidateScore || raw.whyNowScore || raw.why_now_score || 0),
    diagnostics: { ...(raw.diagnostics || {}), candidate: candidate.diagnostics || null }
  };
}

function validateOpportunity(opportunity = {}) {
  const reasons = [];
  if (!clean(opportunity.companyName || opportunity.accountName)) reasons.push('missing company');
  if (!clean(opportunity.headline || opportunity.signalTitle || opportunity.whatChanged)) reasons.push('missing event');
  if (!clean(opportunity.sourceUrl) && !(opportunity.sources || []).some(s => s && s.url)) reasons.push('missing evidence');
  if (opportunity.signalFamily === 'unknown') reasons.push('unsupported classification');
  if (!clean(opportunity.whyThisMatters || opportunity.whyItMattersForPromo)) reasons.push('missing commercial implication');
  return { valid: reasons.length === 0, reasons };
}

function dedupeOpportunities(opportunities = []) {
  const best = new Map();
  for (const o of opportunities) {
    if (!o) continue;
    const key = o.eventFingerprint || eventFingerprint({ companyName: o.companyName || o.accountName, title: o.headline || o.signalTitle, snippet: o.whatChanged, publishedAt: o.eventDate || o.publishedAt }, o.signalFamily);
    const existing = best.get(key);
    const score = Number(o.whyNowScore || o.why_now_score || o.commercialScore || o.confidenceScore || 0);
    const existingScore = Number(existing?.whyNowScore || existing?.why_now_score || existing?.commercialScore || existing?.confidenceScore || 0);
    if (!existing || score > existingScore) best.set(key, { ...o, eventFingerprint: key });
  }
  return [...best.values()];
}

function buildQueryPlan(company, context = {}) {
  const q = `"${clean(company)}"`;
  const domain = clean(context.website || context.domain || '').replace(/^https?:\/\//,'').replace(/^www\./,'').split('/')[0];
  const contact = clean(context.contactName || '');
  const intents = [
    ['financial', `${q} (acquisition OR merger OR funding OR investment OR "major contract")`],
    ['growth', `${q} ("new facility" OR expansion OR relocation OR renovation OR reopening OR "ribbon cutting")`],
    ['events', `${q} (conference OR "trade show" OR expo OR webinar OR summit OR "open house" OR "customer event" OR festival)`],
    ['product', `${q} (launches OR launched OR "new product" OR "new service" OR campaign)`],
    ['hiring', `${q} (hiring OR recruiting OR workforce OR careers OR onboarding)`],
    ['leadership', `${q} (appointed OR promoted OR "joins as" OR "new vice president" OR "new director")`],
    ['award', `${q} (award OR recognition OR anniversary OR milestone OR "safety milestone")`],
    ['community', `${q} (sponsor OR charity OR fundraiser OR volunteer OR "golf tournament" OR community OR festival)`],
    ['partnership', `${q} (partnership OR "distribution agreement" OR collaboration OR contract)`],
    ['rebrand', `${q} (rebrand OR "brand identity" OR "new logo")`]
  ];
  if (domain) {
    intents.unshift(['owned', `site:${domain} (news OR press OR events OR careers OR leadership OR awards OR expansion OR launch)`]);
  }
  if (contact) intents.push(['leadership', `"${contact}" ${q} (promoted OR appointed OR joined OR "new role")`]);
  const seen = new Set();
  return intents.filter(([,query]) => {
    const key = query.toLowerCase(); if (seen.has(key)) return false; seen.add(key); return true;
  }).map(([signalFamily, query], index) => ({ id: `${signalFamily}-${index}`, signalFamily, query, priority: index }));
}

// ---------------------------------------------------------------------------
// Sprint 4.5.1 — Stage A: Business Event resolution (additive; clusterCandidates()
// and eventFingerprint() above are UNCHANGED and remain the active production
// path. Nothing below is wired into research-account.js or research-batch.js yet.
// ---------------------------------------------------------------------------

// Event types where the same real-world event legitimately recurs on a cadence
// (an "instance" — e.g. a specific year's conference — is its own event).
const RECURRING_EVENT_TYPES = new Set(['EVENT_TRADE_SHOW', 'EVENT_CONFERENCE', 'EVENT_AWARD', 'EVENT_COMMUNITY']);

// ---------------------------------------------------------------------------
// Phase 2A / B3 — single source of truth for event classification.
//
// Before this change, three independent classifiers could each assign a
// label to the same signal (normalizeSignalTypeFromEvidence() in
// research-batch.js trusting the AI's own free-text declaration in most
// cases; classifySignalFamily()/signalSubtype() above; resolveEventType()
// below, computed separately and only at persistence time), with nothing
// reconciling them. That is the confirmed root cause of every observed
// signal_type/eventType/opportunityType disagreement in the frozen Phase 1B
// baseline (ranks 5, 8, 11, 14, 17).
//
// The fix: resolveEventType()'s ALL_CAPS taxonomy becomes the one canonical
// value, computed once (in research-batch.js's makeSignal(), before any
// AI-declared type is consulted) and carried through unchanged. This table
// is the ONLY place a canonical eventType is mapped to a rep-facing display
// label — callers must go through displayLabelForEventType(), never invent
// their own label for a canonical type. The invariant is semantic mapping
// consistency (NEW_LOCATION_OPENING -> "New Location"), not literal string
// equality between the enum and the label.
// ---------------------------------------------------------------------------
const EVENT_TYPE_DISPLAY_LABELS = {
  ACQUISITION: 'Acquisition',
  LEADERSHIP_APPOINTMENT: 'Leadership Change',
  EVENT_TRADE_SHOW: 'Trade Show Participation',
  EVENT_CONFERENCE: 'Conference / Summit',
  EVENT_AWARD: 'Award / Recognition',
  EVENT_COMMUNITY: 'Community Event',
  PRODUCT_LAUNCH: 'Product Launch',
  PARTNERSHIP: 'Partnership / Contract',
  REBRAND: 'Rebrand',
  RENOVATION_COMPLETION: 'Renovation Completed',
  LOCATION_REOPENING: 'Location Reopening',
  NEW_LOCATION_OPENING: 'New Location',
  FACILITY_EXPANSION: 'Facility Expansion',
  LOCATION_EVENT_UNSPECIFIED: 'Location Event',
  HIRING_ACTIVITY: 'Hiring Activity'
};
function displayLabelForEventType(eventType = '') {
  const t = String(eventType || '');
  if (EVENT_TYPE_DISPLAY_LABELS[t]) return EVENT_TYPE_DISPLAY_LABELS[t];
  if (t.startsWith('BUSINESS_ACTIVITY_')) {
    const family = t.slice('BUSINESS_ACTIVITY_'.length).toLowerCase();
    return SIGNAL_FAMILIES[family]?.label || 'Business Activity';
  }
  return 'Business Activity';
}

function normalizeForMatch(value = '') {
  return clean(value).toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}

// Resolves free text into a canonical Business Event type. Returns candidateTypes
// (plural) because some phrasing — bare "ribbon cutting" being the classic case —
// is genuinely ambiguous until matched against accompanying evidence or an
// already-known event; see resolveEvents().
function resolveEventType(text = '', family = '') {
  const t = clean(text);

  const hasNewQualifier = /\bnew\b[\s\S]{0,25}\b(branch|location|office)\b|\bbrand new\b|\bjust opened\b|\bnewest (branch|location|office)\b|\bfirst (branch|location)\b/i.test(t);
  const hasReopenQualifier = /\breopen|re-open|reopened|back open|relaunch(ed)?\b/i.test(t);
  const hasRenovationQualifier = /\brenovat|remodel|refresh(ed)?|upgraded (branch|location|facility)\b|\breimagin\w*/i.test(t);
  const mentionsBranchOpening = /\bbranch opening\b|\bopening (?:a |its |their )?new branch\b/i.test(t);
  const mentionsRibbonOrGrandOpening = /\bribbon cutting|ribbon-cutting|grand opening\b/i.test(t);
  const mentionsFacilityExpansion = /\bnew facility|new plant|capacity expansion|manufacturing expansion|plant expansion|expanding operations|distribution center\b/i.test(t);

  // QA final round, item 3: "acquired"/"acquisition" also appears in loose,
  // non-M&A usage ("acquired a $15,000 grant", "acquisition of additional
  // retail space for the renovation") -- a capital-investment/renovation
  // signal or a grant/funding/award signal must never be reclassified as a
  // corporate acquisition merely because that wording (or a contaminating
  // field elsewhere in the combined classification text) happens to use
  // "acquired"/"acquisition". Genuine acquisition language is required to
  // name a business/company/assets/stake as its object, and grant/funding
  // or investment/renovation language -- when present anywhere in the same
  // text -- always takes precedence over a bare "acquired"/"acquisition"
  // match.
  const mentionsGrantOrFunding = /\b(grants?|funding award|sponsorship award|arts (?:grant|funding)|community funding)\b/i.test(t);
  const mentionsInvestmentOrRenovation = /\binvest(?:ing|ment|s)?\b|\breimagin\w*|\brenovat\w*|\bremodel\w*|\bredevelop\w*|\bexpand(?:ing|s|ed)?\s+(?:its|their|the)?\s*campus\b|\bconstruction\b/i.test(t);
  const hasGenuineAcquisitionLanguage = /\bacquisition of\b|\bcompletes acquisition\b|\bfinalizes purchase of\b|\bmerger\b|\bmerged with\b|\bpurchased\s+(?:the\s+)?(?:assets|business|compan(?:y|ies)|operations)\s+of\b/i.test(t)
    || (/\bacquires?\b|\bacquired\b/i.test(t) && /\b(business(?:es)?|compan(?:y|ies)|assets|stake|firm|operations|entity)\b/i.test(t));
  if (hasGenuineAcquisitionLanguage && !mentionsGrantOrFunding && !mentionsInvestmentOrRenovation) {
    return { primaryType: 'ACQUISITION', candidateTypes: ['ACQUISITION'], recurring: false };
  }
  if (/\bappoints?\b|\bappointed\b|\bnames?\b.*\bas\b|\bnamed\b.*\bas\b|\bpromotes?\b|\bpromoted\b|joins as|hired as|named (ceo|president|vice president|chief|director)/i.test(t)) {
    return { primaryType: 'LEADERSHIP_APPOINTMENT', candidateTypes: ['LEADERSHIP_APPOINTMENT'], recurring: false };
  }
  if (/trade show|tradeshow|\bexpo\b|\bbooth\b|exhibitor/i.test(t)) {
    return { primaryType: 'EVENT_TRADE_SHOW', candidateTypes: ['EVENT_TRADE_SHOW'], recurring: true };
  }
  // QA round 3, item 1: `\bworkshop\b` (and siblings) never matched the far
  // more common plural phrasing ("workshops", "seminars", "webinars") --
  // `\b` is a boundary between the LAST letter and what follows, so a
  // trailing "s" right after the word defeats it entirely, silently
  // dropping these signals out of EVENT_LIKE_TYPES and into "ongoing".
  // Every noun below now tolerates an optional plural "s".
  if (/\bconferences?\b|\bsummits?\b|\bwebinars?\b|\bworkshops?\b|\bseminars?\b|\btraining sessions?\b|\bpanel discussions?\b|\broundtables?\b/i.test(t)) {
    return { primaryType: 'EVENT_CONFERENCE', candidateTypes: ['EVENT_CONFERENCE'], recurring: true };
  }
  // QA final round, item 3: grant/funding/sponsorship awards are grouped
  // with Award/Recognition -- both are discrete, announced occurrences,
  // never a corporate acquisition (see the acquisition guard above).
  if (/\bawards?\b|recognition|recognized|\bwinners?\b|\bmilestones?\b|\banniversar(?:y|ies)\b|\bgrants?\b|funding award|sponsorship award/i.test(t)) {
    return { primaryType: 'EVENT_AWARD', candidateTypes: ['EVENT_AWARD'], recurring: true };
  }
  // QA final round, item 3: "open house"/"festival"/"rodeo"/bare
  // "tournament" (not just "golf tournament") previously matched no specific
  // regex here and fell through to the generic BUSINESS_ACTIVITY_* bucket,
  // which is never in EVENT_LIKE_TYPES -- an explicitly event-like signal
  // (open house, festival, tournament, rodeo) must never be silently
  // downgraded to an ongoing business change just because its wording didn't
  // happen to match one of the narrower event categories above.
  //
  // Temporal-integrity round: "open house" is also the single most common
  // way a real branch opening/reopening/renovation-reveal event is phrased
  // ("ribbon cutting and open house celebration for our new Westborough
  // branch"). Two write-ups of the SAME real location event, phrased
  // slightly differently, must not receive incompatible canonical types
  // merely because one happens to use "open house" language and the other
  // doesn't -- that mismatch is exactly what breaks resolveEvents()'s
  // typesCompatible() merge check downstream, producing duplicate
  // opportunities for one real event (confirmed production case: two
  // Avidia Bank Westborough branch write-ups). A genuine location-opening
  // signal (ribbon cutting/grand opening, or a new/reopened/renovated
  // branch qualifier) always takes precedence over the generic community-
  // event bucket, mirroring the acquisition-vs-funding disambiguation
  // pattern above. A bare community/charity event with no location-opening
  // language is unaffected.
  if (/community event|golf tournament|\btournaments?\b|\b5k\b|fundraiser|\bcharity\b|\bsponsor|\bopen house(?:s|es)?\b|\bfestivals?\b|\brodeos?\b/i.test(t)
      && !mentionsRibbonOrGrandOpening && !hasNewQualifier && !hasReopenQualifier && !hasRenovationQualifier && !mentionsBranchOpening) {
    return { primaryType: 'EVENT_COMMUNITY', candidateTypes: ['EVENT_COMMUNITY'], recurring: true };
  }
  if (/product launch|\blaunches\b|\blaunched\b|\bunveil|new product|new service/i.test(t)) {
    return { primaryType: 'PRODUCT_LAUNCH', candidateTypes: ['PRODUCT_LAUNCH'], recurring: false };
  }
  if (/\bpartnership\b|distribution agreement|supplier agreement|\bcollaboration\b/i.test(t)) {
    return { primaryType: 'PARTNERSHIP', candidateTypes: ['PARTNERSHIP'], recurring: false };
  }
  if (/\brebrand|brand identity|new logo/i.test(t)) {
    return { primaryType: 'REBRAND', candidateTypes: ['REBRAND'], recurring: false };
  }

  // Location family: qualifiers disambiguate before falling back to "unspecified".
  if (hasRenovationQualifier && !hasNewQualifier) {
    return { primaryType: 'RENOVATION_COMPLETION', candidateTypes: ['RENOVATION_COMPLETION'], recurring: false };
  }
  if (hasReopenQualifier && !hasNewQualifier) {
    return { primaryType: 'LOCATION_REOPENING', candidateTypes: ['LOCATION_REOPENING'], recurring: false };
  }
  if (hasNewQualifier || mentionsBranchOpening) {
    return { primaryType: 'NEW_LOCATION_OPENING', candidateTypes: ['NEW_LOCATION_OPENING'], recurring: false };
  }
  if (mentionsFacilityExpansion) {
    return { primaryType: 'FACILITY_EXPANSION', candidateTypes: ['FACILITY_EXPANSION'], recurring: false };
  }
  if (mentionsRibbonOrGrandOpening) {
    // Ambiguous on its own — could be a new opening, a reopening, or a renovation
    // reveal. Left unresolved here; resolveEvents() disambiguates via matching.
    return { primaryType: 'LOCATION_EVENT_UNSPECIFIED', candidateTypes: ['NEW_LOCATION_OPENING', 'LOCATION_REOPENING', 'RENOVATION_COMPLETION'], recurring: false };
  }
  if (/\bhiring\b|\brecruit|workforce growth|onboarding initiative|\bjobs\b|open positions/i.test(t)) {
    return { primaryType: 'HIRING_ACTIVITY', candidateTypes: ['HIRING_ACTIVITY'], recurring: false };
  }

  const fam = family || classifySignalFamily(text);
  const generic = `BUSINESS_ACTIVITY_${String(fam || 'unknown').toUpperCase()}`;
  return { primaryType: generic, candidateTypes: [generic], recurring: false };
}

function extractFromOneField(t = '') {
  if (!t) return { subjectEntity: null, location: null, role: null };
  let subjectEntity = null;
  let location = null;
  let role = null;

  const NON_LOCATION_WORDS = new Set(['new', 'our', 'its', 'their', 'the', 'this', 'next', 'another', 'a', 'an', 'latest', 'newest', 'grand', 'corp', 'inc', 'llc', 'co', 'company', 'corporation', 'ltd']);
  // Proper-noun sequence: 1-5 consecutive capitalized tokens. Used for any entity/place
  // capture, since real place and company names are capitalized and this naturally stops
  // at the first lowercase connector word ("and", "in", "finalized"...) rather than relying
  // on a hand-maintained stop-word list that can silently fail when the actual sentence
  // boundary is farther away than a fixed length cap.
  const PN = "[A-Z][A-Za-z0-9&.'-]*(?:\\s+[A-Z][A-Za-z0-9&.'-]*){0,4}";
  const acquisitionMatch = t.match(new RegExp(`(?:[Aa]cquires?|[Aa]cquired|[Aa]cquisition of|[Cc]ompletes acquisition of|[Ff]inalizes purchase of)\\s+(${PN})`));
  const appointmentMatch =
    t.match(new RegExp(`(?:[Aa]ppoints?|[Nn]ames?|[Pp]romotes?)\\s+(${PN})\\s+as\\s+([A-Za-z0-9&, -]{3,70}?)(?:\\.|,?\\s+effective\\b|$)`)) ||
    t.match(new RegExp(`(${PN})\\s+joins\\s+as\\s+([A-Za-z0-9&, -]{3,70}?)(?:\\.|,?\\s+effective\\b|$)`)) ||
    t.match(new RegExp(`(${PN})\\s+(?:has been |was |is )?(?:appointed|named|promoted to)\\s+([A-Za-z0-9&, -]{3,70}?)(?:\\.|,?\\s+effective\\b|$)`));
  const facilityInAtMatch = t.match(new RegExp(`(?:facility|branch|office|location|plant)\\s+(?:in|at)\\s+(${PN})`, 'i'));
  const openingLocationMatch = t.match(new RegExp(`(?:grand opening|ribbon cutting|opening|opens?)\\s+(?:of|for)?\\s*(?:its|their|a|the)?\\s*(?:new)?\\s*(?:branch|location|office)?\\s*(?:in|at)\\s+(${PN})`, 'i'));
  const openingOfXLocationMatch = t.match(new RegExp(`(?:grand opening|opening)\\s+of\\s+(?:its|their|a|the)?\\s*(?:new\\s+)?(${PN})\\s+(?:location|branch|office)\\b`, 'i'));
  const possessiveLocationMatch = t.match(new RegExp(`(?:'s|its)\\s+(?:new\\s+)?(${PN})\\s+(?:location|branch|office|plant|facility)\\b`, 'i'));
  const branchNameMatchRaw = t.match(/\b([A-Z][a-zA-Z]{2,30})\s+[Bb]ranch\b/);
  const branchNameMatch = branchNameMatchRaw && !NON_LOCATION_WORDS.has(branchNameMatchRaw[1].toLowerCase()) ? branchNameMatchRaw : null;
  const cityStateMatch = t.match(/\b([A-Z][a-zA-Z]+(?:\s[A-Z][a-zA-Z]+)?),\s*([A-Z]{2})\b/);

  const trimTrailingPunct = (s) => s ? s.replace(/[.,;:]+$/, '').trim() : s;
  if (acquisitionMatch) subjectEntity = trimTrailingPunct(acquisitionMatch[1].trim());
  if (appointmentMatch) { subjectEntity = trimTrailingPunct(appointmentMatch[1].trim()); role = appointmentMatch[2].trim(); }

  if (facilityInAtMatch) location = trimTrailingPunct(facilityInAtMatch[1].trim());
  else if (openingOfXLocationMatch) location = trimTrailingPunct(openingOfXLocationMatch[1].trim());
  else if (openingLocationMatch) location = trimTrailingPunct(openingLocationMatch[1].trim());
  else if (possessiveLocationMatch) location = trimTrailingPunct(possessiveLocationMatch[1].trim());
  else if (cityStateMatch) location = `${cityStateMatch[1]}, ${cityStateMatch[2]}`;
  else if (branchNameMatch) location = trimTrailingPunct(branchNameMatch[1].trim());

  return { subjectEntity, location, role };
}

// Runs extraction on each field SEPARATELY (never on a blind concatenation of
// title+snippet+rawContent) and takes the first field that yields a value, per
// sub-field. This avoids a permissive capture group in one field silently
// extending across the boundary into an unrelated adjacent field's text.
function extractEventEntities(title = '', snippet = '', rawContent = '') {
  const fields = [clean(title), clean(snippet), clean(rawContent)].filter(Boolean);
  let subjectEntity = null, location = null, role = null;
  for (const f of fields) {
    const r = extractFromOneField(f);
    if (!subjectEntity && r.subjectEntity) subjectEntity = r.subjectEntity;
    if (!location && r.location) location = r.location;
    if (!role && r.role) role = r.role;
    if (subjectEntity && location && role) break;
  }
  if (!subjectEntity && location) subjectEntity = location;
  return {
    subjectEntity: subjectEntity ? subjectEntity.slice(0, 60) : null,
    location: location ? location.slice(0, 60) : null,
    role: role ? role.slice(0, 70) : null
  };
}

// eventDate is ONLY set when the text itself describes when the event happened
// or will happen. Publication date never substitutes for it (see normalizeCandidate
// / Evidence, where publishedAt stays a separate, per-source field).
// QA final round, item 2: month-name normalization for date-range parsing
// below -- reconstructs an unambiguous "Month D, YYYY" string from a
// captured month token (full name or common abbreviation, with or without
// a trailing period) so the anchor date is built the same trusted way the
// existing single-date branches already build theirs (parseDate() on a
// clean "Month D, YYYY" string), rather than trusting the Date constructor
// on the raw, possibly-abbreviated source text directly.
const MONTH_FULL_NAME_BY_KEY = {
  jan: 'January', feb: 'February', mar: 'March', apr: 'April', may: 'May', jun: 'June',
  jul: 'July', aug: 'August', sep: 'September', sept: 'September', oct: 'October',
  nov: 'November', dec: 'December'
};
function normalizeMonthName(raw = '') {
  const key = String(raw).replace(/\./g, '').trim().toLowerCase();
  return MONTH_FULL_NAME_BY_KEY[key] || (key.length > 3 ? MONTH_FULL_NAME_BY_KEY[key.slice(0, 3)] : null) || null;
}
const MONTH_TOKEN = '(January|Jan\\.?|February|Feb\\.?|March|Mar\\.?|April|Apr\\.?|May|June|Jun\\.?|July|Jul\\.?|August|Aug\\.?|September|Sept\\.?|Sep\\.?|October|Oct\\.?|November|Nov\\.?|December|Dec\\.?)';
const DATE_RANGE_RE = new RegExp(`\\b${MONTH_TOKEN}\\s+(\\d{1,2})\\s*(?:[-–—]|through|to)\\s*(\\d{1,2}),?\\s+(20\\d{2})\\b`, 'i');

// Problem 2 (Preview QA follow-up round): the free text this function mines
// routinely contains TWO different kinds of date -- when the real-world
// event happened/happens, and when a SOURCE recorded/listed/posted its
// write-up (an Eventbrite listing's own "posted"/"dated" timestamp is the
// classic case, and it is very often a day or two off from the event it
// describes). extractEventDate() previously grabbed whichever date pattern
// matched FIRST in the concatenated text with no way to tell the two kinds
// apart, so a listing site's own dateline could silently outrank -- or
// simply arrive before, in string order -- the sentence that actually named
// the event date (confirmed production case: "ceremonial ribbon cutting on
// June 23, 2026" in the signal's own description, while a nearby "Eventbrite
// ... dated Jun 22" listing timestamp was the value that ended up in
// eventDate). A date immediately preceded by publication/listing language
// ("posted", "published", "dated", "listed", "updated", "created", "added")
// is never treated as the event date -- callers needing that value read
// publicationDate/publishedAt instead, which are populated separately and
// were never at risk from this bug.
const PUBLICATION_DATE_CONTEXT_RE = /\b(?:posted|published|dated|listed|updated|created|added)\b\s*(?:on|:)?\s*$/i;
function isPublicationDateContext(text, matchIndex) {
  const before = text.slice(Math.max(0, matchIndex - 30), matchIndex);
  return PUBLICATION_DATE_CONTEXT_RE.test(before);
}
// Returns the first match (by string order) from `regex` (which must be
// global) whose immediately-preceding text is NOT publication/listing
// language, or null if every match found is publication-context. Preferring
// "first non-publication match" over "first match" is what lets a genuine
// event-date sentence win even when a listing site's dateline happens to
// appear earlier in the concatenated text.
function firstNonPublicationMatch(text, regex) {
  const matches = Array.from(text.matchAll(regex));
  if (!matches.length) return null;
  const nonPubMatch = matches.find(m => !isPublicationDateContext(text, m.index));
  return nonPubMatch || null;
}

// R5 follow-up: the inverse of firstNonPublicationMatch() above -- finds a
// date that IS immediately preceded by publication/listing language, so a
// read-time legacy-data reconciliation pass (classifyLegacySignalActionability()
// in api/research-batch.js) can check whether an already-persisted eventDate
// value matches a publication-context date in the source text, rather than
// a real event-date statement. Returns the parsed ISO date string, or null
// if no publication-context date is present at all.
function findPublicationContextDate(text = '') {
  const t = clean(text);
  const patterns = [
    /\b(20\d{2}-\d{2}-\d{2})\b/g,
    /\b(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},?\s+20\d{2}\b/gi
  ];
  for (const re of patterns) {
    const matches = Array.from(t.matchAll(re));
    const pubMatch = matches.find(m => isPublicationDateContext(t, m.index));
    if (pubMatch) {
      const parsed = parseDate(pubMatch[1] || pubMatch[0]);
      if (parsed) return parsed.toISOString().slice(0, 10);
    }
  }
  return null;
}

function extractEventDate(text = '') {
  const t = clean(text);
  const isoMatch = firstNonPublicationMatch(t, /\b(20\d{2}-\d{2}-\d{2})\b/g);
  const monthDayYear = firstNonPublicationMatch(t, /\b(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},?\s+20\d{2}\b/gi);
  // Common date-range phrasing ("September 18-20, 2026", "September 18–20,
  // 2026", "Sep. 18 through 20, 2026") -- extractEventDate() previously only
  // matched a single day, so a real, explicit range like an L.L.Bean grand
  // opening ("September 18-20, 2026") silently fell through to "unknown"
  // and rendered as "Date unavailable" despite naming an exact date. The
  // anchor date used for all upcoming/recent/stale math is the FIRST day of
  // the range (when the event begins); displayEventDate preserves the full,
  // human-readable range text for rendering.
  const rangeMatch = t.match(DATE_RANGE_RE);
  const monthYear = t.match(/\b(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+20\d{2}\b/i);
  const hasEventLanguage = /\b(on|opens?|opened|opening|effective|held|takes place|scheduled for|will open)\b/i.test(t);

  let raw = null;
  let display = null;
  let confidence = 'unknown';
  if (isoMatch) { raw = isoMatch[1]; confidence = 'exact'; }
  else if (monthDayYear) { raw = monthDayYear[0]; confidence = 'exact'; }
  else if (rangeMatch) {
    const monthName = normalizeMonthName(rangeMatch[1]);
    const [, , day1, day2, year] = rangeMatch;
    if (monthName) {
      raw = `${monthName} ${day1}, ${year}`;
      confidence = 'exact';
      display = `${monthName} ${day1}–${day2}, ${year}`;
    }
  }
  else if (monthYear && hasEventLanguage) { raw = monthYear[0]; confidence = 'approximate'; }

  const parsed = raw ? parseDate(raw) : null;
  if (!parsed) return { eventDate: null, dateConfidence: 'unknown', year: null, displayEventDate: null };
  return {
    eventDate: parsed.toISOString().slice(0, 10),
    dateConfidence: confidence,
    year: parsed.getUTCFullYear(),
    displayEventDate: display
  };
}

function extractYearFallback(text = '', publishedAt = '') {
  const yearInText = clean(text).match(/\b(20\d{2})\b/);
  if (yearInText) return Number(yearInText[1]);
  const d = parseDate(publishedAt);
  return d ? d.getUTCFullYear() : null;
}

// Coarse origin category — used only to judge whether two sources plausibly
// originate separately, never to assert certainty either way.
function originClass(url = '') {
  const d = sourceDomain(url);
  if (!d) return 'other';
  if (/businesswire|prnewswire|globenewswire/.test(d)) return 'wire';
  if (/eventbrite|meetup/.test(d)) return 'listing';
  if (/chamber/.test(d) || d.endsWith('.org')) return 'community-org';
  if (/linkedin\.com|facebook\.com|instagram\.com|twitter\.com|x\.com/.test(d)) return 'social';
  if (/news|press|tribune|gazette|herald|journal|times\b/.test(d)) return 'local-news';
  return 'other';
}

// Deliberately conservative per Sprint 4.5.1 correction: near-identical wording
// (or same domain republishing) is labeled likely_syndicated, not "duplicate."
// Different wording from a source we can't confidently place is labeled unknown
// — never asserted independent just because the wording differs.
function classifyCorroboration(candidateEvidence = {}, existingEvidence = []) {
  if (!existingEvidence.length) return 'independent';
  const candDomain = sourceDomain(candidateEvidence.url);
  const candClass = originClass(candidateEvidence.url);

  const overlapsExisting = existingEvidence.some(e => materiallyRepeats(candidateEvidence.excerpt, e.excerpt));
  if (overlapsExisting) return 'likely_syndicated';

  const sameDomainAsExisting = existingEvidence.some(e => sourceDomain(e.url) === candDomain);
  if (sameDomainAsExisting) return 'likely_syndicated';

  const differentOriginClassSeen = existingEvidence.some(e => originClass(e.url) !== candClass);
  return differentOriginClassSeen ? 'independent' : 'unknown';
}

function stripHeadlineNoise(title = '') {
  return clean(title)
    .replace(/\s*\|\s*[^|]{2,40}$/, '')
    .replace(/^(BREAKING|EXCLUSIVE|UPDATE)\s*:\s*/i, '')
    .replace(/\s*[-–]\s*[A-Z][a-zA-Z]+(?: [A-Z][a-zA-Z]+)?\s*(News|Times|Tribune|Gazette|Herald|Journal|Daily)$/i, '')
    .trim();
}

// Identity-first title generation, per Sprint 4.5.1 correction: the source's own
// headline is used only as a fallback when Event Identity can't fill a template
// — never copied verbatim as the primary path, so SEO-heavy or awkward article
// headlines never become the product's own language when a clean title can be
// generated instead.
function generateCanonicalTitle(eventType, identity = {}, evidence = []) {
  const subject = identity.subjectEntity || identity.location;
  const companyDisplay = identity.companyDisplay || identity.company || '';
  const templates = {
    NEW_LOCATION_OPENING: subject ? `${subject} Branch Opening` : null,
    LOCATION_REOPENING: subject ? `${subject} Branch Reopening` : null,
    RENOVATION_COMPLETION: subject ? `${subject} Renovation Completed` : null,
    FACILITY_EXPANSION: identity.location ? `${identity.location} Facility Expansion` : null,
    LEADERSHIP_APPOINTMENT: identity.subjectEntity ? `${identity.subjectEntity} Appointed${identity.role ? ` ${identity.role}` : ''}` : null,
    ACQUISITION: identity.subjectEntity ? `Acquisition of ${identity.subjectEntity}` : null,
    PRODUCT_LAUNCH: identity.subjectEntity ? `${identity.subjectEntity} Launch` : (companyDisplay ? `${companyDisplay} Product Launch` : null)
  };
  const generated = templates[eventType];
  if (generated) return { title: clean(generated), titleSource: 'generated' };

  const best = [...evidence].sort((a, b) => (b.authorityScore || 0) - (a.authorityScore || 0))[0];
  const fallback = best?.sourceTitle ? stripHeadlineNoise(best.sourceTitle) : `${companyDisplay || 'Company'} Business Activity`;
  return { title: clean(fallback), titleSource: 'fallback-source-title' };
}

function locationsAgree(a, b) {
  if (!a || !b) return false;
  const na = normalizeForMatch(a);
  const nb = normalizeForMatch(b);
  if (!na || !nb) return false;
  return na === nb || na.includes(nb) || nb.includes(na);
}

function dateWindowDays(eventType = '') {
  if (eventType === 'LEADERSHIP_APPOINTMENT') return 14;
  return 30;
}

function datesAgree(idA = {}, idB = {}, eventTypeForWindow = '') {
  if (idA.dateConfidence === 'unknown' || idB.dateConfidence === 'unknown') return false;
  if (!idA.eventDate || !idB.eventDate) return false;
  const da = parseDate(idA.eventDate);
  const db = parseDate(idB.eventDate);
  if (!da || !db) return false;
  const diffDays = Math.abs(da.getTime() - db.getTime()) / 86400000;
  return diffDays <= dateWindowDays(eventTypeForWindow);
}

function typesCompatible(candTypes = [], eventTypes = []) {
  return candTypes.some(t => eventTypes.includes(t));
}

// Resolves a batch of candidates (same shape clusterCandidates() consumes) into
// Business Events with attached Evidence — a same-run resolution only; nothing
// here persists or matches against prior runs. Returns a backward-compatible
// shape (see Sprint 4.5.1 plan §6) so it can later be swapped in wherever
// clusterCandidates() is called today without touching the callers' other logic.
function resolveEvents(candidates = []) {
  const events = [];

  for (const c of candidates) {
    if (!c) continue;
    const text = `${c.title || c.headline || ''} ${c.snippet || ''} ${c.rawContent || c.pageContent || ''}`;
    const family = c.signalFamily || classifySignalFamily(text, c.intendedSignalFamily);
    // Reuse an already-computed canonical type when the caller attached one
    // (research-batch.js's makeSignal() does this — see Phase 2A / B3 note
    // above RECURRING_EVENT_TYPES) instead of recomputing it here. This is
    // what makes "compute canonical event type once" an actual guarantee
    // rather than an assumption that two separate regex passes over
    // similar-but-not-identical text happen to agree. Any other caller
    // (e.g. api/weekly-scan.js, which does not set canonicalEventType) keeps
    // today's behavior unchanged: resolveEventType() computed fresh here.
    const typeInfo = c.canonicalEventType
      ? { primaryType: c.canonicalEventType, candidateTypes: [c.canonicalEventType], recurring: RECURRING_EVENT_TYPES.has(c.canonicalEventType) }
      : resolveEventType(text, family);
    const { subjectEntity, location, role } = extractEventEntities(c.title || c.headline || '', c.snippet || '', c.rawContent || c.pageContent || '');
    // Prefer the candidate's own structured event date (already resolved by
    // an upstream stage — e.g. research-batch.js's makeSignal() or a
    // previously-persisted opportunity's eventDate) over re-deriving one by
    // mining free text. Two representations of the same real-world event
    // routinely differ in prose (one restates "June 23, 2026" in a sentence,
    // another's snippet never mentions a date at all) even though both
    // objects already agree, structurally, on when the event happened. Text
    // mining is the correct fallback only when no structured date exists;
    // using it as the primary source discarded that agreement and was the
    // root cause of two representations of one event never satisfying
    // resolveEvents()'s "positive agreement" merge gate below.
    const structuredDate = parseDate(c.eventDate || c.event_date || '');
    const textDate = extractEventDate(text);
    const eventDate = structuredDate ? structuredDate.toISOString().slice(0, 10) : textDate.eventDate;
    const dateConfidence = structuredDate ? 'exact' : textDate.dateConfidence;
    const dateYear = structuredDate ? structuredDate.getUTCFullYear() : textDate.year;
    const companyDisplay = clean(c.companyName || c.accountName || '');
    const company = normalizeCompany(companyDisplay);
    const year = dateYear || extractYearFallback(text, c.publishedAt);

    const candidateIdentity = {
      company, companyDisplay,
      candidateTypes: typeInfo.candidateTypes,
      recurring: typeInfo.recurring,
      subjectEntity, location, role,
      eventDate, dateConfidence, year
    };

    const evidenceItem = {
      sourceTitle: clean(c.title || c.headline || '') || null,
      sourceName: clean(c.sourceName || sourceDomain(c.url) || 'Public source'),
      url: clean(c.url || ''),
      publishedDate: clean(c.publishedAt || c.publicationDate || '') || null,
      discoveredDate: clean(c.discoveredAt || new Date().toISOString()),
      excerpt: clean(text).slice(0, 220),
      authorityScore: c.sourceAuthorityScore ?? sourceAuthority(c.url, c.title || c.headline),
      corroboration: 'unknown'
    };

    let matched = null;
    for (const ev of events) {
      const id = ev.identity;
      if (id.company !== company || !company) continue;
      if (!typesCompatible(candidateIdentity.candidateTypes, id.candidateTypes)) continue;

      if (RECURRING_EVENT_TYPES.has(id.candidateTypes[0]) || candidateIdentity.recurring) {
        if (!id.year || !candidateIdentity.year || id.year !== candidateIdentity.year) continue;
      }

      const locAgree = locationsAgree(id.location || id.subjectEntity, candidateIdentity.location || candidateIdentity.subjectEntity);
      const dateAgree = datesAgree(id, candidateIdentity, id.candidateTypes[0]);
      if (!locAgree && !dateAgree) continue; // positive-agreement requirement — absence of conflict is not agreement

      if (id.location && candidateIdentity.location && !locationsAgree(id.location, candidateIdentity.location) && !dateAgree) continue; // explicit-mismatch veto

      matched = ev;
      break;
    }

    if (matched) {
      evidenceItem.corroboration = classifyCorroboration(evidenceItem, matched.evidence);
      matched.evidence.push(evidenceItem);
      matched.identity.candidateTypes = matched.identity.candidateTypes.filter(t => candidateIdentity.candidateTypes.includes(t));
      if (!matched.identity.location && candidateIdentity.location) matched.identity.location = candidateIdentity.location;
      if (!matched.identity.subjectEntity && candidateIdentity.subjectEntity) matched.identity.subjectEntity = candidateIdentity.subjectEntity;
      if (!matched.identity.role && candidateIdentity.role) matched.identity.role = candidateIdentity.role;
      if (matched.identity.dateConfidence === 'unknown' && candidateIdentity.dateConfidence !== 'unknown') {
        matched.identity.eventDate = candidateIdentity.eventDate;
        matched.identity.dateConfidence = candidateIdentity.dateConfidence;
        matched.identity.year = candidateIdentity.year;
      }
      matched.candidates.push(c);
    } else {
      evidenceItem.corroboration = 'independent';
      events.push({ identity: candidateIdentity, evidence: [evidenceItem], candidates: [c] });
    }
  }

  return events.map(ev => {
    const primaryType = ev.identity.candidateTypes[0] || 'BUSINESS_ACTIVITY_UNKNOWN';
    const { title, titleSource } = generateCanonicalTitle(primaryType, ev.identity, ev.evidence);
    const bestEvidence = [...ev.evidence].sort((a, b) => (b.authorityScore || 0) - (a.authorityScore || 0))[0];
    const primaryCandidate = [...ev.candidates].sort((a, b) => (b.candidateScore || 0) - (a.candidateScore || 0))[0] || {};

    const eventIdentity = {
      company: ev.identity.companyDisplay || ev.identity.company,
      eventType: primaryType,
      candidateTypes: ev.identity.candidateTypes,
      subjectEntity: ev.identity.subjectEntity,
      location: ev.identity.location,
      eventDate: ev.identity.eventDate,
      dateConfidence: ev.identity.dateConfidence,
      canonicalTitle: title,
      titleSource
    };

    const flatSources = ev.evidence.map(e => ({ name: e.sourceName, url: e.url, publishedAt: e.publishedDate || '' }));
    const fingerprint = `${ev.identity.company}|${primaryType}|${normalizeForMatch(ev.identity.location || ev.identity.subjectEntity || '')}|${ev.identity.year || 'unknown'}`;

    return {
      ...primaryCandidate,
      title: primaryCandidate.title || primaryCandidate.headline || title,
      headline: primaryCandidate.headline || primaryCandidate.title || title,
      url: bestEvidence?.url || primaryCandidate.url,
      sourceName: bestEvidence?.sourceName || primaryCandidate.sourceName,
      publishedAt: bestEvidence?.publishedDate || primaryCandidate.publishedAt || '',
      eventFingerprint: fingerprint,
      corroboratingCandidates: ev.evidence.length,
      sources: flatSources,
      canonicalTitle: title,
      eventIdentity,
      evidence: ev.evidence
    };
  }).sort((a, b) => (b.corroboratingCandidates || 0) - (a.corroboratingCandidates || 0));
}

// ---------------------------------------------------------------------------
// Priority 0 — global event-resolution boundary for persistence.
// resolveEvents() above already matches the same real-world event across
// different title phrasing (via eventType + location/date agreement, not
// literal token overlap). resolveOpportunityEvents() is the same engine
// adapted to the *normalized opportunity* shape (headline/whatChanged/
// sourceUrl) that research-batch.js produces, so callers merging results
// from multiple chunks/generators/persistence attempts can run ONE
// resolution pass across the full combined set right before writing to the
// database. This is intentionally the only place that changes the
// persisted event_fingerprint; normalizeOpportunity()'s own eventFingerprint
// (legacy, per-title-token) is left untouched for intra-request plumbing
// (e.g. matching an opportunity back to its source candidate).
// ---------------------------------------------------------------------------
function resolveOpportunityEvents(opportunities = []) {
  const candidates = (opportunities || []).filter(Boolean).map(o => ({
    ...o,
    title: o.headline || o.signalTitle || '',
    snippet: o.whatChanged || o.businessContext || '',
    url: o.sourceUrl || (Array.isArray(o.sources) && o.sources[0]?.url) || '',
    candidateScore: Number(o.commercialScore || o.whyNowScore || o.why_now_score || o.confidenceScore || 0)
  }));
  return resolveEvents(candidates).map(ev => ({
    ...ev,
    headline: ev.headline || ev.title,
    signalTitle: ev.signalTitle || ev.headline || ev.title,
    sourceUrl: ev.sourceUrl || ev.url
  }));
}

// Generic last-line-of-defense dedup for anything carrying an eventFingerprint
// (or event_fingerprint, the persisted column name) — keeps the highest-scoring
// item per key. Used to deduplicate in-memory immediately before a bulk insert,
// so the database's uniqueness constraint is a safety net, not the only guard.
function dedupeByEventFingerprint(items = [], options = {}) {
  const keyOf = options.keyOf || ((x) => x.eventFingerprint || x.event_fingerprint || '');
  const scoreOf = options.scoreOf || ((x) => Number(x.confidence ?? x.commercialScore ?? x.whyNowScore ?? x.confidenceScore ?? 0));
  const best = new Map();
  for (const item of items || []) {
    if (!item) continue;
    const key = keyOf(item);
    if (!key) continue;
    const existing = best.get(key);
    if (!existing || scoreOf(item) > scoreOf(existing)) best.set(key, item);
  }
  return [...best.values()];
}

export {
  SIGNAL_FAMILIES, clean, normalizeCompany, normalizeUrl, normalizeTitle, sourceDomain,
  classifySignalFamily, signalSubtype, displaySignalType, sourceAuthority, freshnessScore,
  entityMatch, verifyCandidateCompanyGrounding, hasDistinctiveNameFallbackMatch, distinctiveCompanyTokens,
  eventFingerprint, commercialScore, normalizeCandidate, clusterCandidates,
  normalizeOpportunity, validateOpportunity, dedupeOpportunities, buildQueryPlan, materiallyRepeats,
  RECURRING_EVENT_TYPES, resolveEventType, extractEventEntities, extractEventDate,
  findPublicationContextDate,
  classifyCorroboration, generateCanonicalTitle, resolveEvents,
  resolveOpportunityEvents, dedupeByEventFingerprint,
  EVENT_TYPE_DISPLAY_LABELS, displayLabelForEventType
};
