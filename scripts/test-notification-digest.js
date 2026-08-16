// Notification & Outcome Loop V1 step 3 -- deterministic coverage for
// api/lib/notification-digest.js's pure selection/rendering logic. No
// Supabase/HTTP calls -- every scenario is already-fetched candidate rows,
// matching this codebase's established pure-function testability
// convention.
//
// Usage: node scripts/test-notification-digest.js
import { selectDigestContent, renderDigestSubject, renderDigestHtml, renderPreheaderText, initialLookbackHours, filterPriorityEligibleSignals, DAILY_INITIAL_LOOKBACK_HOURS, WEEKLY_INITIAL_LOOKBACK_HOURS } from '../api/lib/notification-digest.js';
import { buildTargetIdentityIndex } from '../api/lib/monitoring-identity.js';

let failures = 0;
function assert(condition, message) {
  if (condition) console.log(`PASS: ${message}`);
  else { failures += 1; console.error(`FAIL: ${message}`); }
}

const NOW = new Date('2026-08-20T00:00:00.000Z');
function hoursAgo(n, from = NOW) { return new Date(from.getTime() - n * 60 * 60 * 1000).toISOString(); }
function daysAgo(n, from = NOW) { return hoursAgo(n * 24, from); }

// A real, actionable payload shape (matches classifyLegacySignalActionability's
// own 'upcoming'/isPriorityEligible:true requirements -- an event-like
// canonicalEventType, a future exact-confidence event_date, and a
// publishedAt field) with NO identityConfidence set, so
// classifyMonitoringSignalEligibility()'s LEGACY GRANDFATHER clause treats
// it as 'priority' by default. Tests that care specifically about the
// priority/secondary distinction override identityConfidence/reasons
// explicitly -- every other test uses this default so it isn't accidentally
// exercising the eligibility gate it isn't testing.
function actionablePayload(overrides = {}) {
  return {
    concreteTrigger: 'Flagship Store Reopening',
    title: 'Flagship Store Reopening',
    businessContext: 'The flagship store has undergone extensive renovations, indicating a commitment to enhancing customer experience and brand presence.',
    publishedAt: 'Jun 11, 2026',
    event_date: '2026-12-01',
    eventDateConfidence: 'exact',
    ...overrides
  };
}

// ---------------------------------------------------------------------------
// Initial lookback defaults.
// ---------------------------------------------------------------------------
assert(DAILY_INITIAL_LOOKBACK_HOURS === 24, 'REQUIRED: daily initial lookback is ~24 hours, per the founder\'s exact specification');
assert(WEEKLY_INITIAL_LOOKBACK_HOURS === 24 * 7, 'REQUIRED: weekly initial lookback is ~7 days, per the founder\'s exact specification');
assert(initialLookbackHours('daily') === 24, 'initialLookbackHours(\'daily\') returns 24');
assert(initialLookbackHours('weekly') === 168, 'initialLookbackHours(\'weekly\') returns 168');

// ---------------------------------------------------------------------------
// First-ever digest (no lastSuccessfulDelivery): watermark is the initial
// lookback, not "all history."
// ---------------------------------------------------------------------------
{
  const signals = [
    { id: 'sig-recent', account_name: 'Acme', title: 'Recent', first_seen_at: hoursAgo(2), payload: actionablePayload() },
    { id: 'sig-old', account_name: 'Beta', title: 'Old', first_seen_at: daysAgo(30), payload: actionablePayload() }
  ];
  const { newSignals } = selectDigestContent({ user: { id: 'user-1', notification_preference: 'daily' }, signals, unresolvedOutreach: [], lastSuccessfulDelivery: null, now: NOW });
  assert(newSignals.length === 1 && newSignals[0].id === 'sig-recent', `REQUIRED: a daily user's first-ever digest only includes signals within the 24h initial lookback, never a 30-day-old signal (got ${JSON.stringify(newSignals.map(s => s.id))})`);
}
{
  const signals = [
    { id: 'sig-within-week', account_name: 'Acme', title: 'Within week', first_seen_at: daysAgo(5), payload: actionablePayload() },
    { id: 'sig-old', account_name: 'Beta', title: 'Old', first_seen_at: daysAgo(30), payload: actionablePayload() }
  ];
  const { newSignals } = selectDigestContent({ user: { id: 'user-1', notification_preference: 'weekly' }, signals, unresolvedOutreach: [], lastSuccessfulDelivery: null, now: NOW });
  assert(newSignals.length === 1 && newSignals[0].id === 'sig-within-week', 'REQUIRED: a weekly user\'s first-ever digest uses the 7-day initial lookback');
}

