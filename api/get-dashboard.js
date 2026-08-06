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
  return {
    ...payload,
    isReal: true,
    accountName: row.account_name,
    signalType: row.signal_type || payload.signalType || 'Business Activity',
    type: row.signal_type || payload.type || 'Business Activity',
    title: row.title || payload.title || payload.signalTitle || 'Verified business signal',
    signalTitle: row.title || payload.signalTitle || payload.title || 'Verified business signal',
    signalDetail: row.title || payload.signalDetail || payload.whatChanged || 'Verified business signal',
    whyNow: row.why_reach_out || payload.whyNow || payload.whyItMattersForPromo || payload.reasonToReachOut || '',
    whyItMattersForPromo: row.why_reach_out || payload.whyItMattersForPromo || payload.whyNow || '',
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
    opportunity: s.promoOpportunity || s.opportunityCategory || s.signalType || 'Business Activity',
    opportunityCategory: s.opportunityCategory || s.signalType || 'Business Activity',
    // QA final round, item 1: carry the canonical classification (freshly
    // recomputed for legacy rows by classifyLegacySignalActionability() above)
    // onto the opportunity object itself so every consumer -- headline,
    // Prepare for Call, outreach, dedup family -- reads the SAME, current
    // classification rather than a stale value trapped inside businessSignals[0].
    canonicalEventType: s.canonicalEventType || '',
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
// A second, independent defect shares this exact boundary: existingSignals
// entries written before isVerifiedSignalOpportunity/signalLayerType were
// set on every opportunity object (an even older shape) silently fail
// isBusinessSignalOpportunity()/isBusinessOpportunity() (both here and in
// dashboard/index.html), which defeats resolveOpportunityEvents()'s and the
// client's business-signal identity merge entirely for that one persisted
// object -- a freshly re-derived ha_signals row for the SAME real-world
// event then survives alongside it as an apparent duplicate (confirmed
// production case: Dispatch Goods' "Follow-on Investment from Santa Cruz
// Ventures"). Reconciling every existingSignals entry through the SAME
// classifyLegacySignalActionability() used for ha_signals rows, and
// re-asserting the two identity flags every CURRENT signal always carries,
// closes both gaps at their one shared hydration boundary -- no database
// write, no provider call, applies on the very next dashboard read.
function reconcileStoredOpportunity(opp){
  if(!opp || typeof opp !== 'object') return opp;
  const legacyFields = classifyLegacySignalActionability(opp);
  return {
    ...opp,
    ...legacyFields,
    isVerifiedSignalOpportunity: true,
    signalLayerType: opp.signalLayerType || 'Business Activity Signal'
  };
}

// Real-world, web-research-derived business-activity events only -- never
// historical/repeat-pattern opportunities (order-history-derived, with no
// canonical event identity to resolve). Mirrors dashboard/index.html's own
// isBusinessOpportunity() partition exactly, so the client's later dedup
// pass and this server-side canonicalization agree on which items are
// "the same kind of thing" to begin with.
function isBusinessSignalOpportunity(o){
  return Boolean(o) && (o.signalLayerType === 'Business Activity Signal' || o.isVerifiedSignalOpportunity === true);
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
  const businessOpps = opps.filter(isBusinessSignalOpportunity).map(o => ({
    ...o,
    accountName: o.accountName || o.account || account.name,
    companyName: o.companyName || o.accountName || o.account || account.name
  }));
  const otherOpps = opps.filter(o => !isBusinessSignalOpportunity(o));
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
function buildAccountsFromRows(accountRows, signalRows){
  const byAccount = new Map();
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
    const storedOpps = [
      ...(Array.isArray(raw.existingSignals) ? raw.existingSignals.map(reconcileStoredOpportunity) : []),
      ...(Array.isArray(raw.repeatPatterns) ? raw.repeatPatterns : [])
    ];
    byAccount.set(a.account_name, {
      name: a.account_name,
      uploadId: a.upload_id,
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
    acct.signals.push(rowToSignal(row));
    acct.futureOpportunities.push(signalToOpportunity(row));
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
      const {accountList: scopedAccountList, uniqueSignals: scopedUniqueSignals} = buildAccountsFromRows(scopedAccountRows, scopedSignalRows);

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
        personalEmpty:true
      });
    }

    if(!upload && !accounts.length && !(Array.isArray(signals) && signals.length)){
      return json(res, 404, {error:'No existing customer dashboard data found yet.'});
    }

    const {accountList, uniqueSignals} = buildAccountsFromRows(accounts, signals);

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
  buildAccountsFromRows, canonicalizeAccountOpportunities, isBusinessSignalOpportunity
};
