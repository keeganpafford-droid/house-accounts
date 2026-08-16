// Notification & Outcome Loop V1 step 3: pure(ish) digest assembly --
// selection logic, HTML/subject rendering. No Supabase/HTTP calls of its
// own; every input is already-fetched data, matching this codebase's
// established pure-function testability convention. api/notification-
// scheduler.js is the thin route that fetches the real data and calls
// api/lib/email.js's sendEmail() with this module's output.
//
// This was deliberately a NEW template, not a reuse of the legacy
// api/weekly-scan.js's rich opportunityCardHtml()/reportHtml() -- the
// founder's own spec for this artifact is a compact "N accounts worth a
// look, two headline lines, X more in House Accounts" digest plus an
// unresolved-outreach section the old Monday Brief template had no concept
// of at all; forcing a shared template would have coupled two structurally
// different emails together for no real benefit. The one genuinely
// duplicative piece (the outbound Resend call itself) is shared via
// api/lib/email.js. api/weekly-scan.js was retired with the Full Beta
// Cutover, so this is now the only digest email House Accounts sends --
// the template-unification question this comment used to defer is moot.
// Signal doctrine correction: a row persisted in ha_signals is NOT the same
// thing as it being eligible for a PROACTIVE surface. classifyMonitoringSignalEligibility()
// (+ lookupTargetIdentity()) is the ONE centralized priority/secondary/
// hidden policy every consumer must call -- the dashboard opportunity feed
// (api/get-dashboard.js) applies it too -- reused here verbatim, never
// recreated. classifyLegacySignalActionability() is the companion
// actionability gate the dashboard also applies (dateless/non-commercial
// signals can be identity-eligible yet still not actionable enough to push
// proactively) -- both gates together are what "priority" means for a
// proactive surface, exactly matching the dashboard's own doctrine.
import { classifyMonitoringSignalEligibility, lookupTargetIdentity } from './monitoring-identity.js';
import { classifyLegacySignalActionability } from '../research-batch.js';

export const DAILY_INITIAL_LOOKBACK_HOURS = 24;
export const WEEKLY_INITIAL_LOOKBACK_HOURS = 24 * 7;

// For a user with no prior successful delivery, how far back "new" reaches
// on their very first-ever notification -- per the founder's exact
// specification, so a brand-new daily/weekly subscriber never gets flooded
// with months of historical intelligence on day one.
export function initialLookbackHours(preference) {
  return preference === 'daily' ? DAILY_INITIAL_LOOKBACK_HOURS : WEEKLY_INITIAL_LOOKBACK_HOURS;
}

