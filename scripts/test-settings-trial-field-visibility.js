// Founder QA (billing/pricing cleanup sprint): Account Settings always
// rendered five Trial */... rows (Trial status, Trial used, Trial started,
// Trial end, Trial remaining) regardless of subscription state -- for a
// genuinely paid/manual customer (usage.paidActive, which
// api/lib/entitlement.js's accountCapacity() precedence already makes the
// authority over any leftover trial_status/trial_end), those rows are
// obsolete internal history, not something confusing to show next to the
// real "Subscription" row. Fixed by only including them for a Free/
// trialing/lapsed-trial org, where they are still the genuinely relevant
// state.
//
// Extracts the real `const trialRows = ...` computation (verbatim, not
// reimplemented) out of settings.html's inline <script> and runs it
// against fixture usage/org shapes -- same convention as
// scripts/test-settings-subscription-label.js.
//
// Usage: node scripts/test-settings-trial-field-visibility.js
import { readFileSync } from 'fs';

let failures = 0;
function assert(condition, message){
  if(condition) console.log(`PASS: ${message}`);
  else { failures += 1; console.error(`FAIL: ${message}`); }
}

const html = readFileSync(new URL('../settings.html', import.meta.url), 'utf8');

const match = html.match(/const trialRows = usage\.paidActive[\s\S]*?\['Trial remaining',trialDays\]\];/);
if(!match) throw new Error('Could not locate the trialRows computation in settings.html -- it may have been renamed or restructured.');
const trialRowsFn = new Function('usage', 'trialLabel', 'trialUsed', 'trialStarted', 'org', 'dt', 'trialDays', `${match[0]}\nreturn trialRows;`);

function dt(v){ return v ? `formatted(${v})` : '—'; }

// A genuinely paid/manual org (the founder's own reported case: 100-account
// capacity, active subscription) -- the five Trial rows must be entirely
// absent, not merely blanked out.
{
  const rows = trialRowsFn({ paidActive: true }, 'inactive', 'Yes', '2026-08-11', { trial_end: '2026-09-10' }, dt, '—');
  assert(Array.isArray(rows) && rows.length === 0, `REQUIRED: a paid/manual organization (usage.paidActive) renders ZERO trial rows -- obsolete history is not shown next to a real subscription (got ${rows.length})`);
}

// A genuinely Free organization (never paid) -- the trial rows are still
// the real, relevant state and must remain.
{
  const rows = trialRowsFn({ paidActive: false }, 'inactive', 'No', null, { trial_end: null }, dt, '—');
  const labels = rows.map(r => r[0]);
  assert(labels.length === 5, `REQUIRED: a Free organization still shows all 5 trial rows (got ${labels.length})`);
  for(const label of ['Trial status', 'Trial used', 'Trial started', 'Trial end', 'Trial remaining']){
    assert(labels.includes(label), `REQUIRED: a Free organization's trial rows include "${label}"`);
  }
}

// An organization currently mid a genuinely active grandfathered legacy
// trial (not yet converted to paid) -- still relevant, must remain.
{
  const rows = trialRowsFn({ paidActive: false, trialActive: true }, 'Active', 'Yes', '2026-08-01', { trial_end: '2026-08-31' }, dt, '26 days remaining');
  assert(rows.length === 5, 'REQUIRED: an org mid an active legacy trial (not yet paid) still shows all 5 trial rows');
  assert(rows.find(r => r[0] === 'Trial remaining')[1] === '26 days remaining', 'the Trial remaining row still shows the real day count for an active trial');
}

// An org whose trial has lapsed and never converted -- also still relevant
// (explains why they are on Free now).
{
  const rows = trialRowsFn({ paidActive: false, trialExpired: true }, 'Expired', 'Yes', '2026-07-01', { trial_end: '2026-07-31' }, dt, '—');
  assert(rows.length === 5, 'REQUIRED: an org with a lapsed, never-converted trial still shows all 5 trial rows -- explains their current Free state');
}

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
