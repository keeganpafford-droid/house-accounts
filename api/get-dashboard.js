// Vercel Serverless Function: retrieve the saved House Accounts dashboard
// for the authenticated caller. Endpoint: GET /api/get-dashboard
// Requires a valid Supabase Auth Bearer token -- identity is resolved ONLY
// from that token (see resolveDashboardUser() below), never from a query
// parameter. An optional ?email= is accepted for backwards-compatible
// request shape but has no effect on identity/authorization.

// QA round 2, item 1: this is the single canonical read boundary where every
// signal row -- fresh or legacy -- gets its actionability metadata
// normalized (see rowToSignal() below), before it ever reaches the
// dashboard client. classifyLegacySignalActionability() is a pure function:
// it never mutates the stored row, and it returns fresh signals' own
// metadata unchanged.
import { classifyLegacySignalActionability } from './research-batch.js';
// Monitoring Identity V1: the ONE centralized priority/secondary/hidden
// policy -- see api/lib/monitoring-identity.js's own header comment. Every
// consumer of identity-gated signal visibility (this file, the weekly
// digest, and the live-research dashboard client) must call this same
// function, not invent its own trust rule.
import { classifyMonitoringSignalEligibility, buildTargetIdentityIndex, lookupTargetIdentity } from './lib/monitoring-identity.js';
// Follow-up temporal-integrity round (Preview QA): buildAccountsFromRows()
// below assembles each account's futureOpportunities from TWO independent
// sources -- the already-canonicalized snapshot stored on the account row
// (raw_data.existingSignals, written by resolveOpportunityEvents() at
// weekly-scan.js/save-upload.js persistence time) and a fresh
// signalToOpportunity() built from EVERY row still in ha_signals (deduped
// only WITHIN itself, by uniqueSignalRows()'s title-text key) -- with no
// dedup pass EVER run BETWEEN the two sources. A signal whose event was
// already canonicalized into the snapshot can therefore also survive as its
// own raw ha_signals row and reappear a second time, under whatever generic
// title it happened to be stored with (confirmed production case: Dispatch
// Goods' Santa Cruz Ventures investment rendering as both the primary
// Verified Opportunity and, under a classification-fallback title, an
// Additional Opportunity). resolveOpportunityEvents() is the SAME canonical
// event-resolution engine already used at persistence time -- reusing it
// here, once, on the complete combined candidate set for each account
// (before the payload is ever split into primary/Additional/Research
// Details/Recently Researched on the client) is the single shared
// canonicalization boundary this round's forensic review required.
import { resolveOpportunityEvents } from './signal-intelligence.js';

function json(res, status, body){ return res.status(status).json(body); }
function clean(v=''){ return String(v || '').trim(); }
function env(){
  const rawUrl = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if(!rawUrl || !key) throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  const url = String(rawUrl).trim().replace(/\/+$/, '').replace(/\/rest\/v1$/i, '');
  return {url, key};
}
async function supabase(path, options={}){
  const {url, key} = env();
  const resp = await fetch(`${url}/rest/v1/${path}`, {
    ...options,
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      Prefer: options.prefer || 'return=representation',
      ...(options.headers || {})
    }
  });
  const text = await resp.text();
  let data = null;
  if(text){ try{ data = JSON.parse(text); } catch { data = text; } }
  if(!resp.ok){
    const msg = typeof data === 'string' ? data : (data?.message || data?.hint || JSON.stringify(data));
    throw new Error(`Supabase ${resp.status}: ${msg}`);
  }
  return data;
}

// Release blocker fix: this used to fall back to resolving ha_users
// directly from the untrusted ?email= query parameter whenever the Bearer
// token was missing or didn't resolve to a matching ha_users row -- a
// request with NO token (or an invalid/expired one) could still retrieve
// another user's dashboard data by supplying their email. authFetchUser()
// now returns a distinguishable {ok, reason} result instead of a bare
// user-or-null, and resolveDashboardUser() below never reads the email
// query parameter at all -- identity comes ONLY from a verified Supabase
// Auth Bearer token, exactly like api/monitoring-lists.js's authUser()/
// context() already do.
async function authFetchUser(req){
  const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if(!token) return {ok:false, reason:'no-token'};
  const {url, key} = env();
  const resp = await fetch(`${url}/auth/v1/user`, {headers:{apikey:key, Authorization:`Bearer ${token}`}});
  if(!resp.ok) return {ok:false, reason:'invalid-token'};
  const authUser = await resp.json().catch(() => null);
  if(!authUser?.id) return {ok:false, reason:'invalid-token'};
  return {ok:true, authUser};
}
async function resolveDashboardUser(req){
  const auth = await authFetchUser(req);
  if(!auth.ok) return {user:null, reason:auth.reason};
  const byAuth = await supabase(`ha_users?select=*&auth_user_id=eq.${encodeURIComponent(auth.authUser.id)}&limit=1`);
  const user = Array.isArray(byAuth) ? byAuth[0] : null;
  if(!user) return {user:null, reason:'no-account'};
  return {user, reason:null};
}
// BACKLOG OBSERVATION (deliberately not changed by this patch): unlike
// activeOrgUserIdsForUploadScope() below, this includes every org member
// regardless of status, so aggregate Team View (?view=team, no uploadId=)
// still surfaces inactive members' accounts/uploads today. Scoped
// out of the get-dashboard authentication patch on purpose -- the
// acceptance rule that prompted activeOrgUserIdsForUploadScope() was
// specific to the uploadId= single-upload path; changing aggregate Team
// View's status filtering is a separate, broader behavior change that
// should go through its own review rather than ride along here.
async function orgUserIds(user){
  if(user?.organization_id){
    const rows = await supabase(`ha_users?organization_id=eq.${encodeURIComponent(user.organization_id)}&select=id`);
    const ids = (Array.isArray(rows) ? rows : []).map(u => u.id).filter(Boolean);
    if(ids.length) return ids;
  }
  return user?.id ? [user.id] : [];
}
function inFilter(ids){
  return `in.(${ids.map(id => encodeURIComponent(id)).join(',')})`;
}

// Used ONLY by the uploadId= single-upload-scoped branch below -- NOT by
// orgUserIds() or the aggregate my/team paths, which are deliberately left
// unchanged in this patch (aggregate Team View's own handling of inactive
// org members is a separate, pre-existing behavior; see the backlog note
// near the bottom of this file rather than a silent change here).
//
// Release blocker: orgUserIds() includes every ha_users row for the
// organization regardless of status, so an owner/admin's uploadId= request
// could resolve an upload owned by an INACTIVE org member. The stated
// acceptance rule is "an ACTIVE user in their organization" -- this
// resolves the same rows orgUserIds() would, but with status also
// selected, and filters out status='inactive' before returning ids.
// Missing/blank status still means active, matching the exact convention
// already used for activeOrgUsers elsewhere in this file
// (clean(u.status || 'active') !== 'inactive').
async function activeOrgUserIdsForUploadScope(user){
  if(!user?.organization_id) return user?.id ? [user.id] : [];
  const rows = await supabase(`ha_users?organization_id=eq.${encodeURIComponent(user.organization_id)}&select=id,status`);
  const ids = (Array.isArray(rows) ? rows : [])
    .filter(u => lower(u.status || 'active') !== 'inactive')
    .map(u => u.id)
    .filter(Boolean);
  if(ids.length) return ids;
  return user?.id ? [user.id] : [];
}