// ---------------------------------------------------------------------------
// REQUIRED (signal doctrine correction): a signal persisted in ha_signals is
// NOT automatically eligible for a proactive surface -- filterPriorityEligibleSignals()
// must reuse the exact centralized classifyMonitoringSignalEligibility()/
// classifyLegacySignalActionability() policy api/weekly-scan.js's own
// digest already applies, never a new looser definition. 'hidden'/rejected
// and 'secondary' signals are excluded; 'priority' signals (via either
// path) are included; excluding a signal here never mutates it.
// ---------------------------------------------------------------------------
{
  // Path A: strong signal-level corroboration alone -> priority, regardless
  // of target identity state.
  const targetIdentityIndex = buildTargetIdentityIndex([]); // no targets at all -- unresolved by construction
  const priorityByPathA = { id: 'sig-priority-a', account_name: 'Acme Co', payload: actionablePayload({ identityConfidence: 'confirmed', identityCorroboratorReasons: ['verified company domain'] }) };
  const secondaryWeak = { id: 'sig-secondary-weak', account_name: 'Beta Inc', payload: actionablePayload({ identityConfidence: 'possible', identityCorroboratorReasons: ['location match'] }) };
  const hiddenRejected = { id: 'sig-hidden', account_name: 'Gamma LLC', payload: actionablePayload({ identityConfidence: 'rejected', identityCorroboratorReasons: [] }) };
  const legacyGrandfathered = { id: 'sig-legacy', account_name: 'Delta Co', payload: actionablePayload() }; // no identityConfidence at all

  const result = filterPriorityEligibleSignals([priorityByPathA, secondaryWeak, hiddenRejected, legacyGrandfathered], { targetIdentityIndex, userId: 'user-1' });
  const ids = result.map(r => r.id).sort();
  assert(JSON.stringify(ids) === JSON.stringify(['sig-legacy', 'sig-priority-a']), `REQUIRED: only the priority-tier and legacy-grandfathered signals survive -- secondary (weak corroboration) and hidden (rejected) are excluded (got ${JSON.stringify(ids)})`);
}
{
  // Path B: an unresolved target gets NO benefit -- an otherwise-identical
  // signal with only weak corroboration stays secondary even with a
  // resolved target unless the target's anchor is genuinely Strong.
  const weakTargetIndex = buildTargetIdentityIndex([{ user_id: 'user-1', display_account_name: 'Weak Co', identity_status: 'unresolved', identity_domain: null, identity_domain_source: null }]);
  const stillSecondary = { id: 'sig-weak-target', account_name: 'Weak Co', payload: actionablePayload({ identityConfidence: 'possible', identityCorroboratorReasons: [] }) };
  assert(filterPriorityEligibleSignals([stillSecondary], { targetIdentityIndex: weakTargetIndex, userId: 'user-1' }).length === 0, 'REQUIRED: an unresolved target grants no Path B benefit -- a possible-tier signal stays secondary and is excluded');

  // A STRONG target anchor (uploaded-website) promotes an otherwise-bare
  // name-match signal to priority -- Path B, reused verbatim from
  // classifyMonitoringSignalEligibility(), not reimplemented here.
  const strongTargetIndex = buildTargetIdentityIndex([{ user_id: 'user-1', display_account_name: 'Strong Co', identity_status: 'derived', identity_domain: 'strongco.com', identity_domain_source: 'uploaded-website' }]);
  const promotedByPathB = { id: 'sig-strong-target', account_name: 'Strong Co', payload: actionablePayload({ identityConfidence: 'unconfirmed', identityCorroboratorReasons: [] }) };
  const promoted = filterPriorityEligibleSignals([promotedByPathB], { targetIdentityIndex: strongTargetIndex, userId: 'user-1' });
  assert(promoted.length === 1 && promoted[0].id === 'sig-strong-target', 'REQUIRED: a Strong target-side identity anchor (uploaded-website) promotes an otherwise-secondary signal to priority via Path B, reused from the real centralized policy');
}
{
  // Actionability gate: even a priority-tier identity classification is
  // excluded if the signal itself is not actionable (e.g. dateless/ongoing)
  // -- the SAME combined gate api/weekly-scan.js's real digest applies.
  const nonActionable = { id: 'sig-non-actionable', account_name: 'Acme Co', payload: {} }; // empty payload -> ongoing-undated, isPriorityEligible:false
  assert(filterPriorityEligibleSignals([nonActionable], { targetIdentityIndex: buildTargetIdentityIndex([]), userId: 'user-1' }).length === 0, 'REQUIRED: a non-actionable signal is excluded even without any identity concern -- both gates must pass');
}
{
  // End-to-end through selectDigestContent(): a recent priority signal is
  // included in the New Intelligence section; a recent secondary signal
  // (same recency, same digest) is excluded -- proving the eligibility
  // gate is actually wired into the real selection path, not just the
  // standalone filter function.
  const targetIdentityIndex = buildTargetIdentityIndex([]);
  const signals = [
    { id: 'sig-priority', account_name: 'Priority Co', first_seen_at: hoursAgo(1), payload: actionablePayload({ identityConfidence: 'confirmed', identityCorroboratorReasons: ['verified company domain'] }) },
    { id: 'sig-secondary', account_name: 'Secondary Co', first_seen_at: hoursAgo(1), payload: actionablePayload({ identityConfidence: 'possible', identityCorroboratorReasons: ['location match'] }) }
  ];
  const { newSignals } = selectDigestContent({ user: { id: 'user-1', notification_preference: 'daily' }, signals, unresolvedOutreach: [], lastSuccessfulDelivery: null, targetIdentityIndex, now: NOW });
  assert(newSignals.length === 1 && newSignals[0].id === 'sig-priority', `REQUIRED: a recent PRIORITY signal is included and a recent SECONDARY signal (same age, same digest) is excluded from the New Intelligence section (got ${JSON.stringify(newSignals.map(s => s.id))})`);
}

