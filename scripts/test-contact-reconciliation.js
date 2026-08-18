// Contact durability V1 (founder architecture round, 2026-08-19) --
// deterministic coverage for the contact identity/reconciliation model:
// generateContactId(), normalizeContactName(), reconcileImportedContacts(),
// and normalizeSavedAccount()'s id/origin backfill + legacy-field derive.
// Extracts the REAL, verbatim source via the shared semantic extractor and
// runs it in a plain Node vm sandbox -- these are pure data-transformation
// functions with no DOM dependency, so no fake-browser harness is needed.
//
// Required founder QA coverage this file closes (items 1-7 of the 9-point
// list, 2026-08-19):
//   1. an imported contact receives an id
//   2. that id survives save/reload (normalizeSavedAccount idempotency)
//   3. a matching imported contact retains the same id on re-upload
//   4. a new imported contact is added
//   5. a manually added contact survives a later re-upload
//   6. a manually edited imported contact survives a later re-upload
//      without its edited fields being overwritten
//   7. same-name ambiguity does not cause an unsafe merge
// (items 8-9 -- multiple contacts in one Buying Center, and correct
// display in Account Intelligence/the relationship popover -- are real-
// browser/client-extraction coverage; see
// scripts/test-whitespace-cell-answers-client.js and
// scripts/test-whitespace-cell-answers-live.js.)
//
// Usage: node scripts/test-contact-reconciliation.js
import vm from 'vm';
import { extractFn, loadDashboardSource } from './lib/dashboard-extract.js';

let failures = 0;
function assert(condition, message){
  if(condition) console.log(`PASS: ${message}`);
  else { failures += 1; console.error(`FAIL: ${message}`); }
}

const DASHBOARD_SRC = loadDashboardSource();

// normalizeSavedAccount() also touches opportunity dedup/scoring (entirely
// unrelated to contacts) -- stubbed exactly like
// scripts/test-dashboard-orchestration.js stubs its own unrelated
// dependencies of a bigger function under test, so this file's contact
// assertions aren't coupled to that separate machinery.
const STUBS = `
function dedupeOpportunities(opps){ return Array.isArray(opps) ? opps : []; }
function dedupeFoundSignals(signals){ return Array.isArray(signals) ? signals : []; }
function assignOpportunityScore(opp, account){ return opp; }
`;

const SRC = [
  STUBS,
  extractFn(DASHBOARD_SRC, 'generateContactId'),
  extractFn(DASHBOARD_SRC, 'normalizeContactName'),
  extractFn(DASHBOARD_SRC, 'reconcileImportedContacts'),
  extractFn(DASHBOARD_SRC, 'normalizeSavedAccount')
].join('\n\n');

const EXPORT_NAMES = ['generateContactId', 'normalizeContactName', 'reconcileImportedContacts', 'normalizeSavedAccount'];

function makeSandbox(){
  // A real, working crypto.randomUUID so generateContactId() exercises its
  // primary path, not the regex fallback -- both are simple enough that
  // either is fine for these assertions, but this matches what a real
  // browser actually provides.
  let uuidCounter = 0;
  const window = {
    crypto: { randomUUID: () => `uuid-${++uuidCounter}` }
  };
  const context = { window, console };
  vm.createContext(context);
  vm.runInContext(SRC + '\n' + EXPORT_NAMES.map(n => `globalThis.__export_${n} = typeof ${n} !== 'undefined' ? ${n} : undefined;`).join('\n'), context);
  const dash = {};
  for(const name of EXPORT_NAMES) dash[name] = context[`__export_${name}`];
  return dash;
}

// ===========================================================================
// 1) An imported contact receives a durable id (and origin:'upload') the
//    first time it's normalized.
// ===========================================================================
{
  const dash = makeSandbox();
  const account = { name: 'Acme', contacts: [{ name: 'Jordan Reyes', title: 'Marketing Manager', department: 'Marketing', email: '', phone: '' }] };
  const normalized = dash.normalizeSavedAccount(account);
  assert(!!normalized.contacts[0].id, '1) REQUIRED: an imported contact receives a durable id');
  assert(normalized.contacts[0].origin === 'upload', '1) REQUIRED: an imported contact is stamped origin:"upload"');
}

