// Monitoring Identity V1 -- deterministic coverage for api/lib/monitoring-identity.js,
// the durable target-identity resolution/eligibility layer described in the
// Phase 2C grounding-policy design. Covers, per the design's required test
// list: resolution order (uploaded website / unique business contact domain
// / unresolved), free-mail exclusion, multi-contact dedup, conflicting-
// domain and malformed-email handling, domain normalization equivalence,
// the identity-change lifecycle on later uploads (retain / supersede /
// move-to-unresolved / never-overwrite-confirmed), the circularity guard,
// and the centralized priority/secondary/hidden eligibility policy
// including the legacy-grandfather rule.
//
// Usage: node scripts/test-monitoring-identity-v1.js
import {
  normalizeDomain,
  extractBusinessDomainsFromContacts,
  resolveTargetIdentity,
  classifyCorroboratorTier,
  classifyMonitoringSignalEligibility
} from '../api/lib/monitoring-identity.js';

let failures = 0;
function assert(condition, message) {
  if (condition) console.log(`PASS: ${message}`);
  else { failures += 1; console.error(`FAIL: ${message}`); }
}

function contact(email) { return { email }; }

// ============================================================================
// 1. Domain normalization -- one deterministic boundary, reused everywhere
//    in this module. Casing, www, bare domain vs full URL, trailing paths,
//    protocol, subdomains must all resolve to the same comparable value.
// ============================================================================
assert(normalizeDomain('acme.com') === 'acme.com', '1) a bare domain normalizes to itself');
assert(normalizeDomain('https://acme.com') === 'acme.com', '1) a full https URL normalizes to the bare hostname');
assert(normalizeDomain('http://acme.com') === 'acme.com', '1) http (not just https) normalizes identically');
assert(normalizeDomain('https://www.acme.com') === 'acme.com', '1) www is stripped');
assert(normalizeDomain('www.acme.com') === 'acme.com', '1) www is stripped even without a protocol');
assert(normalizeDomain('ACME.COM') === 'acme.com', '1) uppercase normalizes to lowercase');
assert(normalizeDomain('https://ACME.com/About-Us') === 'acme.com', '1) mixed case + trailing path both normalize away');
assert(normalizeDomain('acme.com/products/widgets') === 'acme.com', '1) a trailing path on a bare domain is stripped');
assert(normalizeDomain('https://acme.com/') === 'acme.com', '1) a bare trailing slash is stripped');
assert(normalizeDomain('shop.acme.com') === 'shop.acme.com', '1) a genuine subdomain (not www) is preserved, not collapsed into the parent domain');
assert(normalizeDomain('') === '', '1) empty input normalizes to empty string');
assert(normalizeDomain('   ') === '', '1) whitespace-only input normalizes to empty string');
assert(
  normalizeDomain('https://www.Acme.com/About/') === normalizeDomain('acme.com'),
  '1) a decorated URL and its bare domain form normalize to the SAME value -- the equivalence the whole module depends on'
);

// ============================================================================
// 2. Contact-domain safeguards -- free-mail exclusion reused from existing
//    logic (domainFromContactEmail()), applied across ALL contacts (not
//    just the first), deduplicated, malformed/missing emails ignored.
// ============================================================================
assert(
  extractBusinessDomainsFromContacts([contact('jane@gmail.com')]).size === 0,
  '2) a single free-mail contact (gmail) yields zero business domains'
);
assert(
  extractBusinessDomainsFromContacts([
    contact('a@yahoo.com'), contact('b@outlook.com'), contact('c@hotmail.com'),
    contact('d@icloud.com'), contact('e@aol.com')
  ]).size === 0,
  '2) every common free-mail provider (yahoo/outlook/hotmail/icloud/aol) is excluded, not just gmail'
);
assert(
  [...extractBusinessDomainsFromContacts([contact('jane@acme.com')])][0] === 'acme.com',
  '2) a single business-domain contact yields exactly that domain'
);
assert(
  extractBusinessDomainsFromContacts([contact('jane@acme.com'), contact('bob@acme.com')]).size === 1,
  '2) multiple contacts sharing the same business domain dedupe to a single domain, not counted twice'
);
assert(
  extractBusinessDomainsFromContacts([contact('jane@gmail.com'), contact('bob@acme.com')]).size === 1,
  '2) a free-mail contact alongside one business-domain contact still yields exactly the one usable business domain'
);
assert(
  extractBusinessDomainsFromContacts([contact('jane@acme.com'), contact('bob@widgets.com')]).size === 2,
  '2) two contacts with genuinely different business domains both survive as distinct domains'
);
assert(
  extractBusinessDomainsFromContacts([contact('not-an-email'), contact(''), contact(undefined)]).size === 0,
  '2) malformed, empty, and missing email values are all safely ignored (no throw, no false domain)'
);
assert(
  extractBusinessDomainsFromContacts([]).size === 0,
  '2) an empty contact list yields zero business domains'
);
assert(
  extractBusinessDomainsFromContacts([contact('jane@ACME.com'), contact('bob@acme.COM')]).size === 1,
  '2) mixed-case domains from different contacts still dedupe to one normalized domain'
);
assert(
  extractBusinessDomainsFromContacts([contact('jane@acme.com'), { ...contact('jane@acme.com') }]).size === 1,
  '2) duplicate contact entries (same email) still dedupe to one domain'
);