function lower(v=''){ return clean(v).toLowerCase(); }
function appRole(user){ return lower(user?.app_role || user?.role || 'member'); }
function canViewTeam(user){ const r = appRole(user); return r === 'owner' || r === 'admin'; }

async function prospectCountForUsers(users){
  const emails = (users || []).map(u => clean(u.email).toLowerCase()).filter(Boolean);
  const names = new Set();
  for(const email of emails){
    try{
      const uploads = await supabase(`ha_prospect_uploads?user_email=eq.${encodeURIComponent(email)}&select=id`);
      const uploadIds = (Array.isArray(uploads) ? uploads : []).map(u => u.id).filter(Boolean);
      if(uploadIds.length){
        const rows = await supabase(`ha_prospect_accounts?upload_id=in.(${uploadIds.map(encodeURIComponent).join(',')})&select=company_name`);
        for(const row of rows || []){
          const n = normalizeName(row.company_name || '');
          if(n) names.add(n);
        }
      }
    }catch{}
  }
  return names.size;
}
function uniqueAccountRows(rows){
  const map = new Map();
  for(const row of rows || []){
    const key = clean(row.account_name).toLowerCase();
    if(!key) continue;
    if(!map.has(key)) map.set(key, row);
  }
  return Array.from(map.values()).sort((a,b)=>clean(a.account_name).localeCompare(clean(b.account_name)));
}

function sourceDomain(url=''){
  try{ return new URL(url).hostname.replace(/^www\./,''); } catch { return ''; }
}
function confidenceWord(score){
  const n = Number(score || 0);
  if(n >= 80) return 'High';
  if(n >= 55) return 'Medium';
  return 'Low';
}
function rowToSignal(row){
  const rawPayload = row.payload || {};
  // QA round 2, item 1: normalize actionability ONCE, here, for every signal
  // this endpoint ever returns. classifyLegacySignalActionability() passes
  // trustworthy fresh metadata through untouched and only computes fresh
  // classification for legacy rows that lack it -- the merge below never
  // mutates rawPayload/row itself (row.payload is left exactly as stored).
  const legacyFields = classifyLegacySignalActionability(rawPayload);
  const payload = { ...rawPayload, ...legacyFields };
  const sourceUrl = clean(row.source_url || payload.sourceUrl || '');
  const confidence = Number(row.confidence || payload.confidenceScore || payload.confidence || 0) || 0;
  // Final bounded Beta trust correction: row.why_reach_out is a separate,
  // flat DB column written at persist time -- for a row whose raw payload
  // never carried a canonicalEventType at all, that column reflects
  // whatever independent (now-fixed) classifier produced it, not the
  // freshly-regenerated, canonically-gated payload.whyNow
  // classifyLegacySignalActionability() just computed above. Preferring the
  // stored column unconditionally would silently mask that self-heal. A row
  // that DID carry a real canonicalEventType was persisted by an
  // already-canonical-aware endpoint, so the stored column and the payload
  // already agree -- kept as the preferred source there, unchanged.
  const canonicalEventTypeWasMissing = !rawPayload.canonicalEventType;
  const legacyWhyReachOut = canonicalEventTypeWasMissing ? '' : row.why_reach_out;
  return {
    ...payload,
    isReal: true,
    // Signal feedback / organizational-learning foundation: id/eventFingerprint
    // were never previously exposed to the client at all -- every consumer of
    // this function's output needs a stable identity to key an
    // api/signal-events.js call on. eventFingerprint (not id) is the durable
    // one; id is carried only as an optional/secondary hint.
    id: row.id,
    eventFingerprint: row.event_fingerprint || '',
    accountName: row.account_name,
    signalType: row.signal_type || payload.signalType || 'Business Activity',
    type: row.signal_type || payload.type || 'Business Activity',
    title: row.title || payload.title || payload.signalTitle || 'Verified business signal',
    signalTitle: row.title || payload.signalTitle || payload.title || 'Verified business signal',
    signalDetail: row.title || payload.signalDetail || payload.whatChanged || 'Verified business signal',
    whyNow: legacyWhyReachOut || payload.whyNow || payload.whyItMattersForPromo || payload.reasonToReachOut || '',
    whyItMattersForPromo: legacyWhyReachOut || payload.whyItMattersForPromo || payload.whyNow || '',
    confidence,
    confidenceScore: confidence,
    confidenceLevel: confidenceWord(confidence),
    sourceUrl,
    cleanSourceName: row.source_domain || payload.cleanSourceName || sourceDomain(sourceUrl),
    publishedDate: row.published_at || payload.publishedDate || payload.publicationDate || '',
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at
  };
}

function uniqueSignalRows(rows){
  const map = new Map();
  for(const row of rows || []){
    const payload = row.payload || {};
    const source = sourceDomain(row.source_url || payload.sourceUrl || '');
    const key = String(`${row.account_name || ''}|${row.signal_type || payload.signalType || ''}|${row.title || payload.title || payload.signalTitle || ''}|${source}`)
      .toLowerCase()
      .replace(/[^a-z0-9|]+/g,' ')
      .replace(/\s+/g,' ')
      .trim();
    if(!key) continue;
    const existing = map.get(key);
    const score = Number(row.confidence || payload.confidenceScore || payload.confidence || 0) || 0;
    const existingScore = Number(existing?.confidence || existing?.payload?.confidenceScore || existing?.payload?.confidence || 0) || 0;
    if(!existing || score > existingScore) map.set(key, row);
  }
  return Array.from(map.values());
}