// ===========================================================================
// 2) That id survives save/reload -- normalizeSavedAccount() is idempotent:
//    a second normalize pass on the same (already-normalized) object never
//    mints a new id.
// ===========================================================================
{
  const dash = makeSandbox();
  const account = { name: 'Acme', contacts: [{ name: 'Jordan Reyes', department: 'Marketing' }] };
  const first = dash.normalizeSavedAccount(account);
  const firstId = first.contacts[0].id;
  const second = dash.normalizeSavedAccount(first);
  assert(second.contacts[0].id === firstId, '2) REQUIRED: a contact\'s id survives repeated normalize passes (save/reload), never regenerated');

  // Also survives a genuinely fresh normalizeSavedAccount() call against a
  // plain object shaped like what api/get-dashboard.js returns after a
  // real reload (raw_data.contacts already carrying the same id).
  const reloaded = dash.normalizeSavedAccount({ name: 'Acme', rawData: { contacts: [{ id: firstId, name: 'Jordan Reyes', department: 'Marketing', origin: 'upload' }] } });
  assert(reloaded.contacts[0].id === firstId, '2) REQUIRED: an id already present in raw_data.contacts (a real reload) is preserved, not regenerated');
}

// ===========================================================================
// 3) A matching imported contact (same email, or an unambiguous name
//    match) retains its existing durable id when reconciled against a
//    freshly re-uploaded CSV row for the same person.
// ===========================================================================
{
  const dash = makeSandbox();
  const existing = [{ id: 'contact-1', name: 'Jordan Reyes', title: 'Marketing Manager', department: 'Marketing', email: 'jordan@example.com', phone: '', origin: 'upload' }];
  const fresh = [{ id: 'provisional-new', name: 'Jordan Reyes', title: 'Sr. Marketing Manager', department: 'Marketing', email: 'jordan@example.com', phone: '', origin: 'upload' }];
  const result = dash.reconcileImportedContacts(existing, fresh);
  assert(result.length === 1, '3) sanity: reconciling one matching contact produces exactly one contact');
  assert(result[0].id === 'contact-1', '3) REQUIRED: a matching imported contact (email match) retains its existing durable id on re-upload');
  assert(result[0].title === 'Sr. Marketing Manager', '3) REQUIRED: a matched, non-manually-edited contact\'s fields refresh from the new upload');

  // Name-only match (no email on either side) is also safe when unambiguous.
  const existingNoEmail = [{ id: 'contact-2', name: 'Dana Whitfield', title: 'Procurement Lead', department: 'Procurement', email: '', phone: '', origin: 'upload' }];
  const freshNoEmail = [{ id: 'provisional-2', name: 'Dana Whitfield', title: 'Sr. Procurement Lead', department: 'Procurement', email: '', phone: '', origin: 'upload' }];
  const resultNoEmail = dash.reconcileImportedContacts(existingNoEmail, freshNoEmail);
  assert(resultNoEmail[0].id === 'contact-2', '3) REQUIRED: an unambiguous normalized-name match also retains the existing durable id');
}

// ===========================================================================
// 4) A genuinely new imported contact (no match in the existing list) is
//    added, not dropped.
// ===========================================================================
{
  const dash = makeSandbox();
  const existing = [{ id: 'contact-1', name: 'Jordan Reyes', department: 'Marketing', email: 'jordan@example.com', origin: 'upload' }];
  const fresh = [
    { id: 'provisional-1', name: 'Jordan Reyes', department: 'Marketing', email: 'jordan@example.com', origin: 'upload' },
    { id: 'provisional-2', name: 'Alex Chen', department: 'Procurement', email: 'alex@example.com', origin: 'upload' }
  ];
  const result = dash.reconcileImportedContacts(existing, fresh);
  assert(result.length === 2, `4) REQUIRED: a genuinely new imported contact is added alongside the matched one (got ${result.length})`);
  assert(result.some(c => c.name === 'Alex Chen' && c.id === 'provisional-2'), '4) REQUIRED: the new contact keeps its freshly minted id');
}

// ===========================================================================
// 5) A manually added contact (origin:'manual') survives a later re-upload
//    untouched, even when the new upload says nothing about that person at
//    all.
// ===========================================================================
{
  const dash = makeSandbox();
  const existing = [
    { id: 'contact-1', name: 'Jordan Reyes', department: 'Marketing', email: 'jordan@example.com', origin: 'upload' },
    { id: 'contact-manual', name: 'Taylor Brooks', title: 'CFO', department: 'Leadership', email: '', phone: '', origin: 'manual', source: 'Added by your team' }
  ];
  // The new upload only mentions Jordan -- Taylor never appears in any CSV.
  const fresh = [{ id: 'provisional-1', name: 'Jordan Reyes', department: 'Marketing', email: 'jordan@example.com', origin: 'upload' }];
  const result = dash.reconcileImportedContacts(existing, fresh);
  const taylor = result.find(c => c.id === 'contact-manual');
  assert(!!taylor, '5) REQUIRED: a manually added contact survives a re-upload that never mentions that person');
  assert(taylor.name === 'Taylor Brooks' && taylor.title === 'CFO', '5) REQUIRED: the manual contact\'s fields are completely untouched by the re-upload');
}

