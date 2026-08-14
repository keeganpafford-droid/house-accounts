// Organizational Learning V1B: canonical, server-side derivation of durable
// Follow-Up / Repeat-Pattern account-history opportunity identity.
//
// Architecture note (Phase 2 correction from the design conversation): the
// dashboard's own findRepeatPatternGroups()/createRepeatPatternOpportunities()/
// generateFutureOpportunities() live in dashboard/index.html, a classic
// (non-module) inline script that at least 5 EXISTING test files already
// extract/call those exact functions BY NAME (scripts/test-live-qa-round4/
// 5/6-corrections.js, scripts/test-repeat-followup-live-pipeline-e2e.js,
// scripts/test-repeat-order-follow-up-fixture.js, scripts/generate-digest-
// preview.js). Physically relocating findRepeatPatternGroups() out of the
// dashboard into a shared file both sides `import` would break all of them
// for no behavioral gain -- the dashboard's copy renders presentation the
// server must never depend on anyway (see computeFollowUpEvidence()'s own
// comment below). Instead: this file is a DELIBERATE, VERBATIM port of
// findRepeatPatternGroups()'s identity-relevant kernel (grouping + threshold
// gates + anchor/evidence computation -- not the industry-template
// generator, not scoring, not collapse/dedup, none of which are needed for
// identity). scripts/test-account-opportunity-detection-equivalence.js
// proves this stays behaviorally identical to the dashboard's real function
// against shared fixtures -- edit one without the other and that test fails
// loudly. Do not "fix" one side without checking the other.
//
// Client-submitted opportunity data is never trusted as source of truth:
// every function here derives identity/evidence ONLY from raw purchase
// records already persisted server-side (ha_accounts.raw_data), the same
// source the dashboard itself reads -- never from anything a request body
// supplies about what opportunities exist.
import { normalizeCompany } from '../signal-intelligence.js';

const FINGERPRINT_VERSION = 'v1';

function parseDate(value) {
  if (!value) return null;
  const d = new Date(value);
  return isNaN(d.getTime()) ? null : d;
}

// Verbatim mirror of api/get-dashboard.js's buildAccountsFromRows() purchase-
// parsing block -- the SAME raw_data shape, the SAME field-name fallbacks --
// plus date parsing (needed here for cadence math; the dashboard API
// response leaves dates as strings and lets the browser parse them later).
export function parsePurchases(rawData) {
  const raw = rawData || {};
  const historicalProjects = Array.isArray(raw.historicalProjects) ? raw.historicalProjects : [];
  const rawPurchases = Array.isArray(raw.purchases) && raw.purchases.length ? raw.purchases : historicalProjects.map(p => ({
    project: p.project || p.name || p.description || p.orderName || 'Historical order',
    category: p.category || p.productCategory || p.type || '',
    revenue: Number(p.revenue || p.amount || p.total || 0) || 0,
    dateStr: p.dateStr || p.date || p.orderDate || p.order_date || '',
    status: p.status || 'Historical'
  }));
  return rawPurchases.map(p => ({ ...p, date: parseDate(p.dateStr || p.date) }));
}

