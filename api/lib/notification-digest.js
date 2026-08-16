// Notification & Outcome Loop V1 step 3: pure(ish) digest assembly --
// selection logic, HTML/subject rendering. No Supabase/HTTP calls of its
// own; every input is already-fetched data, matching this codebase's
// established pure-function testability convention. api/notification-
// scheduler.js is the thin route that fetches the real data and calls
// api/lib/email.js's sendEmail() with this module's output.
//
// This is deliberately a NEW template, not a reuse of api/weekly-scan.js's
// rich opportunityCardHtml()/reportHtml() -- the founder's own spec for
// this artifact is a compact "N accounts worth a look, two headline lines,
// X more in House Accounts" digest plus an unresolved-outreach section
// weekly-scan's template has no concept of at all; forcing a shared
// template today would couple two structurally different emails together
// for no real benefit. The one genuinely duplicative piece (the outbound
// Resend call itself) is shared via api/lib/email.js. Template unification
// is a natural candidate for the eventual Monday Brief cutover (Step 6),
// once weekly-scan's digest is actually being REPLACED rather than run
// alongside this one.
import { clean } from './signal-persistence.js';

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
export function selectDigestContent({ user, signals = [], unresolvedOutreach = [], lastSuccessfulDelivery = null, now = new Date() }) {
  const watermarkMs = lastSuccessfulDelivery
    ? new Date(lastSuccessfulDelivery.sent_at).getTime()
    : now.getTime() - initialLookbackHours(user.notification_preference) * 60 * 60 * 1000;

  const newSignals = signals.filter(s => new Date(s.first_seen_at).getTime() > watermarkMs);

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

export function renderDigestSubject({ newSignals = [], promptEligibleOutreach = [] }) {
  if (newSignals.length && promptEligibleOutreach.length) {
    return `${newSignals.length} new reason${newSignals.length === 1 ? '' : 's'} to reach out, plus outreach to follow up on`;
  }
  if (newSignals.length === 1) return `1 new reason to reach out this week: ${clean(newSignals[0].account_name) || 'your top account'}`;
  if (newSignals.length) return `${newSignals.length} new reasons to reach out this week`;
  return 'Outreach waiting on an update';
}

export function renderDigestHtml({ user, newSignals = [], promptEligibleOutreach = [], baseUrl }) {
  const dashboardUrl = `${String(baseUrl || '').replace(/\/$/, '')}?dashboardEmail=${encodeURIComponent(user.email || '')}`;
  const headline = newSignals.slice(0, MAX_HEADLINE_SIGNALS);
  const extraCount = Math.max(newSignals.length - headline.length, 0);
  const signalLines = headline
    .map(s => `<div style="margin:6px 0;color:#25364d;">${escapeHtml(s.account_name || 'Account')} — ${escapeHtml(s.title || s.signal_type || 'New reason to reach out')}</div>`)
    .join('');
  const extraLine = extraCount > 0
    ? `<div style="margin:8px 0 0;color:#5b677a;">${extraCount} more in House Accounts</div>`
    : '';
  const signalsBlock = newSignals.length ? `<div style="margin:0 0 22px;">
    <div style="font-weight:700;font-size:16px;margin-bottom:8px;color:#17375E;">${newSignals.length} account${newSignals.length === 1 ? '' : 's'} worth a look this week</div>
    ${signalLines}
    ${extraLine}
  </div>` : '';

  const outreachLines = promptEligibleOutreach
    .map(item => `<div style="margin:10px 0;color:#25364d;">You reached out to ${escapeHtml(item.accountName)} — how did it go? <a href="${dashboardUrl}" style="color:#1FB7AE;font-weight:700;text-decoration:none;">Tell House Accounts →</a></div>`)
    .join('');
  const outreachBlock = promptEligibleOutreach.length ? `<div>${outreachLines}</div>` : '';

  return `<div style="margin:0;padding:0;background:#F7F8FA;font-family:Arial,sans-serif;color:#17375E;">
    <div style="max-width:600px;margin:0 auto;padding:28px 16px;">
      <div style="background:#ffffff;border:1px solid #D8DEE9;border-radius:18px;padding:28px;">
        <div style="font-size:13px;font-weight:700;color:#1FB7AE;letter-spacing:.04em;text-transform:uppercase;margin-bottom:14px;">House Accounts</div>
        ${signalsBlock}
        ${outreachBlock}
        <div style="margin:24px 0 0;">
          <a href="${dashboardUrl}" style="display:inline-block;background:#1FB7AE;color:#ffffff;padding:14px 22px;text-decoration:none;border-radius:8px;font-weight:700;font-size:15px;">Open Dashboard →</a>
        </div>
      </div>
      <p style="text-align:center;margin:16px 0 0;color:#7b8794;font-size:12px;">House Accounts helps you focus on who to contact this week, and why.</p>
    </div>
  </div>`;
}
