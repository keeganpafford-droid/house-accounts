// Shared deterministic signal-intelligence helpers.
// This module intentionally performs normalization, verification, classification,
// freshness/source scoring, and event clustering before/after AI enrichment.

const SIGNAL_FAMILIES = {
  growth: { label: 'Growth / Expansion', halfLifeDays: 240, weight: 88 },
  hiring: { label: 'Hiring / Workforce', halfLifeDays: 60, weight: 72 },
  leadership: { label: 'Leadership / Relationship', halfLifeDays: 75, weight: 68 },
  product: { label: 'Product / Service', halfLifeDays: 120, weight: 82 },
  events: { label: 'Events / Marketing', halfLifeDays: 60, weight: 86 },
  community: { label: 'Community / CSR', halfLifeDays: 75, weight: 64 },
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
  if (/trade show|tradeshow|conference|expo|summit|webinar|open house|customer event|dealer meeting|sales meeting|booth|exhibitor|grand opening event/.test(text)) return 'events';
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
    ['Webinar', /webinar/], ['Product Launch', /product launch|launches|launched|unveil/], ['Executive Appointment', /appoint|named ceo|named president|joins as/],
    ['Promotion', /promot/], ['Hiring Initiative', /hiring initiative|workforce growth|recruiting campaign|now hiring/],
    ['Company Anniversary', /anniversary/], ['Safety Milestone', /safety milestone|years without|lost-time/], ['Award / Recognition', /award|recognition|winner/],
    ['Community Event', /community event|golf tournament|5k|fundraiser|charity event/], ['Sponsorship', /sponsor/], ['Rebrand', /rebrand|brand identity|new logo/]
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
    signalType: displaySignalType(family, subtype),
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
    ['events', `${q} (conference OR "trade show" OR expo OR webinar OR summit OR "open house" OR "customer event")`],
    ['product', `${q} (launches OR launched OR "new product" OR "new service" OR campaign)`],
    ['hiring', `${q} (hiring OR recruiting OR workforce OR careers OR onboarding)`],
    ['leadership', `${q} (appointed OR promoted OR "joins as" OR "new vice president" OR "new director")`],
    ['award', `${q} (award OR recognition OR anniversary OR milestone OR "safety milestone")`],
    ['community', `${q} (sponsor OR charity OR fundraiser OR volunteer OR "golf tournament" OR community)`],
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

export {
  SIGNAL_FAMILIES, clean, normalizeCompany, normalizeUrl, normalizeTitle, sourceDomain,
  classifySignalFamily, signalSubtype, displaySignalType, sourceAuthority, freshnessScore,
  entityMatch, eventFingerprint, commercialScore, normalizeCandidate, clusterCandidates,
  normalizeOpportunity, validateOpportunity, dedupeOpportunities, buildQueryPlan, materiallyRepeats
};
