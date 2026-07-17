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
console.log('MVP navigation and dashboard checks passed.');
