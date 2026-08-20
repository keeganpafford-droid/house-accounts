function clean(value = ''){
  return String(value || '').trim();
}

function escapeHtml(value = ''){
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Paid-beta support improvement: enrich the existing structured Feedback /
// Bug / Feature Request flow (contact.html -> this endpoint -> Resend) with
// safe diagnostic context, without building a parallel support system, an
// AI assistant, or a new database table. Everything below is additive to
// the existing email-only pipe -- no storage is introduced.

const TYPE_LABELS = {
  Feedback: 'Feedback',
  Bug: 'Bug Report',
  'Feature Request': 'Feature Request'
};
function friendlyType(type){
  return TYPE_LABELS[type] || type || 'Feedback';
}

// Only a small, known set of real product pages -- anything unmapped falls
// back to the raw pathname (already query-string-free and safe) rather
// than guessing.
const PAGE_NAMES = {
  '/': 'Home',
  '/contact.html': 'Feedback & Support',
  '/pricing.html': 'Pricing',
  '/faq.html': 'FAQ',
  '/security.html': 'Security',
  '/whats-new.html': "What's New",
  '/dashboard/': 'Dashboard',
  '/settings.html': 'Settings'
};
function friendlyPageName(pathname){
  return PAGE_NAMES[pathname] || pathname || '';
}

// Same lightweight pattern already used elsewhere in this codebase (see
// dashboard/index.html and signup-form.js) -- good enough to reject
// obviously-malformed values before they're ever used as an email header.
function isValidEmail(value){
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function env(){
  const rawUrl = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if(!rawUrl || !key) return null;
  const url = String(rawUrl).trim().replace(/\/+$/, '').replace(/\/rest\/v1$/i, '');
  return {url, key};
}

async function supabaseGet(path){
  const cfg = env();
  if(!cfg) return null;
  try{
    const resp = await fetch(`${cfg.url}/rest/v1/${path}`, {
      headers: { apikey: cfg.key, Authorization: `Bearer ${cfg.key}`, 'Content-Type': 'application/json' }
    });
    if(!resp.ok) return null;
    return await resp.json().catch(() => null);
  }catch{
    return null;
  }
}

// Resolves the submitter's real email/workspace from a verified Supabase
// Auth Bearer token -- never from a client-supplied identity field. Fails
// closed to null (never throws) on ANY problem -- missing/invalid token,
// missing env config, a Supabase hiccup, no matching ha_users row -- so an
// authenticated submission with a stale/expired token degrades to
// "treated as unauthenticated" rather than blocking the submission. This
// mirrors the same token-verification pattern already used in
// api/get-dashboard.js/api/monitoring-lists.js, kept self-contained here
// rather than introducing a new shared module for one endpoint.
async function resolveAuthenticatedIdentity(req){
  const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  if(!token) return null;
  const cfg = env();
  if(!cfg) return null;
  try{
    const authResp = await fetch(`${cfg.url}/auth/v1/user`, {
      headers: { apikey: cfg.key, Authorization: `Bearer ${token}` }
    });
    if(!authResp.ok) return null;
    const authUser = await authResp.json().catch(() => null);
    if(!authUser?.id) return null;

    const userRows = await supabaseGet(`ha_users?auth_user_id=eq.${encodeURIComponent(authUser.id)}&select=id,email,organization_id&limit=1`);
    const user = Array.isArray(userRows) ? userRows[0] : null;
    if(!user) return { email: clean(authUser.email || ''), organizationName: '' };

    let organizationName = '';
    if(user.organization_id){
      const orgRows = await supabaseGet(`ha_organizations?id=eq.${encodeURIComponent(user.organization_id)}&select=name&limit=1`);
      const org = Array.isArray(orgRows) ? orgRows[0] : null;
      if(org?.name) organizationName = clean(org.name);
    }
    return { email: clean(user.email || authUser.email || ''), organizationName };
  }catch{
    return null;
  }
}

function diagRow(label, value){
  if(!value) return '';
  return `<p style="margin:0 0 4px;text-transform:uppercase;letter-spacing:.04em;font-size:11px;font-weight:700;color:#5B6B82;">${escapeHtml(label)}</p><p style="margin:0 0 14px;font-size:14px;">${escapeHtml(value)}</p>`;
}

async function sendFeedbackEmail({type, message, email, organizationName, currentPage, timestamp, browser}){
  const key = process.env.RESEND_API_KEY;
  if(!key) return {skipped: true, reason: 'Missing RESEND_API_KEY'};

  // The From address never changes -- sending "from" a customer's own
  // address would break SPF/DMARC. Instead a verified/validated submitter
  // email is used only as the Reply-To header, so clicking Reply in an
  // inbox addresses the customer directly.
  const from = process.env.ALERTS_FROM_EMAIL || 'House Accounts <alerts@houseaccounts.ai>';
  const to = process.env.FEEDBACK_TO_EMAIL || 'hello@houseaccounts.ai';
  const label = friendlyType(type);
  const subject = `House Accounts ${label}`;
  const pageLabel = friendlyPageName(currentPage);
  const submitterLabel = email || 'Not provided';
  // Diagnostic context is rendered in its own labeled block, visually and
  // structurally separated from the customer's own message below it. The
  // submitter identity leads the block so it's never buried under lower-
  // priority metadata like browser/page.
  const html = `
    <div style="font-family:Arial,sans-serif;line-height:1.5;color:#17375E;">
      <h2 style="margin:0 0 16px;">New ${escapeHtml(label)}</h2>
      <div style="padding:14px 16px;border:1px solid #D8DEE9;border-radius:8px;background:#EEF3F8;margin-bottom:18px;">
        <p style="margin:0 0 4px;text-transform:uppercase;letter-spacing:.04em;font-size:11px;font-weight:700;color:#5B6B82;">Submitted by</p>
        <p style="margin:0 0 14px;font-size:15px;font-weight:700;">${escapeHtml(submitterLabel)}</p>
        ${diagRow('Workspace', organizationName)}
        ${diagRow('Submitted', timestamp)}
        ${diagRow('Page', pageLabel)}
        ${diagRow('Browser', browser)}
      </div>
      <p style="margin:0 0 8px;font-weight:700;">Message</p>
      <div style="padding:16px;border:1px solid #D8DEE9;border-radius:8px;background:#F7F8FA;white-space:pre-wrap;">${escapeHtml(message)}</div>
    </div>
  `;

  const payload = { from, to, subject, html };
  // Only ever a verified (authenticated) or well-formed (signed-out,
  // client-supplied) address -- never an unvalidated value that could
  // become a malformed or spoofable email header.
  if(email && isValidEmail(email)) payload.reply_to = email;

  const resp = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  const data = await resp.json().catch(() => ({}));
  if(!resp.ok) throw new Error(`Resend ${resp.status}: ${data.message || JSON.stringify(data)}`);
  return data;
}

export default async function handler(req, res){
  if(req.method !== 'POST'){
    return res.status(405).json({success: false, error: 'Method not allowed'});
  }

  try{
    const body = req.body || {};
    const type = clean(body.type || body.feedbackType || 'Feedback');
    const message = clean(body.message);
    // Diagnostic-only fields, all optional -- missing any (or all) of them
    // never blocks submission.
    const currentPage = clean(body.currentPage);
    const timestamp = clean(body.timestamp || new Date().toISOString());
    const browser = clean(body.browser).slice(0, 120);
    const deviceClass = clean(body.deviceClass).slice(0, 40);

    if(!message){
      return res.status(400).json({success: false, error: 'Feedback message is required'});
    }

    // Authenticated identity/workspace is resolved server-side from a
    // verified Bearer token when present -- a client-supplied email is
    // only ever used as a fallback when server-side resolution didn't
    // produce one (e.g. a genuinely signed-out visitor), never allowed to
    // override a trusted, server-resolved identity.
    const identity = await resolveAuthenticatedIdentity(req);
    const email = identity?.email || clean(body.email);
    const organizationName = identity?.organizationName || '';

    const payload = { type, message, email, organizationName, currentPage, timestamp, browser, deviceClass };
    console.log('House Accounts feedback submission:', {
      type, currentPage, timestamp, browser, deviceClass,
      authenticated: Boolean(identity),
      hasOrganization: Boolean(organizationName)
    });

    await sendFeedbackEmail(payload);

    return res.status(200).json({success: true});
  }catch(error){
    console.error('Feedback submission error:', error);
    return res.status(500).json({success: false, error: 'Feedback submission failed'});
  }
}