function signalToOpportunity(row){
  const s = rowToSignal(row);
  const products = Array.isArray(s.likelyProducts) && s.likelyProducts.length ? s.likelyProducts
    : Array.isArray(s.commonPromoCategories) && s.commonPromoCategories.length ? s.commonPromoCategories
    : ['employee apparel','event support','recognition gifts','onboarding items'];
  const buyers = Array.isArray(s.likelyBuyers) && s.likelyBuyers.length ? s.likelyBuyers : [s.suggestedContact || 'Relevant department lead'];
  const confidence = Number(s.confidenceScore || 0) || 70;
  return {
    account: row.account_name,
    // Signal feedback / organizational-learning foundation: the durable
    // identity a client-side api/signal-events.js call keys on. id is
    // carried only as an optional/secondary hint alongside it.
    id: s.id,
    eventFingerprint: s.eventFingerprint || '',
    opportunity: s.promoOpportunity || s.opportunityCategory || s.signalType || 'Business Activity',
    opportunityCategory: s.opportunityCategory || s.signalType || 'Business Activity',
    // QA final round, item 1: carry the canonical classification (freshly
    // recomputed for legacy rows by classifyLegacySignalActionability() above)
    // onto the opportunity object itself so every consumer -- headline,
    // Prepare for Call, outreach, dedup family -- reads the SAME, current
    // classification rather than a stale value trapped inside businessSignals[0].
    canonicalEventType: s.canonicalEventType || '',
    // Trust correction (entity-disambiguation), founder QA follow-up: this
    // object literal was built by explicitly listing every field it carries
    // forward from rowToSignal()'s output (`s`) -- identityConfidence was
    // never added to that list when the tri-state grounding model shipped,
    // so it was silently dropped between persistence and every dashboard
    // consumer (accountOpportunityCluster(), isPriorityEligibleOpportunity(),
    // renderVerifiedOpportunitySection(), ...), even though rowToSignal()
    // itself already exposes it correctly via its {...payload} spread.
    // Confirmed production defect: a persisted 'unconfirmed' Dover Holiday
    // Parade signal rendered as "Verified Opportunity" and won the primary
    // slot on ranking alone, with the trust gate never actually seeing its
    // real state. A straight passthrough (no fallback/default) is required
    // -- undefined must stay undefined (a true legacy row, grandfathered)
    // and must never collapse into the same value a newly-graded
    // 'unconfirmed'/'confirmed' row carries, or the reverse.
    identityConfidence: s.identityConfidence,
    // Monitoring Identity V1: carried through for the same reason
    // identityConfidence above is -- an explicit-list object literal drops
    // anything not named here, and classifyMonitoringSignalEligibility()
    // needs the actual corroborator reasons, not just the confidence label.
    identityCorroboratorReasons: s.identityCorroboratorReasons,
    signalLayerType: 'Business Activity Signal',
    isVerifiedSignalOpportunity: true,
    signalType: s.signalType || 'Business Activity',
    signalTitle: s.signalTitle || s.title,
    signalSummary: s.signalDetail || s.title,
    sourceUrl: s.sourceUrl,
    cleanSourceName: s.cleanSourceName,
    // Temporal-integrity round: only a real publication/event date -- never
    // firstSeenAt/lastSeenAt (when House Accounts' own pipeline discovered/
    // last touched this row, not when the underlying event happened) and
    // never a fabricated "now" fallback. See dashboard/index.html's
    // formatSignalAge() for the client-side half of this fix.
    signalDate: s.publishedDate || s.eventDate || '',
    firstSeenAt: s.firstSeenAt,
    // QA round 2, item 1/5: carry the (normalized-if-legacy) actionability
    // fields through so the dashboard's priorities filter and the "Date/
    // actionability" line on the card and Verified Opportunity section see
    // the same classification rowToSignal() already computed above.
    actionabilityStatus: s.actionabilityStatus,
    eventCategory: s.eventCategory,
    eventDate: s.eventDate || '',
    event_date: s.eventDate || s.event_date || '',
    // QA final round, item 2: the human-readable event date RANGE (e.g.
    // "September 18-20, 2026"), when the source named one -- see
    // classifyLegacySignalActionability()'s eventDateDisplay.
    eventDateDisplay: s.eventDateDisplay || '',
    eventDateConfidence: s.eventDateConfidence,
    isUpcoming: s.isUpcoming,
    publicationDate: s.publicationDate || s.publishedDate || '',
    whyNow: s.whyNow || s.whyItMattersForPromo || s.signalDetail,
    reasonToReachOut: s.whyItMattersForPromo || s.whyNow || s.signalDetail,
    // Commercial Activation Reasoning sprint, live-QA correction: same
    // defect class as the identityConfidence omission documented above --
    // commercialPlay/activationIdeas/expansionPotential were never added to
    // this explicit field list when the Commercial Opportunity Intelligence
    // feature shipped, even though rowToSignal() (s) already exposes them
    // correctly via its {...payload} spread. Confirmed production impact:
    // isCommercialIntelligenceSignal() (dashboard/index.html) checks these
    // three keys on the TOP-LEVEL opportunity object -- with all three
    // always undefined here, EVERY signal this endpoint ever served was
    // misclassified as legacy, regardless of how rich its actual generated
    // commercialPlay/activationIdeas were. "The Play" was rendering through
    // the legacy whyNow/reasonToReachOut fallback instead (a shorter,
    // separately-sourced, NOT fact-vs-inference-governed field), and Ideas
    // to Send/Why It Could Grow had no path to the dashboard at all.
    commercialPlay: s.commercialPlay || null,
    // Deliberately NOT coerced to [] when absent -- isCommercialIntelligenceSignal()
    // (dashboard/index.html) distinguishes "went through commercial-
    // intelligence generation and got zero ideas" (a real []) from "predates
    // the feature entirely" (never had this key) via Array.isArray(). A
    // truly legacy signal (e.g. Dispatch Goods' pre-feature investment
    // signal) must stay undefined here, or it gets misclassified as a
    // fresh, idea-less signal and wrongly held to the stricter fresh-schema
    // credibility bar instead of its own legacy-narrative bar.
    activationIdeas: Array.isArray(s.activationIdeas) ? s.activationIdeas : undefined,
    expansionPotential: s.expansionPotential || null,
    conversationStarter: s.conversationStarter || s.suggestedOpener || `Ask whether ${row.account_name} has anything worth planning around based on this recent business activity.`,
    contactTitle: buyers.slice(0,2).join(' / '),
    contact: buyers.slice(0,2).join(' / '),
    likelyBuyers: Array.isArray(s.recommendedBuyingTeam) && s.recommendedBuyingTeam.length ? s.recommendedBuyingTeam : buyers,
    recommendedBuyingTeam: Array.isArray(s.recommendedBuyingTeam) ? s.recommendedBuyingTeam : buyers,
    suggestedContactDetails: s.suggestedContactDetails || s.suggested_contact_details || null,
    suggestedContact: s.suggestedContact || s.suggestedContactDetails?.name || buyers[0] || '',
    potentialContacts: s.potentialContacts || s.potential_contacts || [],
    whyTheseContacts: s.whyTheseContacts || s.why_these_contacts || '',
    businessContext: s.businessContext || s.companyContext || s.signalDetail || '',
    commonPromoCategories: products,
    suggestedProducts: products,
    likelyProducts: products,
    evidence: [
      s.cleanSourceName ? `Source: ${s.cleanSourceName}` : 'Source: public web',
      s.publishedDate ? `Published: ${s.publishedDate}` : '',
      s.signalDetail || s.title || ''
    ].filter(Boolean),
    confidence,
    quickWinScore: confidence,
    closeProbability: confidence,
    estimatedValue: 0,
    valueSource: 'Verified Signal',
    businessSignals: [s],
    email: ''
  };
}

