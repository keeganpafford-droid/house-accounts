// Foundation freeze, Phase 2 (Business Activity Classification Unification):
// proves the ONE authoritative "is this opportunity a Business Activity/
// web-research signal" contract -- isWebResearchSignal() -- behaves
// identically across its two mirrored implementations (api/get-dashboard.js,
// server/read-side; dashboard/index.html, client/write-side, extracted
// verbatim into a vm sandbox since that file cannot import the server
// module), and satisfies the full required regression matrix: current
// ha_signals Business Activity always classifies as one; Follow-Up/Repeat-
// Pattern never do, even when a stale/corrupted legacy flag is also present;
// a true legacy object missing modern fields is handled intentionally;
// explicit identity confirmation state never affects this classification;
// this classification never implies Verified Opportunity; and read-side/
// write-side agree exactly on the same fixture.
//
// Usage: node scripts/test-foundation-freeze-classification-parity.js
import { readFileSync } from 'fs';
import vm from 'vm';
import { fileURLToPath } from 'url';
import path from 'path';
import { isWebResearchSignal as serverIsWebResearchSignal } from '../api/get-dashboard.js';

let failures = 0;
function assert(condition, message){
  if(condition) console.log(`PASS: ${message}`);
  else { failures += 1; console.error(`FAIL: ${message}`); }
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DASHBOARD_PATH = path.join(__dirname, '..', 'dashboard', 'index.html');
const LINES = readFileSync(DASHBOARD_PATH, 'utf8').split('\n');

function extractFn(name, startLine, endLine){
  const slice = LINES.slice(startLine - 1, endLine).join('\n');
  const expectedPrefix = `function ${name}(`;
  if(!slice.startsWith(expectedPrefix)){
    throw new Error(`extractFn(${name}): dashboard/index.html line ${startLine} no longer starts with "${expectedPrefix}" -- source has shifted, update the line range in this test.`);
  }
  if(!slice.trimEnd().endsWith('}')){
    throw new Error(`extractFn(${name}): dashboard/index.html line ${endLine} does not close the function body as expected -- update the line range.`);
  }
  return slice;
}

const CLIENT_SRC = extractFn('isWebResearchSignal', 3434, 3439);
const sandbox = {};
vm.createContext(sandbox);
new vm.Script(CLIENT_SRC, { filename: 'client-is-web-research-signal.js' }).runInContext(sandbox);
const clientIsWebResearchSignal = sandbox.isWebResearchSignal;
assert(typeof clientIsWebResearchSignal === 'function', 'client isWebResearchSignal() extracted successfully as a real function');

// ===========================================================================
// Shared fixture table -- every entry states its expected answer ONCE and is
// run through BOTH implementations, proving read-side/write-side parity
// (required regression #7) while also exercising the rest of the required
// matrix.
// ===========================================================================
const FIXTURES = [
  {
    label: '1) current ha_signals-derived Business Activity (canonical producer shape)',
    opp: { signalLayerType: 'Business Activity Signal', isVerifiedSignalOpportunity: true, sourceUrl: 'https://example.com/acme-award' },
    expected: true
  },
  {
    label: '2) Follow-Up Signal, clean shape (order-history-derived, no sourceUrl)',
    opp: { signalLayerType: 'Follow-Up Signal', evidence: 'Recent order delivered' },
    expected: false
  },
  {
    label: '3) Repeat / Pattern Signal, clean shape',
    opp: { signalLayerType: 'Repeat / Pattern Signal', opportunityType: 'REPEAT PATTERN' },
    expected: false
  },
  {
    label: '4) CORRUPTED Follow-Up: explicit signalLayerType=Follow-Up but a stale isVerifiedSignalOpportunity:true also present -- the exact contradiction this contract closes; the explicit family declaration must win over the weaker/legacy flag',
    opp: { signalLayerType: 'Follow-Up Signal', isVerifiedSignalOpportunity: true, evidence: 'Recent order delivered' },
    expected: false
  },
  {
    label: '5) CORRUPTED Repeat/Pattern: explicit signalLayerType=Repeat/Pattern but a sourceUrl also present -- same principle as (4)',
    opp: { signalLayerType: 'Repeat / Pattern Signal', sourceUrl: 'https://example.com/unrelated' },
    expected: false
  },
  {
    label: '6) true legacy business entry: no signalLayerType, no isVerifiedSignalOpportunity, but sourceUrl present',
    opp: { sourceUrl: 'https://example.com/legacy-business-signal' },
    expected: true
  },
  {
    label: '7) true legacy business entry: no signalLayerType, no sourceUrl, but isVerifiedSignalOpportunity:true',
    opp: { isVerifiedSignalOpportunity: true },
    expected: true
  },
  {
    label: '8) Dispatch-Goods-shaped legacy entry (sourceName/cleanSourceName only, no sourceUrl, no flags) -- deliberately FALSE under this general contract; sourceName is a narrow, explicitly-scoped exception used only inside reconcileStoredOpportunity(), never part of isWebResearchSignal() itself (both implementations must agree it is NOT a general web-research signal)',
    opp: { sourceName: 'Santa Cruz Works', cleanSourceName: 'Santa Cruz Works', signalTitle: 'Follow-on Investment from Santa Cruz Ventures' },
    expected: false
  },
  {
    label: '9) garbage/unrecognized signalLayerType with no other evidence (Predictable-Timing-shaped fallback signal) -- must default to NOT business, never silently assumed business',
    opp: { signalLayerType: 'Predictable Timing', isReal: false, isFallbackOpportunity: true, sourceUrl: '' },
    expected: false
  },
  {
    label: '10) empty object -- no throw, false',
    opp: {},
    expected: false
  },
  {
    label: '11) null -- no throw, false',
    opp: null,
    expected: false
  }
];

for(const { label, opp, expected } of FIXTURES){
  const serverResult = serverIsWebResearchSignal(opp);
  const clientResult = clientIsWebResearchSignal(opp);
  assert(serverResult === expected, `server isWebResearchSignal(): ${label} (got ${serverResult}, expected ${expected})`);
  assert(clientResult === expected, `client isWebResearchSignal(): ${label} (got ${clientResult}, expected ${expected})`);
  assert(serverResult === clientResult, `parity: ${label} -- server and client agree (server=${serverResult}, client=${clientResult})`);
}

// ===========================================================================
// Required regression #5: explicit confirmed/unconfirmed identity state does
// not affect this classification -- two otherwise-identical business
// opportunities, one confirmed and one unconfirmed, must both classify as
// Business Activity.
// ===========================================================================
{
  const confirmed = { signalLayerType: 'Business Activity Signal', isVerifiedSignalOpportunity: true, sourceUrl: 'https://example.com/a', identityConfidence: 'confirmed' };
  const unconfirmed = { ...confirmed, identityConfidence: 'unconfirmed' };
  const legacyUndefined = { ...confirmed, identityConfidence: undefined };
  assert(serverIsWebResearchSignal(confirmed) === true && serverIsWebResearchSignal(unconfirmed) === true && serverIsWebResearchSignal(legacyUndefined) === true, 'required test 5 (server): identityConfidence (confirmed/unconfirmed/legacy-undefined) has zero effect on isWebResearchSignal()');
  assert(clientIsWebResearchSignal(confirmed) === true && clientIsWebResearchSignal(unconfirmed) === true && clientIsWebResearchSignal(legacyUndefined) === true, 'required test 5 (client): identityConfidence (confirmed/unconfirmed/legacy-undefined) has zero effect on isWebResearchSignal()');
}

// ===========================================================================
// Required regression #6: Business Activity classification does not imply
// Verified Opportunity -- isExplicitlyVerifiedIdentity() (the actual gate for
// the "Verified Opportunity" heading) is driven ONLY by identityConfidence,
// never by isWebResearchSignal()/signalLayerType/isVerifiedSignalOpportunity.
// ===========================================================================
{
  const ISEXPLICITLY_VERIFIED_SRC = extractFn('isExplicitlyVerifiedIdentity', 10339, 10341);
  const identitySandbox = {};
  vm.createContext(identitySandbox);
  new vm.Script(ISEXPLICITLY_VERIFIED_SRC, { filename: 'is-explicitly-verified-identity.js' }).runInContext(identitySandbox);
  const isExplicitlyVerifiedIdentity = identitySandbox.isExplicitlyVerifiedIdentity;
  assert(typeof isExplicitlyVerifiedIdentity === 'function', 'isExplicitlyVerifiedIdentity() extracted successfully as a real function');

  const businessButUnconfirmed = { signalLayerType: 'Business Activity Signal', isVerifiedSignalOpportunity: true, sourceUrl: 'https://example.com/a', identityConfidence: 'unconfirmed' };
  assert(clientIsWebResearchSignal(businessButUnconfirmed) === true, 'required test 6: the opportunity IS classified as a web-research/Business Activity signal');
  assert(isExplicitlyVerifiedIdentity(businessButUnconfirmed) === false, 'required test 6: yet it is NOT "Verified Opportunity" -- that heading is gated solely on identityConfidence===\'confirmed\', never on the family classification, despite the historical isVerifiedSignalOpportunity field name');

  const nonBusinessButConfirmed = { signalLayerType: 'Follow-Up Signal', identityConfidence: 'confirmed' };
  assert(clientIsWebResearchSignal(nonBusinessButConfirmed) === false, 'required test 6 (inverse): a Follow-Up Signal is never classified as a web-research/Business Activity signal...');
  assert(isExplicitlyVerifiedIdentity(nonBusinessButConfirmed) === true, '...even though confirmed identity (a completely separate concept) can still be true for it');
}

if(failures > 0){
  console.error(`\n${failures} FAILURE(S)`);
  process.exit(1);
} else {
  console.log('\nALL PASS');
}
