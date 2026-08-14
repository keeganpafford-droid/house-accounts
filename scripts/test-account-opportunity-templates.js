// Organizational Learning V1B, Correction 2: proves
// api/lib/account-opportunity-templates.js's FOLLOW_UP_TEMPLATES registry
// stays byte-for-byte in sync with the real templateKey/name/contactTitle
// literals dashboard/index.html's generateFutureOpportunities() actually
// renders -- the same "equivalence test against the real source" pattern
// used for api/lib/account-opportunities.js (see
// scripts/test-account-opportunity-detection-equivalence.js), applied here
// to a much smaller, pure-data surface (no scoring/rendering logic at all).
//
// Usage: node scripts/test-account-opportunity-templates.js
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  FOLLOW_UP_TEMPLATES, categoryProgramLabel, repeatPatternContactTitle, buildOpportunityRecommendationSnapshot
} from '../api/lib/account-opportunity-templates.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DASHBOARD_SRC = fs.readFileSync(path.join(__dirname, '../dashboard/index.html'), 'utf8');

let failures = 0;
function assert(condition, message) {
  if (condition) console.log(`PASS: ${message}`);
  else { failures += 1; console.error(`FAIL: ${message}`); }
}

// ---------------------------------------------------------------------
// Every FOLLOW_UP_TEMPLATES entry must match a real pushTemplated('key', ...)
// call in generateFutureOpportunities(), with the exact same name/contactTitle
// literals as the next two string arguments.
// ---------------------------------------------------------------------
for (const [key, def] of Object.entries(FOLLOW_UP_TEMPLATES)) {
  const pattern = new RegExp(
    `pushTemplated\\('${key}',\\s*\\n\\s*account,\\s*\\n\\s*'([^']*)',\\s*\\n\\s*'([^']*)',`
  );
  const match = DASHBOARD_SRC.match(pattern);
  assert(!!match, `REQUIRED: dashboard/index.html has a real pushTemplated('${key}', ...) call`);
  if (match) {
    assert(match[1] === def.name, `REQUIRED: templateKey "${key}" name matches dashboard source (got "${match[1]}", expected "${def.name}")`);
    assert(match[2] === def.contactTitle, `REQUIRED: templateKey "${key}" contactTitle matches dashboard source (got "${match[2]}", expected "${def.contactTitle}")`);
  }
}

// Every pushTemplated(...) call site in the dashboard source must have a
// corresponding registry entry -- catches a new template being added
// client-side without ever updating the server's registry.
const allCallSiteKeys = [...DASHBOARD_SRC.matchAll(/pushTemplated\('([a-z_]+)',/g)].map(m => m[1]);
assert(allCallSiteKeys.length > 0, 'sanity: at least one pushTemplated(...) call site was found in dashboard/index.html');
for (const key of new Set(allCallSiteKeys)) {
  assert(Object.prototype.hasOwnProperty.call(FOLLOW_UP_TEMPLATES, key), `REQUIRED: pushTemplated('${key}', ...) call site has a matching FOLLOW_UP_TEMPLATES registry entry`);
}

// ---------------------------------------------------------------------
// categoryProgramLabel() / repeatPatternContactTitle() -- pure-function
// unit coverage (already proven verbatim by inspection above; this locks
// their behavior against regressions).
// ---------------------------------------------------------------------
assert(categoryProgramLabel('Apparel') === 'Apparel Program', 'categoryProgramLabel: plain category gets " Program" suffix');
assert(categoryProgramLabel('Event / Giveaway') === 'Event / Giveaway Program', 'categoryProgramLabel: Event / Giveaway special case');
assert(categoryProgramLabel('Recognition / Awards') === 'Recognition / Awards Program', 'categoryProgramLabel: Recognition / Awards special case');
assert(categoryProgramLabel('Onboarding / Recruiting') === 'Onboarding / Recruiting Program', 'categoryProgramLabel: Onboarding / Recruiting special case');
assert(categoryProgramLabel('Print / Stationery') === 'Print / Stationery Program', 'categoryProgramLabel: Print / Stationery special case');

assert(repeatPatternContactTitle('Event / Giveaway') === 'Marketing Manager / Events Lead', 'repeatPatternContactTitle: Event category');
assert(repeatPatternContactTitle('Onboarding / Recruiting') === 'HR Manager', 'repeatPatternContactTitle: Onboarding category');
assert(repeatPatternContactTitle('Safety') === 'Safety Manager / HR Manager', 'repeatPatternContactTitle: Safety category');
assert(repeatPatternContactTitle('Client Gifts') === 'Marketing Manager / Client Experience Lead', 'repeatPatternContactTitle: Client category');
assert(repeatPatternContactTitle('Apparel') === 'Marketing Manager / HR Manager', 'repeatPatternContactTitle: default fallback');

// ---------------------------------------------------------------------
// buildOpportunityRecommendationSnapshot() -- the actual reconstruction
// used by api/signal-events.js.
// ---------------------------------------------------------------------
{
  const snap = buildOpportunityRecommendationSnapshot({ opportunityType: 'repeat_pattern', category: 'Apparel' });
  assert(snap.opportunityName === 'Apparel Program', 'REQUIRED: repeat_pattern snapshot reconstructs the program name from category alone');
  assert(snap.recommendedContact === 'Marketing Manager / HR Manager', 'REQUIRED: repeat_pattern snapshot reconstructs the contact title from category alone');
  assert(snap.conversationStarter === 'Ask if the apparel program is happening again this year.', 'REQUIRED: repeat_pattern snapshot builds a lowercase-category conversation starter');
}
{
  const snap = buildOpportunityRecommendationSnapshot({ opportunityType: 'follow_up', templateKey: 'auto_service_apparel' });
  assert(snap.opportunityName === 'Service Department Apparel Program', 'REQUIRED: follow_up snapshot reconstructs the program name from a known templateKey');
  assert(snap.recommendedContact === 'Service Director', 'REQUIRED: follow_up snapshot reconstructs the contact title from a known templateKey');
  assert(snap.reasonToReachOut === 'Recent order delivered or completed', 'REQUIRED: follow_up snapshot uses the standing follow-up reason');
}
{
  // An unknown/missing templateKey (e.g. a stale client, or a tampered
  // request) never fabricates a template name -- it degrades to an honest
  // generic label instead of trusting anything the client supplied.
  const snap = buildOpportunityRecommendationSnapshot({ opportunityType: 'follow_up', templateKey: 'not-a-real-key' });
  assert(snap.opportunityName === 'Follow-Up Opportunity', 'REQUIRED: an unrecognized templateKey degrades to an honest generic name, never a fabricated one');
  assert(snap.recommendedContact === '', 'REQUIRED: an unrecognized templateKey never fabricates a contact title');
}

console.log(`\n${failures === 0 ? 'ALL TESTS PASSED' : `${failures} TEST(S) FAILED`}`);
process.exitCode = failures === 0 ? 0 : 1;