// ---------------------------------------------------------------------------
// Subsequent digest: watermark is the last successful delivery's sent_at,
// not the initial lookback -- a signal older than the lookback window but
// newer than the watermark still counts as new relative to what they
// already saw... except the watermark IS newer than any initial-lookback
// boundary in steady state, so this really just proves "only what's newer
// than last success" governs once one exists.
// ---------------------------------------------------------------------------
{
  const lastSuccessfulDelivery = { sent_at: hoursAgo(3), included_signal_ids: [], included_outreach_event_ids: [] };
  const signals = [
    { id: 'sig-since-last', account_name: 'Acme', title: 'New', first_seen_at: hoursAgo(1), payload: actionablePayload() },
    { id: 'sig-before-last', account_name: 'Beta', title: 'Already seen', first_seen_at: hoursAgo(5), payload: actionablePayload() }
  ];
  const { newSignals } = selectDigestContent({ user: { id: 'user-1', notification_preference: 'daily' }, signals, unresolvedOutreach: [], lastSuccessfulDelivery, now: NOW });
  assert(newSignals.length === 1 && newSignals[0].id === 'sig-since-last', `REQUIRED: only signals newer than the last SUCCESSFUL delivery's sent_at count as new (got ${JSON.stringify(newSignals.map(s => s.id))})`);
}

// ---------------------------------------------------------------------------
// Empty digest detection -- hasContent is false when there's genuinely
// nothing new and nothing prompt-eligible.
// ---------------------------------------------------------------------------
{
  const { hasContent } = selectDigestContent({ user: { notification_preference: 'daily' }, signals: [], unresolvedOutreach: [], lastSuccessfulDelivery: null, now: NOW });
  assert(hasContent === false, 'REQUIRED: zero new signals and zero eligible outreach produces hasContent:false -- the caller must never send an empty "nothing happened" email');
}

// ---------------------------------------------------------------------------
// Outreach eligibility gate: only isEligibleForPrompt:true items ever reach
// the digest, regardless of isStillOpen.
// ---------------------------------------------------------------------------
{
  const unresolvedOutreach = [
    { outreachEventId: 'or-eligible', accountName: 'Acme', outreachCreatedAt: daysAgo(6), latestOutcomeReportedAt: null, isEligibleForPrompt: true, isStillOpen: true },
    { outreachEventId: 'or-not-yet', accountName: 'Beta', outreachCreatedAt: daysAgo(2), latestOutcomeReportedAt: null, isEligibleForPrompt: false, isStillOpen: true }
  ];
  const { promptEligibleOutreach, hasContent } = selectDigestContent({ user: { notification_preference: 'daily' }, signals: [], unresolvedOutreach, lastSuccessfulDelivery: null, now: NOW });
  assert(promptEligibleOutreach.length === 1 && promptEligibleOutreach[0].outreachEventId === 'or-eligible', 'REQUIRED: only isEligibleForPrompt:true outreach items are ever included in a digest');
  assert(hasContent === true, 'a digest with only an eligible outreach prompt (no new signals) still has content');
}