function averageRevenue(records) {
  const values = (records || []).map(r => Number(r.revenue || 0)).filter(v => v > 0);
  if (!values.length) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function monthNameFromDate(d) {
  if (!d || isNaN(d.getTime())) return '';
  return d.toLocaleString('en-US', { month: 'long' });
}

// Identity-relevant kernel of dashboard/index.html's findRepeatPatternGroups() --
// same 2-order-per-category minimum, same hasMultiYear/hasSeasonalMonth/
// hasEnoughVolume qualification gates, same top-3-by-confidence cap.
// Deliberately drops hasCurrentSeasonActivity/orders/lastDateStr from the
// dashboard's own return shape -- none of those affect which categories
// qualify or their anchor date, only rendering, which stays client-side.
export function findRepeatPatternGroups(purchases) {
  const orders = (purchases || []).filter(o => o && o.date && o.category && o.category !== 'Uncategorized');
  if (orders.length < 2) return [];
  const groups = new Map();
  orders.forEach(o => {
    const key = o.category;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(o);
  });

  const patterns = [];
  groups.forEach((catOrders, category) => {
    if (catOrders.length < 2) return;
    const years = new Set(catOrders.map(o => o.date.getFullYear()));
    const monthCounts = new Map();
    catOrders.forEach(o => monthCounts.set(o.date.getMonth(), (monthCounts.get(o.date.getMonth()) || 0) + 1));
    const strongestMonth = [...monthCounts.entries()].sort((a, b) => b[1] - a[1])[0];
    const hasMultiYear = years.size >= 2;
    const hasSeasonalMonth = strongestMonth && strongestMonth[1] >= 2;
    const hasEnoughVolume = catOrders.length >= 3;
    if (!(hasMultiYear || hasSeasonalMonth || hasEnoughVolume)) return;

    const sorted = [...catOrders].sort((a, b) => b.date - a.date);
    const last = sorted[0];
    const monthLabel = strongestMonth ? new Date(2026, strongestMonth[0], 1).toLocaleString('en-US', { month: 'long' }) : monthNameFromDate(last.date);
    const avg = averageRevenue(catOrders);
    const confidence = (hasMultiYear && hasSeasonalMonth) ? 82 : hasMultiYear ? 74 : 64;
    patterns.push({
      category, orderCount: catOrders.length, years: [...years].sort(),
      monthLabel, lastDate: last.date, avgRevenue: avg, confidence
    });
  });
  return patterns.sort((a, b) => b.confidence - a.confidence || b.orderCount - a.orderCount || b.avgRevenue - a.avgRevenue).slice(0, 3);
}

// Follow-Up existence/evidence: deliberately NOT the industry-template
// engine (generateFutureOpportunities()) -- see the V1B design doc.
// Existence tracks only whether the account has at least one dated
// purchase record; which industry template (if any) a rep is shown for it
// is pure client-render-time presentation, gated by account.industry and
// live scoring, and is never derived or persisted here. Two purchase
// records sharing a date collapse to one instance -- there is no per-
// purchase row id in this data, so day-level date is the most specific
// anchor honestly available (see the design doc's stated limitation).
export function computeFollowUpEvidence(purchases) {
  const dated = (purchases || []).filter(o => o && o.date);
  if (!dated.length) return null;
  const sorted = [...dated].sort((a, b) => b.date - a.date);
  return { mostRecentOrderDate: sorted[0].date, orderCount: dated.length };
}

function normalizeCategoryToken(category) {
  return String(category || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function isoDate(d) {
  if (!d || isNaN(d.getTime())) return '';
  return d.toISOString().slice(0, 10);
}

// Namespaced/versioned so a V1B fingerprint can never collide with a V1A
// event_fingerprint (no colon-delimited prefix in that format) or with the
// other V1B family. Family fingerprint is the evergreen (account, category)
// or (account) grouping key -- never its own persisted row, just a lookup
// column on the instance rows that share it. Instance fingerprint extends
// the family with the anchor date; a genuinely new anchor is a genuinely
// new instance, deliberately not inheriting a prior instance's feedback.
export function repeatPatternFamilyFingerprint(accountName, category) {
  return `opp:repeat_pattern:${FINGERPRINT_VERSION}:${normalizeCompany(accountName)}|${normalizeCategoryToken(category)}`;
}
export function repeatPatternInstanceFingerprint(accountName, category, lastDate) {
  return `${repeatPatternFamilyFingerprint(accountName, category)}|last:${isoDate(lastDate)}`;
}
export function followUpFamilyFingerprint(accountName) {
  return `opp:follow_up:${FINGERPRINT_VERSION}:${normalizeCompany(accountName)}`;
}
export function followUpInstanceFingerprint(accountName, mostRecentDate) {
  return `${followUpFamilyFingerprint(accountName)}|last:${isoDate(mostRecentDate)}`;
}

// The single canonical "what account-history opportunities currently exist
// for this account" derivation -- the one function reconciliation (on every
// account save) and the one-time backfill both call, so there is exactly
// one place this logic can drift, not two. Never trusts anything except
// rawData (== ha_accounts.raw_data, the same source the dashboard itself
// reads) and the account's own persisted account_name.
export function deriveAccountOpportunities(accountName, rawData) {
  const purchases = parsePurchases(rawData);
  const results = [];

  for (const pattern of findRepeatPatternGroups(purchases)) {
    results.push({
      opportunityType: 'repeat_pattern',
      category: pattern.category,
      familyFingerprint: repeatPatternFamilyFingerprint(accountName, pattern.category),
      fingerprint: repeatPatternInstanceFingerprint(accountName, pattern.category, pattern.lastDate),
      payload: {
        category: pattern.category,
        orderCount: pattern.orderCount,
        years: pattern.years.slice(-5),
        monthLabel: pattern.monthLabel,
        avgRevenue: Math.round(pattern.avgRevenue),
        confidence: pattern.confidence,
        reasonToReachOut: 'Repeat or seasonal buying pattern',
        conversationStarter: 'Ask whether a similar program, order, or event is happening again.'
      }
    });
  }

  const followUp = computeFollowUpEvidence(purchases);
  if (followUp) {
    results.push({
      opportunityType: 'follow_up',
      category: null,
      familyFingerprint: followUpFamilyFingerprint(accountName),
      fingerprint: followUpInstanceFingerprint(accountName, followUp.mostRecentOrderDate),
      payload: {
        mostRecentOrderDate: isoDate(followUp.mostRecentOrderDate),
        orderCount: followUp.orderCount,
        reasonToReachOut: 'Recent order delivered or completed',
        conversationStarter: 'Check in and ask how the recent order was received.'
      }
    });
  }

  return results;
}