function escapeHtml(value = '') {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Reuses the exact centralized eligibility policy the dashboard opportunity
// feed already applies -- not a second, looser notion of "new
// intelligence." A signal being persisted in ha_signals only means research
// found and stored it; whether it's strong enough to push proactively is a
// separate question this policy alone answers. 'secondary' signals are
// simply excluded from proactive surfaces here -- never deleted, never
// mutated, still fully visible in HA's own View Research / Research
// Details per the already-banked dashboard doctrine (this function has no
// write path at all). targetIdentityIndex is built once per scheduler
// invocation the same way api/get-dashboard.js builds its own (see
// buildTargetIdentityIndex() in api/lib/monitoring-identity.js) and passed
// in here, never rebuilt or reinvented per call.
export function filterPriorityEligibleSignals(signals, { targetIdentityIndex, userId } = {}) {
  return (signals || []).filter(row => {
    if (classifyLegacySignalActionability(row.payload || {}).actionabilityStatus?.isPriorityEligible === false) return false;
    const rowTargetIdentity = lookupTargetIdentity(targetIdentityIndex, userId, row.account_name);
    return classifyMonitoringSignalEligibility({
      identityConfidence: row.payload?.identityConfidence,
      reasons: row.payload?.identityCorroboratorReasons,
      targetIdentityDomainSource: rowTargetIdentity.source
    }) === 'priority';
  });
}

// Selection: which signals/outreach items actually belong in THIS
// notification. signals/unresolvedOutreach are already-fetched candidate
// rows (unresolvedOutreach already filtered to isStillOpen by
// api/unresolved-outreach.js's own listUnresolvedOutreach()) --
// this function narrows further to what's genuinely NEW/eligible for this
// specific delivery.
//
//   lastSuccessfulDelivery: the user's most recent status='success' row
//     from ha_notification_deliveries, or null if they've never had one.
//     Drives BOTH the "new since when" watermark for signals AND the
//     re-inclusion suppression for outreach prompts -- one watermark
//     concept, not two independently-tracked ones.
//
//   Outreach suppression: an eligible item is excluded if it was already
//     mentioned in the last successful delivery AND nothing has changed
//     about it since (no fresher outcome_reported report landed) -- this is
//     what stops the SAME "still waiting" prompt appearing on every single
//     daily digest forever; a genuinely new report always re-qualifies
//     regardless of how recently it was last mentioned.
//
//   Eligibility runs FIRST, before the recency watermark -- signals is
//   filtered through filterPriorityEligibleSignals() before anything else,
//   so a secondary signal can never enter the New Intelligence section
//   regardless of how recent it is.
export function selectDigestContent({ user, signals = [], unresolvedOutreach = [], lastSuccessfulDelivery = null, targetIdentityIndex, now = new Date() }) {
  const watermarkMs = lastSuccessfulDelivery
    ? new Date(lastSuccessfulDelivery.sent_at).getTime()
    : now.getTime() - initialLookbackHours(user.notification_preference) * 60 * 60 * 1000;

  const eligibleSignals = filterPriorityEligibleSignals(signals, { targetIdentityIndex, userId: user.id });
  const newSignals = eligibleSignals.filter(s => new Date(s.first_seen_at).getTime() > watermarkMs);

  const previouslyIncludedOutreachIds = new Set(lastSuccessfulDelivery?.included_outreach_event_ids || []);
  const promptEligibleOutreach = unresolvedOutreach.filter(item => {
    if (!item.isEligibleForPrompt) return false;
    if (!lastSuccessfulDelivery) return true; // first-ever digest: nothing to suppress against
    const lastChangedMs = new Date(item.latestOutcomeReportedAt || item.outreachCreatedAt).getTime();
    const alreadyMentioned = previouslyIncludedOutreachIds.has(item.outreachEventId);
    return !(alreadyMentioned && lastChangedMs <= watermarkMs);
  });

  return {
    hasContent: newSignals.length > 0 || promptEligibleOutreach.length > 0,
    newSignals,
    promptEligibleOutreach
  };
}

const MAX_HEADLINE_SIGNALS = 5;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

function pluralize(count, singular, plural) {
  return `${count} ${count === 1 ? singular : (plural || `${singular}s`)}`;
}

// Concise, count-based subject per the founder's exact preferred shapes --
// replaces the old verbose/clunky "1 new reason to reach out, plus outreach
// to follow up on" phrasing entirely, for all three cases (not just the
// combined one). No cadence-specific copy (daily vs weekly reads
// identically) -- deliberately not overbuilt.
export function renderDigestSubject({ newSignals = [], promptEligibleOutreach = [] }) {
  const signalCount = newSignals.length;
  const outreachCount = promptEligibleOutreach.length;
  const signalPart = pluralize(signalCount, 'account worth a look', 'accounts worth a look');
  const outreachPart = pluralize(outreachCount, 'follow-up', 'follow-ups');
  if (signalCount && outreachCount) return `${signalPart} + ${outreachPart}`;
  if (signalCount) return signalPart;
  if (outreachCount) return `${outreachPart} waiting on you`;
  // selectDigestContent()'s hasContent gate means an empty digest is never
  // actually sent -- this fallback exists only so the function itself
  // never returns something nonsensical if called directly.
  return 'House Accounts update';
}

// Hidden preheader text (founder-approved small email improvement): without
// this, Gmail/most inbox clients scrape the first visible text in the body
// for the inbox preview snippet -- for this template that would be the
// "House Accounts" eyebrow label, not anything useful. Dynamic per the
// founder's exact example shape ("L.L. Bean has a new reason to reach out.
// Plus 1 follow-up waiting on you." for 1 signal + 1 follow-up), correctly
// pluralized, concise. Deliberately separate copy from renderDigestSubject()
// -- the subject is count-only by design; the preheader can afford to name
// the single top account when there's exactly one, since it has more room
// and a different job (inbox curiosity, not scanability across many emails).
export function renderPreheaderText({ newSignals = [], promptEligibleOutreach = [] }) {
  const signalCount = newSignals.length;
  const outreachCount = promptEligibleOutreach.length;
  let signalPart = '';
  if (signalCount === 1) {
    signalPart = `${escapeHtml(newSignals[0].account_name) || 'An account'} has a new reason to reach out.`;
  } else if (signalCount > 1) {
    signalPart = `${signalCount} accounts have new reasons to reach out.`;
  }
  const outreachPart = outreachCount ? `${pluralize(outreachCount, 'follow-up', 'follow-ups')} waiting on you.` : '';
  if (signalPart && outreachPart) return `${signalPart} Plus ${outreachPart}`;
  if (signalPart) return signalPart;
  if (outreachPart) return outreachPart;
  return 'House Accounts has an update for you.';
}

function daysAgoLabel(iso, now) {
  const ms = now.getTime() - new Date(iso).getTime();
  const days = Math.max(0, Math.floor(ms / MS_PER_DAY));
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

// Notification Deep Links (bounded scope, see api/notification-scheduler.js's
// own comment on the same topic): outreachEventId is the exact same stable
// ha_signal_events primary key dashboard/index.html's unresolved-outreach
// panel already keys everything on and now stamps as data-outreach-event-id
// -- reusing it here as a query param is the smallest possible way to land
// a rep on the SPECIFIC outreach the email is asking about, not just the
// general dashboard. A per-SIGNAL deep link ("View opportunity ->") is
// deliberately NOT built yet: unlike this outreach panel (one small,
// self-contained fetch+render function), the priorities feed a signal would
// need to deep-link into is a much larger, async, collapsing/deduping
// render pipeline where the exact same signal may no longer render as a
// distinct card by the time a rep opens the email days later -- see
// BACKLOG.md's "Notification Deep Links / Actionable Re-entry" entry.
function outreachDeepLinkUrl(dashboardUrl, outreachEventId) {
  return `${dashboardUrl}?outreach=${encodeURIComponent(outreachEventId)}`;
}

export function renderDigestHtml({ user, newSignals = [], promptEligibleOutreach = [], baseUrl, now = new Date() }) {
  const dashboardUrl = `${String(baseUrl || '').replace(/\/$/, '')}/dashboard/`;
  const headline = newSignals.slice(0, MAX_HEADLINE_SIGNALS);
  const extraCount = Math.max(newSignals.length - headline.length, 0);
  const signalLines = headline
    .map(s => `<div style="margin:0 0 14px;">
      <div style="font-weight:700;font-size:15px;color:#17375E;">${escapeHtml(s.account_name || 'Account')}</div>
      <div style="margin-top:2px;color:#5b677a;font-size:14px;">${escapeHtml(s.title || s.signal_type || 'New reason to reach out')}</div>
    </div>`)
    .join('');
  const extraLine = extraCount > 0
    ? `<div style="margin:4px 0 0;color:#5b677a;font-size:14px;">${extraCount} more in House Accounts</div>`
    : '';
  const signalsBlock = newSignals.length ? `<div style="margin:0 0 26px;">
    <div style="font-size:12px;font-weight:700;color:#1FB7AE;letter-spacing:.06em;text-transform:uppercase;margin-bottom:12px;">New Intelligence</div>
    ${signalLines}
    ${extraLine}
  </div>` : '';

  // Founder QA correction: in a mixed email the large filled "Open
  // Dashboard" button visually dominated, so a rep would default to
  // clicking it instead of the contextual deep link this section exists
  // for. Each outreach item's own link is now styled as the PROMINENT
  // (filled, button-style) action -- reusing the exact same visual
  // language the generic CTA used to own -- while the generic CTA is
  // demoted to a small secondary link when outreach exists (see
  // primaryCta/secondaryCta below). Still the same outreachDeepLinkUrl()
  // per item, unchanged -- only copy and styling changed, not the link
  // target or the deep-link mechanism itself.
  const hasOutreach = promptEligibleOutreach.length > 0;
  const outreachLines = promptEligibleOutreach
    .map(item => `<div style="margin:0 0 16px;">
      <div style="color:#25364d;font-size:14px;margin-bottom:8px;">You reached out to ${escapeHtml(item.accountName)} ${daysAgoLabel(item.outreachCreatedAt, now)}.</div>
      <a href="${outreachDeepLinkUrl(dashboardUrl, item.outreachEventId)}" style="display:inline-block;background:#1FB7AE;color:#ffffff;padding:10px 18px;text-decoration:none;border-radius:8px;font-weight:700;font-size:14px;">Tell us how it went →</a>
    </div>`)
    .join('');
  const outreachBlock = hasOutreach ? `<div style="margin:0 0 26px;padding-top:22px;border-top:1px solid #D8DEE9;">
    <div style="font-size:12px;font-weight:700;color:#1FB7AE;letter-spacing:.06em;text-transform:uppercase;margin-bottom:12px;">How Did This Go?</div>
    ${outreachLines}
  </div>` : '';

  // No contextual outreach action exists -- the general dashboard CTA has
  // nothing to lose to, so it stays the prominent primary button exactly
  // as before.
  const primaryCta = hasOutreach ? '' : `<div style="margin:4px 0 0;">
      <a href="${dashboardUrl}" style="display:inline-block;background:#1FB7AE;color:#ffffff;padding:14px 22px;text-decoration:none;border-radius:8px;font-weight:700;font-size:15px;">Open Dashboard →</a>
    </div>`;
  // Demoted: small, unfilled, centered -- still present and functional
  // (the general fallback/global CTA per the founder's spec), just no
  // longer visually competing with the per-item contextual action above.
  const secondaryCta = hasOutreach ? `<div style="margin:20px 0 0;text-align:center;">
      <a href="${dashboardUrl}" style="color:#5b677a;font-weight:700;text-decoration:none;font-size:13px;">Open House Accounts →</a>
    </div>` : '';

  // Hidden preheader: display:none/font-size:1/color-matched/max-height:0/
  // opacity:0 covers every major client's hiding quirks (Gmail/Outlook/
  // Apple Mail all differ in which single rule they honor); the trailing
  // zero-width-space + non-breaking-space padding stops Gmail from
  // appending the next VISIBLE text (the "House Accounts" eyebrow) onto
  // the inbox preview once the real preheader text runs out. Never
  // rendered/visible once the email is actually opened -- purely an inbox-
  // list affordance.
  const preheaderText = renderPreheaderText({ newSignals, promptEligibleOutreach });
  const preheaderPadding = '&zwnj;&nbsp;'.repeat(40);
  const preheaderHtml = `<div style="display:none;font-size:1px;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;mso-hide:all;color:#F7F8FA;">${escapeHtml(preheaderText)}${preheaderPadding}</div>`;

  return `<div style="margin:0;padding:0;background:#F7F8FA;font-family:Arial,sans-serif;color:#17375E;">
    ${preheaderHtml}
    <div style="max-width:600px;margin:0 auto;padding:28px 16px;">
      <div style="background:#ffffff;border:1px solid #D8DEE9;border-radius:18px;padding:28px;">
        <div style="font-size:13px;font-weight:700;color:#1FB7AE;letter-spacing:.04em;text-transform:uppercase;margin-bottom:20px;">House Accounts</div>
        ${signalsBlock}
        ${outreachBlock}
        ${primaryCta}
        ${secondaryCta}
      </div>
      <p style="text-align:center;margin:16px 0 0;color:#7b8794;font-size:12px;">House Accounts helps you focus on who to contact this week, and why.</p>
    </div>
  </div>`;
}