// ---------------------------------------------------------------------------
// REQUIRED: re-inclusion suppression. An eligible item already mentioned in
// the last successful delivery, with NOTHING changed since, is suppressed
// -- this is what stops the SAME "still waiting" prompt appearing on every
// single daily digest forever.
// ---------------------------------------------------------------------------
{
  const lastSuccessfulDelivery = { sent_at: hoursAgo(20), included_signal_ids: [], included_outreach_event_ids: ['or-mentioned'] };
  const unresolvedOutreach = [
    // Still eligible today, but nothing has changed since it was mentioned
    // 20 hours ago (its outreachCreatedAt predates the last delivery).
    { outreachEventId: 'or-mentioned', accountName: 'Acme', outreachCreatedAt: daysAgo(10), latestOutcomeReportedAt: null, isEligibleForPrompt: true, isStillOpen: true }
  ];
  const { promptEligibleOutreach } = selectDigestContent({ user: { notification_preference: 'daily' }, signals: [], unresolvedOutreach, lastSuccessfulDelivery, now: NOW });
  assert(promptEligibleOutreach.length === 0, `REQUIRED: an already-mentioned, unchanged outreach item is suppressed from repeating on every daily digest (got ${JSON.stringify(promptEligibleOutreach)})`);
}
{
  // Mirror case: already mentioned, but a FRESH report landed since --
  // must re-qualify, not stay suppressed forever.
  const lastSuccessfulDelivery = { sent_at: hoursAgo(20), included_signal_ids: [], included_outreach_event_ids: ['or-mentioned'] };
  const unresolvedOutreach = [
    { outreachEventId: 'or-mentioned', accountName: 'Acme', outreachCreatedAt: daysAgo(10), latestOutcomeReportedAt: hoursAgo(1), isEligibleForPrompt: true, isStillOpen: true }
  ];
  const { promptEligibleOutreach } = selectDigestContent({ user: { notification_preference: 'daily' }, signals: [], unresolvedOutreach, lastSuccessfulDelivery, now: NOW });
  assert(promptEligibleOutreach.length === 1, 'REQUIRED: a genuinely fresher report (latestOutcomeReportedAt newer than the last delivery) re-qualifies an already-mentioned item, it is never suppressed forever');
}
{
  // Eligible item NEVER mentioned before -- included even if old, since
  // there is nothing to suppress it against.
  const lastSuccessfulDelivery = { sent_at: hoursAgo(20), included_signal_ids: [], included_outreach_event_ids: ['or-other'] };
  const unresolvedOutreach = [
    { outreachEventId: 'or-never-mentioned', accountName: 'Acme', outreachCreatedAt: daysAgo(30), latestOutcomeReportedAt: null, isEligibleForPrompt: true, isStillOpen: true }
  ];
  const { promptEligibleOutreach } = selectDigestContent({ user: { notification_preference: 'daily' }, signals: [], unresolvedOutreach, lastSuccessfulDelivery, now: NOW });
  assert(promptEligibleOutreach.length === 1, 'an eligible item that was never mentioned in the last successful delivery is included, regardless of age');
}
{
  // First-ever digest (no lastSuccessfulDelivery at all): nothing to
  // suppress against, every eligible item is included.
  const unresolvedOutreach = [
    { outreachEventId: 'or-1', accountName: 'Acme', outreachCreatedAt: daysAgo(30), latestOutcomeReportedAt: null, isEligibleForPrompt: true, isStillOpen: true }
  ];
  const { promptEligibleOutreach } = selectDigestContent({ user: { notification_preference: 'daily' }, signals: [], unresolvedOutreach, lastSuccessfulDelivery: null, now: NOW });
  assert(promptEligibleOutreach.length === 1, 'a first-ever digest has no suppression history to check against -- eligible items are simply included');
}