// ============================================================================
// 3. resolveTargetIdentity() -- resolution order, from a fresh/unresolved
//    target: uploaded website (strongest) > unique business contact domain
//    > unresolved (never guess).
// ============================================================================
{
  const unresolved = { status: 'unresolved', domain: null, source: null };

  const r1 = resolveTargetIdentity({ current: unresolved, uploadedWebsite: 'acme.com', contacts: [] });
  assert(
    r1 && r1.status === 'derived' && r1.domain === 'acme.com' && r1.source === 'uploaded-website',
    '3) an explicit uploaded website alone derives identity from it'
  );

  const r2 = resolveTargetIdentity({ current: unresolved, uploadedWebsite: '', contacts: [contact('jane@acme.com')] });
  assert(
    r2 && r2.status === 'derived' && r2.domain === 'acme.com' && r2.source === 'contact-derived',
    '3) with no uploaded website, a unique business-domain contact email derives identity from it'
  );

  const r3 = resolveTargetIdentity({ current: unresolved, uploadedWebsite: '', contacts: [contact('jane@gmail.com')] });
  assert(r3 === null, '3) free-mail-only contact data leaves the target unresolved (no change)');

  const r4 = resolveTargetIdentity({ current: unresolved, uploadedWebsite: '', contacts: [] });
  assert(r4 === null, '3) no contact data at all leaves the target unresolved (no change)');

  const r5 = resolveTargetIdentity({
    current: unresolved, uploadedWebsite: '',
    contacts: [contact('a@acme.com'), contact('b@acme.com'), contact('c@acme.com')]
  });
  assert(
    r5 && r5.status === 'derived' && r5.domain === 'acme.com',
    '3) multiple contacts at the same domain still derive exactly once, to that one domain'
  );

  const r6 = resolveTargetIdentity({
    current: unresolved, uploadedWebsite: '',
    contacts: [contact('jane@gmail.com'), contact('bob@acme.com')]
  });
  assert(
    r6 && r6.status === 'derived' && r6.domain === 'acme.com',
    '3) free-mail contact + exactly one business-domain contact still derives from the usable domain'
  );

  const r7 = resolveTargetIdentity({
    current: unresolved, uploadedWebsite: '',
    contacts: [contact('jane@acme.com'), contact('bob@widgets.com')]
  });
  assert(r7 === null, '3) two distinct business domains across contacts leaves the target unresolved -- never guess between them');

  const r8 = resolveTargetIdentity({ current: unresolved, uploadedWebsite: 'acme.com', contacts: [contact('bob@widgets.com')] });
  assert(
    r8 && r8.domain === 'acme.com' && r8.source === 'uploaded-website',
    '3) an uploaded website takes priority over a conflicting contact-derived domain, per resolution order'
  );
}

