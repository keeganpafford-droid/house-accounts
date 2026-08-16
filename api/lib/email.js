// Shared Resend-calling helper. Extracted from api/weekly-scan.js's own
// local sendEmail() (byte-for-byte identical behavior) so the new,
// independent notification scheduler (api/notification-scheduler.js) and
// the legacy weekly digest share exactly ONE outbound-email implementation
// from day one -- weekly-scan.js continues sending its own digest content
// during the migration window, but never through a second, divergent
// Resend call. See the Notification & Outcome Loop V1 recon report for why
// this extraction happens now rather than at the eventual Monday Brief
// cutover: duplicating this function today, even temporarily, is exactly
// the "permanent second email implementation" risk the founder asked to
// avoid.
export async function sendEmail({ to, subject, html }) {
  const key = process.env.RESEND_API_KEY;
  if (!key) return { skipped: true, reason: 'Missing RESEND_API_KEY' };
  const from = process.env.ALERTS_FROM_EMAIL || 'House Accounts <alerts@houseaccounts.ai>';
  const resp = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from, to, subject, html })
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(`Resend ${resp.status}: ${data.message || JSON.stringify(data)}`);
  return data;
}
