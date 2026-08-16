// Shared Resend-calling helper. Originally extracted from the legacy
// api/weekly-scan.js's own local sendEmail() (byte-for-byte identical
// behavior) so the new, independent notification scheduler
// (api/notification-scheduler.js) and the legacy weekly digest could share
// exactly ONE outbound-email implementation during the migration window,
// never a second, divergent Resend call. api/weekly-scan.js was retired
// with the Full Beta Cutover; this is now the one and only outbound-email
// implementation in the codebase.
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
