import fs from 'node:fs';
function assert(ok,msg){if(!ok) throw new Error(msg)}
const header=fs.readFileSync('site-header.js','utf8');
const home=fs.readFileSync('index.html','utf8');
const signup=fs.readFileSync('signup.html','utf8');
const login=fs.readFileSync('login.html','utf8');
assert(!header.includes("label:'Coming Soon'"),'Coming Soon remains in public nav');
assert(!header.includes("label:'Customer Success'"),'Customer Success remains in public nav');
for(const label of ['Pricing','FAQ','Security','Feedback']) assert(header.includes(`label:'${label}'`),`${label} missing from public nav`);
assert(home.includes('Upload your customer history'),'Homepage MVP supporting copy missing');
assert(!home.includes('Research target accounts'),'Homepage still promotes target-account research');
for(const name of ['name','organizationName','role','house_accounts','crm_erp','email','password']) assert(signup.includes(`name="${name}"`),`Signup field ${name} missing`);
assert(!login.includes('signupFields'),'Login still contains embedded signup component');
assert(signup.includes('/signup-form.js'),'Canonical signup component is not loaded');
console.log('Public MVP navigation and canonical signup checks passed.');
