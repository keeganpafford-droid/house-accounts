// Organizational Learning V1B, Correction 2: the durable evidence stored
// on ha_account_opportunities.payload ("why this opportunity instance
// exists") is deliberately template-independent -- but a meaningful
// learning event also needs "what House Accounts actually recommended/
// presented when the rep acted." Those are different things: which
// industry template currently wins client-side scoring is presentation,
// not identity, and can legitimately change between two reads of the
// same durable opportunity instance.
//
// This module is a SMALL, STATIC, PURE-DATA reconstruction of that
// presentation -- explicitly NOT a port of dashboard/index.html's scoring/
// rendering engine (createOpportunity()'s value/confidence/relationship
// scoring, generateFutureOpportunities()'s selection/sort/dedupe). It only
// answers "given a trusted opportunity_type/category/templateKey, what did
// the rep most likely see as the program name and recommended contact,
// and what is the standing reasonToReachOut/conversationStarter for that
// family?" The browser supplies templateKey (a stable identifier for
// which literal template it rendered) and category; the server validates
// templateKey against this known registry and reconstructs the snapshot
// from it -- it never trusts recommendation prose the client supplies
// directly.
//
// FOLLOW_UP_TEMPLATES keys and names/contactTitles are a verbatim, literal
// copy of the templates dashboard/index.html's generateFutureOpportunities()
// passes to createOpportunity() for each industry branch. If a template's
// name/contactTitle changes there, this table must be updated to match --
// scripts/test-account-opportunity-templates.js proves the two stay in
// sync via a static source-text check against the real file, the same
// equivalence-proof pattern used for api/lib/account-opportunities.js.
const FOLLOW_UP_TEMPLATES = {
  auto_service_apparel: { name: 'Service Department Apparel Program', contactTitle: 'Service Director' },
  auto_tech_onboarding: { name: 'Technician Onboarding Kits', contactTitle: 'Service Director / HR Manager' },
  auto_event_campaign_kit: { name: 'Customer Event / Campaign Kit', contactTitle: 'Marketing Manager / General Manager' },
  auto_customer_appreciation: { name: 'Customer Appreciation Program', contactTitle: 'Marketing Manager' },
  mfg_safety_recognition: { name: 'Safety Recognition Program', contactTitle: 'Safety Manager / HR Manager' },
  mfg_trade_show_event: { name: 'Trade Show / Event Program', contactTitle: 'Marketing Manager / Sales Manager' },
  mfg_new_hire_kits: { name: 'New Hire Welcome Kits', contactTitle: 'HR Manager' },
  health_employee_recognition: { name: 'Employee Recognition Program', contactTitle: 'HR Manager / Practice Manager' },
  health_new_provider_onboarding: { name: 'New Provider Onboarding Kits', contactTitle: 'Practice Manager / HR Manager' },
  fin_client_appreciation: { name: 'Client Appreciation Program', contactTitle: 'Marketing Director / Client Experience Lead' },
  fin_investor_alumni_event: { name: 'Investor / Alumni Event Kit', contactTitle: 'Events Manager / Marketing Director' },
  food_retail_giveaway: { name: 'Retail / Customer Giveaway Program', contactTitle: 'Marketing Manager' },
  food_staff_apparel_refresh: { name: 'Staff Apparel Refresh', contactTitle: 'Operations Manager' },
  generic_multi_department_expansion: { name: 'Multi-Department Expansion', contactTitle: 'Marketing Manager / HR Manager' },
  generic_employee_recognition: { name: 'Employee Recognition Program', contactTitle: 'HR Manager' },
  generic_event_campaign_merch: { name: 'Event / Campaign Merch Program', contactTitle: 'Marketing Manager' }
};

// Verbatim port of dashboard/index.html's categoryProgramLabel() -- a pure
// string function, not scoring logic.
function categoryProgramLabel(category) {
  const c = String(category || 'Program').replace(/\s*\/\s*/g, ' / ');
  if (c === 'Event / Giveaway') return 'Event / Giveaway Program';
  if (c === 'Recognition / Awards') return 'Recognition / Awards Program';
  if (c === 'Onboarding / Recruiting') return 'Onboarding / Recruiting Program';
  if (c === 'Print / Stationery') return 'Print / Stationery Program';
  return `${c} Program`;
}

// Verbatim port of the contactTitle ternary inside
// dashboard/index.html's createRepeatPatternOpportunities().
function repeatPatternContactTitle(category) {
  const c = String(category || '');
  if (c.includes('Event')) return 'Marketing Manager / Events Lead';
  if (c.includes('Onboarding')) return 'HR Manager';
  if (c.includes('Safety')) return 'Safety Manager / HR Manager';
  if (c.includes('Client')) return 'Marketing Manager / Client Experience Lead';
  return 'Marketing Manager / HR Manager';
}

// Deliberately does NOT reproduce reorderWindowStatus()'s overdue-vs-
// approaching wording split -- that distinction is calendar drift, real-
// time presentation state that can change on every read of the same
// durable instance, not part of what HA recommended at the moment the rep
// acted. The steady-state phrasing below is the honest, stable snapshot:
// accurate enough to later show "HA recommended a repeat/pattern outreach
// on <category>," without claiming a precise urgency reading the server
// cannot safely reconstruct after the fact.
function buildOpportunityRecommendationSnapshot({ opportunityType, category, templateKey } = {}) {
  if (opportunityType === 'repeat_pattern') {
    const name = categoryProgramLabel(category);
    const categoryLower = String(category || '').toLowerCase();
    return {
      opportunityType: 'repeat_pattern',
      opportunityName: name,
      recommendedContact: repeatPatternContactTitle(category),
      reasonToReachOut: `${name} may be coming up again`,
      conversationStarter: categoryLower ? `Ask if the ${categoryLower} program is happening again this year.` : 'Ask if a similar program is happening again this year.'
    };
  }
  const template = FOLLOW_UP_TEMPLATES[templateKey] || null;
  return {
    opportunityType: 'follow_up',
    opportunityName: template ? template.name : 'Follow-Up Opportunity',
    recommendedContact: template ? template.contactTitle : '',
    reasonToReachOut: 'Recent order delivered or completed',
    conversationStarter: 'Check in and ask how the recent order was received.'
  };
}

export { FOLLOW_UP_TEMPLATES, categoryProgramLabel, repeatPatternContactTitle, buildOpportunityRecommendationSnapshot };