// ---------------------------------------------------------------------------
// Rendering: subject/HTML reflect the actual selected content, never an
// empty-state message masquerading as real content.
// ---------------------------------------------------------------------------
{
  const subject = renderDigestSubject({ newSignals: [{ account_name: 'Acme Co' }], promptEligibleOutreach: [] });
  assert(subject === '1 account worth a look', `REQUIRED: signals-only subject uses the founder's concise count-based shape, singular (got ${JSON.stringify(subject)})`);
}
{
  const subject = renderDigestSubject({ newSignals: [{ account_name: 'A' }, { account_name: 'B' }], promptEligibleOutreach: [] });
  assert(subject === '2 accounts worth a look', `REQUIRED: signals-only subject uses the founder's concise count-based shape, plural (got ${JSON.stringify(subject)})`);
}
{
  const subject = renderDigestSubject({ newSignals: [], promptEligibleOutreach: [{ accountName: 'Acme' }] });
  assert(subject === '1 follow-up waiting on you', `REQUIRED: follow-ups-only subject, singular (got ${JSON.stringify(subject)})`);
}
{
  const subject = renderDigestSubject({ newSignals: [], promptEligibleOutreach: [{ accountName: 'Acme' }, { accountName: 'Beta' }] });
  assert(subject === '2 follow-ups waiting on you', `REQUIRED: follow-ups-only subject, plural (got ${JSON.stringify(subject)})`);
}
{
  const subject = renderDigestSubject({ newSignals: [{ account_name: 'Acme Co' }], promptEligibleOutreach: [{ accountName: 'Beta' }] });
  assert(subject === '1 account worth a look + 1 follow-up', `REQUIRED: combined subject matches the founder's exact preferred shape (got ${JSON.stringify(subject)})`);
}
{
  const subject = renderDigestSubject({ newSignals: [{ account_name: 'A' }, { account_name: 'B' }], promptEligibleOutreach: [{ accountName: 'X' }, { accountName: 'Y' }, { accountName: 'Z' }] });
  assert(subject === '2 accounts worth a look + 3 follow-ups', `REQUIRED: combined subject pluralizes both halves independently (got ${JSON.stringify(subject)})`);
}