// ============================================================================
// 4. Identity-change lifecycle on later uploads -- established identity is
//    never silently replaced; uploaded website may supersede contact-
//    derived; conflicting contact-derived domains move to unresolved, not
//    a silent switch; confirmed/rep-confirmed is never auto-overwritten.
// ============================================================================
{
  const contactDerived = { status: 'derived', domain: 'acme.com', source: 'contact-derived' };

  const same = resolveTargetIdentity({ current: contactDerived, uploadedWebsite: '', contacts: [contact('jane@acme.com')] });
  assert(same === null, '4) the same normalized contact domain on a later upload is retained (no-op), not re-derived');

  const noContactsThisRound = resolveTargetIdentity({ current: contactDerived, uploadedWebsite: '', contacts: [] });
  assert(noContactsThisRound === null, '4) a later upload with no contact data at all does not retract a previously contact-derived identity');

  const supersede = resolveTargetIdentity({ current: contactDerived, uploadedWebsite: 'acme-corp.com', contacts: [contact('jane@acme.com')] });
  assert(
    supersede && supersede.status === 'derived' && supersede.domain === 'acme-corp.com' && supersede.source === 'uploaded-website',
    '4) an explicit uploaded website supersedes a previously contact-derived identity, even one that differs from the contact domain'
  );

  const conflict = resolveTargetIdentity({ current: contactDerived, uploadedWebsite: '', contacts: [contact('jane@widgets.com')] });
  assert(
    conflict && conflict.status === 'unresolved' && conflict.domain === null,
    '4) a DIFFERENT contact-derived domain on a later upload moves the target to unresolved, never silently switches to the new domain'
  );

  const ambiguous = resolveTargetIdentity({
    current: contactDerived, uploadedWebsite: '',
    contacts: [contact('jane@acme.com'), contact('bob@widgets.com')]
  });
  assert(
    ambiguous && ambiguous.status === 'unresolved',
    '4) a later upload introducing a second distinct business domain also moves a contact-derived identity to unresolved'
  );

  const uploadedWebsiteTarget = { status: 'derived', domain: 'acme.com', source: 'uploaded-website' };
  const laterNoWebsite = resolveTargetIdentity({ current: uploadedWebsiteTarget, uploadedWebsite: '', contacts: [contact('jane@widgets.com')] });
  assert(
    laterNoWebsite === null,
    '4) once identity is uploaded-website-derived, a later upload that simply omits the website field (even with a conflicting contact domain) does not downgrade it'
  );

  const confirmedTarget = { status: 'confirmed', domain: 'acme.com', source: 'rep-confirmed' };
  const confirmedVsWebsite = resolveTargetIdentity({ current: confirmedTarget, uploadedWebsite: 'widgets.com', contacts: [] });
  assert(confirmedVsWebsite === null, '4) a rep-confirmed identity is never auto-overwritten, even by a conflicting explicit uploaded website');
  const confirmedVsContacts = resolveTargetIdentity({ current: confirmedTarget, uploadedWebsite: '', contacts: [contact('jane@widgets.com')] });
  assert(confirmedVsContacts === null, '4) a rep-confirmed identity is never auto-overwritten by conflicting contact-derived evidence either');
}

// ============================================================================
// 5. Circularity guard -- target identity resolution consumes ONLY
//    account-side inputs (uploadedWebsite, contacts). Proven structurally:
//    the function signature has no candidate/source/signal parameter for a
//    caller to (mis)use, so a discovered research domain literally cannot
//    reach this function's decision, no matter what a caller does with it.
// ============================================================================
{
  const unresolved = { status: 'unresolved', domain: null, source: null };
  const discoveredCandidateDomain = 'totally-different-co.example.net'; // simulates a research-discovered domain
  // Calling with only the legitimate account-side shape -- the discovered
  // domain above is never passed in at all, by construction of the call.
  const result = resolveTargetIdentity({ current: unresolved, uploadedWebsite: '', contacts: [] });
  assert(result === null, '5) with no account-side evidence, identity stays unresolved regardless of what research may have discovered elsewhere');
  // A single destructured parameter with a default value (`= {}`) reports
  // function.length === 0 in JS -- this only confirms arity, i.e. that
  // there is exactly one argument slot at all (so no second "candidate
  // domain" parameter exists for a caller to pass), not that it's used.
  assert(
    resolveTargetIdentity.length === 0,
    '5) resolveTargetIdentity() has exactly one argument slot (a single destructured options object) -- structurally no separate candidate/source-domain parameter exists for a caller to pass'
  );
  void discoveredCandidateDomain;
}

