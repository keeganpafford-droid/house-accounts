// Paid-beta support improvement -- enrich the existing structured Feedback /
// Bug / Feature Request flow (contact.html -> api/feedback.js -> Resend)
// with safe diagnostic context. No AI support assistant, no new support
// platform, no new database table, no persistence at all: this file
// exercises the REAL, unmodified default export of api/feedback.js with a
// fetch mock standing in for both Supabase (identity resolution) and Resend
// (the outbound email) -- no real network call, and no real email, is ever
// made by this test.
//
// Usage: node scripts/test-feedback-diagnostic-context.js
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key';
process.env.RESEND_API_KEY = process.env.RESEND_API_KEY || 'test-resend-key';

import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import handler from '../api/feedback.js';

let failures = 0;
function assert(condition, message){
  if(condition) console.log(`PASS: ${message}`);
  else { failures += 1; console.error(`FAIL: ${message}`); }
}

function jsonResponse(data, {ok = true, status = 200} = {}){
  const text = JSON.stringify(data);
  return { ok, status, text: async () => text, json: async () => data };
}

// ===========================================================================
// Fixtures.
// ===========================================================================
const FIXTURES = {
  // A real member of a real organization -- the "authenticated, with
  // workspace" case.
  tokenMember: 'valid-token-member',
  authUserIdMember: 'auth-user-member',
  userIdMember: 'user-member',
  emailMember: 'member@example.com',
  orgId: 'org-1',
  orgName: 'Acme Promo',

  // An authenticated user with no organization -- the "authenticated, no
  // workspace" case.
  tokenNoOrg: 'valid-token-noorg',
  authUserIdNoOrg: 'auth-user-noorg',
  userIdNoOrg: 'user-noorg',
  emailNoOrg: 'noorg@example.com',

  // A token Supabase Auth accepts but with no matching ha_users row -- a
  // Supabase Auth user who never finished House Accounts account setup.
  tokenOrphan: 'valid-token-orphan',
  authUserIdOrphan: 'auth-user-orphan',
  emailOrphan: 'orphan-auth@example.com'
};

const HA_USERS = [
  {id: FIXTURES.userIdMember, auth_user_id: FIXTURES.authUserIdMember, email: FIXTURES.emailMember, organization_id: FIXTURES.orgId},
  {id: FIXTURES.userIdNoOrg, auth_user_id: FIXTURES.authUserIdNoOrg, email: FIXTURES.emailNoOrg, organization_id: null}
];
const AUTH_TOKEN_TO_AUTH_USER = {
  [FIXTURES.tokenMember]: {id: FIXTURES.authUserIdMember, email: FIXTURES.emailMember},
  [FIXTURES.tokenNoOrg]: {id: FIXTURES.authUserIdNoOrg, email: FIXTURES.emailNoOrg},
  [FIXTURES.tokenOrphan]: {id: FIXTURES.authUserIdOrphan, email: FIXTURES.emailOrphan}
};
const HA_ORGANIZATIONS = [
  {id: FIXTURES.orgId, name: FIXTURES.orgName}
];

