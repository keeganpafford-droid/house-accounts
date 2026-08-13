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

function truncateText(value = '', maxLength = 300) {
  const c = clean(value);
  return c.length > maxLength ? `${c.slice(0, maxLength - 1).trim()}…` : c;
}

// Identity-collision-hardening correction: a plain apostrophe collapse
// (the general non-alnum-to-space rule below) turns a possessive company
// name like "Wyman's" into a TWO-token "wyman s" -- a floating, disconnected
// "s" that can then coincidentally re-attach to any OTHER text ending in
// "wyman" + possessive grammar ("...celebrate a milestone for Oliver
// Wyman's presence...") or even an unrelated "wyman s..." phrase entirely.
// Stripping a genuine possessive 's/'s suffix BEFORE the general
// punctuation collapse keeps "Wyman's" as the single, clean token "wyman"
// it actually names -- required for isSingleTokenCompanyIdentity() below to
// correctly recognize it as the single-token identity it is (the two-token
// "wyman s" would otherwise look like a safer, more distinctive multi-word
// phrase than it really is).
function normalizeCompany(value = '') {
  return clean(value).toLowerCase()
    .replace(/['’]s\b/g, '')
    .replace(/\b(incorporated|inc|llc|ltd|limited|corp|corporation|co|company|holdings?)\b\.?/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}

// Identity-collision-hardening correction: a company's own name being just
// ONE token after normalization (e.g. "Wyman's" -> "wyman", "Timberland" ->
// "timberland") is the actual risk signal for a bare-text-match false
// positive -- not raw character length. A single common word/surname/
// category term can trivially appear inside completely unrelated text (an
// ordinary English sentence, a DIFFERENT company's name that happens to
// share the same word/surname, a place name) in a way a genuine multi-word
// phrase almost never does by coincidence ("Northfield Instruments" as a
// literal three-word run is a real claim; "wyman" or "timberland" as a bare
// single word is not). Deliberately checks TOKEN COUNT, not string length --
// a short-but-multi-word name ("ACI Corp" -> "aci") and a long-but-single-
// word name are judged on the same, single, structural property.
function isSingleTokenCompanyIdentity(name = '') {
  const normalized = normalizeCompany(name);
  if (!normalized) return false;
  return normalized.split(' ').filter(Boolean).length === 1;
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

// Founder QA follow-up (Dover Holiday Parade false-negative): a third-party
// publisher's domain can itself carry real geographic identity independent
// of anything the article says (dovernh.org covering a Dover, NH event) --
// but a city name ALONE is deliberately not treated as sufficient. Two
// reasons: (1) for a franchise/dealer-style ambiguous name ("Dover Honda"),
// the city name is already baked into the company name itself, so a loose
// "does the account's city appear anywhere" check would be satisfied by a
// wrong-company source exactly as easily as the right one -- the same trap
// a bare name match already is. (2) even scoped to the PUBLISHER'S DOMAIN
// rather than the article text, a bare city name in a domain is still
// judged too weak on its own for this conservative beta (policy: false
// negative > false attribution) -- CITY+STATE together in the domain is
// required. Only fires when the account record has both parseable ("City,
// ST" -- the same format hasLocationContradiction() already requires); an
// account on file with just a city, or a non-comma-formatted location, does
// not get this corroborator at all rather than falling back to a looser
// check.
//
// Deliberately narrow/deterministic (no geocoding, no state-name spellout
// table): checks for the normalized city+state concatenated with no
// separator ("dovernh") and with a hyphen ("dover-nh") -- the two cheapest,
// most common domain-naming conventions. A publisher that encodes its
// region a different way (spelled-out state name, abbreviation-first, a
// municipal .gov TLD with no text encoding at all) will not match; that is
// an accepted recall gap, not a correctness gap, consistent with the
// conservative policy above -- see the accompanying Return report's
// "optional inspection" note for a documented, deliberately-deferred
// stronger recall improvement (recognizing a location mention that occurs
// independently of the company-name span in the article text itself).
function accountCityStateGeoTokens(account = {}) {
  const accountLocationText = clean(account.location || account.cityState || '');
  const pair = accountLocationText.match(new RegExp(`\\b${CITY_STATE_PATTERN}\\b`));
  if (!pair) return null;
  const city = normalizeForMatch(pair[1]).replace(/\s+/g, '');
  const state = normalizeForMatch(pair[2]).replace(/\s+/g, '');
  if (city.length < 3 || !state) return null;
  return [`${city}${state}`, `${city}-${state}`];
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
  const geoTokens = accountCityStateGeoTokens(account);
  if (geoTokens && candidateDomain && geoTokens.some(t => candidateDomain.includes(t))) { score += 20; reasons.push('publisher domain matches account city+state geography'); }
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

// Trust correction (entity-disambiguation): a same-name/near-same-name
// business is not sufficient entity grounding when multiple real companies
// can share that name (dealerships, franchises, healthcare practices, banks,
// restaurants, regional companies). entityMatch()'s bare full-phrase name
// match (58 points, already enough to clear the old boolean gate on its own)
// is necessary but no longer sufficient by itself -- these helpers add an
// INDEPENDENT-corroboration requirement and a positive-contradiction veto,
// without touching entityMatch()'s own scoring (still reused unmodified;
// other callers of entityMatch()/its score, e.g. commercialScore(), are
// unaffected).
const SOCIAL_URL_RE = /linkedin\.com|facebook\.com|instagram\.com|x\.com|twitter\.com/i;

function isSocialUrl(url = '') {
  return SOCIAL_URL_RE.test(url || '');
}

// Extracts the profile/page handle from a social URL's first path segment
// (e.g. instagram.com/dover_honda -> "dover honda"). Used only to ask "does
// this look like the account's OWN profile," never to identify a third-party
// business by name -- so no hardcoded business list is needed.
function socialHandleFromUrl(url = '') {
  try {
    const u = new URL(url);
    if (!SOCIAL_URL_RE.test(u.hostname)) return '';
    const segment = u.pathname.split('/').filter(Boolean)[0] || '';
    return clean(segment.replace(/[._-]+/g, ' '));
  } catch { return ''; }
}

// Founder QA follow-up: an INFERRED handle match (the profile's URL text
// merely resembles the company name) is NOT independent identity evidence --
// for an ambiguous name, a same-name-but-wrong-company profile ("@doverhonda"
// belonging to a different real Dover Honda) satisfies this exactly as
// easily as the real one does. This distinguishes it from a KNOWN official
// profile: one House Accounts already holds on file for this specific
// account (account.knownSocialProfiles -- no current caller populates this
// yet, but the primitive exists so a future contact/account-enrichment field
// can plug in without another grounding change). Only a known-profile match
// counts as an independent corroborator; an inferred one is downgraded to a
// same-tier signal as the bare name match itself -- real, but not sufficient
// alone -- see verifyCandidateCompanyGrounding() below.
function accountKnownSocialProfileMatch(account = {}, url = '') {
  const known = Array.isArray(account.knownSocialProfiles) ? account.knownSocialProfiles : [];
  if (!known.length || !url) return false;
  const candidateNormalizedUrl = normalizeUrl(url);
  const candidateHandle = normalizeCompany(socialHandleFromUrl(url)).replace(/\s+/g, '');
  return known.some(entry => {
    const raw = String(entry || '');
    if (!raw) return false;
    if (normalizeUrl(raw) === candidateNormalizedUrl) return true;
    const knownHandle = normalizeCompany(socialHandleFromUrl(raw) || raw).replace(/\s+/g, '');
    return Boolean(knownHandle) && knownHandle === candidateHandle;
  });
}

function socialProfileMatchesCompany(companyName = '', url = '') {
  const handle = normalizeCompany(socialHandleFromUrl(url)).replace(/\s+/g, '');
  const company = normalizeCompany(companyName).replace(/\s+/g, '');
  if (!handle || !company) return false;
  return handle.includes(company) || company.includes(handle);
}

// Identity-collision-hardening follow-up: the single-token downgrade in
// verifyCandidateCompanyGrounding() below sends a collision-prone account
// (e.g. "Unitil") to 'possible' unless independently corroborated -- but
// every corroborator that existed at the time (verified company domain,
// location match, known social profile) required the founder to have
// UPLOADED that metadata. A single-token company legitimately sourced from
// its own obvious first-party domain (confirmed production shape: "Unitil"
// with no uploaded website, evidence hosted on unitil.com) had no way to
// ever clear 'possible', even though the domain itself already IS the
// identity evidence. This adds a SECOND, independent way to reach domain
// corroboration -- comparing the candidate's own registrable-domain SLD
// against the account's name directly, never requiring an uploaded
// website. Deliberately EXACT SLD-equals-normalized-token only -- no
// substring/contains/fuzzy matching, and only for single-token identities
// (a multi-word company already reaches 'unconfirmed', not 'possible', on
// a bare match alone, so it needs no domain rescue here). "unitil.com" ->
// SLD "unitil" === normalizeCompany("Unitil") -> corroborated.
// "timberlandpartners.com" -> SLD "timberlandpartners" !== "timberland" ->
// never corroborated -- a different real company whose domain merely
// CONTAINS the account's token must not be rescued by this check, or the
// exact Timberland collision this whole correction targets would reopen.
// Purely additive: a legitimate signal from a credible THIRD-PARTY source
// (regulator, wire service, trade press) that isn't the company's own
// domain is completely unaffected by this function -- it simply doesn't
// gain this particular corroborator, and can still reach 'possible'
// (visible, flagged) or 'confirmed'/'unconfirmed' via any other existing
// path exactly as before.
function registrableDomainSld(url = '') {
  const host = sourceDomain(url);
  if (!host) return '';
  const labels = host.split('.').filter(Boolean);
  if (labels.length < 2) return '';
  return labels[labels.length - 2].toLowerCase();
}
function isExactSelfDomainMatch(companyName = '', url = '') {
  if (!isSingleTokenCompanyIdentity(companyName)) return false;
  const company = normalizeCompany(companyName).replace(/\s+/g, '');
  const sld = registrableDomainSld(url);
  return Boolean(company) && company === sld;
}

// Final bounded Beta trust correction: analogous to isExactSelfDomainMatch()
// above, but for a social profile's own handle instead of a domain's
// registrable SLD. Legitimate third-party/social evidence (e.g. an
// Instagram post explicitly tagging @llbean) should not require a
// pre-populated account.knownSocialProfiles list (see
// accountKnownSocialProfileMatch()'s own comment -- no current caller
// populates it) when the account's own name, compacted, exactly equals the
// profile's own handle: the profile is speaking for itself, the same
// reasoning isExactSelfDomainMatch() already applies to a namesake domain.
// Deliberately NOT restricted to single-token company names (unlike the
// domain check): a social handle is near-universally the compacted form of
// a brand's FULL name regardless of word count ("L.L.Bean" -> "@llbean"),
// unlike a domain SLD, which is far less commonly an exact compacted match
// for a multi-word name -- that asymmetry is why isExactSelfDomainMatch()
// itself stays single-token-only while this one does not. Deliberately
// EXACT compacted-string equality only -- no substring/contains/fuzzy/
// prefix/suffix matching, mirroring isExactSelfDomainMatch()'s own
// discipline exactly. Purely additive: this is one MORE way to reach
// corroboration, never a requirement -- every existing legitimate
// non-social signal source (news, trade press, government, partner sites,
// etc.) is completely unaffected, and social evidence with no exact handle
// match still reaches whatever grade it would have reached before this
// function existed.
function isExactSelfSocialHandleMatch(companyName = '', url = '') {
  if (!isSocialUrl(url)) return false;
  const handle = normalizeCompany(socialHandleFromUrl(url)).replace(/\s+/g, '');
  const company = normalizeCompany(companyName).replace(/\s+/g, '');
  return Boolean(company) && Boolean(handle) && company === handle;
}

// ---------------------------------------------------------------------------
// Identity-grounding correction (round: embedded-entity precision + one-word
// third-party recall). ONE bounded, deterministic, contextual-adjacency
// primitive drives both directions below. Deliberately scoped to
// candidate.snippet ONLY -- never title (commonly Title-Case for every word,
// which would make "is the next word capitalized" meaningless) and never
// rawContent/pageContent (full-page noise, already excluded from identity
// checks elsewhere in this module for the same reason -- see
// verifyCandidateCompanyGrounding()'s own header comment on scoping).
//
// Reproduced production case (precision): an "Albany International" account
// bare-matched evidence about "Albany International Airport" -- the account's
// full multi-word phrase is a literal substring of a DIFFERENT, larger named
// entity. entityMatch()'s plain substring check has no way to see that; the
// existing single-token downgrade (isSingleTokenCompanyIdentity) never
// applies here since "Albany International" is two tokens.
//
// Reproduced production case (recall): a "Cianbro" account (single-token)
// with explicit, unambiguous third-party evidence ("Mark Brooks represented
// Cianbro at the Maine CTE Business Summit") graded 'possible' purely because
// no independent domain/location/social corroborator existed -- too
// conservative once the evidence itself already makes clear which company is
// meant.
function companyNameMatchRegex(companyName = '') {
  const tokens = normalizeCompany(companyName).split(' ').filter(Boolean);
  if (!tokens.length) return null;
  const escaped = tokens.map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp(`\\b${escaped.join('[^a-zA-Z0-9]+')}\\b`, 'gi');
}

// The word immediately adjacent to a match, ONLY when separated by plain
// whitespace -- a comma/period/other punctuation between the match and a
// neighboring word is a genuine phrase/sentence boundary and must never be
// treated as an extension (e.g. "...Group. Officials said..." -- "Officials"
// is the start of a new sentence, not a continuation of "Group").
function wordImmediatelyBefore(text, index) {
  const m = text.slice(0, index).match(/([A-Za-z0-9][A-Za-z0-9'-]*)\s+$/);
  return m ? m[1] : '';
}
function wordImmediatelyAfter(text, index) {
  const m = text.slice(index).match(/^\s+([A-Za-z0-9][A-Za-z0-9'-]*)/);
  return m ? m[1] : '';
}

function eachCompanyMatchNeighbors(companyName, text) {
  const re = companyNameMatchRegex(companyName);
  const t = String(text || '');
  if (!re || !t) return [];
  const results = [];
  let m;
  while ((m = re.exec(t))) {
    results.push({
      matchedText: m[0],
      index: m.index,
      before: wordImmediatelyBefore(t, m.index),
      after: wordImmediatelyAfter(t, m.index + m[0].length)
    });
    if (m.index === re.lastIndex) re.lastIndex += 1; // defensive: \b...\b matches are never zero-length here, but never loop forever if that ever changes
  }
  return results;
}

// Identity-grounding correction (round: same-sentence/local-clause
// tightening). The smallest unit of "local context" around a match --
// bounded by the nearest sentence-ending punctuation (.!?) OR a structural
// list/breadcrumb/table delimiter (newline, ">", "|", a bullet, ";") on
// either side, whichever is closer. Deliberately includes the structural
// delimiters, not just sentence punctuation: a roster/schedule/breadcrumb
// page ("ABC Convention > Past Events > 2026 > Schedule" followed by a
// dash- or newline-separated list of past exhibitor names) rarely uses
// periods at all, so bounding on sentence punctuation alone would let the
// "local clause" balloon out to the whole page -- exactly the false-
// positive shape this correction exists to close.
const LOCAL_CLAUSE_BOUNDARY = /[.!?\n>|•·]/;
function localClauseAroundMatch(text, index, matchLength) {
  const before = text.slice(0, index);
  const after = text.slice(index + matchLength);
  let start = 0;
  for (let i = before.length - 1; i >= 0; i--) {
    if (LOCAL_CLAUSE_BOUNDARY.test(before[i])) { start = i + 1; break; }
  }
  let end = text.length;
  for (let i = 0; i < after.length; i++) {
    if (LOCAL_CLAUSE_BOUNDARY.test(after[i])) { end = index + matchLength + i; break; }
  }
  return text.slice(start, end).trim();
}

function isCapitalizedWord(word = '') {
  return /^[A-Z]/.test(word || '');
}

// A neighboring word that is one of the company's OWN generic legal-suffix
// continuations (reuses GENERIC_COMPANY_WORDS and normalizeCompany()'s own
// suffix-stripping vocabulary -- no new list) is never treated as evidence
// of a DIFFERENT, larger entity -- "Cianbro Corporation" is still just
// Cianbro speaking about itself, not a Cianbro-Corporation-shaped collision.
const COMPANY_SUFFIX_WORDS = new Set(['incorporated', 'inc', 'llc', 'ltd', 'limited', 'corp', 'corporation', 'co', 'company', 'holding', 'holdings']);
function isGenericContinuationWord(word = '') {
  const normalized = String(word || '').toLowerCase().replace(/\.$/, '');
  return GENERIC_COMPANY_WORDS.has(normalized) || COMPANY_SUFFIX_WORDS.has(normalized);
}

// Precision fix (Albany International / Airport shape): a MULTI-WORD bare
// match is "embedded" when EVERY occurrence of the company's phrase in the
// snippet is immediately adjacent (before or after) to another capitalized,
// non-generic-suffix word -- i.e. no occurrence stands on its own. Requiring
// EVERY occurrence (not just one) means a snippet that mentions the company
// BOTH embedded ("...near Albany International Airport...") AND standalone
// ("Albany International announced...") is correctly left alone -- a real
// standalone self-mention exists, so this is not treated as a collision.
function isEntityEmbeddedInLargerName(companyName, snippet = '') {
  const occurrences = eachCompanyMatchNeighbors(companyName, snippet);
  if (!occurrences.length) return false;
  return occurrences.every(({ before, after }) => {
    const extendedAfter = isCapitalizedWord(after) && !isGenericContinuationWord(after);
    const extendedBefore = isCapitalizedWord(before) && !isGenericContinuationWord(before);
    return extendedAfter || extendedBefore;
  });
}

// Recall fix (Cianbro shape): a single-token bare match with no independent
// corroborator may still be trusted as a legitimate (uncorroborated,
// 'unconfirmed') reference when the evidence contains a genuine STANDALONE
// capitalized mention of the token, GRAMMATICALLY ATTACHED to a real local
// clause, AND that same local clause independently classifies into a
// recognized business-activity family.
//
// Capitalization + isolation ALONE is not sufficient -- two failure shapes
// both pass an isolation-only check identically to a genuine standalone
// company mention ("Cianbro received the Safety Award."):
//   1. a sentence-initial common-noun coincidence ("Timberland covers
//      thousands of acres.") -- neither has an adjacent capitalized
//      neighbor. Excluded by the classifySignalFamily() requirement below,
//      scoped to the LOCAL clause (see localClauseAroundMatch()'s own
//      comment) -- "covers thousands of acres" names no business-activity
//      family.
//   2. bare roster/directory/breadcrumb membership ("ABC Convention > Past
//      Events > 2026 > Schedule" followed by the company appearing only as
//      one dash- or comma-separated entry in a list of many) -- the page
//      can be saturated with genuine event vocabulary ELSEWHERE while the
//      company's own occurrence has no claim attached to it at all.
//      Excluded by the grammatical-neighbor requirement below: a real
//      sentence always joins the company mention to an adjacent lowercase
//      word (a verb, preposition, or article) by plain whitespace, exactly
//      like wordImmediatelyBefore()/After() already capture; a roster
//      entry's neighbors are structural delimiters (dashes, pipes, commas,
//      ">"), which those two helpers already treat as a hard boundary and
//      report as no word at all.
//
// Deliberately STRICTER than isEntityEmbeddedInLargerName() above: NO
// generic-suffix exemption here. "Timberland Partners announced..." must
// stay a Possible Match for a "Timberland"-named account -- "Partners" is a
// real, distinguishing word in a DIFFERENT company's actual name, not
// necessarily Timberland's own suffix, and this promotion path must never
// risk manufacturing a false Business Signal out of that ambiguity.
function isStandaloneSingleTokenMention(companyName, snippet = '') {
  if (!isSingleTokenCompanyIdentity(companyName)) return false;
  const text = String(snippet || '');
  const occurrences = eachCompanyMatchNeighbors(companyName, text);
  return occurrences.some(({ matchedText, before, after, index }) => {
    if (!isCapitalizedWord(matchedText)) return false;
    if (isCapitalizedWord(before) || isCapitalizedWord(after)) return false;
    if (!before && !after) return false;
    const localClause = localClauseAroundMatch(text, index, matchedText.length);
    return classifySignalFamily(localClause) !== 'unknown';
  });
}

// Finds every explicit "City, ST" mention in text. A fresh RegExp is built
// per call (see CITY_STATE_PATTERN comment) so repeated calls never share
// exec()/matchAll() lastIndex state.
function extractCityStatePairs(text = '') {
  const matches = [...clean(text).matchAll(new RegExp(`\\b${CITY_STATE_PATTERN}\\b`, 'g'))];
  return matches.map(m => ({ city: m[1], state: m[2].toUpperCase() }));
}

// Live-diagnosis round 5: a real iclautos.com numbered dealership directory
// puts the address TWO lines after the account's own line, not on it --
// "09. **Dover Honda**" / "1 Dover Point Rd" / "Dover,NH03820" / "- Sales:
// (603) 242-1129" / "10. **International Cars**". Bare same-line
// association (the previous rule) never had a chance against this real
// shape. This widens association from "the account's own line" to "the
// account's own line PLUS its own numbered-entry block," using the exact,
// generic structural signal the live markup itself provides -- a leading
// "N. " / "N) " enumerator -- rather than a character-count radius or any
// hardcoded company name. A line that is NOT itself a numbered entry (any
// other page shape -- prose, a bare "Name -- City, ST" line, etc.) gets NO
// lookahead at all and keeps the exact previous same-line-only behavior.
const LIST_ENTRY_BOUNDARY_RE = /^\d{1,3}[.)]\s/;
// Safety bound only -- normal termination is hitting the next numbered
// entry (LIST_ENTRY_BOUNDARY_RE), which the real fixture hits after 3
// lines. This just prevents an unbounded scan if a numbered list is
// malformed or never resumes; it is not the primary stop condition and is
// far short of "arbitrarily forward through the page."
const ACCOUNT_BLOCK_MAX_LOOKAHEAD_LINES = 8;

// Returns the bounded set of lines that belong to ONE occurrence's own
// account block, given the (already clean()'d, newline-split) `segments`
// and the index of a line naming the account. Shared by
// deriveAccountLocationFromContent() and diagnoseAccountLocationExtraction()
// so the two can never disagree about what a "block" is.
function accountBlockLines(segments, idx) {
  if (!LIST_ENTRY_BOUNDARY_RE.test(segments[idx])) return [segments[idx]];
  const block = [segments[idx]];
  for (let j = idx + 1; j < segments.length && block.length <= ACCOUNT_BLOCK_MAX_LOOKAHEAD_LINES; j++) {
    if (LIST_ENTRY_BOUNDARY_RE.test(segments[j])) break; // next entry starts -- never cross into it
    block.push(segments[j]);
  }
  return block;
}

// Distinct City/ST pairs found within one occurrence's block. Each block
// line is checked INDIVIDUALLY (never joined into one string first) so a
// trailing word from one line (e.g. "...Point Rd") can never fuse with the
// start of the next line's own city name inside the shared capture group --
// this is exactly the same per-line scanning the original same-line rule
// already used, just applied across the block's own lines instead of one.
function accountBlockCityStatePairs(segments, idx) {
  const block = accountBlockLines(segments, idx);
  const pairs = [];
  for (const line of block) pairs.push(...extractCityStatePairs(line));
  return { block, distinct: [...new Map(pairs.map(p => [`${normalizeForMatch(p.city)}|${p.state}`, p])).values()] };
}

// Ephemeral identity-bootstrap: derives an account's city/state from real
// fetched content (e.g. a trusted-domain page), but ONLY when the location
// is genuinely ASSOCIATED with a specific mention of the account -- never
// merely co-present on the same page. A dealer-group/network locations page
// can list many companies and many addresses (the founder's own example:
// "Dover Honda -- Dover, NH" / "Portsmouth Ford -- Portsmouth, NH" on
// adjacent lines, or a real numbered directory with the address a couple of
// lines below the name); finding the account name anywhere and then
// matching ANY City/ST anywhere on the page would just as easily attach an
// unrelated dealership's address to the target account.
//
// Deterministic association rule, chosen for the format real directory/
// listing content actually takes rather than an arbitrary character window
// (which would incorrectly span into an adjacent, unrelated line): split
// the content into lines, then for each line that names the account (bare,
// case-insensitive phrase match -- the same standard entityMatch()'s
// "company named in source" bare check uses), extract City/ST pairs from
// that occurrence's own BLOCK (see accountBlockLines()/
// accountBlockCityStatePairs() above -- same line only, unless the line is
// itself a numbered directory entry, in which case the block extends
// through the immediately following lines up to, but never including, the
// next numbered entry):
//   - exactly one distinct pair in the block -> this occurrence's location.
//   - zero pairs -> this occurrence contributes nothing (not an error).
//   - more than one distinct pair in the block -> ambiguous; this
//     occurrence contributes nothing rather than guessing which one.
// Across every occurrence that contributed a location, they must all agree
// on the exact same city+state -- any disagreement derives nothing at all,
// per the explicit invariant that conflicting evidence must never be
// resolved by picking one arbitrarily.
function deriveAccountLocationFromContent(companyName = '', content = '') {
  const company = clean(companyName).toLowerCase();
  const rawContent = String(content || '');
  if (!company || !rawContent.trim()) return null;
  // Split on the RAW newlines first -- clean() collapses all whitespace
  // (including \n) into single spaces, which would merge every dealership's
  // entry onto one line before this function ever got a chance to isolate
  // them, destroying the exact line-boundary signal this rule depends on.
  // Each individual line is cleaned only after the split, never before it.
  const lines = rawContent.split(/\r?\n+/).map(line => clean(line)).filter(Boolean);
  // Single-blob fallback: content with no line breaks at all (some Firecrawl
  // extractions collapse everything to one line) is treated as one line --
  // the same-line ambiguity rule below still protects against picking an
  // arbitrary wrong pair if more than one appears together with the name.
  const segments = lines.length ? lines : [clean(rawContent)];
  const candidateLocations = [];
  for (let idx = 0; idx < segments.length; idx++) {
    if (!segments[idx].toLowerCase().includes(company)) continue;
    const { distinct } = accountBlockCityStatePairs(segments, idx);
    if (distinct.length === 1) candidateLocations.push(distinct[0]);
    // distinct.length === 0 -> no contribution; > 1 -> ambiguous block, skip.
  }
  if (!candidateLocations.length) return null;
  const uniqueLocations = [...new Map(candidateLocations.map(p => [`${normalizeForMatch(p.city)}|${p.state}`, p])).values()];
  if (uniqueLocations.length !== 1) return null; // conflicting occurrences -- derive nothing
  const { city, state } = uniqueLocations[0];
  return `${city}, ${state}`;
}

// Founder QA follow-up (identity-bootstrap live-diagnosis, round 3): a live
// Dover Honda run found, discovered, and Firecrawl-enriched three real
// iclautos.com pages, but deriveAccountLocationFromContent() derived nothing
// from any of them -- and a bounded first-500-char raw-content sample was
// not enough to tell WHY (the account name and any City/ST pattern could be
// anywhere in a multi-KB scraped page, not necessarily near the start).
// Read-only mirror of deriveAccountLocationFromContent()'s own line-split/
// same-line-association rule above -- identical regex, identical clean()
// sequencing -- so its outcome can never disagree with what that function
// actually did. Exists purely to expose the real evidence a human can
// read (which lines named the account, what City/ST pairs exist nearby vs.
// merely somewhere on the page) instead of guessing from a truncated
// sample. Never called by grounding or by deriveAccountLocationFromContent
// itself -- changing this function cannot change what gets derived.
function diagnoseAccountLocationExtraction(companyName = '', content = '') {
  const company = clean(companyName).toLowerCase();
  const rawContent = String(content || '');
  const globalPairs = extractCityStatePairs(rawContent);
  if (!company || !rawContent.trim()) {
    return {
      accountNameOccurrenceCount: 0,
      accountNameContexts: [],
      cityStateMatchesNearAccount: [],
      globalCityStateMatchCount: globalPairs.length,
      extractionOutcome: 'no-content-or-no-company-name',
      extractionFailureReason: !rawContent.trim() ? 'page had no fetched content' : 'no company name provided'
    };
  }
  const lines = rawContent.split(/\r?\n+/).map(line => clean(line)).filter(Boolean);
  const segments = lines.length ? lines : [clean(rawContent)];
  const matchingLineIndices = [];
  segments.forEach((line, idx) => { if (line.toLowerCase().includes(company)) matchingLineIndices.push(idx); });
  // Round 5: accountNameContexts now also reports each occurrence's real
  // BLOCK (see accountBlockLines() above) alongside the previous fixed
  // 5-line afterLines preview, so a human can see exactly what the real
  // extractor treated as this occurrence's own block vs. what merely
  // followed it on the page.
  const AFTER_LINES_WINDOW = 5;
  const accountNameContexts = matchingLineIndices.slice(0, 3).map(idx => ({
    before: idx > 0 ? segments[idx - 1].slice(0, 240) : '',
    line: segments[idx].slice(0, 240),
    afterLines: segments.slice(idx + 1, idx + 1 + AFTER_LINES_WINDOW).map(l => l.slice(0, 240)),
    block: accountBlockLines(segments, idx).map(l => l.slice(0, 240))
  }));
  const cityStateMatchesNearAccount = [];
  let ambiguousBlockFound = false;
  const contributedLocations = [];
  for (const idx of matchingLineIndices) {
    const { block, distinct } = accountBlockCityStatePairs(segments, idx);
    distinct.forEach(p => cityStateMatchesNearAccount.push({ city: p.city, state: p.state, block: block.map(l => l.slice(0, 240)) }));
    if (distinct.length > 1) ambiguousBlockFound = true;
    if (distinct.length === 1) contributedLocations.push(distinct[0]);
  }
  const uniqueContributed = [...new Map(contributedLocations.map(p => [`${normalizeForMatch(p.city)}|${p.state}`, p])).values()];

  let extractionOutcome, extractionFailureReason;
  if (!matchingLineIndices.length) {
    extractionOutcome = 'account-name-not-found-in-raw-content';
    extractionFailureReason = 'the fetched page content contains no case-insensitive occurrence of the account name, despite the account looking eligible before fetch (search snippet/title match or trusted-domain probe)';
  } else if (ambiguousBlockFound) {
    extractionOutcome = 'ambiguous-multiple-city-state-pairs-in-a-single-account-block';
    extractionFailureReason = 'at least one occurrence\'s own block (its line, or its numbered-entry block) contains more than one distinct City, ST pair -- refusing to guess which one belongs to the account';
  } else if (!uniqueContributed.length) {
    extractionOutcome = globalPairs.length
      ? 'account-name-found-but-no-city-state-in-its-own-block'
      : 'account-name-found-but-no-city-state-pattern-recognized-anywhere-on-page';
    extractionFailureReason = globalPairs.length
      ? 'a City, ST pattern exists elsewhere on the page, but never within this occurrence\'s own block (its line, or -- for a numbered directory entry -- the lines up to the next numbered entry) -- see accountNameContexts.block'
      : 'no text on the page matches the City, ST pattern at all, near the account name or anywhere else on the page';
  } else if (uniqueContributed.length > 1) {
    extractionOutcome = 'conflicting-locations-across-multiple-account-mentions';
    extractionFailureReason = `different occurrences of the account associate it with different locations (${uniqueContributed.map(p => `${p.city}, ${p.state}`).join(' vs ')}) -- refusing to pick one`;
  } else {
    extractionOutcome = 'derived';
    extractionFailureReason = '';
  }

  return { accountNameOccurrenceCount: matchingLineIndices.length, accountNameContexts, cityStateMatchesNearAccount, globalCityStateMatchCount: globalPairs.length, extractionOutcome, extractionFailureReason };
}

// Positive-contradiction check -- NOT a "does it agree" check. Absence of a
// location mention is never a contradiction (a source that says nothing
// about location is exactly what "unconfirmed" exists for). This only fires
// when the account's own city/state is on file AND the candidate's
// query-scoped text explicitly names at least one different city/state and
// never names the account's own -- e.g. a source that plainly says
// "Indianapolis, IN" for an account on file as "Dover, NH". A source that
// legitimately covers the account's real move/expansion into a new market
// will still typically restate the account's home city/state somewhere, and
// even when it doesn't, verifyCandidateCompanyGrounding() below treats a
// compensating corroborator (the account's own domain, or its own verified
// social profile) as sufficient to override this veto -- so a genuine new-
// market press release from the company's own domain is never penalized.
function hasLocationContradiction(candidate = {}, account = {}) {
  const accountLocationText = clean(account.location || account.cityState || '');
  const accountPair = accountLocationText.match(new RegExp(`\\b${CITY_STATE_PATTERN}\\b`));
  if (!accountPair) return false;
  const mentioned = extractCityStatePairs(`${candidate.title || ''} ${candidate.snippet || ''}`);
  if (!mentioned.length) return false;
  const accountCity = normalizeForMatch(accountPair[1]);
  // CITY_STATE_PATTERN's city group is greedy over an optional second
  // capitalized word (by design -- real two-word city names like "West
  // Springfield" need it), so a sentence-initial capitalized word right
  // before the account's real city ("The Dover, NH...") can get folded into
  // the captured city text. Agreement is checked as containment, not exact
  // equality, so that spurious extra word never turns a genuine match into a
  // false contradiction; a truly different city never contains the
  // account's city name, so this does not weaken contradiction detection.
  const agreesWithAccount = mentioned.some(p => normalizeForMatch(p.city).includes(accountCity) && p.state.toUpperCase() === accountPair[2].toUpperCase());
  return !agreesWithAccount;
}

// Company-grounding check, scoped to ONLY the candidate's query-scoped
// title+snippet -- never pageContent/rawContent (Firecrawl's full,
// relevance-agnostic page scrape, which is where the reproduced Avidia
// contamination actually lived). entityMatch() itself is reused unmodified;
// only the object passed to it is scoped down to title+snippet+url. That
// scoping decision is unchanged by this trust correction -- the failure this
// fixes (a same-name-but-different-company source) lives INSIDE the scoped
// title+snippet text itself, not in Firecrawl's full page content, so
// widening the scope back to pageContent would not have helped and would
// reopen the Avidia-class gap this scoping was built to close.
//
// Explicit scope: this proves the candidate's query-scoped evidence
// credibly identifies the requested company. It does NOT prove event-local
// provenance -- a candidate whose title and snippet genuinely identify the
// right company, but whose separately-fetched pageContent also contains an
// unrelated company's story elsewhere on the same page, remains a residual
// gap (see each endpoint's grounding regression tests). Closing that would
// require a fuzzy event-local excerpt/fingerprint primitive this module does
// not implement and this sprint does not build.
//
// Returns a tri-state identityConfidence rather than a boolean:
//   'confirmed'   -- name match AND at least one INDEPENDENT corroborator:
//                    official domain, the account's own location appearing
//                    in the source, a THIRD-PARTY publisher whose own domain
//                    is geographically tied to the account's city+state
//                    (accountCityStateGeoTokens() -- e.g. dovernh.org for a
//                    Dover, NH account; city alone is not enough), or a
//                    social profile House Accounts already KNOWS is this
//                    account's own official profile
//                    (account.knownSocialProfiles). A social handle that
//                    merely resembles the company name is NOT this -- see
//                    the founder QA note below.
//   'unconfirmed' -- a plausible name match with no corroborator and no
//                    contradiction. Preserved for research recall, but never
//                    eligible to be presented as a Verified Opportunity or to
//                    win a primary-opportunity slot (see dashboard gating).
//   'rejected'    -- no credible name match at all, OR a positive identity
//                    contradiction (a different, explicitly-named city/state)
//                    with no compensating corroborator.
// `grounded` is kept (true whenever identityConfidence !== 'rejected') so
// existing discard-on-false call sites keep working unchanged; new callers
// should read identityConfidence directly.
//
// Founder QA follow-up (post-implementation pressure test): the FIRST
// version of this function treated ANY social handle whose text resembled
// the company name as sufficient independent corroboration on its own. That
// is exactly the failure this whole correction exists to prevent -- for an
// ambiguous name, an unrelated same-name business's own Instagram handle
// ("@doverhonda" for the WRONG real-world Dover Honda) satisfies a text-
// resemblance check exactly as easily as the right one does, so it is not
// independent evidence, only a restatement of the same ambiguous name in a
// different field. Only accountKnownSocialProfileMatch() (a handle/URL
// House Accounts already holds on file specifically for this account) counts
// toward `corroborated` now; an inferred-only handle match is recorded in
// `reasons` for visibility but never on its own promotes a candidate past
// 'unconfirmed', and never overrides a location contradiction either.
function verifyCandidateCompanyGrounding(candidate = {}, account = {}) {
  const scopedCandidate = { title: candidate.title || candidate.headline || '', snippet: candidate.snippet || '', url: candidate.url || '' };
  const entity = entityMatch(scopedCandidate, account);
  const companyName = account.name || account.companyName || '';
  const scopedText = `${scopedCandidate.title} ${scopedCandidate.snippet}`;
  const distinctiveFallbackMatched = hasDistinctiveNameFallbackMatch(companyName, scopedText);
  // Trust correction (identity-bootstrap follow-up): CORROBORATOR != ENTITY
  // MATCH. `entity.level !== 'rejected'` was previously used as a proxy for
  // "the name was matched," but entityMatch()'s domain bonus alone (38
  // points) already clears the 'rejected' floor (30) with ZERO name-text
  // match required -- meaning a candidate hosted on account.website with no
  // mention of the company anywhere could satisfy this gate purely from
  // domain membership. Harmless as long as every account.website was an
  // exclusive single-company domain (any page on your own exclusive site is
  // trivially "about you"), but a proven live failure once a domain can be a
  // shared/group domain (e.g. derived from a contact's email at a multi-
  // brand dealer group): ANY page on that domain, even one with no mention
  // of the target account, would confirm. Domain/location/social
  // corroboration must STRENGTHEN an actual name match, never MANUFACTURE
  // one -- so nameMatched is now derived directly from entityMatch()'s own
  // name-text reasons (its bare full-phrase or normalized-form check),
  // never from the blended score/level, which mixes in non-name evidence.
  // This invariant holds even for an uploaded, exclusive account.website --
  // corroborator strength never substitutes for the name-match floor.
  const hasBareNameMatch = entity.reasons.includes('company named in source') || entity.reasons.includes('normalized company match');
  const nameMatched = hasBareNameMatch || distinctiveFallbackMatched;
  const reasons = [...entity.reasons];
  if (distinctiveFallbackMatched && !hasBareNameMatch) reasons.push('distinctive company name matched in source');

  if (!nameMatched) {
    return { grounded: false, identityConfidence: 'rejected', reasons };
  }

  const domainCorroborated = entity.reasons.includes('verified company domain');
  // Identity-collision-hardening follow-up: independent of domainCorroborated
  // above (which requires an UPLOADED account.website) -- see
  // isExactSelfDomainMatch()'s own header comment for the full rationale and
  // the exact Unitil/Timberland contrast this exists to preserve.
  const selfDomainCorroborated = isExactSelfDomainMatch(companyName, scopedCandidate.url);
  if (selfDomainCorroborated) reasons.push('candidate domain exactly matches the account\'s own single-token company name');
  const locationCorroborated = entity.reasons.includes('location match');
  // Founder QA follow-up (Dover Holiday Parade): a THIRD-PARTY publisher
  // whose own domain is geographically tied to the account (city+state, not
  // city alone -- see accountCityStateGeoTokens()) is a real, independent
  // corroborator. Deliberately weaker than domainCorroborated/
  // knownSocialProfileMatch for one purpose only: it does NOT compensate for
  // an explicit location contradiction below. The account's own domain or
  // its own verified social profile is the company speaking for itself and
  // can safely override a contradiction (e.g. a genuine new-market press
  // release); a third-party publisher merely being geo-matched to the
  // account's town is weaker evidence than that, so a geo-matched publisher
  // that ALSO names a conflicting city/state stays conservative and rejects.
  const publisherGeoCorroborated = entity.reasons.includes('publisher domain matches account city+state geography');
  const socialUrl = isSocialUrl(scopedCandidate.url);
  const knownSocialProfileMatch = socialUrl && accountKnownSocialProfileMatch(account, scopedCandidate.url);
  // Final bounded Beta trust correction: an EXACT compacted handle match
  // (e.g. "@llbean" for account "L.L.Bean") is checked independently of
  // knownSocialProfileMatch -- it requires no pre-populated
  // account.knownSocialProfiles entry at all. See
  // isExactSelfSocialHandleMatch()'s own header comment for the full
  // rationale and its deliberate contrast with the weaker, non-corroborating
  // inferredSocialHandleMatch below (a "resembles" check, never sufficient
  // alone).
  const exactSocialHandleCorroborated = socialUrl && !knownSocialProfileMatch && isExactSelfSocialHandleMatch(companyName, scopedCandidate.url);
  const inferredSocialHandleMatch = socialUrl && !knownSocialProfileMatch && !exactSocialHandleCorroborated && socialProfileMatchesCompany(companyName, scopedCandidate.url);
  if (knownSocialProfileMatch) reasons.push('matches account\'s known official social profile');
  else if (exactSocialHandleCorroborated) reasons.push('social handle exactly matches the account\'s own compacted company name');
  else if (inferredSocialHandleMatch) reasons.push('social handle text resembles account name (not independently verified -- does not count as corroboration alone)');
  else if (socialUrl) reasons.push('social source has no verifiable profile corroboration');

  const contradicted = hasLocationContradiction(scopedCandidate, account);
  // selfDomainCorroborated/exactSocialHandleCorroborated join
  // domainCorroborated/knownSocialProfileMatch in overriding a location
  // contradiction -- the account's own namesake domain or exactly-matched
  // social handle (verified by exact match, same as an uploaded website or
  // a known profile) is the company speaking for itself, exactly the same
  // reasoning that already applies to domainCorroborated above.
  if (contradicted && !domainCorroborated && !knownSocialProfileMatch && !selfDomainCorroborated && !exactSocialHandleCorroborated) {
    return { grounded: false, identityConfidence: 'rejected', reasons: [...reasons, 'source names a conflicting location with no compensating identity evidence'] };
  }

  const corroborated = domainCorroborated || locationCorroborated || knownSocialProfileMatch || publisherGeoCorroborated || selfDomainCorroborated || exactSocialHandleCorroborated;
  if (corroborated) return { grounded: true, identityConfidence: 'confirmed', reasons };
  // Final Beta Signal Intelligence Correction sprint: a name match that is
  // ONLY the distinctive-token fallback (never the strong bare full-phrase/
  // normalized-form match), with no independent corroborator either, is not
  // the same claim as a genuine Business Signal -- it's the exact shape of
  // the confirmed QA collisions (an uploaded "Wyman's" matching "Careers at
  // Oliver Wyman | A Marsh business" -- a real, different company that
  // happens to share the surname; an uploaded "Timberland" matching
  // "Nusenda Credit Union on Instagram" -- the word "timberland" used in its
  // ordinary-English sense, not the brand). hasBareNameMatch means the
  // account's own (normalized) name genuinely appears in the source text --
  // real evidence, even without a second corroborator, and stays
  // 'unconfirmed' (a legitimate Business Signal). distinctiveFallbackMatched
  // alone means only a shortened/surname-style TOKEN of the name was found,
  // which is exactly as consistent with a different, same-surname/same-word
  // entity as it is with the real account -- HA cannot tell those apart from
  // this evidence alone, so the rep should not be asked to either. This is a
  // strictly SMALLER-grant change: nameMatched (the reject/no-reject floor
  // just above) still allows either kind of match through to a returned,
  // visible result -- only the identityConfidence LABEL is downgraded to
  // 'possible' when the match is token-only and uncorroborated, so it can be
  // shown in Research Results for transparency without being treated as a
  // Business Signal (see isPossibleMatchIdentity() at every consumer).
  //
  // Identity-collision-hardening correction (this round): the paragraph
  // above assumed hasBareNameMatch alone was strong enough evidence to
  // reach 'unconfirmed' -- but the audit of the fresh production run proved
  // this wasn't true when the account's OWN full name, once normalized, is
  // itself just a single token (isSingleTokenCompanyIdentity()). "Wyman's"
  // bare-matched "...Oliver Wyman's presence..." and "Timberland" bare-
  // matched an unrelated "2027 Timberland Investment Conference" -- both
  // via the STRONG hasBareNameMatch path (entity.reasons included "company
  // named in source"), never distinctiveFallbackMatched at all. A single
  // common word/surname/category term is exactly as consistent with a
  // different, same-word entity (or the word's ordinary English sense) as
  // it is with the real account, REGARDLESS of whether the match came via
  // the bare-phrase check or the distinctive-token fallback -- the
  // account's own name being a full, multi-word phrase (e.g. "Northfield
  // Instruments") is what made the ORIGINAL bare-match branch trustworthy;
  // a full name that is itself only one token never earned that trust. A
  // multi-word bare match keeps its full 'unconfirmed' grade unchanged --
  // UNLESS the bare match is itself embedded inside a larger, different
  // proper-name entity (the Albany International / Airport shape): a
  // multi-word phrase escapes the single-token protection above entirely,
  // so without this check a company phrase that is merely a literal prefix
  // of an unrelated larger entity would sail straight to 'unconfirmed' with
  // no protection at all. See isEntityEmbeddedInLargerName()'s own header
  // comment for the exact rule (every occurrence embedded, snippet-scoped,
  // generic-suffix-exempt).
  if (hasBareNameMatch && !isSingleTokenCompanyIdentity(companyName)) {
    if (!isEntityEmbeddedInLargerName(companyName, scopedCandidate.snippet)) {
      return { grounded: true, identityConfidence: 'unconfirmed', reasons };
    }
    reasons.push('bare match is embedded inside a larger, different proper-name entity in the source text -- treated as a possible match, not a confirmed reference');
    return { grounded: true, identityConfidence: 'possible', reasons };
  }
  if (hasBareNameMatch) {
    // Recall fix (Cianbro shape): before falling to the unconditional
    // 'possible' default, check whether the evidence itself already
    // contains a genuine standalone, contextual reference to the account --
    // see isStandaloneSingleTokenMention()'s own header comment for the
    // exact rule (capitalized + non-adjacent + a recognized business-event
    // family in the snippet; deliberately excludes the sentence-initial
    // common-noun coincidence this same round's QA required be preserved).
    if (isStandaloneSingleTokenMention(companyName, scopedCandidate.snippet)) {
      reasons.push('single-token company identity appears as a standalone, capitalized mention in an explicit business-activity context -- treated as a legitimate (uncorroborated) reference');
      return { grounded: true, identityConfidence: 'unconfirmed', reasons };
    }
    reasons.push('single-token company identity matched with no independent corroboration -- treated as a possible match, not a confirmed reference');
  }
  return { grounded: true, identityConfidence: 'possible', reasons };
}

// GUARDRAIL (product/commercial-opportunity-intelligence): this identity key
// must be built ONLY from factual/evidence fields (company, family/subtype,
// event date, named entities extracted from title/snippet/rawContent).
// commercialPlay/activationIdeas/expansionPotential are interpretation, not
// evidence -- they must NEVER be added as inputs here, or a creative concept
// like "50 Summers" could silently become part of an event's dedup identity.
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
  // GUARDRAIL: fingerprint inputs are headline/whatChanged (factual) only --
  // never raw.commercialPlay/activationIdeas/expansionPotential. See the
  // guardrail comment on eventFingerprint() itself.
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
    // Fingerprint Stability sprint: preserve the original candidate's
    // source-derived title/snippet/content under distinct field names --
    // additive only, never overwrites headline/whatChanged above, which stay
    // the model-authored fields every existing consumer already expects.
    // Lets downstream identity resolution (resolveOpportunityEvents()) prefer
    // genuinely raw text over LLM-resynthesized wording when both exist.
    //
    // Foundation-freeze correction: this was checking candidate.headline
    // alone, but every real candidate on both production paths (research-
    // batch.js's discoverCandidatesForAccounts()/scoreCandidate() and
    // research-account.js's search-result mapping) carries the search
    // provider's own title under `.title`, never `.headline` -- confirmed by
    // direct inspection, matching every other candidate-title read in this
    // same function (see `headline` above) and file, which all check
    // candidate.title first. rawTitle was therefore always '' on the real
    // path -- inert since it was introduced -- even though genuinely
    // source-derived text (the search result's own headline, pre-LLM-
    // synthesis) was available the whole time.
    rawTitle: clean(candidate.title || candidate.headline || ''),
    rawSnippet: clean(candidate.snippet || ''),
    rawContent: clean(candidate.rawContent || raw.rawContent || raw.pageContent || ''),
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
  // product/commercial-opportunity-intelligence: commercialPlay itself is
  // optional (absence is a valid outcome -- see normalizeCommercialIntelligence()),
  // so its absence never fails validation. This only guards against a
  // malformed commercialPlay object with no narrative ever reaching
  // persistence -- normalizeCommercialIntelligence() already guarantees this
  // can't happen for anything that went through it, so this is defense in
  // depth, not the primary safeguard.
  if (opportunity.commercialPlay && !clean(opportunity.commercialPlay.narrative)) reasons.push('commercialPlay present without a narrative');
  return { valid: reasons.length === 0, reasons };
}

// ---------------------------------------------------------------------------
// product/commercial-opportunity-intelligence
//
// House Accounts' core job is the research and commercial thinking a
// salesperson doesn't have time to do -- not writing their email for them.
// This is the ONE shared reasoning instruction spliced into both live
// research endpoints' prompts (api/research-batch.js, api/research-account.js)
// so the actual wording of how to reason about the commercial angle is
// written once, never maintained as two independently-drifting copies. Each
// endpoint's surrounding prompt (candidate evidence, account context,
// output-format wrapper, field-name casing) stays endpoint-specific --
// only this reasoning instruction is shared, and normalizeCommercialIntelligence()
// below is the shared post-processing that reconciles both endpoints' raw
// output into one consistent internal shape regardless of casing.
// ---------------------------------------------------------------------------
const COMMERCIAL_INTELLIGENCE_PROMPT_FRAGMENT = `
IMPORTANT, READ FIRST -- SIGNAL vs. ACTIVATION are two separate judgments, not one: everything below is about whether YOU have a credible commercial ACTIVATION to recommend (commercialPlay/activationIdeas/expansionPotential). It is never about whether the underlying event itself gets reported. If the event is real, current, and sourced -- a genuine acquisition, leadership change, facility opening, funding event, product launch, sponsorship, or other material business development about this specific company -- return it as a signal regardless of whether you end up with a credible activation for it. "I don't have a confident commercial play for this yet" and "this event isn't worth mentioning" are different conclusions; only the first is what an empty/omitted commercialPlay, activationIdeas, and expansionPotential mean. A rep who learns "this customer just made an acquisition, no specific activation recommended yet" is far better served than a rep who never hears about the acquisition at all because you couldn't responsibly infer a program around it. Do not let restraint on the commercial fields talk you out of returning the signal itself -- withhold the activation, not the event.

Beyond the factual event itself, reason like a smart promotional-products merchandise strategist sitting beside the rep -- not a copywriter drafting an email. Do not merely summarize the signal; interpret it commercially. Commercial Activation Reasoning sprint: your goal is to translate a business event into a commercial ACTIVATION, not a product category. "This event may create a need for promotional products" is not a play -- it is a merchandise justification wearing a play's clothing.

First, separate what you actually know from what you're inferring:
- FACT: directly stated or clearly supported by the evidence (e.g. "the company hired a VP of Marketing & Brand Growth").
- REASONABLE COMMERCIAL INFERENCE: a plausible implication you're using to reason toward an activation (e.g. "a new marketing leader may be evaluating how the brand shows up internally and externally, and may want an early, visible win"). Inference is allowed and expected -- this is where a real play comes from.
- UNSUPPORTED ASSUMPTION: a specific plan, program, or initiative you have no actual evidence for (e.g. "the company is beginning a comprehensive rebrand" based on a leadership change alone, or "the company is launching an onboarding program" based on an acquisition alone). Never state this as if it were true. If your best play depends on an assumption like this, either soften it into an inference ("may be an early moment to...") or drop the play.

Before generating commercialPlay/activationIdeas, work through four questions in order, silently, and let the answers actually shape what you write -- do not skip straight to a product category:
1. AUDIENCE -- Who are the relevant audiences THIS signal creates, affects, or brings together? Do not default to employees -- name at least two plausible candidate audiences before you settle on one. Depending on the event and company, this might include employees, recruits, customers, prospects, investors/LPs, portfolio companies, executives, partners, dealers, field teams, event attendees, VIPs, volunteers, community members, or sponsors. A financing/fund-close signal specifically must have investors/LPs/portfolio companies weighed as a candidate audience alongside (not instead of) any operational/employee angle -- never settle on employee-onboarding/apparel as the only read of a financing signal without having actually considered who the money itself connects the company to. If you cannot name a real audience, confidence in any activation should fall sharply.
2. OBJECTIVE -- What is that audience likely TRYING TO ACCOMPLISH or experience right now because of this development? (A newly hired executive wants early, visible impact. A community-impact report reflects the work of specific people -- e.g. the store associates or field staff who actually deliver it -- who are rarely thanked for it by name. Investors in a newly closed fund are about to have their first touchpoints with it.) The objective is things like celebrate, welcome, integrate, launch, recognize, recruit, engage, thank, equip, or reinforce culture -- never "sell hats" or "order shirts". A product is never an objective.
3. MOMENT -- Is there a real, specific moment or touchpoint where this audience and objective actually meet (a parade, an opening day, an onboarding, a conference, a welcome event, a shipment, a recognition moment)? Branded activation works best attached to a real human moment, not an abstract headline. A vague or absent moment is itself a reason to lower confidence or omit the play.
4. ACTIVATION -- Only now, what commercially relevant activation could actually serve that objective at that moment?

- commercialPlay: your interpretation of the specific commercial opportunity this event creates, derived from steps 1-4 above -- not a reflexive "this could create demand for promotional products" reaction to the event category. Answer "what's the play I see here?", not "what happened" (that belongs in the factual fields above), and answer it the way a sharp rep would explain it to a colleague: specifically what to do, for whom, and why now -- not "could they potentially sell promo here?" Before finalizing, apply this test: if every reference to promotional products/merchandise disappeared from this narrative, would there still be a meaningful initiative left? ("Turn the parade sponsorship into a tangible community activation for families and the team" survives that test. "This creates demand for promotional products" does not.) A concise, memorable concept/title (e.g. "50 Summers" for an anniversary) is welcome ONLY when a genuinely useful one emerges naturally from the evidence -- never manufacture a cute campaign name just to fill the field. If the evidence does not support a credible, specific commercial play, omit commercialPlay entirely -- a genuinely empty field beats a filled-in non-answer. Treat these as non-answers, not real plays, even though they technically fill the field: "this creates an opportunity for promotional products," "could create a need for promotional products," "branded materials may be useful here," "merchandise could support this initiative," "consider branded merchandise," "this could be an opportunity to reach out," "increase brand visibility," "support marketing efforts," "creates internal or customer-facing needs." A real play always names a specific business objective, a specific audience, and a specific activation angle together -- if you can't state all three, you don't have a play yet, so leave the field empty. NO IDEA, NO PLAY: commercialPlay is proof-of-work only when it is paired with at least one real, specific entry in activationIdeas below -- a well-written paragraph with nothing concrete behind it is not a credible play. If you cannot generate at least one genuinely specific, signal-grounded idea, leave BOTH commercialPlay and activationIdeas empty rather than submitting a narrative with no idea to back it up. Ideally produce 2-4 real ideas, not just one.
- activationIdeas: up to 6 concrete, specific ways a rep could activate against the opportunity for the audience(s) identified above -- a concept and its role in the activation, not a bare catalog noun (e.g. "Parade Team Kit for the volunteers walking the route" or "Family take-home piece extending the sponsorship beyond the float", never bare "Apparel", "Drinkware", or "Giveaways" with no qualifier). Product specificity itself is fine and often what makes an idea useful -- the bar is connection to the actual activation, not avoidance of product nouns. If your commercialPlay narrative mentions a concept or activity, that same concept must also appear here as its own entry -- never describe an idea only in prose and leave this list empty. If nothing specific and credible comes to mind, return an empty list (and see NO IDEA, NO PLAY above -- omit commercialPlay too in that case). Do not pad to reach a target count -- two strong ideas beat six generic ones.
- expansionPotential: a credible repeat or extension path -- one sponsorship leading to a recurring sponsorship program, one location opening leading to a repeatable new-location playbook, one acquisition integration leading to a repeatable future-acquisition welcome program -- not generic optimism ("could expand company-wide", "could lead to more merchandise", "future opportunities may arise"). Give a short narrative explaining the commercial upside (not a restatement of the tags), plus up to 3 tags from this fixed list ONLY when they genuinely apply: one-time, recurring-program, account-expansion, cross-department, employee-program, customer-program, seasonal-repeat, parent-org-route, other. Omit expansionPotential entirely if you have no confident, grounded read on this -- absence beats optimism.
- recommendedBuyingTeam / likelyBuyers: name the team or role that would actually OWN the activation you identified above (e.g. a community sponsorship activation points to marketing/community/events; an employee integration activation points to people/HR/internal communications) -- not a generic department guess disconnected from the play.

FUNDING AND EARNINGS/FINANCIAL-RESULTS SIGNALS SPECIFICALLY: these are weak by default. Funding alone does not imply hiring, onboarding, office expansion, events, or a customer launch -- "$20M raised" is not itself a reason to write "onboarding kits." A routine earnings call or financial-results announcement normally has no activation at all. Only write a commercialPlay for one of these signal types when the evidence ITSELF discloses a concrete downstream initiative (a stated hiring push, a market launch, an office expansion, a conference strategy) -- reason from that disclosed initiative, never from the funding/earnings event alone. Otherwise, omitting commercialPlay/activationIdeas/expansionPotential entirely is the correct, expected output for these two signal types -- a real signal with no credible activation is a legitimate result, not a gap to fill. NO GROUNDED ACTIVATION, NO PRIORITY: producing SOME activationIdeas does not by itself prove a real activation exists -- do not satisfy this requirement by manufacturing an idea ABOUT the funding/earnings event itself (e.g. a "brand visibility campaign," "funding announcement launch kit," or "social media campaign" for the raise/results). Announcing money is not a moment the audience experiences, even if you can picture marketing collateral for it -- that is exactly the "merchandise justification wearing a play's clothing" this whole framework exists to prevent, just with confident phrasing instead of hedged phrasing. If the only "activation" you can produce is about the financial event itself, you do not have one -- leave commercialPlay and activationIdeas empty.

THE SAME "NO GROUNDED ACTIVATION, NO PRIORITY" STANDARD APPLIES TO EVERY OTHER WEAK-BY-DEFAULT SIGNAL TYPE, not just funding -- an acquisition, a leadership appointment, and a new-facility opening are each frequently reported with almost no operational detail, and each has its own version of the exact same trap:
- Acquisition: the acquisition itself is not a welcome/integration moment -- only a DISCLOSED integration detail (a stated combined-team event, a customer transition plan, a branch consolidation) is. "Acquiring a company creates a great opportunity for onboarding kits" is a manufactured activation with no real audience specified; "the two teams are holding a joint welcome event for the combined field staff" is grounded because it names who and what actually happens.
- Leadership appointment: a new executive's title alone never proves a rebrand, reorganization, or any other sweeping initiative is underway -- see the UNSUPPORTED ASSUMPTION example above. A real activation here comes from the INFERENCE that a new leader likely wants an early, visible win (see AUDIENCE/OBJECTIVE above), not from asserting a specific program the evidence never mentioned.
- Facility opening or relocation: a new location is not itself a team/customer/community moment -- reflexively translating "new location" into uniforms, signage, or launch materials with no audience attached is the same merchandise-justification pattern as funding's "brand visibility campaign." A real activation names who experiences the opening (staff on their first day, customers visiting for the first time, the community at a ribbon cutting), not just that a new place now exists.
In every case: a confidently-worded idea or narrative is not evidence of a real activation merely because it sounds specific -- if its entire content is the bare event category plus a generic campaign/visibility/launch noun with no audience or moment named, it is the same manufactured pattern regardless of which signal family it dresses up.

A grounded signal with no credible commercial interpretation is a better output than fabricated commercial intelligence. Absence of commercialPlay, an empty activationIdeas list, and absence of expansionPotential are all valid and expected outcomes for weak or generic signals -- never force any of these fields merely because the schema has a place for them.

For the discovery question, give the single most useful thing to learn or confirm next -- ownership, timing, scope, whether a program already exists, which department owns it, or expansion potential. This is commercial discovery, not opener copy: do not write a scripted greeting and do not ask to schedule a meeting. Never phrase this question by asking the buyer what THEIR plans/strategy/approach are for the event itself (e.g. "What promotional strategies are you considering for X?", "How do you plan to engage with X?", "What's your approach to X?") -- that outsources the thinking back to the buyer, which is the opposite of the point. If you have a real activation idea, lead with it (the permission-ask branch below). If you genuinely don't have enough to propose anything concrete, ask about ownership/timing/scope/whether a program already exists instead -- never ask the buyer to invent the commercial angle for you.
Usually this means a plain question with no product mention at all. But when the event is a genuinely UPCOMING one (not yet happened), OR a genuinely RECENT PAST event where a real follow-through moment still applies (e.g. a just-completed acquisition's integration/welcome window, a facility that just opened), and you have one or two genuinely strong, specific activationIdeas, the question may instead lead with those exact ideas and ask permission to send concepts -- e.g. "We had a couple ideas for the event, including [a real activation idea] -- would it be okay if I sent a few concepts over?" Never reference an idea you did not actually generate in activationIdeas, never assert the work is already happening, and never combine this with a scheduling request. If you do not have a genuinely strong activation idea, ask a plain discovery question instead -- do not force a product mention.

If the account context below includes recent uploaded purchases, and this signal is a RECENT PAST event (not upcoming, not ongoing): check whether any uploaded purchase date falls within roughly 3-4 weeks of the event date. Date proximity ALONE is never enough -- an unrelated purchase (e.g. office furniture) that merely happens to land near a community festival's date is not evidence of anything. Only treat a purchase as likely evidence we supplied something for THIS event when it is BOTH close in time AND plausibly connected by its own project/category description (mentions the event, the event type, or a matching activity) -- reference the actual purchased category/project by name, ask how it landed, and pivot the discovery question toward what's next (e.g. "Glad the bandanas landed well -- what's next on the calendar?"). If no purchase is both close in time and plausibly connected, or timing/connection is unclear or ambiguous, do NOT claim we supplied anything -- use a neutral posture instead (e.g. "Saw the event wrapped up -- how did it go? What's next on the calendar?"). Never guess at fulfillment from the event topic alone or from date proximity alone; only a genuinely close AND plausibly connected uploaded purchase counts as evidence.
`.trim();

const GENERIC_ACTIVATION_IDEA_PHRASES = new Set([
  'apparel', 'branded apparel', 'drinkware', 'giveaways', 'promotional items',
  'promotional products', 'swag', 'branded merchandise', 'merchandise',
  'branded items', 'corporate gifts', 'custom products', 'promotional giveaways',
  'branded swag', 'company swag', 'custom merchandise', 'branded gear',
  // Global Business Trigger Intelligence sprint: the founder's named facility-
  // opening/relocation weak pattern ("new location -> uniforms / signage /
  // launch materials") -- bare, unqualified translations of "there is a new
  // place" into a product category, with no audience or moment attached. A
  // qualified, specific idea using the same underlying words (e.g. "Staff
  // opening-day polos", already a real idea in this suite's own strong
  // facility-opening fixture) is unaffected -- this is still an exact
  // whole-string match, never a substring search.
  'uniforms', 'signage', 'launch materials'
]);

// Deliberately a short, fixed list of content-free category labels -- the
// goal is rejecting obviously generic filler, not building a merchandising
// ontology. A specific, qualified phrase ("Premium pool/beach towels") is
// never caught by this even though it contains a generic word, because the
// check is against the WHOLE cleaned idea string, not a substring search.
// Final Beta Signal Intelligence Correction sprint: the SAME family-agnostic
// gap isGenericCommercialPlay() closed for narrative text, applied per-idea.
// isWeakEventDressedAsActivation() only fires when WEAK_EVENT_ANCHOR matches
// (funding/acquisition/leadership/facility, deliberately never rebrand/
// conference/product-launch), so a short idea phrase like "Rebrand launch
// apparel" or "New-brand promotional giveaways" -- naming only a bare merch
// category word with no real audience/moment, for an event family the
// anchor never covers -- previously survived unfiltered. Deliberately a
// SMALL, bare-category-word list (not the fuller GENERIC_COMMERCIAL_PLAY_NOUN
// phrase set, which requires a qualifying word like "branded"/"custom" a
// short idea title often omits) plus the SAME GROUNDED_AUDIENCE_OR_MOMENT_WORDS
// positive check -- a real, grounded idea always names who it's for or what
// moment it serves ("Volunteer polos for the staff working check-in",
// "Welcome kit for new drivers"), so this never fires on genuine specificity.
const GENERIC_MERCH_CATEGORY_WORD = /\b(?:apparel|gear|swag|merch|giveaways?|promo items?|promotional items?|kits?)\b/i;
function isGenericActivationIdea(idea = '') {
  const normalized = clean(idea).toLowerCase().replace(/[.!]+$/, '');
  if (!normalized) return true;
  if (GENERIC_ACTIVATION_IDEA_PHRASES.has(normalized)) return true;
  // Commercial Activation Reasoning sprint, final validation round: an idea
  // can be a manufactured weak-event activation even when it isn't one of
  // the fixed bare-category phrases above (e.g. "Funding announcement launch
  // kit", "Social media campaign for the seed round", "Acquisition
  // celebration launch kit", "Comprehensive rebrand campaign") -- see
  // isWeakEventDressedAsActivation()'s header comment below for the full
  // rationale; same check, applied per-idea here.
  if (isWeakEventDressedAsActivation(idea)) return true;
  if (GENERIC_MERCH_CATEGORY_WORD.test(idea) && !GROUNDED_AUDIENCE_OR_MOMENT_WORDS.test(idea)) return true;
  return false;
}

// QA correction 4 (original finding): commercialPlay is free-form prose,
// so it can't be screened with an exact-match phrase set the way
// activationIdeas is above -- a full-sentence generic non-answer needs a
// STRUCTURAL check instead. This deliberately stays a hedge-pattern + a
// generic-noun-pattern + "nothing else survives" check, not a growing
// dictionary of banned sentences: a hedge ("could create a need for",
// "opportunity for", "may be useful") landing on a bare generic merch noun
// ("promotional products", "branded materials", "merchandise") with no
// other real word left over IS the shape of a non-answer, regardless of
// exact wording. A genuinely specific play always has some word left over
// (a program name, a named stakeholder, a concrete activation) once this
// same stripping is applied, so this never fires on real specificity --
// only two short, fixed patterns plus a stopword-style filter, not a
// dictionary of forbidden sentences.
//
// Confirmed non-answers this must catch (founder examples, verbatim):
// "opportunity for promotional products"; "could create a need for
// promotional products"; "branded materials may be useful"; "merchandise
// could support this initiative"; and the production case, "This could
// lead to a need for promotional products to support brand initiatives,
// such as branded materials for outreach and events."
// Commercial Activation Reasoning sprint: two more confirmed-shape non-answer
// families named directly in the founder's brief -- "branded materials may
// be NEEDED" (the HEDGE list only had "may be useful") and "increase brand
// visibility"/"support marketing efforts" (a non-answer shape with no
// traditional merch noun at all, just a vague brand-awareness claim). Both
// extensions stay narrow: HEDGE alone or NOUN alone never trigger anything,
// only their combination does, exactly like the existing pattern -- a
// specific narrative that happens to use "build" or "grow" for something
// else entirely (e.g. "could build strong relationships with the new team")
// still never matches NOUN and is unaffected.
const GENERIC_COMMERCIAL_PLAY_HEDGE = /\b(?:could|might|may|can)\s+(?:lead to|create|open up|present|support|increase|improve|boost|build|drive|grow)\b|\b(?:opportunity|need|demand)\s+for\b|\bmay\s+be\s+(?:useful|needed|necessary|required)\b|\bconsider\b/i;
const GENERIC_COMMERCIAL_PLAY_NOUN = /\b(?:promotional\s+(?:products?|materials?|items?|needs?)|branded\s+(?:materials?|items?|merchandise|products?|apparel|gear)|custom\s+merchandise|merchandise|swag|corporate\s+gifts?|brand\s+(?:visibility|awareness|recognition|presence))\b/i;
const GENERIC_COMMERCIAL_PLAY_STOPWORDS = new Set([
  'this', 'that', 'such', 'with', 'from', 'into', 'their', 'they', 'them',
  'consider', 'support', 'supporting', 'could', 'might', 'need', 'needs', 'lead', 'create',
  'creates', 'creating', 'present', 'presents', 'opportunity', 'opportunities',
  'useful', 'likely', 'potential', 'potentially', 'various', 'general', 'generic',
  'promotional', 'products', 'product', 'materials', 'material', 'branded', 'brand',
  'branding', 'merchandise', 'apparel', 'gear', 'swag', 'gifts', 'gift', 'corporate',
  'custom', 'items', 'item', 'initiative', 'initiatives', 'outreach', 'events',
  'event', 'campaign', 'campaigns', 'marketing', 'kits', 'kit', 'related',
  'increase', 'improve', 'boost', 'build', 'drive', 'grow', 'visibility',
  'awareness', 'recognition', 'presence', 'necessary', 'required', 'needed'
]);
// Beta Seller Experience sprint, Preview QA round 2: confirmed real production
// text (Gallagher "...to support the call and subsequent marketing efforts.",
// Kiniksa "...such as branded materials for the webcast or investor relations
// kits.") wraps the exact same hedge+generic-merch-noun non-answer in a little
// extra filler that only ever references the signal's OWN procedural mechanics
// (the call/webcast/filing itself) -- not any real external audience or
// activation moment. The stricter all-stopwords-only check below missed both
// because "call"/"webcast"/"investor"/"relations"/"subsequent"/"efforts"
// weren't in the stopword vocabulary. This whitelist is intentionally narrow
// and additive: it only ever activates once HEDGE+NOUN already matched above,
// and a genuine external-audience word (parade, community, customers,
// attendees, families, festival, employees, ...) is never in it, so a real
// activation described alongside incidental procedural language is never
// caught by this alone.
const GENERIC_COMMERCIAL_PLAY_PROCEDURAL_WORDS = new Set([
  'call', 'calls', 'webcast', 'webcasts', 'conference', 'investor', 'investors',
  'relations', 'earnings', 'quarterly', 'filing', 'filings', 'presentation',
  'presentations', 'shareholders', 'shareholder', 'subsequent', 'efforts',
  'effort', 'results', 'report', 'reports', 'meeting', 'meetings'
]);
// Commercial Activation Reasoning sprint, final validation round (Neural
// Trust/Black Hat funding finding): "NO IDEA, NO PRIORITY" is gameable --
// the model can satisfy "produce a real activationIdea" by inventing one
// for the underlying event ITSELF ("a great opportunity to run a brand
// visibility campaign celebrating the round"), which is confident,
// well-formed prose with no hedge word at all, so GENERIC_COMMERCIAL_PLAY_HEDGE
// never fires. The founder's stronger standard: a funding/financial event
// is NEVER itself a real moment/touchpoint -- an idea or play whose entire
// content is the event plus a generic campaign/visibility noun, with
// nothing else concrete, is a manufactured activation regardless of how
// confidently it's phrased. This is a SEPARATE, independent check
// (weak-event-anchor + generic-campaign-noun, no hedge required) -- it
// only ever fires on this specific combination, so a genuinely grounded
// funding-adjacent play (e.g. "the round is earmarked for opening three new
// offices -- a reason to build a new-office welcome program for each") is
// unaffected: "new-office welcome program" matches neither generic-campaign
// noun list below.
//
// Global Business Trigger Intelligence sprint: originally scoped to
// funding/earnings only (the confirmed Neural Trust case), but live QA
// showed the exact same confident-dressed-up shape recurs for every other
// signal family the prompt itself calls "weak by default" -- an acquisition
// ("a great opportunity to run a brand visibility campaign celebrating the
// deal"), a leadership appointment ("the new VP is a great moment to launch
// a comprehensive rebrand"), or a facility opening ("a great opportunity to
// run a visibility campaign for the grand opening"). None of these were
// previously caught: WEAK_EVENT_ANCHOR only matched funding/earnings
// language, so a confidently-worded fabrication anchored on any other weak
// family sailed through unflagged. Widened to a family-agnostic anchor
// covering every weak-by-default event category named in the founder's
// brief -- content-based, not account-specific, so it applies identically
// regardless of which company or signal triggered it.
const WEAK_EVENT_ANCHOR = /\b(?:funding|seed round|series [a-z]\b|investment round|financing round|capital raise|raised \$|an? ipo\b|going public|earnings|financial results|quarterly results|acquisition|acquiring|acquired|acquires|merger|merged|new (?:vp|ceo|cfo|coo|cmo|cto|president|vice president|chief \w+ officer)|newly hired (?:vp|ceo|cfo|coo|cmo|cto|president)|appointed (?:as )?(?:vp|ceo|cfo|coo|cmo|cto|president|vice president)|named (?:ceo|president|chief|vice president)|leadership change|promoted to|new (?:facility|location|office|branch|plant)|grand opening|ribbon cutting|relocat(?:ed|ing|ion))\b/i;
const GENERIC_CAMPAIGN_NOUN = /\b(?:brand visibility|brand awareness|brand recognition|visibility campaign|awareness campaign|social(?:\s+media)?\s+campaign|launch kit|celebration campaign|pr campaign|press campaign|milestone campaign|funding announcement|announcement campaign|comprehensive rebrand|rebrand campaign|brand relaunch|relaunch campaign)\b/i;
// Deliberately a POSITIVE check (does a real audience/moment word appear
// anywhere?) rather than the "strip stopwords until nothing survives"
// pattern the older checks above use -- a natural, fluently-written
// narrative almost always contains the company's own name and ordinary
// connective prose ("which", "just", "worth", "great"), so requiring full
// reduction to nothing is too strict once the model writes confidently
// instead of in a hedging voice (exactly what this sprint's prompt changes
// pushed it toward). Presence of a genuine audience/moment word is a much
// more robust signal of real grounding than absence of connective filler.
//
// Global Business Trigger Intelligence sprint: deliberately does NOT include
// "acquisition"/"acquired"/"merger"/"leadership"/"executive"/"office"/
// "facility"/"location"/"branch"/"store" -- every one of these is now also
// part of WEAK_EVENT_ANCHOR above (the anchor has to name the event category
// -- "acquisition", "new facility" -- to detect it in the first place), so
// keeping the exact same words here would make the two lists cancel each
// other out: almost any acquisition-, leadership-, or facility-anchored
// narrative mentions its own event category ("acquisition", "the new
// facility") somewhere in ordinary connective prose merely by describing
// what kind of event happened, which would satisfy this check regardless of
// whether a genuine audience/moment was ever named -- confirmed empirically
// during this sprint: a facility-opening narrative anchored on "the new
// facility" was still passing this check purely because "facility" is both
// the anchor AND (in the pre-sprint list) a "grounded" word. A bare
// event-category label -- what TYPE of thing happened, or WHERE it
// happened -- is not the same claim as WHO experiences it; only WHO
// (employees, customers, staff, the community, dealers, volunteers...) or a
// genuine human touchpoint (welcome, onboarding, a trade show, a parade)
// counts as real grounding here. Every strong held-out fixture in this
// suite still passes on a WHO/touchpoint word alone (Solaris: "...for staff
// and the patients visiting..." -- grounded by "staff", not by "location";
// Vantage/Ridgeline: "...incoming...drivers and dispatch staff..." --
// grounded by "staff", not by "acquisition").
const GROUNDED_AUDIENCE_OR_MOMENT_WORDS = /\b(?:employee|employees|staff|workforce|team|customer|customers|client|clients|community|families|family|attendee|attendees|volunteer|volunteers|partner|partners|dealer|dealers|franchisee|recruit|recruits|hire|hires|hiring|conference|summit|trade show|expo|booth|parade|festival|sponsor|sponsorship|launch event|onboarding|welcome|integration|community event|open house)\b/i;
function isWeakEventDressedAsActivation(text = '') {
  const t = clean(text);
  if (!t) return false;
  if (!WEAK_EVENT_ANCHOR.test(t) || !GENERIC_CAMPAIGN_NOUN.test(t)) return false;
  return !GROUNDED_AUDIENCE_OR_MOMENT_WORDS.test(t);
}
function isGenericCommercialPlay(narrative = '') {
  const text = clean(narrative);
  if (!text) return false;
  if (isWeakEventDressedAsActivation(text)) return true;
  if (!GENERIC_COMMERCIAL_PLAY_HEDGE.test(text) || !GENERIC_COMMERCIAL_PLAY_NOUN.test(text)) return false;
  // Final Beta Signal Intelligence Correction sprint (mirrors
  // dashboard/index.html's identically-widened check -- see that copy's
  // header comment for the full rationale): a hedged "[event] may create an
  // opportunity for [merch]" narrative with no genuine audience/moment named
  // is the same manufactured pattern regardless of event family, independent
  // of WEAK_EVENT_ANCHOR -- this generalizes protection against manufactured
  // activation reasoning without adding more families to any anchor list.
  if (!GROUNDED_AUDIENCE_OR_MOMENT_WORDS.test(text)) return true;
  const remaining = text.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/)
    .filter(w => w.length > 3 && !GENERIC_COMMERCIAL_PLAY_STOPWORDS.has(w));
  if (remaining.length === 0) return true;
  return remaining.every(w => GENERIC_COMMERCIAL_PLAY_PROCEDURAL_WORDS.has(w));
}

const EXPANSION_POTENTIAL_TAGS = new Set([
  'one-time', 'recurring-program', 'account-expansion', 'cross-department',
  'employee-program', 'customer-program', 'seasonal-repeat', 'parent-org-route', 'other'
]);

// Normalizes the ONE new commercial-interpretation thought the model may
// produce (commercialPlay/commercial_play, activationIdeas/activation_ideas,
// expansionPotential/expansion_potential -- reconciling both endpoints'
// casing conventions here, not in either endpoint) into a safe, bounded
// shape. Absence is a valid, encouraged outcome: this function NEVER
// manufactures a play/idea/expansion-read the model didn't actually
// produce -- it only cleans, caps, and filters what IS present.
//
// All three keys are always present on the returned object (commercialPlay:
// object|null, activationIdeas: array, expansionPotential: object|null),
// even when a value is empty -- this lets callers distinguish "a new-schema
// signal with no credible commercial interpretation" from "an old signal
// that predates this feature entirely and never had these keys at all" (see
// dashboard/index.html's getCommercialPlayNarrative()).
function normalizeCommercialIntelligence(raw = {}) {
  const rawPlay = raw.commercialPlay || raw.commercial_play;
  let commercialPlay = null;
  if (rawPlay && typeof rawPlay === 'object') {
    const narrative = truncateText(rawPlay.narrative || rawPlay.description || '', 320);
    // QA correction 4: a narrative that is nothing more than generic promo
    // language (see isGenericCommercialPlay()'s header comment) normalizes
    // to null here -- the same "absence over filler" rule commercialPlay
    // already follows for a missing/empty narrative, just extended to a
    // narrative that is technically present but commercially empty.
    if (narrative && !isGenericCommercialPlay(narrative)) {
      commercialPlay = { narrative };
      const concept = truncateText(rawPlay.concept || rawPlay.title || rawPlay.name || '', 60);
      if (concept) commercialPlay.concept = concept;
    }
  }

  const rawIdeas = Array.isArray(raw.activationIdeas) ? raw.activationIdeas
    : Array.isArray(raw.activation_ideas) ? raw.activation_ideas : [];
  const activationIdeas = [];
  const seenIdeas = new Set();
  for (const idea of rawIdeas) {
    const text = truncateText(idea, 80);
    if (!text || isGenericActivationIdea(text)) continue;
    const key = text.toLowerCase();
    if (seenIdeas.has(key)) continue;
    seenIdeas.add(key);
    activationIdeas.push(text);
    if (activationIdeas.length >= 6) break;
  }

  const rawExpansion = raw.expansionPotential || raw.expansion_potential;
  let expansionPotential = null;
  if (rawExpansion && typeof rawExpansion === 'object') {
    const narrative = truncateText(rawExpansion.narrative || rawExpansion.description || '', 320);
    if (narrative) {
      expansionPotential = { narrative };
      const rawTags = Array.isArray(rawExpansion.tags) ? rawExpansion.tags : [];
      const tags = [...new Set(rawTags.map(t => clean(t).toLowerCase().replace(/[^a-z-]/g, '')).filter(t => EXPANSION_POTENTIAL_TAGS.has(t)))].slice(0, 3);
      if (tags.length) expansionPotential.tags = tags;
    }
  }

  return { commercialPlay, activationIdeas, expansionPotential };
}

// Shared new-schema marker (mirrors dashboard/index.html's identically-named,
// identically-implemented function -- one predicate, defined once per
// runtime, never two independently-drifting copies). True only for a signal
// that actually went through normalizeCommercialIntelligence() above, which
// always attaches activationIdeas as a real array (even []) -- an old
// signal that predates this feature never had these keys at all, so
// Array.isArray() alone reliably tells the two apart.
//
// This is the read-policy distinction QA correction 1 depends on: "new
// schema, no credible play" (commercialPlay: null) must never be treated
// the same as "old signal, legacy fallback is the only thing available."
// The deterministic legacy why-fields (whyThisMatters/whyItMattersForPromo/
// reasonToReachOut) are still populated on a no-play new-schema signal --
// that is required for validateOpportunity()/old code paths to keep
// working -- but a downstream CUSTOMER-FACING commercial surface must call
// this predicate before trusting that text as a real recommendation, not
// read it unconditionally.
function isCommercialIntelligenceSignal(payload = {}) {
  return Array.isArray(payload && payload.activationIdeas) || !!(payload && payload.expansionPotential) || !!(payload && payload.commercialPlay);
}

// ---------------------------------------------------------------------------
// product/commercial-opportunity-intelligence, QA correction round 2
// (historical-event/order-linkage), hardened in QA correction round 4
// (false-positive finding). A narrow, bounded check against an account's
// own uploaded purchase history -- deliberately NOT a fuzzy text/keyword-
// matching engine, and not used anywhere near event identity/fingerprinting/
// dedup. Confidence is judged on date proximity BETWEEN an uploaded
// purchase and the signal's resolved event date, AND, for the 'confident'
// tier specifically, on whether the purchase's own project/category text
// shares a distinctive word with the event's own title/context text:
//   - 'confident': exactly one uploaded purchase within
//     RELATED_PURCHASE_CONFIDENT_WINDOW_DAYS of the event date, AND that
//     purchase's project/category text shares at least one distinctive word
//     with eventContextText. Round 4 finding: date proximity ALONE is not
//     evidence of fulfillment -- an unrelated purchase (e.g. office
//     furniture) that merely happens to land in the same window as a
//     community festival is not "confident" evidence of anything, and must
//     never be treated as such merely because the dates are close. This
//     reuses the same bounded word-overlap technique already established
//     for isPermissionBasedConceptOffer() in dashboard/index.html (a short
//     stopword-style filter, not a new subsystem) rather than adding fuzzy
//     matching. If eventContextText is not supplied by the caller, the
//     'confident' tier can never fire (there is nothing to check overlap
//     against) -- degrading safely to 'ambiguous', never to a wrongly
//     promoted 'confident'.
//   - 'ambiguous': more than one date-candidate within the confident window
//     (which one, if any, is genuinely unclear); a single date-candidate
//     that's close but outside the confident window and inside the wider
//     one; or a single date-candidate within the confident window whose
//     project/category text does NOT overlap with the event context (close
//     in time, but nothing else ties it to this specific event) -- all
//     treated the same as "don't know," never guessed at.
//   - 'none': nothing within the wider window at all.
// This exists solely so the DETERMINISTIC fallback templates (used only
// when the live model doesn't supply its own text) can decide whether it's
// safe to reference an actual supplied item for a recent-past event, or
// must use a neutral, uncertainty-preserving posture instead. The live
// model itself reasons about this directly from the same paired purchase
// data in its own prompt context (see COMMERCIAL_INTELLIGENCE_PROMPT_FRAGMENT) --
// this function is not called on that path.
// ---------------------------------------------------------------------------
const RELATED_PURCHASE_CONFIDENT_WINDOW_DAYS = 21;
const RELATED_PURCHASE_AMBIGUOUS_WINDOW_DAYS = 45;
// Same "strip common words, see what's left" shape as isPermissionBasedConceptOffer()'s
// significantWords() -- a plain word-length filter is enough here since we
// only need to know whether the SAME distinctive word appears in both the
// purchase description and the event description, not classify either one.
function significantWordsForPurchaseMatch(text = '') {
  return String(text || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter(w => w.length > 3);
}
function findLikelyRelatedPurchase(purchases = [], eventDateIso = '', eventContextText = '') {
  const eventDate = parseDate(eventDateIso);
  if (!eventDate || !Array.isArray(purchases) || !purchases.length) return { confidence: 'none', purchase: null };
  const withDistance = purchases
    .map(p => {
      const d = parseDate(p && (p.dateStr || p.date || p.orderDate));
      if (!d) return null;
      return { purchase: p, days: Math.abs((d.getTime() - eventDate.getTime()) / 86400000) };
    })
    .filter(Boolean)
    .sort((a, b) => a.days - b.days);
  if (!withDistance.length) return { confidence: 'none', purchase: null };
  const withinConfident = withDistance.filter(x => x.days <= RELATED_PURCHASE_CONFIDENT_WINDOW_DAYS);
  const withinAmbiguous = withDistance.filter(x => x.days <= RELATED_PURCHASE_AMBIGUOUS_WINDOW_DAYS);
  if (withinConfident.length === 1) {
    const candidate = withinConfident[0].purchase;
    const eventWords = new Set(significantWordsForPurchaseMatch(eventContextText));
    const purchaseWords = significantWordsForPurchaseMatch(`${candidate?.project || ''} ${candidate?.category || ''}`);
    const overlaps = eventWords.size > 0 && purchaseWords.some(w => eventWords.has(w));
    if (overlaps) return { confidence: 'confident', purchase: candidate };
    return { confidence: 'ambiguous', purchase: null };
  }
  if (withinAmbiguous.length) return { confidence: 'ambiguous', purchase: null };
  return { confidence: 'none', purchase: null };
}

function dedupeOpportunities(opportunities = []) {
  const best = new Map();
  for (const o of opportunities) {
    if (!o) continue;
    // GUARDRAIL: same fingerprint inputs as eventFingerprint()'s own
    // guardrail -- commercialPlay/activationIdeas/expansionPotential never
    // participate in this key either.
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
  // Trust correction (identity-bootstrap follow-up): name-scoped, not a bare
  // domain search. account.website is not guaranteed to be an exclusive
  // single-company domain -- it may be a shared/group domain (e.g. derived
  // from a contact's email at a multi-brand dealer group) -- so a bare
  // `site:${domain}` search can surface pages about the domain owner's OTHER
  // businesses just as easily as this account's. Quoting the company name
  // targets exactly the identity-bootstrap evidence this query exists to
  // find (a page on the domain that specifically names this account), and
  // costs nothing extra: this replaces the prior query at the same array
  // position, so query count/architecture is unchanged, and any result the
  // bare-domain version would have found without naming the account would
  // now be rejected by the name-match gate anyway (verifyCandidateCompanyGrounding()).
  if (domain) {
    intents.unshift(['owned', `${q} site:${domain} (news OR press OR events OR careers OR leadership OR awards OR expansion OR launch)`]);
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
// path for api/research-account.js).
//
// Foundation-freeze correction: this comment's "nothing below is wired in
// yet" claim is stale. resolveOpportunityEvents() below has since become
// the SAME canonical event-resolution engine api/research-batch.js calls at
// persistence time, and is shared (via api/save-upload.js's exported bridge
// primitives) by api/weekly-scan.js and api/save-upload.js's own upload
// path too. api/research-account.js's single-account research flow is the
// one caller that still uses clusterCandidates() above, unchanged.
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

// ---------------------------------------------------------------------------
// Final bounded Beta trust correction: ONE canonical event classification
// controls every specific seller-facing interpretation of what happened.
// Both api/research-batch.js and api/research-account.js consume this SAME
// function -- neither maintains its own independent event-family
// classifier. Confirmed production root cause (live QA, Supabase trace):
// api/research-account.js had its own parallel copy of this exact mapping
// job, re-derived from loose free-text regex over signalType+department+
// industry, completely disconnected from the canonical eventType either
// endpoint had already computed -- producing e.g. a canonical
// EVENT_CONFERENCE (Cianbro's Maine CTE Business Summit) rendering Hiring
// seller copy, and a canonical BUSINESS_ACTIVITY_UNKNOWN (BerryDunn's
// veterinary-accounting thought-leadership piece) rendering "Expansion or
// location activity" Facility Launch copy -- neither of which the
// canonical classification itself ever supported.
//
// A generic/unknown canonical label (Acquisition, Rebrand, Business
// Activity, etc.) always maps to null, so every caller falls to its own
// topic-neutral generic fallback rather than asserting a specific claim
// the canonical classification does not support.
function canonicalTemplateFamily(type = '') {
  const t = String(type || '').toLowerCase();
  if (/community/.test(t)) return 'community';
  if (/facility|location|renovation|growth\s*\/\s*expansion/.test(t)) return 'facility';
  if (/trade show|conference|events\s*\/\s*marketing/.test(t)) return 'events';
  if (/hiring/.test(t)) return 'hiring';
  if (/product launch|product\s*\/\s*service/.test(t)) return 'launch';
  if (/award|recognition/.test(t)) return 'award';
  if (/partnership|contract/.test(t)) return 'partnership';
  if (/leadership/.test(t)) return 'leadership';
  return null;
}

// Shared per-family seller-copy metadata, keyed by canonicalTemplateFamily()'s
// own family keys -- the ONE table api/research-account.js's opportunityForSignal()/
// detectDepartment()/contactForSignal() now read from (replacing their own
// independent regex tables), and the same table api/research-batch.js's
// classifyLegacySignalActionability() reads from for its bounded, missing-
// canonicalEventType-only read-time self-heal (see that function's own
// comment). Deliberately generic/topic-neutral for the `null` (unknown/
// generic canonical type) entry -- never a specific claim, matching the
// "generic fallback is fine when classification is uncertain" contract.
const SELLER_COPY_BY_TEMPLATE_FAMILY = {
  events: {
    category: 'Trade Show / Event Support',
    name: 'Trade Show / Event Merchandise Program',
    department: 'Marketing / Events',
    contact: 'Marketing Manager / Events Lead',
    products: ['booth giveaways', 'staff apparel', 'attendee gifts', 'signage'],
    whyNow: 'A public event creates a timely reason to ask about booth traffic, staff presentation, attendee giveaways, and customer follow-up.',
    reasonToReachOut: 'Event activity creates a timely reason to check in',
    conversationStarter: 'Ask whether the upcoming event or campaign needs staff apparel, attendee gifts, or customer-facing merch.'
  },
  facility: {
    category: 'Facility / Location Launch',
    name: 'New Location Launch Kit',
    department: 'Operations / Production',
    contact: 'Operations Manager / Safety Manager / HR Manager',
    products: ['grand opening gifts', 'location-branded apparel', 'employee welcome kits', 'customer gifts'],
    whyNow: 'Expansion or location activity creates a timely reason to ask about launch merchandise, employee gear, and customer-facing gifts.',
    reasonToReachOut: 'Growth activity creates a timely reason to check in',
    conversationStarter: 'Ask whether the growth activity creates any need for launch merch, employee gear, or customer gifts.'
  },
  award: {
    category: 'Recognition / Celebration',
    name: 'Recognition & Celebration Program',
    department: 'Marketing / HR',
    contact: 'Marketing Manager / HR Manager',
    products: ['employee gifts', 'award apparel', 'thank-you kits', 'announcement mailers'],
    whyNow: 'Recognition creates a natural opening to ask about employee celebration, customer announcements, and internal culture moments.',
    reasonToReachOut: 'Recognition creates a timely reason to check in',
    conversationStarter: 'Ask whether there are any employee, customer, or team appreciation moments coming up.'
  },
  leadership: {
    category: 'Leadership Transition',
    name: 'New Leader Welcome / Team Culture Kit',
    department: 'Marketing / HR',
    contact: 'Marketing Manager / HR Manager',
    products: ['welcome gifts', 'team apparel', 'executive gifts', 'internal announcement kits'],
    whyNow: 'Leadership changes create a light-touch reason to ask about internal communication, team culture, or executive gifting.',
    reasonToReachOut: 'Leadership change creates a timely reason to check in',
    conversationStarter: 'Ask whether the leadership change connects to any team engagement, recognition, or internal brand moments.'
  },
  launch: {
    category: 'Product / Service Launch',
    name: 'Product Launch Merchandise Kit',
    department: 'Marketing / Sales',
    contact: 'Marketing Manager / Sales Manager',
    products: ['launch giveaways', 'sales team apparel', 'customer gifts', 'sample kits'],
    whyNow: 'Launch activity creates a timely reason to ask about campaign merchandise, sales enablement, and customer-facing giveaways.',
    reasonToReachOut: 'Launch activity creates a timely reason to check in',
    conversationStarter: 'Ask whether the product or service launch needs any sales, customer, or campaign support.'
  },
  community: {
    category: 'Community / Sponsorship',
    name: 'Community Sponsorship Program',
    department: 'Marketing / Community Relations',
    contact: 'Marketing Manager / Community Relations Lead',
    products: ['event giveaways', 'volunteer apparel', 'banners', 'community gifts'],
    whyNow: 'Community programs often need volunteer apparel, banners, giveaways, sponsor gifts, and simple branded items for attendees or partners.',
    reasonToReachOut: 'Community activity creates a timely reason to check in',
    conversationStarter: 'Ask whether the community program needs volunteer apparel, banners, or sponsor gifts.'
  },
  partnership: {
    category: 'Customer / Partnership Win',
    name: 'Customer Appreciation & Partnership Program',
    department: 'Marketing / Sales',
    contact: 'Marketing Manager / Sales Manager',
    products: ['customer appreciation gifts', 'sales kits', 'executive gifts', 'event giveaways'],
    whyNow: 'Major wins can create needs around employee communication, customer appreciation, launch support, and brand visibility with new stakeholders.',
    reasonToReachOut: 'Partnership activity creates a timely reason to check in',
    conversationStarter: 'Ask whether the new partnership or contract creates any customer-facing or internal recognition needs.'
  },
  hiring: {
    category: 'Employee Onboarding',
    name: 'New Hire Onboarding Program',
    department: 'HR / People',
    contact: 'HR Manager / Department Lead',
    products: ['new hire welcome kits', 'employee apparel', 'drinkware', 'recruiting giveaways'],
    whyNow: 'Hiring creates a timely reason to ask about onboarding, recruiting, and employee welcome programs.',
    reasonToReachOut: 'Hiring creates a timely reason to check in',
    conversationStarter: 'Ask how they are handling onboarding, apparel, or employee experience for new hires.'
  }
};
// Deliberately generic/topic-neutral -- used whenever canonicalTemplateFamily()
// returns null (a generic/unknown canonical type). Mirrors the existing
// generic fallback phrasing already used elsewhere (dashboard/index.html's
// getReasonToReachOutTitle() own final default, "Business signal creates a
// reason to reach out") so a generic classification reads consistently
// across every surface, never a manufactured specific claim.
const GENERIC_SELLER_COPY = {
  category: 'General Business Activity',
  name: 'General Outreach',
  department: 'Relevant department',
  contact: 'Relevant department lead',
  products: ['employee apparel', 'event kits', 'customer appreciation', 'recognition gifts'],
  whyNow: 'This is a real, public business update, though the specific initiative behind it is not yet clear from the evidence. Worth a quick check-in to see what is changing.',
  reasonToReachOut: 'Business signal creates a reason to reach out',
  conversationStarter: 'Ask what is changing internally and whether there is a role for branded merchandise or employee/customer recognition.'
};
function sellerCopyForTemplateFamily(family) {
  return SELLER_COPY_BY_TEMPLATE_FAMILY[family] || GENERIC_SELLER_COPY;
}

function normalizeForMatch(value = '') {
  return clean(value).toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}

// Shared "City, ST" pattern -- used both by extractFromOneField()'s existing
// location extraction and by the trust-correction contradiction check below
// (hasLocationContradiction()), so an explicit place mention is recognized
// identically by both. A fresh RegExp is built per call site rather than one
// shared object, since a global-flag regex's lastIndex is stateful across
// matchAll()/exec() calls and this pattern is used both ways.
//
// Identity-bootstrap live-diagnosis (round 5): every call site wraps this
// pattern in `\b...\b`. A real Firecrawl-scraped iclautos.com dealership
// directory renders the address as "Dover,NH03820" -- comma with no space,
// state immediately fused to a 5-digit ZIP with no space either. Before
// this trailing optional group existed, the wrapping `\b` right after the
// bare `[A-Z]{2}` state capture could never match this exact real-world
// shape: `\b` only fires at a transition between a word char and a non-word
// char, and both "H" (end of "NH") and "0" (start of "03820") are word
// characters, so there is no boundary between them at all -- the state
// capture is a fixed two letters, so the regex has no way to extend past
// "NH" and reach a real boundary. This is exactly why `icl-employee-
// awards.htm` reported globalCityStateMatchCount: 0 despite its raw text
// visibly containing the address. The appended group is optional and non-
// capturing (an already-matching "Dover, NH" with no trailing ZIP is
// completely unaffected -- same two capture groups, same trailing `\b`
// firing on the space/punctuation that already followed it) and only
// recognizes an immediately-adjacent standard 5 (or 5+4) digit US ZIP, with
// zero or one space before it -- covers "Dover,NH03820", "Dover,NH 03820",
// "Dover, NH03820", and the already-working "Dover, NH 03820" identically.
// This is not a loosening of what counts as a state (still exactly two
// capital letters) or a new state-name/locality guessing table -- purely
// closing the one specific `\b`-adjacency gap a real, live scrape proved.
const CITY_STATE_PATTERN = "([A-Z][a-zA-Z]+(?:\\s[A-Z][a-zA-Z]+)?),\\s*([A-Z]{2})(?:\\s?\\d{5}(?:-\\d{4})?)?";

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
  // Final bounded Beta trust correction (Round C): "named"/"promotes"/
  // "appoints" are common, ordinary verbs outside a personnel-appointment
  // sense ("BerryDunn promotes a collaborative culture", "was named a Best
  // Place to Work") -- a bare match on the verb alone, or the verb followed
  // by "as" ANYWHERE later in the concatenated evidence text (title +
  // whatChanged + business_context, joined with plain spaces, not sentence
  // boundaries), previously let an unrelated award/careers page get
  // classified as a leadership appointment merely because "named"/"promote"
  // and "as" both happened to appear somewhere in the combined blob
  // (documented, previously-unfixed limitation: scripts/test-canonical-
  // classification.js's rank-14 Marriott case, "Named No. 1 Best Conference
  // Hotel..." + a later, unrelated "...recognized AS the No. 1...").
  // Genuine appointment language names a real ROLE close to the verb, in
  // the SAME local clause (no sentence-ending punctuation crossed) -- "named
  // CEO", "appointed Jane Smith as Chief Financial Officer", "promoted to
  // Director". "as"/"to" is common ("appointed as CEO") but not required
  // ("appointed Chief Financial Officer effective immediately" is just as
  // genuine) -- the required, narrowing element is the nearby ROLE word
  // itself, the same discipline hasGenuineAcquisitionLanguage() above
  // already applies (verb + a real object, not the bare verb alone).
  const LEADERSHIP_ROLE_WORD = '(?:ceo|cfo|coo|cto|cmo|president|vice[- ]president|vp|chief(?:\\s+\\w+){0,2}\\s+officer|chief|executive director|managing director|general manager|director|partner|principal|chairman|chairwoman|chairperson)';
  const hasGenuineLeadershipLanguage =
    new RegExp(`\\b(?:appoints?|appointed|names?|named|promotes?|promoted|joins|joined|hires?|hired|hiring)\\b[^.!?\\n]{0,50}\\b${LEADERSHIP_ROLE_WORD}\\b`, 'i').test(t);
  if (hasGenuineLeadershipLanguage) {
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
  // doesn't -- classification disagreement no longer blocks the identity
  // merge itself (see the Fingerprint Stability sprint notes on resolveEvents()),
  // but a stable, well-disambiguated type is still what feeds the display
  // label and merge-history metadata, so this precedence still matters
  // (confirmed production case: two
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

function extractFromOneField(t = '', companyNorm = '') {
  if (!t) return { subjectEntity: null, location: null, role: null, anchor: null };
  let subjectEntity = null;
  let location = null;
  let role = null;
  let anchor = null;

  const NON_LOCATION_WORDS = new Set(['new', 'our', 'its', 'their', 'the', 'this', 'next', 'another', 'a', 'an', 'latest', 'newest', 'grand', 'corp', 'inc', 'llc', 'co', 'company', 'corporation', 'ltd']);
  // Proper-noun sequence: 1-5 consecutive capitalized tokens. Used for any entity/place
  // capture, since real place and company names are capitalized and this naturally stops
  // at the first lowercase connector word ("and", "in", "finalized"...) rather than relying
  // on a hand-maintained stop-word list that can silently fail when the actual sentence
  // boundary is farther away than a fixed length cap.
  const PN = "[A-Z][A-Za-z0-9&.'-]*(?:\\s+[A-Z][A-Za-z0-9&.'-]*){0,4}";
  const acquisitionMatch = t.match(new RegExp(`(?:[Aa]cquires?|[Aa]cquired|[Aa]cquisition of|[Cc]ompletes acquisition of|[Ff]inalizes purchase of)\\s+(${PN})`));
  // Founder correction (BerryDunn Careers): "hires"/"hired"/"the hiring of"
  // are just as common a way to phrase a genuine leadership appointment
  // ("BerryDunn hires Carson Hanrahan as Chief Transformation Officer",
  // "the hiring of Carson Hanrahan as Chief Transformation Officer") as
  // "appoints"/"names"/"promotes" -- resolveEventType()'s own
  // hasGenuineLeadershipLanguage() (immediately above) is fixed to
  // recognize "hires"/"hired"/"hiring" as a leadership verb too, but this
  // extractor didn't, so a genuinely correct LEADERSHIP_APPOINTMENT
  // classification still had no way to capture the
  // specific person/role that justified it.
  const appointmentMatch =
    t.match(new RegExp(`(?:[Aa]ppoints?|[Nn]ames?|[Pp]romotes?|[Hh]ires?|[Hh]ired|[Hh]iring of)\\s+(${PN})\\s+as\\s+([A-Za-z0-9&, -]{3,70}?)(?:\\.|,?\\s+effective\\b|$)`)) ||
    t.match(new RegExp(`(${PN})\\s+joins\\s+as\\s+([A-Za-z0-9&, -]{3,70}?)(?:\\.|,?\\s+effective\\b|$)`)) ||
    t.match(new RegExp(`(${PN})\\s+(?:has been |was |is )?(?:appointed|named|promoted to|hired as)\\s+([A-Za-z0-9&, -]{3,70}?)(?:\\.|,?\\s+effective\\b|$)`));
  const facilityInAtMatch = t.match(new RegExp(`(?:facility|branch|office|location|plant)\\s+(?:in|at)\\s+(${PN})`, 'i'));
  const openingLocationMatch = t.match(new RegExp(`(?:grand opening|ribbon cutting|opening|opens?)\\s+(?:of|for)?\\s*(?:its|their|a|the)?\\s*(?:new)?\\s*(?:branch|location|office)?\\s*(?:in|at)\\s+(${PN})`, 'i'));
  const openingOfXLocationMatch = t.match(new RegExp(`(?:grand opening|opening)\\s+of\\s+(?:its|their|a|the)?\\s*(?:new\\s+)?(${PN})\\s+(?:location|branch|office)\\b`, 'i'));
  const possessiveLocationMatch = t.match(new RegExp(`(?:'s|its)\\s+(?:new\\s+)?(${PN})\\s+(?:location|branch|office|plant|facility)\\b`, 'i'));
  const branchNameMatchRaw = t.match(/\b([A-Z][a-zA-Z]{2,30})\s+[Bb]ranch\b/);
  const branchNameMatch = branchNameMatchRaw && !NON_LOCATION_WORDS.has(branchNameMatchRaw[1].toLowerCase()) ? branchNameMatchRaw : null;
  const cityStateMatch = t.match(new RegExp(`\\b${CITY_STATE_PATTERN}\\b`));

  // Fingerprint Stability sprint: bounded distinctive-name anchors for the
  // event categories extractFromOneField() previously had zero coverage for
  // (award/recognition, product launch, rebrand). These are deliberately
  // narrow, named-entity captures -- the award/product/brand's own proper
  // name -- not a broadening of what counts as identity-bearing text.
  //
  // Anchored to a required trigger verb/phrase (wins/receives/recipient of/
  // etc.), not left to match "<proper-noun run> Award" anywhere in the text:
  // a fully title-cased headline ("Dover Honda Wins Presidents Award") would
  // otherwise let PN's greedy proper-noun-sequence swallow the company name
  // and verb along with the award's own name, since every word is
  // capitalized. Requiring the verb first bounds where the proper-noun
  // capture is allowed to start.
  const awardMatchRaw = t.match(new RegExp(`\\b(?:wins?|won|receives?|received|awarded|honored with|honoured with|recognized with|recognised with|recipient of)\\s+(?:the\\s+)?(${PN}\\s+Awards?)\\b`, 'i'));
  const honorMatchRaw = t.match(new RegExp(`\\b(?:wins?|won|receives?|received|awarded|honored with|honoured with|recognized with|recognised with|recipient of|earns?|earned)\\s+(?:the\\s+)?(${PN}\\s+(?:Recognition|Honors?|Honours?))\\b`, 'i'));
  const productNameMatchRaw = t.match(new RegExp(`(?:launches|unveils|introduces)\\s+(?:its\\s+|the\\s+|a\\s+|new\\s+)*(${PN})`, 'i'));
  const productNameMatch = productNameMatchRaw && !NON_LOCATION_WORDS.has(productNameMatchRaw[1].toLowerCase()) ? productNameMatchRaw : null;
  const rebrandNameMatchRaw = t.match(new RegExp(`new\\s+(${PN})\\s+(?:logo|brand identity|brand)\\b`, 'i'));
  const rebrandNameMatch = rebrandNameMatchRaw && !NON_LOCATION_WORDS.has(rebrandNameMatchRaw[1].toLowerCase()) ? rebrandNameMatchRaw : null;
  // Same category as the award/product/rebrand anchors above -- a sponsorship
  // or participation names a specific, real, recurring program/event (e.g.
  // "lead Platinum Sponsor for the 2026 Dover Holiday Parade" -> "Dover
  // Holiday Parade"), which is exactly the kind of distinctive, stable named
  // entity this sprint's anchor concept exists to capture -- discovered
  // during implementation via a real refresh-reliability regression test for
  // a community-sponsorship event with no other anchor candidate.
  const sponsorshipNameMatchRaw = t.match(new RegExp(`sponsor(?:ship)?\\s+(?:for|of)\\s+(?:the\\s+)?(?:\\d{4}\\s+)?(${PN})`, 'i'));
  const sponsorshipNameMatch = sponsorshipNameMatchRaw && !NON_LOCATION_WORDS.has(sponsorshipNameMatchRaw[1].toLowerCase()) ? sponsorshipNameMatchRaw : null;
  // Fingerprint Stability sprint, correction round: the reversed word order
  // ("Dover Honda Signs on as Dover Holiday Parade Sponsor") is at least as
  // common as "sponsor for/of X" above -- confirmed against the real Dover
  // Chamber source article this sprint's Preview QA round surfaced. The
  // proper-noun run is captured directly before the trailing "Sponsor(s)"
  // word; PN's own greediness naturally skips over an unrelated leading
  // capitalized run (e.g. the company name) whenever it's broken by a
  // lowercase connector ("Signs on as"). When there is no such break (e.g.
  // "Acme Corp Named City Marathon Sponsor" -- every word capitalized), PN
  // greedily includes the company name in its capture; stripLeadingCompany()
  // below trims a leading company-name match off the captured text before
  // it's used as the anchor, the same "never let the company's own name
  // stand in for a distinctive anchor" principle already applied to
  // acquisitionMatch/appointmentMatch above.
  const sponsorshipReversedMatchRaw = t.match(new RegExp(`(${PN})\\s+[Ss]ponsors?\\b`));
  const sponsorshipReversedMatch = sponsorshipReversedMatchRaw && !NON_LOCATION_WORDS.has(sponsorshipReversedMatchRaw[1].toLowerCase()) ? sponsorshipReversedMatchRaw : null;
  const stripLeadingCompany = (captured) => {
    if (!companyNorm) return captured;
    const words = captured.trim().split(/\s+/);
    const companyWordCount = companyNorm.split(/\s+/).length;
    if (words.length > companyWordCount && normalizeForMatch(words.slice(0, companyWordCount).join(' ')) === companyNorm) {
      return words.slice(companyWordCount).join(' ');
    }
    return captured;
  };

  const trimTrailingPunct = (s) => s ? s.replace(/[.,;:]+$/, '').trim() : s;
  if (acquisitionMatch) subjectEntity = trimTrailingPunct(acquisitionMatch[1].trim());
  if (appointmentMatch) { subjectEntity = trimTrailingPunct(appointmentMatch[1].trim()); role = appointmentMatch[2].trim(); }

  if (facilityInAtMatch) location = trimTrailingPunct(facilityInAtMatch[1].trim());
  else if (openingOfXLocationMatch) location = trimTrailingPunct(openingOfXLocationMatch[1].trim());
  else if (openingLocationMatch) location = trimTrailingPunct(openingLocationMatch[1].trim());
  else if (possessiveLocationMatch) location = trimTrailingPunct(possessiveLocationMatch[1].trim());
  else if (cityStateMatch) location = `${cityStateMatch[1]}, ${cityStateMatch[2]}`;
  else if (branchNameMatch) location = trimTrailingPunct(branchNameMatch[1].trim());

  // Distinctive-entity anchor: computed independently of the `location`
  // display field's priority chain above (never derived from cityStateMatch),
  // so a genuine facility/branch name (e.g. "Westborough Branch") is never
  // masked by a bare "City, ST" pattern also present in the same text, and a
  // bare city/state is never promoted to identity-bearing status. This is
  // the fingerprint's identity-bearing field; `location` remains display/
  // corroboration metadata only.
  //
  // An acquisition/appointment capture that merely restates the company's
  // own name (e.g. passive "Dover Honda was named as a recipient of the
  // Presidents Award" -> subjectEntity="Dover Honda") is skipped for anchor
  // purposes -- it adds no discriminating power over the company field
  // itself -- so the chain falls through to a genuinely distinctive anchor
  // (the award's own name) later in the same sentence, rather than masking
  // it. subjectEntity/role above are unaffected; this only changes what
  // counts as the identity-bearing anchor.
  const isCompanyRedundant = (s) => companyNorm && normalizeForMatch(s) === companyNorm;
  if (acquisitionMatch && !isCompanyRedundant(acquisitionMatch[1])) anchor = trimTrailingPunct(acquisitionMatch[1].trim());
  else if (appointmentMatch && !isCompanyRedundant(appointmentMatch[1])) anchor = trimTrailingPunct(appointmentMatch[1].trim());
  else if (facilityInAtMatch) anchor = trimTrailingPunct(facilityInAtMatch[1].trim());
  else if (openingOfXLocationMatch) anchor = trimTrailingPunct(openingOfXLocationMatch[1].trim());
  else if (openingLocationMatch) anchor = trimTrailingPunct(openingLocationMatch[1].trim());
  else if (possessiveLocationMatch) anchor = trimTrailingPunct(possessiveLocationMatch[1].trim());
  else if (branchNameMatch) anchor = trimTrailingPunct(branchNameMatch[1].trim());
  else if (awardMatchRaw) anchor = trimTrailingPunct(awardMatchRaw[1].trim());
  else if (honorMatchRaw) anchor = trimTrailingPunct(honorMatchRaw[1].trim());
  else if (sponsorshipNameMatch) anchor = trimTrailingPunct(sponsorshipNameMatch[1].trim());
  else if (sponsorshipReversedMatch) anchor = trimTrailingPunct(stripLeadingCompany(sponsorshipReversedMatch[1].trim()));
  else if (productNameMatch) anchor = trimTrailingPunct(productNameMatch[1].trim());
  else if (rebrandNameMatch) anchor = trimTrailingPunct(rebrandNameMatch[1].trim());

  return { subjectEntity, location, role, anchor };
}

// Runs extraction on each field SEPARATELY (never on a blind concatenation of
// title+snippet+rawContent) and takes the first field that yields a value, per
// sub-field. This avoids a permissive capture group in one field silently
// extending across the boundary into an unrelated adjacent field's text.
function extractEventEntities(title = '', snippet = '', rawContent = '', companyNorm = '') {
  const fields = [clean(title), clean(snippet), clean(rawContent)].filter(Boolean);
  let subjectEntity = null, location = null, role = null, anchor = null;
  for (const f of fields) {
    const r = extractFromOneField(f, companyNorm);
    if (!subjectEntity && r.subjectEntity) subjectEntity = r.subjectEntity;
    if (!location && r.location) location = r.location;
    if (!role && r.role) role = r.role;
    if (!anchor && r.anchor) anchor = r.anchor;
    if (subjectEntity && location && role && anchor) break;
  }
  if (!subjectEntity && location) subjectEntity = location;
  return {
    subjectEntity: subjectEntity ? subjectEntity.slice(0, 60) : null,
    location: location ? location.slice(0, 60) : null,
    role: role ? role.slice(0, 70) : null,
    anchor: anchor ? anchor.slice(0, 60) : null
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

// Fingerprint Stability sprint, correction round -- identity-critical date
// parsing. `new Date("November 29, 2026")` (or any non-ISO textual date
// format) is parsed by the JS Date constructor in the RUNTIME'S LOCAL
// TIMEZONE, unlike an ISO date-only string ("2026-11-29"), which the spec
// requires to be parsed as UTC. Two research runs of the exact same source
// text, executed under different server timezones (or the same server
// across a DST change), could therefore extract calendar-date components
// that are only hours apart in absolute time but land on different sides of
// a UTC-vs-local day boundary -- directly undermining fingerprint stability,
// since v2 fingerprints now carry the exact date as identity. Every textual
// (non-ISO) calendar date used for event identity must be constructed via
// explicit UTC components (Date.UTC) instead of handed to `new Date(text)`,
// so the same input text always resolves to the same calendar day
// regardless of the server's TZ.
const MONTH_INDEX_BY_FULL_NAME = {
  January: 0, February: 1, March: 2, April: 3, May: 4, June: 5,
  July: 6, August: 7, September: 8, October: 9, November: 10, December: 11
};
// Foundation freeze, Phase 1D: days-in-month lookup (leap-year aware) used
// to REJECT an impossible calendar date (September 31, April 31, February 29
// in a non-leap year) rather than silently rolling it over to the next
// month -- Date.UTC() itself has no concept of an invalid day, it just
// normalizes past month-end, which would otherwise turn a mis-parsed or
// malformed date into a stable-but-wrong value baked directly into the
// persisted v2 event fingerprint (exact date is identity-bearing there).
function isLeapYear(year) {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}
function daysInMonth(year, monthIndex) {
  const DAYS = [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return DAYS[monthIndex];
}
function parseCalendarDateUTC(monthNameRaw, day, year) {
  const monthName = normalizeMonthName(monthNameRaw) || monthNameRaw;
  const monthIndex = MONTH_INDEX_BY_FULL_NAME[monthName];
  if (monthIndex === undefined) return null;
  const y = Number(year);
  const d = Number(day);
  if (!Number.isFinite(y) || !Number.isFinite(d) || d < 1 || d > daysInMonth(y, monthIndex)) return null;
  const parsed = new Date(Date.UTC(y, monthIndex, d));
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

// Foundation freeze, Phase 1C: a calendar-date difference (e.g. "how many
// days until/since this event") must compare UTC-midnight-normalized values
// on BOTH sides, never a calendar date against a real wall-clock instant
// carrying its own time-of-day -- mixing the two makes the result depend on
// what time of day the comparison happens to run, not on the actual
// difference in calendar days (confirmed production-adjacent defect:
// formatSignalAge()'s test in scripts/test-temporal-integrity-fixtures.js
// flips between floor/round agreement depending on time of day; the same
// mixture in computeActionability() below can misclassify a same-day exact
// event as 'recent-past' instead of 'upcoming' depending on time of day).
// Positive when `laterDate` is chronologically after `earlierDate`. This is
// the one authoritative backend implementation; dashboard/index.html
// (browser-loaded inline script, cannot import this module) carries a
// mirrored implementation -- see formatSignalAge()'s own comment there.
function calendarDaysBetween(laterDate, earlierDate) {
  const utcMidnight = (d) => Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  return Math.round((utcMidnight(laterDate) - utcMidnight(earlierDate)) / 86400000);
}

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
  const isoMatches = Array.from(t.matchAll(/\b(20\d{2}-\d{2}-\d{2})\b/g));
  const isoPubMatch = isoMatches.find(m => isPublicationDateContext(t, m.index));
  if (isoPubMatch) {
    // ISO date-only strings are UTC-anchored by spec -- parseDate() is safe here.
    const parsed = parseDate(isoPubMatch[1]);
    if (parsed) return parsed.toISOString().slice(0, 10);
  }
  const monthDayYearMatches = Array.from(t.matchAll(/\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),?\s+(20\d{2})\b/gi));
  const monthPubMatch = monthDayYearMatches.find(m => isPublicationDateContext(t, m.index));
  if (monthPubMatch) {
    const parsed = parseCalendarDateUTC(monthPubMatch[1], monthPubMatch[2], monthPubMatch[3]);
    if (parsed) return parsed.toISOString().slice(0, 10);
  }
  return null;
}

function extractEventDate(text = '') {
  const t = clean(text);
  const isoMatch = firstNonPublicationMatch(t, /\b(20\d{2}-\d{2}-\d{2})\b/g);
  const monthDayYear = firstNonPublicationMatch(t, /\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),?\s+(20\d{2})\b/gi);
  // Common date-range phrasing ("September 18-20, 2026", "September 18–20,
  // 2026", "Sep. 18 through 20, 2026") -- extractEventDate() previously only
  // matched a single day, so a real, explicit range like an L.L.Bean grand
  // opening ("September 18-20, 2026") silently fell through to "unknown"
  // and rendered as "Date unavailable" despite naming an exact date. The
  // anchor date used for all upcoming/recent/stale math is the FIRST day of
  // the range (when the event begins); displayEventDate preserves the full,
  // human-readable range text for rendering.
  const rangeMatch = t.match(DATE_RANGE_RE);
  const monthYear = t.match(/\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(20\d{2})\b/i);
  const hasEventLanguage = /\b(on|opens?|opened|opening|effective|held|takes place|scheduled for|will open)\b/i.test(t);

  // Identity-critical: every non-ISO branch below constructs its Date via
  // parseCalendarDateUTC() (explicit UTC components), never by handing
  // textual "Month D, YYYY" content to `new Date()` -- see that helper's
  // header comment for why the naive form is environment-dependent. The
  // ISO branch is exempt: a bare "YYYY-MM-DD" string is UTC-anchored by the
  // language spec itself, so parseDate() (a thin `new Date()` wrapper) is
  // already safe there.
  let parsed = null;
  let display = null;
  let confidence = 'unknown';
  if (isoMatch) {
    parsed = parseDate(isoMatch[1]);
    confidence = 'exact';
  } else if (monthDayYear) {
    parsed = parseCalendarDateUTC(monthDayYear[1], monthDayYear[2], monthDayYear[3]);
    confidence = 'exact';
  } else if (rangeMatch) {
    const monthName = normalizeMonthName(rangeMatch[1]);
    const [, , day1, day2, year] = rangeMatch;
    if (monthName) {
      parsed = parseCalendarDateUTC(monthName, day1, year);
      confidence = 'exact';
      display = `${monthName} ${day1}–${day2}, ${year}`;
    }
  } else if (monthYear && hasEventLanguage) {
    parsed = parseCalendarDateUTC(monthYear[1], 1, monthYear[2]);
    confidence = 'approximate';
  }

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

// Deterministic, non-cryptographic string hash (FNV-1a) -- same algorithm
// api/save-upload.js's hashString() already uses for signal_hash. Used only
// to compress the fallback-discriminator evidence bundle into a fixed-width
// token; never a source of identity on its own, always paired with a scoped
// prefix (src:/dom:/ev:) below.
function stableHash(input = '') {
  let h = 2166136261;
  const s = String(input || '');
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(16);
}

// Fingerprint Stability sprint -- non-empty fallback discriminator for an
// event that produced no distinctive anchor. Ordered, deterministic evidence
// bundle: source-derived per-candidate material first (rawTitle/rawSnippet --
// never the shared pageContent/rawContent blob, which is identical for every
// event sourced from the same fetched URL and would defeat discrimination
// between two genuinely different events on one page), model-authored fields
// only as a last-resort supplement. Instability in the model-authored tier
// is an accepted tradeoff: it produces a fresh discriminator (a tolerated
// duplicate on rediscovery), never a collision with a deliberately-separate
// event -- the required failure direction per this sprint's false-separation-
// over-false-merge policy. Never returns an empty discriminator: normalized
// URL, then domain, then a hash of the evidence bundle itself are always
// available for anything that reached persistence.
function fallbackEventDiscriminator(ev, primaryCandidate = {}) {
  const normalizedUrl = normalizeUrl(ev.evidence?.[0]?.url || primaryCandidate.url || primaryCandidate.sourceUrl || '');
  const bundle = [
    clean(primaryCandidate.rawTitle || ''),
    clean(primaryCandidate.rawSnippet || ''),
    ev.identity.dateConfidence === 'exact' ? (ev.identity.eventDate || '') : '',
    clean(primaryCandidate.concreteTrigger || primaryCandidate.concrete_trigger || ''),
    clean(primaryCandidate.whatChanged || ''),
    clean(primaryCandidate.signalTitle || primaryCandidate.headline || primaryCandidate.title || '')
  ].filter(Boolean).map(normalizeForMatch).join('|');
  if (normalizedUrl) return `src:${normalizedUrl}|${stableHash(bundle || normalizedUrl)}`;
  const domain = sourceDomain(primaryCandidate.url || primaryCandidate.sourceUrl || '');
  if (domain) return `dom:${domain}|${stableHash(bundle || domain)}`;
  return `ev:${stableHash(bundle || JSON.stringify(ev.evidence || []))}`;
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
    const companyDisplay = clean(c.companyName || c.accountName || '');
    const company = normalizeCompany(companyDisplay);
    // Fingerprint Stability sprint: prefer source-derived per-candidate text
    // (rawTitle/rawSnippet, threaded through by resolveOpportunityEvents())
    // over model-authored title/snippet when both are available -- the
    // model re-synthesizes headline/whatChanged wording on every research
    // run, while rawTitle/rawSnippet reflect the actual fetched source.
    // Falls back to the existing fields when raw text wasn't captured, so
    // behavior is unchanged for any caller that never threads raw text
    // through (e.g. api/weekly-scan.js's plain search-result candidates).
    // company is passed through so an appointment/acquisition-style capture
    // that merely restates the company's own name (e.g. "Dover Honda was
    // named as a recipient of the Presidents Award" -> subjectEntity="Dover
    // Honda") is never used AS the anchor -- it adds no discriminating power
    // over the company field itself, and would otherwise mask a genuinely
    // distinctive anchor (the award's own name) present later in the same
    // sentence.
    const { subjectEntity, location, role, anchor } = extractEventEntities(
      c.rawTitle || c.title || c.headline || '',
      c.rawSnippet || c.snippet || '',
      c.rawContent || c.pageContent || '',
      company
    );
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
    const year = dateYear || extractYearFallback(text, c.publishedAt);

    const candidateIdentity = {
      company, companyDisplay,
      candidateTypes: typeInfo.candidateTypes,
      recurring: typeInfo.recurring,
      subjectEntity, location, role, anchor,
      eventDate, dateConfidence, year,
      normalizedUrl: normalizeUrl(c.url || c.sourceUrl || ''),
      evidenceText: text
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

    // Fingerprint Stability sprint: canonical-type agreement (typesCompatible())
    // is no longer the merge gate -- classification is proven unstable across
    // reruns (the same real event can be classified REBRAND one run and
    // PRODUCT_LAUNCH the next) and must not decide identity. Replaced with a
    // conservative anchor/same-URL rule: a distinctive named-entity anchor
    // (award/product/rebrand/facility name -- never bare city/state) is the
    // primary merge evidence; a shared exact source URL is the only fallback
    // bridge, and only when at least one side carries some anchor and both
    // agree on an exact event date. Bare location/date/domain agreement alone
    // never establishes identity -- false separation (a tolerated duplicate)
    // is preferred over a false merge throughout this loop.
    let matched = null;
    for (const ev of events) {
      const id = ev.identity;
      if (id.company !== company || !company) continue;

      // Recurring event types (annual awards/conferences/etc.) require an
      // exact-year match to merge -- but only when BOTH sides actually have
      // a resolved year. An undated representation is missing evidence, not
      // conflicting evidence (the same positive-agreement-vs-absence-of-
      // conflict principle used throughout this loop), and must not block a
      // merge a genuine anchor match already establishes.
      if (RECURRING_EVENT_TYPES.has(id.candidateTypes[0]) || candidateIdentity.recurring) {
        if (id.year && candidateIdentity.year && id.year !== candidateIdentity.year) continue;
      }

      const explicitLocationConflict = id.location && candidateIdentity.location && !locationsAgree(id.location, candidateIdentity.location);
      const candAnchor = candidateIdentity.anchor ? normalizeForMatch(candidateIdentity.anchor) : '';
      const idAnchor = id.anchor ? normalizeForMatch(id.anchor) : '';

      if (candAnchor && idAnchor) {
        // Both sides carry a distinctive anchor: two different anchors are two
        // different events by definition -- URL/date/location agreement never
        // overrides a genuine anchor disagreement.
        if (candAnchor !== idAnchor) continue;
        if (explicitLocationConflict) continue;
        matched = ev;
        break;
      }

      // Fewer than two agreeing anchors: the only remaining path is the
      // same-URL bridge, gated by exact-date agreement (Guardrail 2). When
      // NEITHER side has an anchor at all, exact date + shared URL alone is
      // still not enough on its own -- two unrelated candidates can share a
      // page and a publication date (see case 7 below) -- so this branch
      // additionally requires the underlying evidence text to materially
      // agree (materiallyRepeats(), the same corroboration-strength check
      // classifyCorroboration() already uses elsewhere in this file), which
      // is what "no conflicting evidence" means when there is no anchor to
      // conflict on. One side carrying a real anchor is already strong
      // enough evidence on its own and skips this extra text check.
      const sameUrl = candidateIdentity.normalizedUrl && id.normalizedUrl && candidateIdentity.normalizedUrl === id.normalizedUrl;
      if (!sameUrl || explicitLocationConflict) continue;

      const exactDateAgree = candidateIdentity.dateConfidence === 'exact' && id.dateConfidence === 'exact'
        && candidateIdentity.eventDate && id.eventDate && candidateIdentity.eventDate === id.eventDate;
      if (!exactDateAgree) continue;

      if (!candAnchor && !idAnchor && !materiallyRepeats(candidateIdentity.evidenceText, id.evidenceText)) continue;

      matched = ev;
      break;
    }

    if (matched) {
      evidenceItem.corroboration = classifyCorroboration(evidenceItem, matched.evidence);
      matched.evidence.push(evidenceItem);
      const intersectedTypes = matched.identity.candidateTypes.filter(t => candidateIdentity.candidateTypes.includes(t));
      // Type is refreshable display metadata, not identity -- when merged
      // evidence genuinely disagrees on classification (exactly the drift
      // this sprint fixes), keep the event's existing display type rather
      // than collapsing to an empty/generic fallback.
      matched.identity.candidateTypes = intersectedTypes.length ? intersectedTypes : matched.identity.candidateTypes;
      if (!matched.identity.location && candidateIdentity.location) matched.identity.location = candidateIdentity.location;
      if (!matched.identity.subjectEntity && candidateIdentity.subjectEntity) matched.identity.subjectEntity = candidateIdentity.subjectEntity;
      if (!matched.identity.role && candidateIdentity.role) matched.identity.role = candidateIdentity.role;
      if (!matched.identity.anchor && candidateIdentity.anchor) matched.identity.anchor = candidateIdentity.anchor;
      if (!matched.identity.normalizedUrl && candidateIdentity.normalizedUrl) matched.identity.normalizedUrl = candidateIdentity.normalizedUrl;
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
      companyNorm: ev.identity.company,
      eventType: primaryType,
      candidateTypes: ev.identity.candidateTypes,
      subjectEntity: ev.identity.subjectEntity,
      location: ev.identity.location,
      anchor: ev.identity.anchor || null,
      eventDate: ev.identity.eventDate,
      dateConfidence: ev.identity.dateConfidence,
      // Fingerprint Stability sprint, correction round: exposed so callers
      // outside resolveEvents() (specifically api/save-upload.js's legacy
      // compatibility bridge) can compare identity components directly
      // rather than requiring full event_fingerprint string equality, which
      // is too strict for reconciling an incomplete legacy payload against a
      // fully-resolved fresh one.
      year: ev.identity.year || null,
      normalizedUrl: ev.identity.normalizedUrl || null,
      evidenceText: ev.identity.evidenceText || '',
      canonicalTitle: title,
      titleSource
    };

    const flatSources = ev.evidence.map(e => ({ name: e.sourceName, url: e.url, publishedAt: e.publishedDate || '' }));
    // GUARDRAIL: company/anchor(or fallback discriminator)/date-or-year only --
    // see eventFingerprint()'s guardrail comment above. commercialPlay/
    // activationIdeas/expansionPotential must never enter this identity key.
    // canonicalEventType is deliberately EXCLUDED (v1 included it; proven
    // unstable across reruns -- see Fingerprint Stability sprint design docs).
    // The discriminator segment is never empty: a distinctive anchor when one
    // extracted, otherwise the non-empty fallbackEventDiscriminator() chain.
    const discriminator = ev.identity.anchor
      ? `a:${normalizeForMatch(ev.identity.anchor)}`
      : fallbackEventDiscriminator(ev, primaryCandidate);
    const temporalAnchor = ev.identity.dateConfidence === 'exact' && ev.identity.eventDate ? ev.identity.eventDate : (ev.identity.year || 'unknown');
    const fingerprint = `v2|${ev.identity.company}|${discriminator}|${temporalAnchor}`;

    // Trust correction: identityConfidence must be the STRONGEST verdict among
    // every candidate merged into this event, never just whichever candidate
    // happened to have the highest (unrelated) candidateScore. Two write-ups
    // of the same real event independently corroborate each other -- exactly
    // the "independently corroborated sources" case the trust policy treats
    // as sufficient to confirm -- so one confirmed candidate must be able to
    // lift the merged event even if a higher-candidateScore but unconfirmed
    // write-up of the same event also exists. Falls back to the primary
    // candidate's own value (or undefined, for callers/candidates that predate
    // identityConfidence) when nothing in the group is explicitly confirmed.
    const identityConfidence = ev.candidates.some(c => c.identityConfidence === 'confirmed') ? 'confirmed'
      : ev.candidates.some(c => c.identityConfidence === 'unconfirmed') ? 'unconfirmed'
      : primaryCandidate.identityConfidence;

    // Founder correction (BerryDunn Careers evidence provenance): `title`
    // above is already the BEST available seller-facing title --
    // generateCanonicalTitle() prefers a specifically extracted event
    // ("Carson Hanrahan Appointed Chief Transformation Officer") built from
    // identity.subjectEntity/role, and only falls back to the source's own
    // (cleaned) headline when no such extraction succeeded. The code below
    // previously did the opposite: it always preferred the RAW candidate's
    // own title/headline -- the container/aggregator/profile page's own
    // title (e.g. "BerryDunn - Careers") -- and only used the generated
    // title as an unreachable last resort, silently discarding it into the
    // canonicalTitle field below that nothing ever read. Confirmed
    // production case: HA correctly classified a BerryDunn careers page's
    // embedded Chief Transformation Officer hire as LEADERSHIP_APPOINTMENT
    // (classification was never wrong), but "What changed"/How to
    // Approach/Prepare for Call all rendered the generic "BerryDunn -
    // Careers" container title instead of the specific grounded event that
    // justified the classification. Only overrides when a real extraction
    // succeeded (titleSource === 'generated') -- when nothing was
    // extractable, the prior candidate-title-first behavior is unchanged.
    const preferGeneratedTitle = titleSource === 'generated';
    return {
      ...primaryCandidate,
      title: preferGeneratedTitle ? title : (primaryCandidate.title || primaryCandidate.headline || title),
      headline: preferGeneratedTitle ? title : (primaryCandidate.headline || primaryCandidate.title || title),
      url: bestEvidence?.url || primaryCandidate.url,
      sourceName: bestEvidence?.sourceName || primaryCandidate.sourceName,
      publishedAt: bestEvidence?.publishedDate || primaryCandidate.publishedAt || '',
      eventFingerprint: fingerprint,
      corroboratingCandidates: ev.evidence.length,
      sources: flatSources,
      canonicalTitle: title,
      eventIdentity,
      evidence: ev.evidence,
      identityConfidence
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
// (per-title-token, computed once per candidate within THIS request) is
// left untouched for intra-request plumbing (e.g. matching an opportunity
// back to its source candidate).
//
// Foundation-freeze correction: normalizeOpportunity()'s eventFingerprint
// was previously labeled "legacy" here, which conflates two unrelated
// things named "legacy" elsewhere in this codebase: this is a fresh,
// per-title-token value computed EVERY request purely for same-request
// candidate matching, and never persisted as event_fingerprint -- it has
// nothing to do with a "legacy" pre-v2 DB row (api/save-upload.js's
// fetchLegacySignalsForAccounts()/applyLegacyFingerprintBridge(), the v1->v2
// compatibility bridge for rows already written to the database).
// ---------------------------------------------------------------------------
function resolveOpportunityEvents(opportunities = []) {
  const candidates = (opportunities || []).filter(Boolean).map(o => ({
    ...o,
    title: o.headline || o.signalTitle || '',
    snippet: o.whatChanged || o.businessContext || '',
    // Fingerprint Stability sprint: thread source-derived raw text through
    // (populated by normalizeOpportunity() when it has a raw candidate to
    // read from) so anchor extraction and the fallback discriminator can
    // prefer it over model-authored title/snippet. Absent for callers that
    // never had raw candidate text -- falls back to today's behavior.
    rawTitle: o.rawTitle || '',
    rawSnippet: o.rawSnippet || '',
    rawContent: o.rawContent || o.pageContent || '',
    url: o.sourceUrl || (Array.isArray(o.sources) && o.sources[0]?.url) || '',
    candidateScore: Number(o.commercialScore || o.whyNowScore || o.why_now_score || o.confidenceScore || 0)
  }));
  return resolveEvents(candidates).map(ev => ({
    ...ev,
    headline: ev.headline || ev.title,
    // Founder correction (BerryDunn Careers evidence provenance): ev's own
    // `...primaryCandidate` spread (inside resolveEvents()'s return) can
    // still carry the ORIGINAL, un-fixed opportunity's own signalTitle
    // field (e.g. the raw "BerryDunn - Careers" container-page title) --
    // that field is never touched by resolveEvents()'s title/headline fix
    // above, so preferring it here would silently reintroduce the exact
    // container-title leak that fix closes. ev.headline/ev.title are
    // already the best available seller-facing title (specifically
    // extracted when possible); signalTitle must agree with them, not with
    // a stale, unrelated field carried through the spread.
    signalTitle: ev.headline || ev.title,
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
  SIGNAL_FAMILIES, clean, normalizeCompany, isSingleTokenCompanyIdentity, isExactSelfDomainMatch, registrableDomainSld, normalizeUrl, normalizeTitle, sourceDomain,
  classifySignalFamily, signalSubtype, displaySignalType, sourceAuthority, freshnessScore,
  entityMatch, verifyCandidateCompanyGrounding, hasDistinctiveNameFallbackMatch, distinctiveCompanyTokens,
  isEntityEmbeddedInLargerName, isStandaloneSingleTokenMention, isExactSelfSocialHandleMatch,
  isSocialUrl, socialProfileMatchesCompany, accountKnownSocialProfileMatch, accountCityStateGeoTokens, hasLocationContradiction, extractCityStatePairs,
  deriveAccountLocationFromContent, diagnoseAccountLocationExtraction,
  eventFingerprint, commercialScore, normalizeCandidate, clusterCandidates,
  normalizeOpportunity, validateOpportunity, dedupeOpportunities, buildQueryPlan, materiallyRepeats,
  RECURRING_EVENT_TYPES, resolveEventType, extractEventEntities, extractEventDate,
  findPublicationContextDate,
  classifyCorroboration, generateCanonicalTitle, resolveEvents,
  resolveOpportunityEvents, dedupeByEventFingerprint,
  fallbackEventDiscriminator, stableHash, normalizeForMatch,
  calendarDaysBetween,
  EVENT_TYPE_DISPLAY_LABELS, displayLabelForEventType, canonicalTemplateFamily, sellerCopyForTemplateFamily,
  COMMERCIAL_INTELLIGENCE_PROMPT_FRAGMENT, EXPANSION_POTENTIAL_TAGS,
  normalizeCommercialIntelligence, isGenericActivationIdea, truncateText,
  isCommercialIntelligenceSignal, findLikelyRelatedPurchase, isGenericCommercialPlay
};