// R7 follow-up (Preview QA): raw_data.existingSignals holds already-built
// opportunity OBJECTS persisted directly at a PRIOR research/save time --
// unlike ha_signals ROWS, these never pass through rowToSignal(), so
// classifyLegacySignalActionability()'s "trust but verify" date
// reconciliation (added for legacy ha_signals rows) never reached them.
// Confirmed production defect (Avidia Bank): a pre-fix run persisted
// eventDate=2026-06-22 (Eventbrite's listing date) directly into
// existingSignals with exact confidence; every later dashboard load kept
// serving that wrong date verbatim because nothing ever re-examined it.
// A second, independent defect shares this exact boundary: an old-shaped
// existingSignals entry (written before isVerifiedSignalOpportunity/
// signalLayerType existed on every opportunity object, AND with no
// sourceUrl either) silently fails isWebResearchSignal() at the
// CALL SITE below, so it is never excluded -- it reaches reconcileStoredOpportunity()
// (further below) still classified as "not business," letting a freshly
// re-derived ha_signals row for the SAME real-world event survive alongside
// it as an apparent duplicate (confirmed production case: Dispatch Goods'
// "Follow-on Investment from Santa Cruz Ventures", persisted with
// sourceUrl: ''). See that function's own comment for how this is closed.
//
// Foundation freeze, Phase 2 (Business Activity Classification Unification):
// THE one authoritative "is this opportunity a Business Activity/web-research
// signal" predicate. Answers ONLY what family/source this opportunity is --
// never identity confirmation (identityConfidence/isExplicitlyVerifiedIdentity(),
// a completely separate concept despite the historical isVerifiedSignalOpportunity
// field name), commercial quality, actionability, or ranking. Those remain
// independently gated elsewhere and must stay that way.
//
// Priority order, most-to-least authoritative:
//  1. An EXPLICIT, exact-match signalLayerType wins outright, in either
//     direction. 'Business Activity Signal' is business; 'Follow-Up Signal'/
//     'Repeat / Pattern Signal' is NOT, even if a weaker/legacy signal (most
//     notably a stale isVerifiedSignalOpportunity:true left over from a
//     since-fixed producer bug) also happens to be present on the same
//     object. An opportunity that explicitly declares its own family via
//     the field literally named for that purpose must never be overridden
//     by a weaker, structurally-inferred signal.
//  2. With signalLayerType absent (true legacy shape) or not one of the two
//     exact non-business strings, fall back to structural evidence, any one
//     sufficient: sourceUrl (a web-research signal's defining trait; an
//     order-history-derived Follow-Up/Repeat-Pattern opportunity never has
//     one), or isVerifiedSignalOpportunity === true (legacy-shape
//     compatibility for objects persisted before signalLayerType existed).
//
// Deliberately NOT part of this general contract: sourceName/cleanSourceName
// alone. See reconcileStoredOpportunity()'s own comment below for why that
// stays a narrow, explicitly-scoped exception rather than a clause here --
// folding it into this function would make the EXCLUSION filter at this
// function's own call site below drop a Dispatch-Goods-shaped legacy entry
// outright instead of letting it merge-forward with its live ha_signals
// duplicate, reintroducing the exact defect this contract exists to close.
//
// Mirrored, not literally shared: dashboard/index.html is a plain browser-
// loaded inline script and cannot import this module. Its own
// isWebResearchSignal() (mirroring this exact priority order) is the client
// half of one explicit contract; scripts/test-foundation-freeze-classification-parity.js
// proves both sides answer identically across a shared fixture table.
function isWebResearchSignal(o){
  if(!o) return false;
  if(o.signalLayerType === 'Business Activity Signal') return true;
  if(o.signalLayerType === 'Follow-Up Signal' || o.signalLayerType === 'Repeat / Pattern Signal') return false;
  return Boolean(o.sourceUrl) || o.isVerifiedSignalOpportunity === true;
}

// Foundation-freeze correction: this function must NOT blindly force
// isVerifiedSignalOpportunity/signalLayerType onto everything it's handed --
// most entries that reach it (Follow-Up Signal / Repeat-Pattern Signal) have
// ALREADY been correctly proven non-business by isWebResearchSignal() at
// this function's own call site below, and forcing those two flags on them
// inverted that classification right back, which then made
// isWebResearchSignal() (dashboard/index.html) treat a Follow-Up Signal as a
// business signal and silently exclude it from the next existingSignals
// write (serializeAccountForStorage()) -- Follow-Up Signals have no
// ha_signals home, so that was a real, confirmed data-loss path (a Follow-Up
// could be permanently erased by one load-then-save cycle).
//
// The Dispatch Goods gap (a legacy business entry with neither sourceUrl nor
// either identity flag, evidenced only by sourceName/cleanSourceName -- the
// source PUBLICATION's name, set only by the web-research normalizer in
// api/signal-intelligence.js and never present on an order-history-derived
// Follow-Up/Repeat-Pattern opportunity) is real and still needs closing, but
// Phase 2's reassessment (per its own explicit instruction to revisit this)
// confirmed it CANNOT be folded into isWebResearchSignal() above: every
// entry that reaches this function has already been proven, by
// isWebResearchSignal() itself at the exclusion filter below, NOT to be a
// business signal by that contract's own authoritative rules -- if
// sourceName/cleanSourceName were added there too, the SAME entry would be
// dropped outright by that filter instead of ever reaching here to be
// reconciled forward into a merge with its live ha_signals duplicate
// (confirmed by direct trial: doing so reintroduces the exact Dispatch Goods
// duplicate-title regression this exists to prevent). This is therefore
// kept as the smallest possible EXPLICIT compatibility rule, deliberately
// scoped to this one function rather than the general contract -- not a
// second, undocumented, silently-parallel classification system:
// sourceName/cleanSourceName are never written by classifyLegacySignalActionability()
// above, so they stay a stable signal across any number of load/save
// cycles, unlike canonicalEventType (which that call unconditionally
// assigns a BUSINESS_ACTIVITY_* value to even for a Follow-Up Signal's
// ordinary text).
function reconcileStoredOpportunity(opp){
  if(!opp || typeof opp !== 'object') return opp;
  // Live-QA correction (repeat/follow-up priority-eligibility loss): an
  // opportunity that already explicitly declares itself Follow-Up Signal or
  // Repeat / Pattern Signal is order-history-derived and was never a
  // business/web-research event in the first place -- it must never reach
  // classifyLegacySignalActionability() at all. That function is a
  // business-EVENT date/actionability engine (resolveCanonicalEventType()/
  // computeActionability() against evidence text); run against a genuine
  // reorder/follow-up opportunity's generic order-history text (e.g. "Ask
  // whether a similar program, order, or event is happening again"), it
  // fabricates an opportunityType of canonicalEventType (e.g.
  // "BUSINESS_ACTIVITY_UNKNOWN" instead of the real "REPEAT PATTERN") and an
  // actionabilityStatus with no real event date behind it. Confirmed
  // production defect: isPriorityEligibleOpportunity() (dashboard/index.html)
  // reads opp.actionabilityStatus.isPriorityEligible UNCONDITIONALLY, for
  // every opportunity kind, not only web-research ones -- so a fabricated
  // actionabilityStatus here silently drops an otherwise real, correctly
  // detected reorder/follow-up opportunity out of the priorities feed on
  // every reload, with the account's own true REPEAT PATTERN opportunityType
  // (its raw_data.repeatPatterns duplicate, never reconciled) not always
  // surviving the client's own by-score dedupe either. An explicit
  // signalLayerType here is the same authoritative, highest-priority signal
  // isWebResearchSignal() itself trusts above all other evidence -- this is
  // not new information the classifier below needs to add.
  if(opp.signalLayerType === 'Follow-Up Signal' || opp.signalLayerType === 'Repeat / Pattern Signal') return opp;
  const legacyFields = classifyLegacySignalActionability(opp);
  const isLegacyBusinessEntryMissedByTheGeneralContract = Boolean(opp.sourceName) || Boolean(opp.cleanSourceName);
  return {
    ...opp,
    ...legacyFields,
    ...(isLegacyBusinessEntryMissedByTheGeneralContract ? { isVerifiedSignalOpportunity: true, signalLayerType: 'Business Activity Signal' } : {})
  };
}
// Follow-up temporal-integrity round (Preview QA): the single canonicalization
// boundary for one account's futureOpportunities, run ONCE here -- before the
// payload is split, on the client, into primary opportunity, Additional
// Opportunities, Research Details, and the Recently Researched handoff -- so
// none of those surfaces can ever see two different representations of the
// same real-world event. resolveOpportunityEvents() (api/signal-intelligence.js)
// is the SAME canonical event-resolution engine already trusted at
// persistence time; accountName/companyName are normalized onto every
// candidate first because signalToOpportunity() (below) sets `account`, not
// `accountName`/`companyName` -- resolveEvents() groups by companyName/
// accountName, so a mismatched field name would silently prevent every
// candidate from ever matching anything (each becoming its own "event").
// Historical/repeat-pattern opportunities are passed through untouched --
// they have no canonical event identity for this engine to resolve.
function canonicalizeAccountOpportunities(account){
  const opps = Array.isArray(account.futureOpportunities) ? account.futureOpportunities : [];
  const businessOpps = opps.filter(isWebResearchSignal).map(o => ({
    ...o,
    accountName: o.accountName || o.account || account.name,
    companyName: o.companyName || o.accountName || o.account || account.name
  }));
  const otherOpps = opps.filter(o => !isWebResearchSignal(o));
  const resolved = businessOpps.length ? resolveOpportunityEvents(businessOpps) : businessOpps;
  account.futureOpportunities = [...resolved, ...otherOpps];
  return account;
}