// ===========================================================================
// 6) A manually EDITED imported contact (manuallyEdited:true) survives a
//    later re-upload of the same source row WITHOUT its edited fields
//    being overwritten -- approved conservative tradeoff (some other
//    source fields may go stale after a manual edit; no field-level
//    override system in V1).
// ===========================================================================
{
  const dash = makeSandbox();
  // A rep corrected the title after the CSV imported the wrong one.
  const existing = [{ id: 'contact-1', name: 'Jordan Reyes', title: 'VP Marketing (corrected by rep)', department: 'Marketing', email: 'jordan@example.com', phone: '', origin: 'upload', manuallyEdited: true }];
  // The next CSV upload still has the OLD (wrong) title.
  const fresh = [{ id: 'provisional-1', name: 'Jordan Reyes', title: 'Marketing Manager', department: 'Marketing', email: 'jordan@example.com', phone: '', origin: 'upload' }];
  const result = dash.reconcileImportedContacts(existing, fresh);
  assert(result.length === 1, '6) sanity: still exactly one contact (matched, not duplicated)');
  assert(result[0].id === 'contact-1', '6) REQUIRED: the manually edited contact keeps its durable id');
  assert(result[0].title === 'VP Marketing (corrected by rep)', '6) REQUIRED: a manually edited contact\'s corrected field survives the re-upload, never silently overwritten by the stale source value');

  // Also survives when the new upload doesn't mention that person at all.
  const freshEmpty = [];
  const resultEmpty = dash.reconcileImportedContacts(existing, freshEmpty);
  assert(resultEmpty.length === 1 && resultEmpty[0].title === 'VP Marketing (corrected by rep)', '6) REQUIRED: a manually edited contact survives even a re-upload that omits that person entirely -- an intentional correction is never silently destroyed');
}

// ===========================================================================
// 7) Same-name ambiguity never causes an unsafe merge -- two existing
//    contacts sharing a normalized name make the name-fallback match
//    refuse to fire; a same-named fresh row is treated as new rather than
//    guessed at. False duplicates are safer than merging two real humans
//    (House Accounts trust doctrine).
// ===========================================================================
{
  const dash = makeSandbox();
  const existing = [
    { id: 'contact-a', name: 'Chris Park', title: 'Marketing Manager', department: 'Marketing', email: '', phone: '', origin: 'upload' },
    { id: 'contact-b', name: 'Chris Park', title: 'Procurement Analyst', department: 'Procurement', email: '', phone: '', origin: 'upload' }
  ];
  const fresh = [{ id: 'provisional-new', name: 'Chris Park', title: 'Marketing Director', department: 'Marketing', email: '', phone: '', origin: 'upload' }];
  const result = dash.reconcileImportedContacts(existing, fresh);
  assert(result.length === 3, `7) REQUIRED: an ambiguous same-name match is refused -- the fresh row is added as a new, third contact rather than guessed onto either existing "Chris Park" (got ${result.length} contacts)`);
  assert(result.filter(c => c.id === 'contact-a' || c.id === 'contact-b').length === 2, '7) REQUIRED: both original same-named contacts survive untouched, neither one silently merged into');
  assert(result.some(c => c.id === 'provisional-new'), '7) REQUIRED: the fresh row keeps its own freshly minted id rather than being merged');

  // Email match still works correctly even in the presence of a same-name
  // ambiguity elsewhere in the account -- email is a strictly stronger
  // signal than the name fallback and is checked first.
  const existingWithEmail = [
    { id: 'contact-a', name: 'Chris Park', title: 'Marketing Manager', department: 'Marketing', email: 'chris.marketing@example.com', phone: '', origin: 'upload' },
    { id: 'contact-b', name: 'Chris Park', title: 'Procurement Analyst', department: 'Procurement', email: 'chris.procurement@example.com', phone: '', origin: 'upload' }
  ];
  const freshWithEmail = [{ id: 'provisional-new', name: 'Chris Park', title: 'Marketing Director', department: 'Marketing', email: 'chris.marketing@example.com', phone: '', origin: 'upload' }];
  const resultWithEmail = dash.reconcileImportedContacts(existingWithEmail, freshWithEmail);
  assert(resultWithEmail.length === 2, '7) REQUIRED: with a real email match available, the ambiguous name never blocks a correct, safe merge');
  assert(resultWithEmail.find(c => c.id === 'contact-a').title === 'Marketing Director', '7) REQUIRED: the email-matched contact\'s fields refresh correctly despite the name ambiguity elsewhere in the account');
}

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
