import fs from 'node:fs';
import assert from 'node:assert/strict';

const header=fs.readFileSync(new URL('../site-header.js', import.meta.url),'utf8');
const dashboard=fs.readFileSync(new URL('../dashboard/index.html', import.meta.url),'utf8');

assert.match(header,/label:'House Accounts'/);
assert.match(header,/label:'Add Customer Data'/);
assert.doesNotMatch(header,/const appLinks=\[[\s\S]*label:'Prospects'/);
assert.match(header,/prospectIntelligence:false/);
assert.match(header,/location\.replace\('\/dashboard\/\?mvp=feature-hidden'\)/);
assert.match(dashboard,/Who should I contact next, and why\?/);
assert.match(dashboard,/account-intelligence-section/);
assert.match(dashboard,/openLightweightCustomerUpload\(\)/);
assert.doesNotMatch(dashboard,/>Upload New Account List</);
assert.doesNotMatch(dashboard,/>Add another list</);

// QA round 2, item 8: exactly one visible "Add Customer Data" action in the
// authenticated dashboard experience -- the nav entry in site-header.js
// (rendered into every authenticated page) is the single primary entry
// point; the page-level button that used to duplicate it in
// dashboard/index.html is gone, though the underlying upload flow
// (openLightweightCustomerUpload(), asserted above) and the #add-customer-data
// hash handler it depends on are both still present and unremoved.
const navAddCustomerDataMatches = header.match(/label:'Add Customer Data'/g) || [];
assert.equal(navAddCustomerDataMatches.length, 1, 'exactly one "Add Customer Data" nav entry in site-header.js');
assert.doesNotMatch(dashboard, />Add Customer Data</, 'dashboard/index.html no longer renders its own page-level "Add Customer Data" button -- the nav entry (site-header.js, rendered on every authenticated page, desktop and mobile alike) is the single entry point');
assert.match(dashboard, /#add-customer-data['"]?\s*\|\|\s*window\.location\.hash === ['"]#dropzone/, 'the #add-customer-data hash handler the nav link relies on is still wired up');

// QA round 2, item 7: "Cold Play" is no longer rendered anywhere.
assert.doesNotMatch(dashboard, /Cold Play/, '"Cold Play" internal jargon no longer appears anywhere in the rendered dashboard source');
assert.match(dashboard, /First Contact/, 'the plain-language "First Contact" replacement is present');

console.log('MVP navigation and dashboard checks passed.');