// Shared by both the aggregate (my/team view) path and the single-upload
// (uploadId=) path below -- the SAME account-shaping logic, fed rows that
// are ALREADY scoped by whatever query built accountRows/signalRows. This
// function does no additional scoping itself: it is structurally incapable
// of introducing an account from an upload that wasn't already present in
// its inputs, because it has no way to fetch anything on its own -- it only
// maps rows it's handed. uploadId is carried on every returned account
// object (from the account row directly, or from the matching signal row
// for a signals-only entry) so a caller that must prove single-upload
// scoping (see api/get-dashboard.js's uploadId= branch and
// researchAccountFromManageModal() in dashboard/index.html) can verify it
// account-by-account, not just via the top-level upload field.
// Organizational Learning V1B: groups ACTIVE ha_account_opportunities rows
// (the caller queries status=eq.active before calling this) by account_name
// into the shape createRepeatPatternOpportunities()/generateFutureOpportunities()
// (dashboard/index.html) read as account.accountHistoryOpportunityRefs and
// copy onto whatever opportunity objects they build. The browser never
// constructs this identity itself -- only ever copies what the server
// already issued via reconcileAccountOpportunities() (api/save-upload.js).
function buildAccountHistoryOpportunityRefs(rows){
  const byAccountName = new Map();
  for(const row of rows || []){
    if(!byAccountName.has(row.account_name)) byAccountName.set(row.account_name, { followUp: null, repeatPattern: {} });
    const bucket = byAccountName.get(row.account_name);
    const ref = { id: row.id, fingerprint: row.fingerprint };
    if(row.opportunity_type === 'follow_up') bucket.followUp = ref;
    else if(row.opportunity_type === 'repeat_pattern' && row.category) bucket.repeatPattern[row.category] = ref;
  }
  return byAccountName;
}
// Stamps the SAME refs directly onto already-stored repeatPatterns entries
// (raw_data.repeatPatterns, written by a prior save's serializeAccountForStorage())
// -- the reload path never re-runs generateFutureOpportunities() client-side,
// it renders these stored objects as-is, so this is the one place that
// path gets its refs. opportunityType === 'REPEAT PATTERN' entries match by
// their own opp.category (see createRepeatPatternOpportunities()'s own
// comment on that field); every other stored entry -- the generic
// industry-template family -- normalizes to the account's one follow_up ref.
function stampAccountHistoryOpportunityRefs(storedOpps, refs){
  if(!refs) return storedOpps;
  return storedOpps.map(opp => {
    const ref = opp.opportunityType === 'REPEAT PATTERN'
      ? (opp.category ? refs.repeatPattern[opp.category] : null)
      : refs.followUp;
    if(!ref) return opp;
    return { ...opp, accountOpportunityId: ref.id, accountOpportunityFingerprint: ref.fingerprint };
  });
}

