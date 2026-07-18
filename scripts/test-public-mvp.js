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

assert(signup.includes('Free Forever • No credit card required'),'Signup is missing the Free Forever badge');
assert(signup.includes('Monitor up to 10 customer accounts for free—forever.'),'Signup is missing permanent free-tier copy');
assert(signup.includes('Every paid plan starts with a 30-day free trial.'),'Signup is missing paid-trial clarification');
assert(home.includes('Free Forever • No credit card required'),'Homepage is missing the Free Forever badge');
assert(home.includes('Monitor up to 10 customer accounts for free—forever.'),'Homepage is missing permanent free-tier copy');
const pricing=fs.readFileSync('pricing.html','utf8');
const signupScript=fs.readFileSync('signup-form.js','utf8');
assert((pricing.match(/Start 30-Day Free Trial/g)||[]).length===2,'Solo and Team must use the same paid-trial CTA');
assert(pricing.includes('href="/signup?plan=solo">Start 30-Day Free Trial'),'Solo paid CTA is incorrect');
assert(pricing.includes('href="/signup?plan=team">Start 30-Day Free Trial'),'Team paid CTA is incorrect');
assert(pricing.includes('href="/signup">Start Free'),'Free-tier CTA must use the permanent free signup route');
assert(header.includes('href="/signup">Start Free'),'Header Start Free must use the permanent free signup route');
assert(signupScript.includes("plan:requestedPlan"),'Canonical signup does not preserve selected free or paid plan');
for(const [name,html] of [['homepage',home],['signup',signup],['pricing',pricing]]){
  assert(!/monitor(?:ed|ing)? companies/i.test(html),`${name} still uses monitored companies terminology`);
  assert(!/up to 10 companies/i.test(html),`${name} still uses companies for the free-tier limit`);
}

console.log('Public MVP navigation and canonical signup checks passed.');
