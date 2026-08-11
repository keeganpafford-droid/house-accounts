import fs from 'node:fs';
import assert from 'node:assert/strict';

const header=fs.readFileSync(new URL('../site-header.js', import.meta.url),'utf8');
const dashboard=fs.readFileSync(new URL('../dashboard/index.html', import.meta.url),'utf8');

// Correction round: the nav item that used to say "House Accounts" is
// renamed to "Dashboard" -- the logo (.ha-brand-link, still "House
// Accounts") already identifies the product. "Add Customer Data" is no
// longer a plain appLinks nav entry; it is the global teal CTA rendered
// in the account-actions cluster, using the single canonical add-data URL.
assert.match(header,/label:'Dashboard'/);
assert.doesNotMatch(header,/const appLinks=\[[\s\S]*label:'House Accounts'/);
assert.match(header,/ADD_CUSTOMER_DATA_HREF='\/dashboard\/\?action=add-data'/);
assert.match(header,/class="ha-action-link ha-cta" id="haAddCustomerDataCta"/);
assert.doesNotMatch(header,/const appLinks=\[[\s\S]*label:'Prospects'/);
assert.match(header,/prospectIntelligence:false/);
assert.match(header,/location\.replace\('\/dashboard\/\?mvp=feature-hidden'\)/);
assert.match(dashboard,/Who should I contact next, and why\?/);
assert.match(dashboard,/account-intelligence-section/);
assert.match(dashboard,/openLightweightCustomerUpload\(\)/);
assert.doesNotMatch(dashboard,/>Upload New Account List</);
assert.doesNotMatch(dashboard,/>Add another list</);

// QA round 2, item 8 (still true after the correction round): exactly one
// visible "Add Customer Data" action in the authenticated experience -- the
// CTA in site-header.js (rendered into every authenticated page) is the
// single primary entry point; dashboard/index.html never renders its own
// page-level "Add Customer Data" button, and every entry point resolves to
// the same canonical openAddCustomerDataModal() flow.
const ctaMatches = header.match(/>Add Customer Data</g) || [];
assert.equal(ctaMatches.length, 1, 'exactly one "Add Customer Data" CTA in site-header.js');
// Live QA round 9: the signed-in, no-uploaded-data empty state
// (#memberEmptyState, filled in by renderEmptyWorkspaceState()) now has
// its own primary "Add Customer Data" button -- a deliberate exception to
// the "single clickable entry point" invariant above, scoped to the ONE
// context where there is nothing else on the page for a brand-new user to
// click: a true empty workspace. It resolves through the exact same
// canonical openLightweightCustomerUpload() -> openAddCustomerDataModal()
// flow as the header CTA, never a second modal/orchestration path, and it
// is the only OTHER page-level control permitted to carry this label. The
// modal's own <h2> heading legitimately says "Add Customer Data" too (it
// is hidden by default and only opens via the canonical action) -- what
// must stay singular is any FURTHER clickable button/anchor duplicating
// these two.
const dashboardAddCustomerDataControls = dashboard.match(/<(button|a)[^>]*>Add Customer Data</g) || [];
assert.equal(dashboardAddCustomerDataControls.length, 1, 'dashboard/index.html renders exactly one page-level "Add Customer Data" control of its own -- the empty-workspace-state primary CTA -- and no other; the header CTA (site-header.js, rendered on every authenticated page, desktop and mobile alike) remains the entry point everywhere else');
assert.match(dashboard, /id="emptyWorkspaceAddDataBtn">Add Customer Data</, 'the one page-level "Add Customer Data" control is specifically the empty-workspace-state CTA');
assert.match(dashboard, /addDataBtn\.addEventListener\('click', \(\) => openLightweightCustomerUpload\(\)\);/, 'the empty-workspace-state CTA resolves through the exact same canonical openLightweightCustomerUpload() flow, not a separate modal/orchestration path');
assert.match(dashboard, /function openAddCustomerDataModal\(\)/, 'the canonical Add Customer Data modal-open function is present');
assert.match(dashboard, /#add-customer-data['"]?\s*\|\|\s*window\.location\.hash === ['"]#dropzone/, 'the legacy #add-customer-data hash handler still routes through the canonical modal-open path');

// QA round 2, item 7: "Cold Play" is no longer rendered anywhere.
assert.doesNotMatch(dashboard, /Cold Play/, '"Cold Play" internal jargon no longer appears anywhere in the rendered dashboard source');
assert.match(dashboard, /First Contact/, 'the plain-language "First Contact" replacement is present');

console.log('MVP navigation and dashboard checks passed.');