function buildAccountsFromRows(accountRows, signalRows, accountOpportunityRows, targetIdentityIndex){
  const byAccount = new Map();
  const opportunityRefsByAccountName = buildAccountHistoryOpportunityRefs(accountOpportunityRows);
  for(const a of accountRows || []){
    const raw = a.raw_data || {};
    const historicalProjects = Array.isArray(raw.historicalProjects) ? raw.historicalProjects : [];
    const purchases = Array.isArray(raw.purchases) && raw.purchases.length ? raw.purchases : historicalProjects.map(p => ({
      project: p.project || p.name || p.description || p.orderName || 'Historical order',
      category: p.category || p.productCategory || p.type || '',
      revenue: Number(p.revenue || p.amount || p.total || 0) || 0,
      dateStr: p.dateStr || p.date || p.orderDate || p.order_date || '',
      status: p.status || 'Historical'
    }));
    // Source-of-truth correction: ha_signals is now the EXCLUSIVE source for
    // canonical business/web-research opportunities -- a raw_data.existingSignals
    // entry classified as one via isWebResearchSignal(), checked here on the
    // ORIGINAL entry (its own signalLayerType/sourceUrl/flag-based check,
    // before reconcileStoredOpportunity() runs), is dropped from this
    // filter's output -- never reconciled against a live ha_signals row by
    // eventFingerprint or any other resemblance heuristic. A live row that
    // has since been deleted/corrected must mean the opportunity is gone,
    // not "find the old snapshot that looks like it." This is the one place
    // a frozen pre-fix snapshot (e.g. a stale Instagram-sourced business
    // signal written before this trust-correction era) is neutralized --
    // physically still present in the database, but permanently inert from
    // here on, with no migration required. repeatPatterns is untouched: it
    // is order-history-derived and has no ha_signals representation at all.
    // (See reconcileStoredOpportunity()'s own comment for the one entry
    // shape -- a legacy business signal with neither sourceUrl nor flags --
    // that slips past this filter and is instead reconciled forward into a
    // later merge with its live ha_signals duplicate.)
    const accountOpportunityRefs = opportunityRefsByAccountName.get(a.account_name) || null;
    // Fresh-upload V1B feedback-controls fix: raw_data.existingSignals and
    // raw_data.repeatPatterns overlap by design (serializeAccountForStorage()'s
    // own comment calls this "harmlessly redundant") -- existingSignals holds
    // every non-web-research opportunity (Follow-Up Signal entries, which
    // exist ONLY here, PLUS a second copy of every Repeat/Pattern Signal
    // entry already in repeatPatterns), while repeatPatterns holds only the
    // Repeat/Pattern Signal ones. Only the repeatPatterns copy used to be run
    // through stampAccountHistoryOpportunityRefs() -- so a Follow-Up
    // opportunity (which never appears in repeatPatterns at all) could never
    // receive its ref, and a genuine Repeat/Pattern opportunity's ref could
    // be lost anyway: both the stamped (repeatPatterns) and unstamped
    // (existingSignals) copies reach the client with an identical
    // opportunityDedupeKey() and an identical getOpportunityScore() (scoring
    // never looks at the ref fields), so dedupeOpportunities()'s strict `>`
    // tie-break keeps whichever copy was inserted first -- the unstamped
    // existingSignals one, since it's concatenated before repeatPatterns
    // below. Stamping existingSignals the same way repeatPatterns already is
    // fixes both: a Follow-Up entry now gets refs.followUp directly, and a
    // genuine Repeat/Pattern entry's two copies both carry the same correct
    // ref, so whichever one the client's dedupe keeps is stamped either way.
    // Dedupe ordering, scoring, taxonomy, fingerprinting, and identity are
    // all untouched -- this only adds the ref fields already used elsewhere.
    const storedOpps = [
      ...stampAccountHistoryOpportunityRefs(
        Array.isArray(raw.existingSignals) ? raw.existingSignals.filter(o => !isWebResearchSignal(o)).map(reconcileStoredOpportunity) : [],
        accountOpportunityRefs
      ),
      ...stampAccountHistoryOpportunityRefs(Array.isArray(raw.repeatPatterns) ? raw.repeatPatterns : [], accountOpportunityRefs)
    ];
    byAccount.set(a.account_name, {
      name: a.account_name,
      uploadId: a.upload_id,
      // Organizational Learning V1B: the authoritative, server-issued refs
      // (never a client-computed fingerprint) createRepeatPatternOpportunities()/
      // generateFutureOpportunities() copy onto any FRESH opportunity object
      // they build (see dashboard/index.html) -- null when this account has
      // no persisted account-history opportunities yet (a brand-new,
      // never-reconciled account).
      accountHistoryOpportunityRefs: accountOpportunityRefs,
      monitoringStatus: lower(raw.monitoring_status || 'active'),
      lastResearchedAt: raw.last_researched_at || '',
      industry: a.industry || 'Saved Account',
      contactName: a.contact_name || '',
      contactEmail: a.contact_email || '',
      contactTitle: raw.contactTitle || raw.contact_title || '',
      contactDepartment: raw.contactDepartment || raw.contact_department || '',
      contactPhone: raw.contactPhone || raw.contact_phone || '',
      contacts: Array.isArray(raw.contacts) ? raw.contacts : [],
      website: raw.website || '',
      location: raw.location || '',
      assignedRep: raw.assignedRep || raw.assigned_rep || '',
      intelligenceMode: raw.intelligenceMode || raw.intelligence_mode || (Number(a.metrics?.orderCount || 0) > 0 ? 'historical' : 'warm'),
      allRecords: Array.isArray(raw.records) ? raw.records : [],
      revenue: Number(a.metrics?.revenue || 0),
      orderCount: Number(a.metrics?.orderCount || 0),
      confidence: Number(a.metrics?.confidence || a.metrics?.quickWinScore || 0),
      relationshipStrength: Number(a.metrics?.relationshipStrength || 0),
      mostRecentDate: a.metrics?.mostRecentDate || 'Unknown',
      activePipelineValue: Number(a.metrics?.activePipelineValue || 0),
      activePipelineCount: Number(a.metrics?.activePipelineCount || 0),
      subscores: a.metrics?.subscores || {revenue:0, frequency:0, recency:0, diversity:0},
      purchases,
      projects: historicalProjects,
      allProjects: Array.isArray(raw.allProjects) ? raw.allProjects : historicalProjects,
      activePipeline: Array.isArray(raw.activePipeline) ? raw.activePipeline : [],
      categoryTypes: Array.isArray(raw.historicalCategories) ? raw.historicalCategories : [],
      signals: [],
      futureOpportunities: storedOpps
    });
  }
  const uniqueSignals = uniqueSignalRows(signalRows || []);
  for(const row of uniqueSignals || []){
    if(!byAccount.has(row.account_name)){
      byAccount.set(row.account_name, {name: row.account_name, uploadId: row.upload_id, monitoringStatus:'active', lastResearchedAt:'', industry:'Saved Account', revenue:0, orderCount:0, confidence:0, relationshipStrength:0, mostRecentDate:'Unknown', categoryTypes:[], signals:[], futureOpportunities:[]});
    }
    const acct = byAccount.get(row.account_name);
    const signal = rowToSignal(row);
    acct.signals.push(signal);
    // Monitoring Identity V1: only a `priority`-eligible signal (name match
    // PLUS a STRONG account-side corroborator -- see
    // classifyMonitoringSignalEligibility()) becomes an opportunity object
    // on reload. A `secondary` signal (possible/unconfirmed, or only
    // weakly/inferentially corroborated) stays visible in acct.signals
    // (rendered transparently in Research Details), never in
    // futureOpportunities, so it can never reach the Priority feed or
    // Additional Opportunities after a page reload -- mirrors
    // addSignalDerivedOpportunities()'s identical gate on the live-research
    // path (dashboard/index.html). A row with no identityConfidence at all
    // (legacy, predates the tri-state grounding model) is grandfathered as
    // eligible, unchanged from today.
    const targetIdentity = lookupTargetIdentity(targetIdentityIndex, row.user_id, row.account_name);
    if(classifyMonitoringSignalEligibility({ identityConfidence: signal.identityConfidence, reasons: signal.identityCorroboratorReasons, targetIdentityDomainSource: targetIdentity.source }) === 'priority'){
      acct.futureOpportunities.push(signalToOpportunity(row));
    }
  }
  return {
    accountList: Array.from(byAccount.values()).map(a => {
      canonicalizeAccountOpportunities(a);
      if(a.futureOpportunities.length){
        a.confidence = Math.max(a.confidence || 0, ...a.futureOpportunities.map(o => Number(o.confidence || 0)));
      }
      return a;
    }),
    uniqueSignals
  };
}

