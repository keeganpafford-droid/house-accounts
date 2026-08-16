// product/commercial-activation-reasoning -- "PRODUCT DIRECTION UPDATE, CORE
// vs EXPANSION vs PROSPECTING" implementation round.
//
// Two confirmed Core defects, both scoped to EXISTING customers only:
//
// Defect A (api/research-account.js): the single-account research endpoint
// already received website/contacts/categories/notes from every dashboard
// client payload builder, but silently dropped all but notes (notes was
// only ever used to build search-query strings, never reached the
// synthesis prompt) before they ever reached aiQualifyBusinessSignals()'s
// prompt. Fixed by reading them from req.body and threading them through as
// knownContacts/purchaseCategories/accountNotes, plus deriving a domain
// fallback from the account's own known website when no usable contact
// email domain exists.
//
// Defect B (api/research-batch.js): safeAccounts (the batch/warm-account
// pipeline's per-request account shape) never populated recentPurchases or
// purchases at all, so accountPromptContext()'s recentPurchases field (fed
// to the live model's own prompt) and findLikelyRelatedPurchase()'s
// deterministic recent-past fulfillment check (fed `account.purchases`)
// both silently operated on undefined/[] forever, even though the
// dashboard's batchPayloadForAccounts() already computed and sent the
// exact paired {category, project, dateStr} shape both consumers need.
// Fixed via one shared pairedPurchases() normalizer, and mirrored into
// api/weekly-scan.js's accountPayload() (the same defect at the automated
// weekly-scan entry point, which reads persisted raw_data rather than a
// fresh dashboard payload).
//
// Load-bearing product guardrail this suite exists to prove, not just
// describe: "The timely signal provides WHY NOW. Existing customer business
// data helps make the recommendation smarter. Durable/public account
// context must not become a reason-generator by itself." Concretely: none
// of the newly-wired-through context (contacts, purchase categories,
// notes, recentPurchases) is itself sufficient to produce a signal --
// aiQualifyBusinessSignals() requires real public candidate evidence before
// it will ever call the model at all, account context or not.
//
// Usage: node scripts/test-core-account-context-enrichment.js
import { readFileSync } from 'fs';
import handlerAccount, { aiQualifyBusinessSignals, domainFromWebsite } from '../api/research-account.js';
import { pairedPurchases, accountPromptContext } from '../api/research-batch.js';

let failures = 0;
function assert(condition, message) {
  if (condition) console.log(`PASS: ${message}`);
  else { failures += 1; console.error(`FAIL: ${message}`); }
}

for (const fn of [aiQualifyBusinessSignals, domainFromWebsite, pairedPurchases, accountPromptContext, handlerAccount]) {
  assert(typeof fn === 'function', `import produced a real function/handler (${fn && fn.name})`);
}

const originalFetch = global.fetch;
async function withFetch(fetchImpl, fn) {
  global.fetch = fetchImpl;
  try { return await fn(); } finally { global.fetch = originalFetch; }
}

// A single candidate that survives aiQualifyBusinessSignals()'s own filter
// (real url, not bad-search-text) -- the function's precondition for ever
// building a prompt or calling the model at all.
const REAL_CANDIDATE = [{ url: 'https://news.example.com/acme-expansion', title: 'Acme Fixtures opens new distribution center', snippet: 'Acme Fixtures Co. announced a new 80,000 sq ft distribution center opening next quarter, with plans to hire warehouse and logistics staff.' }];

function captureOpenAIPrompt(responseSignals = []) {
  let capturedPrompt = null;
  let callCount = 0;
  const fetchImpl = async (url, options) => {
    const u = String(url);
    if (u.includes('api.openai.com')) {
      callCount += 1;
      const body = JSON.parse(options.body);
      capturedPrompt = body.messages?.find(m => m.role === 'user')?.content || '';
      return {
        ok: true, status: 200,
        json: async () => ({ choices: [{ message: { content: JSON.stringify({ signals: responseSignals }) } }] })
      };
    }
    throw new Error(`unexpected fetch call in captureOpenAIPrompt: ${u}`);
  };
  return { fetchImpl, getPrompt: () => capturedPrompt, getCallCount: () => callCount };
}