// ===========================================================================
// Fetch mock: routes by URL substring, mirroring exactly what
// api/feedback.js's resolveAuthenticatedIdentity()/sendFeedbackEmail()
// actually request. Tracks every call (including the Resend request body)
// so tests can assert on what was -- and, critically, was NOT -- sent.
// No real network call is ever made; the Resend branch never hits the
// network, it just records the body it would have sent.
// ===========================================================================
function createFetchMock(){
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({url, method: init.method || 'GET', headers: init.headers || {}, body: init.body});

    if(url.includes('/auth/v1/user')){
      const authHeader = String((init.headers || {}).Authorization || '');
      const token = authHeader.replace(/^Bearer\s+/i, '');
      const authUser = AUTH_TOKEN_TO_AUTH_USER[token];
      if(!authUser) return jsonResponse({error: 'invalid token'}, {ok: false, status: 401});
      return jsonResponse(authUser);
    }

    // Trip-wire: sensitive/unrelated tables must never be touched by the
    // feedback endpoint -- it enriches with identity/workspace only, never
    // account data, uploads, or signals.
    if(url.includes('/rest/v1/ha_uploads') || url.includes('/rest/v1/ha_accounts') || url.includes('/rest/v1/ha_signals')){
      throw new Error(`UNEXPECTED: api/feedback.js queried a sensitive table it has no business touching: ${url}`);
    }

    if(url.includes('/rest/v1/ha_users') && url.includes('auth_user_id=eq.')){
      const m = url.match(/auth_user_id=eq\.([^&]+)/);
      const authUserId = m ? decodeURIComponent(m[1]) : null;
      return jsonResponse(HA_USERS.filter(u => u.auth_user_id === authUserId));
    }

    if(url.includes('/rest/v1/ha_organizations') && url.includes('id=eq.')){
      const m = url.match(/id=eq\.([^&]+)/);
      const orgId = m ? decodeURIComponent(m[1]) : null;
      return jsonResponse(HA_ORGANIZATIONS.filter(o => o.id === orgId));
    }

    if(url === 'https://api.resend.com/emails'){
      // Never a real send -- just record the payload and answer as Resend
      // would on success.
      if(init.method !== 'POST'){
        throw new Error(`UNEXPECTED: non-POST request to Resend: ${init.method} ${url}`);
      }
      return jsonResponse({id: 'test-email-id'});
    }

    throw new Error(`unexpected fetch in test-feedback-diagnostic-context: ${url}`);
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

function resendCall(fetchImpl){
  return fetchImpl.calls.find(c => c.url === 'https://api.resend.com/emails');
}
function resendPayload(fetchImpl){
  const call = resendCall(fetchImpl);
  return call ? JSON.parse(call.body) : {};
}
function resendHtml(fetchImpl){
  return resendPayload(fetchImpl).html || '';
}
// Extracts the value rendered under a stacked "Label" / value pair (the
// current diagRow()/"Submitted by" markup in api/feedback.js), rather than
// the old inline "<strong>Label:</strong> value" format.
function diagValue(html, label){
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp('>' + escaped + '</p>\\s*<p[^>]*>([^<]*)</p>');
  const m = html.match(re);
  return m ? m[1] : null;
}

function fakeReq({token, body = {}} = {}){
  return {
    method: 'POST',
    headers: token ? {authorization: `Bearer ${token}`} : {},
    body
  };
}
function fakeRes(){
  const res = {
    _status: null,
    _body: null,
    status(code){ this._status = code; return this; },
    json(body){ this._body = body; return this; }
  };
  return res;
}

const originalFetch = global.fetch;

async function run(){
  // =========================================================================
  // 1. Existing Feedback submissions still work, signed out.
  // =========================================================================
  {
    const fetchImpl = createFetchMock();
    global.fetch = fetchImpl;
    const req = fakeReq({body: {type: 'Feedback', message: 'The dashboard is a bit confusing.'}});
    const res = fakeRes();
    await handler(req, res);
    assert(res._status === 200 && res._body?.success === true, `1) plain Feedback submission (signed out) succeeds (got ${res._status} ${JSON.stringify(res._body)})`);
  }

  // =========================================================================
  // 2. Bug submissions still work.
  // =========================================================================
  {
    const fetchImpl = createFetchMock();
    global.fetch = fetchImpl;
    const req = fakeReq({body: {type: 'Bug', message: 'Clicking Export does nothing.'}});
    const res = fakeRes();
    await handler(req, res);
    assert(res._status === 200 && res._body?.success === true, `2) Bug submission succeeds (got ${res._status} ${JSON.stringify(res._body)})`);
    assert(resendHtml(fetchImpl).includes('New Bug Report'), '2) the email subject/heading reflects the friendly "Bug Report" label, not the raw "Bug" type');
  }

  // =========================================================================
  // 3. Feature Request submissions still work.
  // =========================================================================
  {
    const fetchImpl = createFetchMock();
    global.fetch = fetchImpl;
    const req = fakeReq({body: {type: 'Feature Request', message: 'Please add CSV export for signals.'}});
    const res = fakeRes();
    await handler(req, res);
    assert(res._status === 200 && res._body?.success === true, `3) Feature Request submission succeeds (got ${res._status} ${JSON.stringify(res._body)})`);
    assert(resendHtml(fetchImpl).includes('New Feature Request'), '3) the email subject/heading reflects the "Feature Request" label');
  }

  // =========================================================================
  // 4. Current page/path is captured safely -- passed through and rendered
  //    in the diagnostic block, and a known page maps to a friendly label.
  // =========================================================================
  {
    const fetchImpl = createFetchMock();
    global.fetch = fetchImpl;
    const req = fakeReq({body: {type: 'Bug', message: 'Chart is blank.', currentPage: '/dashboard/'}});
    const res = fakeRes();
    await handler(req, res);
    const html = resendHtml(fetchImpl);
    assert(diagValue(html, 'Page') === 'Dashboard', `4) current page is captured and rendered with a friendly label (got "${diagValue(html, 'Page')}")`);
  }

  // =========================================================================
  // 5. Browser context is captured.
  // =========================================================================
  {
    const fetchImpl = createFetchMock();
    global.fetch = fetchImpl;
    const req = fakeReq({body: {type: 'Feedback', message: 'Nice product.', browser: 'Chrome on Windows'}});
    const res = fakeRes();
    await handler(req, res);
    const html = resendHtml(fetchImpl);
    assert(diagValue(html, 'Browser') === 'Chrome on Windows', `5) browser context is captured and rendered in the diagnostic block (got "${diagValue(html, 'Browser')}")`);
  }

  // =========================================================================
  // 6. Authenticated identity/workspace context is included when safely
  //    available -- and a client-supplied email/organization in the body is
  //    NEVER trusted over the server-resolved, token-verified identity.
  // =========================================================================
  {
    const fetchImpl = createFetchMock();
    global.fetch = fetchImpl;
    const req = fakeReq({
      token: FIXTURES.tokenMember,
      body: {
        type: 'Bug', message: 'Signal detail modal is empty.',
        // Deliberately spoofed client-supplied identity -- must be ignored
        // in favor of the token-verified server-side identity.
        email: 'attacker@evil.example', organizationName: 'Spoofed Org'
      }
    });
    const res = fakeRes();
    await handler(req, res);
    const html = resendHtml(fetchImpl);
    const payload = resendPayload(fetchImpl);
    assert(res._status === 200 && res._body?.success === true, '6) authenticated submission succeeds');
    assert(diagValue(html, 'Submitted by') === FIXTURES.emailMember, `6/7) the server-resolved, token-verified email is prominently shown as "Submitted by" (got "${diagValue(html, 'Submitted by')}")`);
    assert(diagValue(html, 'Workspace') === FIXTURES.orgName, `6) the server-resolved workspace/organization name is included (got "${diagValue(html, 'Workspace')}")`);
    assert(!html.includes('attacker@evil.example'), '6/9) a client-supplied, spoofed email is never trusted or shown');
    assert(!html.includes('Spoofed Org'), '6/9) a client-supplied, spoofed organization name is never trusted or shown');
    assert(payload.reply_to === FIXTURES.emailMember, `8) Reply-To is set to the verified, server-resolved email (got "${payload.reply_to}")`);
    assert(payload.reply_to !== 'attacker@evil.example', '9) a spoofed client-supplied email can never become Reply-To, overriding the verified identity');
    assert(payload.from === 'House Accounts <alerts@houseaccounts.ai>', `13) the From address remains alerts@houseaccounts.ai regardless of submitter identity (got "${payload.from}")`);
  }

  // Authenticated but no organization -- Workspace line simply omitted.
  {
    const fetchImpl = createFetchMock();
    global.fetch = fetchImpl;
    const req = fakeReq({token: FIXTURES.tokenNoOrg, body: {type: 'Feedback', message: 'Solo user feedback.'}});
    const res = fakeRes();
    await handler(req, res);
    const html = resendHtml(fetchImpl);
    assert(diagValue(html, 'Submitted by') === FIXTURES.emailNoOrg, '6b) an authenticated user with no organization still gets their resolved email shown');
    assert(diagValue(html, 'Workspace') === null, '6b) no Workspace row is rendered when the user has no organization');
  }

  // =========================================================================
  // 7. Signed-out submission behavior remains functional -- no Authorization
  //    header at all, no identity resolved, submission still succeeds; a
  //    client-supplied email (the only identity a signed-out visitor CAN
  //    offer) is used as the fallback since there is no trusted server
  //    identity to prefer over it.
  // =========================================================================
  {
    const fetchImpl = createFetchMock();
    global.fetch = fetchImpl;
    const req = fakeReq({body: {type: 'Feedback', message: 'Just passing through.', email: 'visitor@example.com'}});
    const res = fakeRes();
    await handler(req, res);
    assert(res._status === 200 && res._body?.success === true, '7) signed-out submission (no token) succeeds');
    assert(!fetchImpl.calls.some(c => c.url.includes('/auth/v1/user')), '7) no auth verification call is made when no token is present');
    const html = resendHtml(fetchImpl);
    const payload = resendPayload(fetchImpl);
    assert(diagValue(html, 'Submitted by') === 'visitor@example.com', '7) a signed-out visitor\'s self-reported email is used as a fallback since no trusted identity exists');
    assert(payload.reply_to === 'visitor@example.com', '10) a valid signed-out-supplied email becomes the Reply-To address');
  }

  // Invalid/expired token -- fails closed to "treated as unauthenticated",
  // never blocks the submission.
  {
    const fetchImpl = createFetchMock();
    global.fetch = fetchImpl;
    const req = fakeReq({token: 'garbage-expired-token', body: {type: 'Bug', message: 'Still works with a bad token.', email: 'fallback@example.com'}});
    const res = fakeRes();
    await handler(req, res);
    assert(res._status === 200 && res._body?.success === true, '7b) an invalid/expired token fails closed to unauthenticated rather than blocking the submission');
    const html = resendHtml(fetchImpl);
    assert(diagValue(html, 'Submitted by') === 'fallback@example.com', '7b) falls back to the client-supplied email when the token cannot be verified');
  }

  // Authenticated (Supabase accepts the token) but no matching ha_users row
  // -- still resolves the Supabase Auth email, still succeeds.
  {
    const fetchImpl = createFetchMock();
    global.fetch = fetchImpl;
    const req = fakeReq({token: FIXTURES.tokenOrphan, body: {type: 'Feedback', message: 'Account setup never finished.'}});
    const res = fakeRes();
    await handler(req, res);
    assert(res._status === 200 && res._body?.success === true, '7c) an authenticated Supabase user with no ha_users row still submits successfully');
    const html = resendHtml(fetchImpl);
    assert(diagValue(html, 'Submitted by') === FIXTURES.emailOrphan, '7c) falls back to the verified Supabase Auth email when no ha_users row exists');
  }

  // =========================================================================
  // 12. Invalid Reply-To values are never sent to Resend -- a malformed,
  //     client-supplied signed-out email is shown for transparency (since
  //     it's what the visitor typed) but never used as a Reply-To header.
  // =========================================================================
  {
    const fetchImpl = createFetchMock();
    global.fetch = fetchImpl;
    const req = fakeReq({body: {type: 'Feedback', message: 'Malformed email test.', email: 'not-a-valid-email'}});
    const res = fakeRes();
    await handler(req, res);
    assert(res._status === 200 && res._body?.success === true, '12) submission with a malformed email still succeeds');
    const payload = resendPayload(fetchImpl);
    assert(!('reply_to' in payload), `12) an invalid email value is never sent as Reply-To (got payload.reply_to=${JSON.stringify(payload.reply_to)})`);
  }

  // 11. Missing signed-out email does not break submission, and no
  //     Reply-To is set (there is nothing valid to reply to).
  {
    const fetchImpl = createFetchMock();
    global.fetch = fetchImpl;
    const req = fakeReq({body: {type: 'Feedback', message: 'No email provided at all.'}});
    const res = fakeRes();
    await handler(req, res);
    assert(res._status === 200 && res._body?.success === true, '11) a signed-out submission with no email at all still succeeds');
    const payload = resendPayload(fetchImpl);
    assert(!('reply_to' in payload), '11/12) no Reply-To header is set when no replyable email exists');
    assert(diagValue(resendHtml(fetchImpl), 'Submitted by') === 'Not provided', '11) "Submitted by: Not provided" is shown when no replyable email exists');
  }

  // =========================================================================
  // 8. Missing context fields do not prevent submission.
  // =========================================================================
  {
    const fetchImpl = createFetchMock();
    global.fetch = fetchImpl;
    // Only the required message field -- no type, currentPage, browser,
    // deviceClass, timestamp, or email at all.
    const req = fakeReq({body: {message: 'Bare minimum submission.'}});
    const res = fakeRes();
    await handler(req, res);
    assert(res._status === 200 && res._body?.success === true, `8) a submission with only a message (no diagnostic fields at all) still succeeds (got ${res._status} ${JSON.stringify(res._body)})`);
    const html = resendHtml(fetchImpl);
    assert(html.includes('New Feedback'), '8) missing type defaults to plain Feedback');
    assert(diagValue(html, 'Submitted by') === 'Not provided', '8) missing/absent identity renders as "Not provided" rather than breaking the template');
  }

  // Missing message is still rejected (unchanged pre-existing validation).
  {
    const fetchImpl = createFetchMock();
    global.fetch = fetchImpl;
    const req = fakeReq({body: {type: 'Feedback', message: '   '}});
    const res = fakeRes();
    await handler(req, res);
    assert(res._status === 400 && res._body?.success === false, `8b) a blank message is still rejected with 400, unchanged from prior behavior (got ${res._status} ${JSON.stringify(res._body)})`);
    assert(!fetchImpl.calls.some(c => c.url === 'https://api.resend.com/emails'), '8b) no email is sent when validation rejects the submission');
  }

  // =========================================================================
  // 9. Sensitive account/raw-data/auth fields are never automatically
  //    attached, even if a client (accidentally or otherwise) includes them
  //    in the request body.
  // =========================================================================
  {
    const fetchImpl = createFetchMock();
    global.fetch = fetchImpl;
    const req = fakeReq({
      token: FIXTURES.tokenMember,
      body: {
        type: 'Bug', message: 'Upload failed.', currentPage: '/dashboard/', browser: 'Chrome on macOS',
        // None of the following should ever reach the outbound email.
        rawData: {csv: 'name,email\nJohn,john@example.com'},
        accounts: [{name: 'Acme Corp', revenue: 5000000}],
        research_results: {signals: ['confidential intel']},
        signalPayload: {secret: 'internal'},
        accessToken: 'super-secret-access-token',
        authHeader: 'Bearer super-secret-access-token',
        cookies: 'session=abc123',
        supabaseServiceRoleKey: 'sk-should-never-leak',
        apiKey: 'sk-another-secret'
      }
    });
    const res = fakeRes();
    await handler(req, res);
    const html = resendHtml(fetchImpl);
    for(const forbidden of ['csv', 'John,john@example.com', 'Acme Corp', '5000000', 'confidential intel', 'internal', 'super-secret-access-token', 'session=abc123', 'sk-should-never-leak', 'sk-another-secret']){
      assert(!html.includes(forbidden), `9) sensitive field value "${forbidden}" is never included in the outbound email`);
    }
    assert(!fetchImpl.calls.some(c => c.url.includes('/rest/v1/ha_uploads') || c.url.includes('/rest/v1/ha_accounts') || c.url.includes('/rest/v1/ha_signals')), '9) no sensitive table (uploads/accounts/signals) is ever queried by the feedback endpoint');
  }

  // =========================================================================
  // 10. Email output clearly separates the customer's message from
  //     diagnostic context -- distinct headings, and diagnostic content
  //     rendered before the message.
  // =========================================================================
  {
    const fetchImpl = createFetchMock();
    global.fetch = fetchImpl;
    const req = fakeReq({token: FIXTURES.tokenMember, body: {
      type: 'Bug', message: 'DISTINCTIVE_CUSTOMER_MESSAGE_TEXT',
      currentPage: '/dashboard/', browser: 'Chrome on Windows'
    }});
    const res = fakeRes();
    await handler(req, res);
    const html = resendHtml(fetchImpl);
    const submittedByIdx = html.indexOf('>Submitted by<');
    const pageIdx = html.indexOf('>Page<');
    const browserIdx = html.indexOf('>Browser<');
    const messageHeadingIdx = html.indexOf('>Message<');
    const messageBodyIdx = html.indexOf('DISTINCTIVE_CUSTOMER_MESSAGE_TEXT');
    assert(submittedByIdx >= 0, '10/14) a distinct "Submitted by" diagnostic field exists, leading the diagnostic block');
    assert(messageHeadingIdx >= 0, '10) a distinct "Message" heading exists');
    assert(submittedByIdx < pageIdx && pageIdx < browserIdx && browserIdx < messageHeadingIdx && messageHeadingIdx < messageBodyIdx, '10/14) diagnostic context (submitter identity, page, browser) is rendered before, and visually separated from, the customer\'s own message');
  }

  // =========================================================================
  // No database write ever occurs -- every Supabase call the handler makes
  // is a GET (read); the only POST is the outbound Resend email itself.
  // =========================================================================
  {
    const fetchImpl = createFetchMock();
    global.fetch = fetchImpl;
    const req = fakeReq({token: FIXTURES.tokenMember, body: {type: 'Feedback', message: 'No writes check.'}});
    const res = fakeRes();
    await handler(req, res);
    const supabaseCalls = fetchImpl.calls.filter(c => !c.url.includes('api.resend.com'));
    assert(supabaseCalls.length > 0 && supabaseCalls.every(c => c.method === 'GET'), 'no database write: every Supabase request the handler issues is a GET (read-only)');
  }

  // =========================================================================
  // 11. Existing Contact page UX remains functional -- all three forms, the
  //     transparency note, and the original alert()-based success/error UX
  //     are all still present and unchanged.
  // =========================================================================
  {
    const contact = fs.readFileSync(new URL('../contact.html', import.meta.url), 'utf8');
    assert(/data-feedback-type="Feedback"/.test(contact), '11) the plain Feedback form is still present');
    assert(/data-feedback-type="Bug"/.test(contact), '11) the Bug report form is still present');
    assert(/data-feedback-type="Feature Request"/.test(contact), '11) the Feature Request form is still present');
    {
      const scriptMatch = contact.match(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/);
      const scriptWithoutComments = (scriptMatch ? scriptMatch[1] : '').replace(/\/\/[^\n]*/g, '');
      assert(!/\balert\s*\(/.test(scriptWithoutComments), '1-3) alert()/window.alert() is never actually called anywhere in contact.html\'s script (comments referencing it by name are fine)');
    }
    assert(/class="form-status"/.test(contact), 'a branded .form-status panel exists in the markup for each form');
    assert(/So we can reply if needed\./.test(contact), 'the optional signed-out email field carries the required helper text');
    assert(/type="email"/.test(contact), 'an optional email input is present for signed-out submitters');
    assert(/class="diagnostic-note"/.test(contact) && /basic context like your current page and browser/.test(contact), '11) a concise, non-alarming diagnostic-context transparency note is present near the forms');
    assert(!/technical bug report|stack trace|error code|debug log/i.test(contact.replace(/<!--[\s\S]*?-->/g, '')), '11) the page still does not read like a technical bug reporter');
    assert(/window\.location\.pathname/.test(contact), '11) currentPage is still captured as a pathname only, never a full URL with query string');
    assert(!/window\.location\.href/.test(contact), '11) the full URL (window.location.href) is never captured, only the pathname');
    assert(!/\.authHeadersAsync\s*\(/.test(contact), '11) the redirecting authHeadersAsync() variant is never called on this signed-out-usable page (a code comment may mention it by name, but it must never be invoked)');
    assert(/window\.HouseAuth && typeof window\.HouseAuth\.authHeaders === 'function'/.test(contact), '11) the non-redirecting, synchronous authHeaders() variant is used, guarded against HouseAuth being unavailable');
  }

  // =========================================================================
  // 14. Syntax checks -- api/feedback.js and contact.html's inline <script>
  //     both parse without a syntax error (same pattern used for the
  //     What's New page's item 8 syntax check).
  // =========================================================================
  {
    execFileSync(process.execPath, ['--check', new URL('../api/feedback.js', import.meta.url).pathname]);
    console.log('PASS: 14) api/feedback.js parses without a syntax error');

    const contact = fs.readFileSync(new URL('../contact.html', import.meta.url), 'utf8');
    const scriptMatches = [...contact.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)];
    assert(scriptMatches.length === 1, `14) contact.html has exactly one inline <script> block to syntax-check (found ${scriptMatches.length})`);
    const scratchPath = new URL('../.tmp-contact-inline-script-check.js', import.meta.url);
    fs.writeFileSync(scratchPath, scriptMatches[0][1]);
    execFileSync(process.execPath, ['--check', scratchPath.pathname]);
    console.log('PASS: 14) contact.html\'s inline <script> parses without a syntax error');
    fs.rmSync(scratchPath);
  }

  console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`);
  process.exit(failures === 0 ? 0 : 1);
}

run().finally(() => { global.fetch = originalFetch; });