export default async function handler(req, res){
  if(req.method !== 'GET') return json(res, 405, {error:'Method not allowed'});
  try{
    // req.query?.email is accepted (harmlessly ignored) for
    // backwards-compatible request shape only -- it is NEVER used to
    // resolve identity, ownership, organization scope, or authorization.
    // See resolveDashboardUser()'s own comment above.
    const resolved = await resolveDashboardUser(req);
    if(!resolved.user){
      if(resolved.reason === 'no-account') return json(res, 404, {error:'No House Accounts profile found for this login.'});
      return json(res, 401, {error:'Authentication required.'});
    }
    const user = resolved.user;
    let organization = null;
    if(user.organization_id){
      try{
        const orgRows = await supabase(`ha_organizations?id=eq.${encodeURIComponent(user.organization_id)}&select=*&limit=1`);
        organization = Array.isArray(orgRows) ? orgRows[0] : null;
      }catch{}
    }

    // Single-upload-scoped path (release blocker fix, see the audit this
    // responds to): the aggregate my/team logic below has NEVER been
    // upload-scoped -- both branches return every account across every
    // upload the user (or, in team view, the org) owns. That is correct
    // and intentional for the main dashboard's own "everything I have"
    // view, but it is NOT safe to use as the snapshot for an operation that
    // must touch exactly one upload and nothing else (single-account
    // research from the Manage Customer Accounts modal). This branch is
    // structurally incapable of returning another upload's accounts: both
    // queries below are filtered by upload_id=eq.<requestedUploadId>
    // directly, not by user_id/org_id, and viewMode/team aggregation is
    // never consulted here at all.
    const requestedUploadId = clean(req.query?.uploadId || '');
    if(requestedUploadId){
      // Ownership/access check: the requested upload must belong to this
      // user, or (owner/admin only) to an ACTIVE user in their org --
      // narrower than the aggregate paths' own org-wide scope (see
      // activeOrgUserIdsForUploadScope()'s comment for why this is a
      // scoped-branch-only helper, not a change to orgUserIds()). A member
      // never needs an org query at all: their scope is always just their
      // own id.
      const teamAllowedForScope = canViewTeam(user);
      const scopeIds = teamAllowedForScope ? await activeOrgUserIdsForUploadScope(user) : [user.id].filter(Boolean);
      if(!scopeIds.length) return json(res, 404, {error:'Upload not found or not accessible.'});
      const scopeFilter = inFilter(scopeIds);
      const scopedUploadRows = await supabase(`ha_uploads?select=*&id=eq.${encodeURIComponent(requestedUploadId)}&user_id=${scopeFilter}&limit=1`);
      const scopedUpload = Array.isArray(scopedUploadRows) ? scopedUploadRows[0] : null;
      if(!scopedUpload) return json(res, 404, {error:'Upload not found or not accessible.'});

      const scopedAccountRows = await supabase(`ha_accounts?select=*&upload_id=eq.${encodeURIComponent(requestedUploadId)}&order=account_name.asc&limit=2500`);
      const scopedSignalRows = await supabase(`ha_signals?select=*&upload_id=eq.${encodeURIComponent(requestedUploadId)}&order=first_seen_at.desc&limit=1000`);
      // Organizational Learning V1B: scoped by the upload's own owner, not
      // upload_id -- an account-history opportunity attaches to (user,
      // account_name), the same durable pair its own fingerprint uses, not
      // to whichever upload_id most recently reconciled it.
      const scopedAccountOpportunities = await supabase(`ha_account_opportunities?select=id,account_name,opportunity_type,category,fingerprint&status=eq.active&user_id=eq.${encodeURIComponent(scopedUpload.user_id)}&limit=5000`);
      // Monitoring Identity V1, Path B wiring: ONE bounded query for this
      // upload's owner's monitoring targets, never per-signal.
      const scopedMonitoringTargets = await supabase(`ha_monitoring_targets?select=user_id,display_account_name,identity_status,identity_domain,identity_domain_source&user_id=eq.${encodeURIComponent(scopedUpload.user_id)}&limit=5000`);
      const scopedTargetIdentityIndex = buildTargetIdentityIndex(scopedMonitoringTargets);
      const {accountList: scopedAccountList, uniqueSignals: scopedUniqueSignals} = buildAccountsFromRows(scopedAccountRows, scopedSignalRows, scopedAccountOpportunities, scopedTargetIdentityIndex);

      return json(res, 200, {
        ok:true,
        user,
        organization,
        upload: scopedUpload,
        summary: scopedUpload?.summary || {},
        accounts: scopedAccountList,
        signals: (scopedUniqueSignals || []).map(rowToSignal),
        weeklyRuns: [],
        newThisWeek: [],
        dashboardScope:'upload',
        viewMode:'upload',
        canViewTeam: teamAllowedForScope,
        userRole: appRole(user),
        organizationSnapshot: null,
        existingCustomerAccountCount: scopedAccountList.length
      });
    }

    const requestedView = clean(req.query?.view || '').toLowerCase();
    const teamAllowed = canViewTeam(user);
    const viewMode = teamAllowed && requestedView !== 'my' ? 'team' : 'my';

    const allOrgIds = await orgUserIds(user);
    if(!allOrgIds.length) return json(res, 404, {error:'No dashboard user found.'});
    const ids = viewMode === 'team' ? allOrgIds : [user.id].filter(Boolean);
    if(!ids.length) return json(res, 404, {error:'No dashboard user found.'});
    const usersFilter = inFilter(ids);

    const orgUsers = user.organization_id
      ? await supabase(`ha_users?organization_id=eq.${encodeURIComponent(user.organization_id)}&select=id,email,status,app_role,role`)
      : [user];
    const activeOrgUsers = (Array.isArray(orgUsers) ? orgUsers : []).filter(u => clean(u.status || 'active') !== 'inactive');
    const orgUsersFilter = inFilter(activeOrgUsers.map(u => u.id).filter(Boolean));

    // For members, upload ownership is the source of truth. Never fall back to
    // organization_id, company-name matching, or direct user_id matches on child rows.
    const uploads = await supabase(`ha_uploads?select=*&user_id=${usersFilter}&order=updated_at.desc&limit=250`);
    const upload = Array.isArray(uploads) ? uploads[0] : null;
    const ownedUploadIds = (Array.isArray(uploads) ? uploads : []).map(u => u.id).filter(Boolean);

    let allAccounts = [];
    let signals = [];
    let weeklyRuns = [];

    if(viewMode === 'team') {
      // Preserve owner/admin organization-wide behavior.
      allAccounts = await supabase(`ha_accounts?select=*&user_id=${usersFilter}&order=updated_at.desc&limit=2500`);
      signals = await supabase(`ha_signals?select=*&user_id=${usersFilter}&order=first_seen_at.desc&limit=1000`);
      weeklyRuns = await supabase(`ha_weekly_runs?select=*&user_id=${usersFilter}&order=started_at.desc&limit=8`);
    } else if(ownedUploadIds.length) {
      const uploadFilter = inFilter(ownedUploadIds);
      allAccounts = await supabase(`ha_accounts?select=*&upload_id=${uploadFilter}&order=updated_at.desc&limit=2500`);
      signals = await supabase(`ha_signals?select=*&upload_id=${uploadFilter}&order=first_seen_at.desc&limit=1000`);
      weeklyRuns = await supabase(`ha_weekly_runs?select=*&user_id=eq.${encodeURIComponent(user.id)}&order=started_at.desc&limit=8`);
    }

    const accounts = uniqueAccountRows(allAccounts || []);
    // Organizational Learning V1B: the authoritative, currently-active
    // account-history opportunity refs for every account this view
    // includes -- scoped the same way accounts/signals already are
    // (usersFilter covers both the team and upload-owner cases above).
    // Never derived from anything the client submits.
    const accountOpportunities = await supabase(`ha_account_opportunities?select=id,account_name,opportunity_type,category,fingerprint&status=eq.active&user_id=${usersFilter}&limit=5000`);
    // Monitoring Identity V1, Path B wiring: ONE bounded query, scoped the
    // same way accounts/signals/accountOpportunities already are, never
    // per-signal or per-account.
    const monitoringTargets = await supabase(`ha_monitoring_targets?select=user_id,display_account_name,identity_status,identity_domain,identity_domain_source&user_id=${usersFilter}&limit=5000`);
    const targetIdentityIndex = buildTargetIdentityIndex(monitoringTargets);

    let teamCustomerCount = accounts.length;
    let teamProspectCount = 0;
    if(viewMode === 'my' && activeOrgUsers.length){
      try{
        const orgAccounts = await supabase(`ha_accounts?select=account_name&user_id=${orgUsersFilter}&limit=5000`);
        teamCustomerCount = uniqueAccountRows(orgAccounts || []).length;
      }catch{}
    }
    teamProspectCount = await prospectCountForUsers(activeOrgUsers.length ? activeOrgUsers : [user]);

    if(viewMode === 'my' && ownedUploadIds.length === 0){
      // Live QA round 9: teamCustomerCount above is already computed from a
      // genuine org-wide account query (the same one the view switcher's
      // own numbers rely on) -- surfacing it here as a plain boolean lets
      // the empty-state UI distinguish "nobody on the team has uploaded
      // anything" from "you personally haven't, but your team has," without
      // a second request. For a solo user with no teammates, teamCustomerCount
      // is just their own (zero) account count, so this is naturally false.
      return json(res, 200, {
        ok:true,
        user,
        organization,
        upload:{},
        summary:{},
        accounts:[],
        signals:[],
        weeklyRuns:[],
        newThisWeek:[],
        dashboardScope:'user',
        viewMode:'my',
        canViewTeam:teamAllowed,
        userRole:appRole(user),
        organizationSnapshot:null,
        existingCustomerAccountCount:0,
        personalEmpty:true,
        teamHasData:teamCustomerCount > 0
      });
    }

    if(!upload && !accounts.length && !(Array.isArray(signals) && signals.length)){
      return json(res, 404, {error:'No existing customer dashboard data found yet.'});
    }

    const {accountList, uniqueSignals} = buildAccountsFromRows(accounts, signals, accountOpportunities, targetIdentityIndex);

    const sevenDaysAgo = Date.now() - 7*24*60*60*1000;
    // Reconciliation item 1 / QA round 2 item 1: "Newly Detected" is an
    // ACTIONABLE count, not merely a discovery-recency count -- a
    // stale/undated event-like signal or an ongoing signal past the recency
    // ceiling is retained in ha_signals for Research Details/account
    // history, but must not inflate this badge. Legacy rows (no trustworthy
    // stored actionabilityStatus) are classified fresh via
    // classifyLegacySignalActionability() -- the SAME canonical normalizer
    // rowToSignal()/signalToOpportunity() use below -- rather than being
    // defaulted to eligible just because the field is missing.
    const newThisWeek = (uniqueSignals || []).filter(s => {
      const t = new Date(s.first_seen_at || s.created_at || 0).getTime();
      if(!Number.isFinite(t) || t < sevenDaysAgo) return false;
      // Monitoring Identity V1: a `secondary`-tier signal (possible/
      // unconfirmed, or only weakly corroborated) must not inflate "Newly
      // Detected" either -- same principle as futureOpportunities'
      // exclusion above, applied to this separate discovery-recency badge.
      const newThisWeekTargetIdentity = lookupTargetIdentity(targetIdentityIndex, s.user_id, s.account_name);
      if(classifyMonitoringSignalEligibility({ identityConfidence: (s.payload || {}).identityConfidence, reasons: (s.payload || {}).identityCorroboratorReasons, targetIdentityDomainSource: newThisWeekTargetIdentity.source }) !== 'priority') return false;
      const { actionabilityStatus } = classifyLegacySignalActionability(s.payload || {});
      return actionabilityStatus?.isPriorityEligible !== false;
    }).map(signalToOpportunity);

    return json(res, 200, {
      ok:true,
      user,
      organization,
      upload: upload || {},
      summary: upload?.summary || {},
      accounts: accountList,
      signals: (uniqueSignals || []).map(rowToSignal),
      weeklyRuns: weeklyRuns || [],
      newThisWeek,
      dashboardScope: viewMode === 'team' ? 'organization' : 'user',
      viewMode,
      canViewTeam: teamAllowed,
      userRole: appRole(user),
      organizationSnapshot: teamAllowed ? {
        customerCount: teamCustomerCount,
        prospectCount: teamProspectCount
      } : null,
      existingCustomerAccountCount: accountList.length
    });
  }catch(err){
    return json(res, 500, {error: err.message || 'Dashboard lookup failed'});
  }
}

export {
  rowToSignal, signalToOpportunity, uniqueSignalRows, uniqueAccountRows,
  buildAccountsFromRows, canonicalizeAccountOpportunities, isWebResearchSignal,
  buildAccountHistoryOpportunityRefs, stampAccountHistoryOpportunityRefs,
  buildTargetIdentityIndex, lookupTargetIdentity
};