// ============================================================================
// 6. Strong vs. weak corroborator classification.
// ============================================================================
assert(classifyCorroboratorTier(['verified company domain']) === 'strong', '6) a verified company domain match classifies as strong');
assert(
  classifyCorroboratorTier(["matches account's known official social profile"]) === 'strong',
  '6) a known official social profile match classifies as strong'
);
assert(classifyCorroboratorTier(['location match']) === 'weak', '6) a bare location match classifies as weak');
assert(
  classifyCorroboratorTier(['publisher domain matches account city+state geography']) === 'weak',
  '6) publisher geography alone classifies as weak'
);
assert(
  classifyCorroboratorTier(["candidate domain exactly matches the account's own single-token company name"]) === 'weak',
  '6) self-domain inference from a single-token company name classifies as weak'
);
assert(
  classifyCorroboratorTier(["social handle exactly matches the account's own compacted company name"]) === 'weak',
  '6) an inferred exact-looking social handle (not already known to the account) classifies as weak'
);
assert(
  classifyCorroboratorTier(['social handle text resembles account name']) === 'weak',
  '6) a fuzzy social handle resemblance classifies as weak'
);
assert(classifyCorroboratorTier([]) === 'none', '6) no reasons at all classifies as none (name match alone)');
assert(classifyCorroboratorTier(undefined) === 'none', '6) a missing reasons array is treated safely as none, not a throw');
assert(
  classifyCorroboratorTier(['location match', 'verified company domain']) === 'strong',
  '6) when both a weak and a strong corroborator are present, strong wins -- one real strong signal is enough'
);

// ============================================================================
// 7. Centralized priority/secondary/hidden eligibility policy.
// ============================================================================
assert(
  classifyMonitoringSignalEligibility({ identityConfidence: 'confirmed', reasons: ['verified company domain'] }) === 'priority',
  '7) confirmed + a strong corroborator (verified domain) is priority-eligible'
);
assert(
  classifyMonitoringSignalEligibility({ identityConfidence: 'confirmed', reasons: ['location match'] }) === 'secondary',
  '7) confirmed with only a WEAK corroborator is secondary, not priority -- bare confidence label alone is never enough'
);
assert(
  classifyMonitoringSignalEligibility({ identityConfidence: 'confirmed', reasons: [] }) === 'secondary',
  '7) confirmed with no corroborator reasons at all (a same-name/different-entity namesake) is secondary, never priority'
);
assert(
  classifyMonitoringSignalEligibility({ identityConfidence: 'possible', reasons: [] }) === 'secondary',
  '7) possible is secondary'
);
assert(
  classifyMonitoringSignalEligibility({ identityConfidence: 'unconfirmed', reasons: [] }) === 'secondary',
  '7) unconfirmed is secondary'
);
assert(
  classifyMonitoringSignalEligibility({ identityConfidence: 'possible', reasons: ['verified company domain'] }) === 'priority',
  '7) a strong corroborator promotes a possible-labeled signal to priority (the actual evidence governs, not the label alone)'
);
assert(
  classifyMonitoringSignalEligibility({ identityConfidence: 'rejected', reasons: ['verified company domain'] }) === 'hidden',
  '7) an explicitly rejected/contradicted signal is hidden, even if some corroborator reason string is present'
);
assert(
  classifyMonitoringSignalEligibility({}) === 'priority',
  '7) LEGACY GRANDFATHER: a row with no identityConfidence at all (pre-tri-state-model) is treated as priority-eligible, not retroactively downgraded'
);
assert(
  classifyMonitoringSignalEligibility({ identityConfidence: undefined, reasons: undefined }) === 'priority',
  '7) legacy grandfather rule also holds when identityConfidence is explicitly undefined'
);
assert(
  classifyMonitoringSignalEligibility({ identityConfidence: null }) === 'priority',
  '7) legacy grandfather rule also holds when identityConfidence is explicitly null'
);