// ---------------------------------------------------------------------------
// Hidden preheader (founder-approved small email improvement): dynamic
// per signal/follow-up counts, per the founder's exact example shape.
// ---------------------------------------------------------------------------
{
  const preheader = renderPreheaderText({ newSignals: [{ account_name: 'L.L. Bean' }], promptEligibleOutreach: [{ accountName: 'Acme' }] });
  assert(preheader === 'L.L. Bean has a new reason to reach out. Plus 1 follow-up waiting on you.', `REQUIRED: the preheader matches the founder's exact preferred shape for 1 signal + 1 follow-up (got ${JSON.stringify(preheader)})`);
}
{
  const preheader = renderPreheaderText({ newSignals: [{ account_name: 'L.L. Bean' }], promptEligibleOutreach: [] });
  assert(preheader === 'L.L. Bean has a new reason to reach out.', `REQUIRED: a single signal with no follow-ups names the account, no "Plus" clause (got ${JSON.stringify(preheader)})`);
}
{
  const preheader = renderPreheaderText({ newSignals: [{ account_name: 'A' }, { account_name: 'B' }], promptEligibleOutreach: [] });
  assert(preheader === '2 accounts have new reasons to reach out.', `REQUIRED: multiple signals use count-based phrasing, not multiple account names (got ${JSON.stringify(preheader)})`);
}
{
  const preheader = renderPreheaderText({ newSignals: [], promptEligibleOutreach: [{ accountName: 'Acme' }] });
  assert(preheader === '1 follow-up waiting on you.', `REQUIRED: follow-ups-only preheader, singular (got ${JSON.stringify(preheader)})`);
}
{
  const preheader = renderPreheaderText({ newSignals: [], promptEligibleOutreach: [{ accountName: 'A' }, { accountName: 'B' }] });
  assert(preheader === '2 follow-ups waiting on you.', `REQUIRED: follow-ups-only preheader, plural (got ${JSON.stringify(preheader)})`);
}
{
  const preheader = renderPreheaderText({ newSignals: [{ account_name: 'A' }, { account_name: 'B' }], promptEligibleOutreach: [{ accountName: 'X' }, { accountName: 'Y' }, { accountName: 'Z' }] });
  assert(preheader === '2 accounts have new reasons to reach out. Plus 3 follow-ups waiting on you.', `REQUIRED: combined preheader pluralizes both halves independently (got ${JSON.stringify(preheader)})`);
}
{
  const html = renderDigestHtml({ user: { email: 'rep@example.com' }, newSignals: [{ account_name: 'L.L. Bean', title: 'Flagship Store Reopening' }], promptEligibleOutreach: [{ accountName: 'Acme', outreachEventId: 'or-1', outreachCreatedAt: daysAgo(2) }], baseUrl: 'https://app.example.com', now: NOW });
  assert(html.includes('L.L. Bean has a new reason to reach out. Plus 1 follow-up waiting on you.'), `REQUIRED: renderDigestHtml() embeds the exact rendered preheader text (got no match)`);
  assert(/display:\s*none/.test(html.split('L.L. Bean has a new reason')[0].slice(-400)), 'REQUIRED: the preheader is wrapped in a display:none element, never visible when the email is opened');
  assert(html.indexOf('L.L. Bean has a new reason to reach out. Plus 1 follow-up waiting on you.') < html.indexOf('New Intelligence'), 'REQUIRED: the preheader is the very first text in the document, before the visible body');
}
{
  const html = renderDigestHtml({ user: { email: 'rep@example.com' }, newSignals: [{ account_name: 'Dover Honda', title: 'Holiday parade activity' }], promptEligibleOutreach: [], baseUrl: 'https://app.example.com' });
  assert(html.includes('Dover Honda') && html.includes('Holiday parade activity'), 'REQUIRED: the rendered HTML includes the real account name and signal title, not a placeholder');
  assert(html.includes('New Intelligence'), 'REQUIRED: the New Intelligence section is visually/textually distinct with its own heading');
  // Compared against the signal TITLE, not the account name -- the hidden
  // preheader (added below) also names the account and deliberately sits
  // before the visible body, so comparing against the account name alone
  // would find the preheader's own (correct, but not visible-body) mention
  // instead of proving the VISIBLE section ordering this assertion is
  // actually about. The title never appears in the preheader.
  assert(html.indexOf('New Intelligence') < html.indexOf('Holiday parade activity'), 'REQUIRED: the section heading renders before the signal content it introduces');
}
{
  const html = renderDigestHtml({ user: { email: 'rep@example.com' }, newSignals: [], promptEligibleOutreach: [{ accountName: 'Dover Honda', outreachEventId: 'or-1', outreachCreatedAt: daysAgo(3) }], baseUrl: 'https://app.example.com', now: NOW });
  assert(html.includes('How Did This Go?'), 'REQUIRED: the outreach section has its own distinct "How Did This Go?" heading, visually separated from New Intelligence');
  assert(html.includes('You reached out to Dover Honda 3 days ago.'), `REQUIRED: the outreach prompt uses the founder-specified "reached out ... ago" phrasing with a real day count (got: ${html.match(/You reached out[^<]*/)})`);
  assert(html.includes('Report outcome →'), 'REQUIRED: the outreach prompt uses the founder-specified "Report outcome ->" link text');
  assert(html.includes('href="https://app.example.com/dashboard/?outreach=or-1"'), `REQUIRED: Notification Deep Links -- the Report outcome link carries this exact outreach's own outreachEventId so it lands on the specific item, not just the dashboard (got: ${html.match(/href="[^"]*outreach[^"]*"/g)})`);
}
{
  const extra = Array.from({ length: 8 }, (_, i) => ({ account_name: `Account ${i}`, title: 'Signal' }));
  const html = renderDigestHtml({ user: { email: 'rep@example.com' }, newSignals: extra, promptEligibleOutreach: [], baseUrl: 'https://app.example.com' });
  assert(html.includes('3 more in House Accounts'), `REQUIRED: only the top 5 headline signals render inline, the rest collapse into an "N more in House Accounts" line matching the founder's example (got no match in: ${html.includes('more in House Accounts')})`);
}
{
  const html = renderDigestHtml({ user: { email: 'rep@example.com' }, newSignals: [{ account_name: 'Dover Honda', title: 'Holiday parade activity' }], promptEligibleOutreach: [{ accountName: 'Acme', outreachEventId: 'or-1', outreachCreatedAt: daysAgo(1) }], baseUrl: 'https://app.example.com/', now: NOW });
  assert(html.includes('https://app.example.com/dashboard/'), `REQUIRED: the fallback CTA and outreach prompt links point at the authenticated /dashboard/ route, not the marketing homepage (got: ${html.match(/href="[^"]*"/g)})`);
  assert(!html.includes('dashboardEmail'), 'REQUIRED: the vestigial dashboardEmail query param must never reappear on any CTA link');
  assert(!/href="https:\/\/app\.example\.com\/?"/.test(html), 'REQUIRED: no link regresses back to the bare marketing homepage URL');
  assert(html.includes('Open Dashboard →'), 'REQUIRED: a general Open Dashboard fallback/global CTA is always present alongside the specific per-item links');
}

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