async function main() {
  process.env.OPENAI_API_KEY = 'sk-test-do-not-log-1234567890';

  // =========================================================================
  // Defect A, required property 1: known contacts, purchase categories, and
  // internal notes now reach the account-context block of
  // aiQualifyBusinessSignals()'s own prompt -- previously dropped entirely
  // (contacts/categories were never even destructured from req.body;
  // notes was destructured but only ever used to build search-query text).
  // =========================================================================
  {
    const capture = captureOpenAIPrompt();
    await withFetch(capture.fetchImpl, () => aiQualifyBusinessSignals(
      'Acme Fixtures', 'Manufacturing', REAL_CANDIDATE, '', [],
      [{ name: 'Jordan Kim', title: 'Facilities Director', department: 'Operations', email: 'jordan@acmefixtures.com' }],
      ['Apparel', 'Drinkware'],
      'Long-time customer, prefers email over phone.'
    ));
    const prompt = capture.getPrompt();
    assert(capture.getCallCount() === 1, 'sanity: exactly one OpenAI call was made for this qualification pass');
    assert(typeof prompt === 'string' && prompt.length > 0, 'a real prompt was captured');
    assert(prompt.includes('Jordan Kim') && prompt.includes('Facilities Director'), `known contact context reaches the prompt (contact fit) -- required property 1 (got prompt excerpt: ${JSON.stringify((prompt.match(/Known contacts[^\n]*/) || [''])[0])})`);
    assert(prompt.includes('Apparel') && prompt.includes('Drinkware'), 'purchase category history reaches the prompt (purchase-aware activation ideas) -- required property 1');
    assert(prompt.includes('Long-time customer, prefers email over phone.'), 'internal account notes reach the prompt -- required property 1');
  }

  // =========================================================================
  // Defect A, sanity: omitting the new context entirely (legacy call shape,
  // e.g. an older caller that hasn't been updated) still produces a valid
  // prompt with no crash and no stray "undefined"/"[object Object]" text --
  // the new parameters are additive, not required.
  // =========================================================================
  {
    const capture = captureOpenAIPrompt();
    await withFetch(capture.fetchImpl, () => aiQualifyBusinessSignals('Acme Fixtures', 'Manufacturing', REAL_CANDIDATE));
    const prompt = capture.getPrompt();
    assert(typeof prompt === 'string' && prompt.length > 0, 'sanity: omitting all new context params still produces a real prompt');
    assert(!/undefined/i.test(prompt), 'sanity: no stray "undefined" leaks into the prompt when the new context is omitted');
    assert(!prompt.includes('Known contacts already on file'), 'sanity: the known-contacts context line is omitted entirely (not printed empty) when there are no contacts');
    assert(!prompt.includes('Product categories this account has bought'), 'sanity: the purchase-category context line is omitted entirely when there are no categories');
    assert(!prompt.includes('Internal notes on file'), 'sanity: the notes context line is omitted entirely when there are no notes');
  }

  // =========================================================================
  // Required property 2 (guardrail): the prompt itself instructs the model
  // that account context sharpens an already-established signal and is
  // never itself a reason to contact -- the "signal provides WHY NOW,
  // account context makes the play smarter, never manufactures timing"
  // principle, made explicit in the prompt text the model actually reads.
  // =========================================================================
  {
    const capture = captureOpenAIPrompt();
    await withFetch(capture.fetchImpl, () => aiQualifyBusinessSignals(
      'Acme Fixtures', 'Manufacturing', REAL_CANDIDATE, '', [],
      [{ name: 'Jordan Kim' }], ['Apparel'], 'VIP account'
    ));
    const prompt = capture.getPrompt();
    assert(/none of it is itself a reason to contact this account/i.test(prompt), 'required property 2: the prompt explicitly states account context is never itself a reason to contact');
    assert(/return \{"signals":\[\]\} regardless of how much account context is available/i.test(prompt), 'required property 2: the prompt explicitly instructs an empty result when public evidence does not establish a real moment, regardless of account context richness');
  }

  // =========================================================================
  // Required property 2 (behavioral, not just textual): rich account
  // context with ZERO public candidates never reaches the model at all --
  // aiQualifyBusinessSignals()'s own precondition (candidates.length) is
  // checked before any account context is used, so account context alone
  // structurally cannot manufacture a signal.
  // =========================================================================
  {
    let called = false;
    const fetchImpl = async () => { called = true; throw new Error('must not call OpenAI with zero candidates'); };
    const result = await withFetch(fetchImpl, () => aiQualifyBusinessSignals(
      'Acme Fixtures', 'Manufacturing', [], '', [{ category: 'Apparel', project: 'Trade show shirts', dateStr: '2026-07-01' }],
      [{ name: 'Jordan Kim' }], ['Apparel', 'Drinkware'], 'Extremely engaged, high-value, long-tenured customer.'
    ));
    assert(called === false, 'required property 2: rich account context (contacts, categories, notes, recent purchases) never triggers an OpenAI call with no public candidate evidence');
    assert(Array.isArray(result.signals) && result.signals.length === 0, 'required property 2: the result is an honest empty signals array, never a fabricated one');
  }

  // =========================================================================
  // Defect A, required property: an existing customer's own known website
  // now resolves a domain even when no usable contact email is available --
  // previously dropped entirely (website was never read from req.body).
  // =========================================================================
  {
    assert(domainFromWebsite('https://www.acmefixtures.com/about') === 'acmefixtures.com', `domainFromWebsite() extracts a bare domain from a full URL (got "${domainFromWebsite('https://www.acmefixtures.com/about')}")`);
    assert(domainFromWebsite('acmefixtures.com') === 'acmefixtures.com', 'domainFromWebsite() accepts a bare domain with no scheme');
    assert(domainFromWebsite('') === '', 'domainFromWebsite() returns empty for no website');
    assert(domainFromWebsite('someone@gmail.com') === '', 'domainFromWebsite() rejects a personal-email-provider domain the same way domainFromEmailDomain() already does');
  }

  // =========================================================================
  // Defect A wiring: the request handler actually reads the previously-
  // dropped fields and threads them through to the aiQualifyBusinessSignals
  // call site. Source-scoped assertions (mirrors the existing splice check
  // in scripts/test-historical-event-purchase-context.js's required test 8)
  // -- proving the wiring exists exactly once, at its real call site.
  // =========================================================================
  {
    const src = readFileSync(new URL('../api/research-account.js', import.meta.url), 'utf8');
    assert(/const \{ accountName, industry, cityState, emailDomain, notes, employees, contactName, purchases, website, contacts, categories \} = req\.body/.test(src), 'defect A wiring: the handler now destructures website/contacts/categories from req.body alongside the existing fields');
    assert(/domainFromEmailDomain\(emailDomain\) \|\| domainFromWebsite\(website\)/.test(src), 'defect A wiring: domain resolution now falls back to the account\'s own known website');
    assert(/aiQualifyBusinessSignals\(accountName, industry, allCandidates, clean\(contactName \|\| ''\), recentPurchases, knownContacts, purchaseCategories, clean\(notes \|\| ''\)\)/.test(src), 'defect A wiring: the call site passes knownContacts/purchaseCategories/accountNotes through');
  }

  // =========================================================================
  // Defect B, required property: safeAccounts now populates both
  // recentPurchases (feeds accountPromptContext()'s prompt data) and
  // purchases (feeds findLikelyRelatedPurchase()'s deterministic check)
  // from whichever shape the caller actually sent.
  // =========================================================================
  {
    const prePaired = pairedPurchases({ recentPurchases: [{ category: 'Apparel', project: 'Trade show shirts', dateStr: '2026-07-01' }] });
    assert(prePaired.length === 1 && prePaired[0].category === 'Apparel', 'pairedPurchases() passes through an already-paired recentPurchases array');

    const rawRecords = pairedPurchases({ purchases: [{ category: 'Drinkware', project: 'Client gift mugs', date: '2026-06-15' }] });
    assert(rawRecords.length === 1 && rawRecords[0].category === 'Drinkware' && rawRecords[0].dateStr === '2026-06-15', `pairedPurchases() normalizes a raw uploaded purchases array (date -> dateStr) into the same paired shape (got ${JSON.stringify(rawRecords)})`);

    assert(pairedPurchases({}).length === 0, 'pairedPurchases() returns [] for an account with no purchase data at all -- never invents one');
    assert(pairedPurchases({ purchases: [{ category: 'Apparel' }] }).length === 0, 'pairedPurchases() drops a purchase record with no resolvable date -- date proximity is the only thing findLikelyRelatedPurchase() can use as evidence');
  }
  {
    // End-to-end through accountPromptContext(), the exact function whose
    // recentPurchases field previously always evaluated to [] because
    // safeAccounts never set it.
    const ctx = accountPromptContext([{ name: 'Acme Fixtures', recentPurchases: [{ category: 'Apparel', project: 'Trade show shirts', dateStr: '2026-07-01' }] }]);
    assert(ctx[0].recentPurchases.length === 1, 'accountPromptContext() carries a populated recentPurchases field through to the live model\'s own prompt data');
  }

  // =========================================================================
  // Defect B wiring: safeAccounts' construction now sets both fields from
  // the shared pairedPurchases() normalizer.
  // =========================================================================
  {
    const src = readFileSync(new URL('../api/research-batch.js', import.meta.url), 'utf8');
    assert(/recentPurchases: pairedPurchases\(a\),\s*\n\s*purchases: pairedPurchases\(a\),/.test(src), 'defect B wiring: safeAccounts now sets both recentPurchases and purchases from pairedPurchases(a)');
    assert(/findLikelyRelatedPurchase\(account\.purchases, resolvedEventDate/.test(src), 'sanity: findLikelyRelatedPurchase()\'s call site (the consumer this fix restores data to) is unchanged');
  }
  // Same defect, at the recurring-monitoring automated entry point: covered
  // independently by scripts/test-account-context-projection.js, which
  // proves api/lib/monitoring-targets.js's projectAccountContext() (the
  // Queue path's account-context resolver, api/queues/monitoring-
  // consumer.js's resolveAccountContext()) reads raw_data.purchases back out
  // into a bounded recentPurchases array -- the Queue architecture's own
  // fix for this same class of defect, not a re-test of the retired
  // api/weekly-scan.js's accountPayload().

  // =========================================================================
  // Required property: no new LLM call was introduced -- exactly one
  // aiQualifyBusinessSignals() call site in research-account.js, and the
  // research-batch.js OpenAI call sites are unchanged in count (this test
  // only asserts absence of a NEW call site; the existing call sites and
  // their behavior are covered by scripts/test-commercial-activation-
  // reasoning.js and scripts/test-held-out-blind-evaluation.js, both
  // re-run clean alongside this file).
  // =========================================================================
  {
    const accountSrc = readFileSync(new URL('../api/research-account.js', import.meta.url), 'utf8');
    const callSites = accountSrc.match(/aiQualifyBusinessSignals\(/g) || [];
    assert(callSites.length === 2, `no new LLM call: aiQualifyBusinessSignals is still referenced exactly twice in research-account.js (its own declaration + the one call site), got ${callSites.length}`);
    const openaiFetchSites = accountSrc.match(/fetch\(['"`]https:\/\/api\.openai\.com/g) || [];
    assert(openaiFetchSites.length === 1, `no new LLM call: exactly one direct OpenAI fetch call site exists in research-account.js, unchanged (got ${openaiFetchSites.length})`);
  }

  console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
  if (failures) process.exitCode = 1;
}

main();