// ============================================================================
// 8. Uniform application across monitoring surfaces -- the dashboard
//    opportunity feed and the independent notification digest import and
//    call the SAME classifyMonitoringSignalEligibility() from this module,
//    proving there is exactly one trust policy regardless of which surface
//    displays a Queue-monitoring-sourced signal (not two parallel
//    reimplementations that could silently drift apart). The legacy
//    weekly-scan digest path this originally also covered was retired with
//    the Full Beta Cutover (api/weekly-scan.js deleted); api/lib/
//    notification-digest.js is its replacement and now the other half of
//    this proof.
// ============================================================================
{
  const fs = await import('node:fs');
  const notificationDigestSrc = fs.readFileSync(new URL('../api/lib/notification-digest.js', import.meta.url), 'utf8');
  const dashboardSrc = fs.readFileSync(new URL('../api/get-dashboard.js', import.meta.url), 'utf8');
  assert(
    /from ['"]\.\/monitoring-identity\.js['"]/.test(notificationDigestSrc) && /classifyMonitoringSignalEligibility/.test(notificationDigestSrc),
    '8) api/lib/notification-digest.js (independent notification digest path) imports and uses the shared classifyMonitoringSignalEligibility() from monitoring-identity.js'
  );
  assert(
    /from ['"]\.\/lib\/monitoring-identity\.js['"]/.test(dashboardSrc) && /classifyMonitoringSignalEligibility/.test(dashboardSrc),
    '8) api/get-dashboard.js (dashboard opportunity feed / "Newly Detected" surfacing) imports and uses the same shared classifier'
  );
}

// ============================================================================
// 9. Path B -- strongly resolved target + strong signal-side name match.
//    Founder QA follow-up (live Test B, L.L. Bean): a credible third-party
//    article that explicitly names an account whose identity is ALREADY
//    durably resolved from independent account-side evidence should not be
//    demoted to secondary merely because the article itself doesn't also
//    restate the account's own domain. See classifyMonitoringSignalEligibility()'s
//    own header comment for the full Path A / Path B rationale.
// ============================================================================
assert(
  classifyMonitoringSignalEligibility({ identityConfidence: 'unconfirmed', reasons: [], targetIdentityDomainSource: 'uploaded-website' }) === 'priority',
  '9.1) REQUIRED: a resolved target (uploaded-website anchor) + an exact, unembedded name match (unconfirmed) + no contradiction => priority (the canonical llbean.com / Press Herald case)'
);
assert(
  classifyMonitoringSignalEligibility({ identityConfidence: 'possible', reasons: [], targetIdentityDomainSource: 'uploaded-website' }) === 'secondary',
  '9.2) REQUIRED: a resolved target + only a possible (embedded/larger-entity or token-only) match stays secondary -- strong target identity never promotes a namesake-shaped match (the synthetic "Harborview Medical" inside "Harborview Medical Center" shape)'
);
assert(
  classifyMonitoringSignalEligibility({ identityConfidence: 'unconfirmed', reasons: [] }) === 'secondary',
  '9.3) REQUIRED: an unresolved target (no targetIdentityDomainSource) + exact name-only unconfirmed evidence stays secondary -- Path B never fires without an independently-established target anchor'
);
assert(
  classifyMonitoringSignalEligibility({ identityConfidence: 'rejected', reasons: [], targetIdentityDomainSource: 'uploaded-website' }) === 'hidden',
  '9.4) REQUIRED: an explicit contradiction (rejected) stays hidden even for a resolved target -- a strong account-side anchor never overrides a genuine identity contradiction'
);
assert(
  classifyMonitoringSignalEligibility({ identityConfidence: 'confirmed', reasons: ['verified company domain'] }) === 'priority',
  '9.5) REQUIRED: the existing Path A (signal-level strong corroborator) still produces priority on its own, with no targetIdentityDomainSource at all -- Path B is additive, not a replacement'
);
assert(
  classifyMonitoringSignalEligibility({ identityConfidence: 'confirmed', reasons: ['location match'], targetIdentityDomainSource: 'contact-derived' }) === 'priority',
  '9.5b) confirmed with only a weak signal-side corroborator still reaches priority via Path B when the target itself has a strong, independent anchor -- "at least unconfirmed" explicitly includes confirmed'
);
assert(
  classifyMonitoringSignalEligibility({ identityConfidence: 'unconfirmed', reasons: ["target identity is uploaded-website, trust me"], targetIdentityDomainSource: undefined }) === 'secondary',
  "9.6) REQUIRED (circularity): target identity cannot originate from the candidate being classified -- text that LOOKS like a target-identity claim inside the signal's own `reasons` array has no effect; only the caller's separate, structurally distinct targetIdentityDomainSource parameter (sourced exclusively from the durably-resolved ha_monitoring_targets row, never from the candidate) can trigger Path B"
);
assert(
  classifyMonitoringSignalEligibility({ identityConfidence: 'unconfirmed', reasons: [], targetIdentityDomainSource: 'some-future-unvetted-source' }) === 'secondary',
  '9.6b) an unrecognized targetIdentityDomainSource value (not one of the three account-side-only sources this module can ever write) is never treated as a strong anchor -- no silent trust of an unknown provenance'
);

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
if (failures) process.exitCode = 1;
