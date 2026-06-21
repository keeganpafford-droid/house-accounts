/**
 * House Accounts Sales Play Generator
 * Relationship-aware, rule-based templates with dynamic variables.
 * No external APIs - entirely client-side.
 *
 * Principle:
 * Sales plays should sound like a real rep speaking to an existing or potential customer.
 * The generator should translate account evidence/signals into a simple human ask,
 * not stitch raw data into robotic sentences.
 */

const SALES_STYLES = {
  consultative: {
    name: 'Auto / Best Fit',
    description: 'Automatically chooses warm, lukewarm, or cold based on account relationship strength',
    tone: 'relationship-aware, practical, human'
  },
  direct: {
    name: 'Warm Relationship',
    description: 'For active customers with recent order history or known contacts',
    tone: 'brief, familiar, low-friction'
  },
  executive: {
    name: 'Lukewarm Reconnect',
    description: 'For accounts with some history but lower recent engagement',
    tone: 'respectful, re-engagement oriented'
  },
  challenger: {
    name: 'Cold / Signal-Based',
    description: 'For low-history accounts where the public signal creates the reason to reach out',
    tone: 'context-led, specific, not pushy'
  },
  friendly: {
    name: 'Short Note',
    description: 'Very brief version a rep can paste into email, LinkedIn, or CRM notes',
    tone: 'short, casual, useful'
  }
};

function generateSalesPlay(opportunity, style = 'consultative') {
  const ctx = buildSalesContext(opportunity || {});
  const mode = chooseRelationshipMode(ctx, style);

  return {
    account: ctx.account,
    opportunity: ctx.opportunityName,
    style,
    relationshipMode: mode,
    generatedAt: new Date().toLocaleString(),
    subjectLine: generateSubjectLine(ctx, mode, style),
    email: generateOutreachEmail(ctx, mode, style),
    callScript: generateCallScript(ctx, mode),
    discoveryQuestions: generateDiscoveryQuestions(ctx, mode),
    suggestedNextStep: generateNextStep(ctx, mode)
  };
}

function buildSalesContext(opportunity) {
  const account = cleanText(opportunity.account || opportunity.accountName || 'this account');
  const industry = cleanText(opportunity.industry || 'General Business');
  const rawOpportunity = cleanText(opportunity.opportunityName || opportunity.opportunity || 'Account expansion opportunity');
  const contactName = firstName(cleanText(opportunity.contactName || opportunity.contact || 'there'));
  const historicalData = Array.isArray(opportunity.historicalPurchaseData) ? opportunity.historicalPurchaseData : [];
  const businessSignals = Array.isArray(opportunity.businessSignals) ? opportunity.businessSignals : [];
  const suggestedProducts = normalizeProducts(opportunity.suggestedProducts || []);
  const categories = unique(historicalData.map(h => h.category || h.productCategory || h).filter(Boolean));
  const historicalRevenue = historicalData.reduce((sum, h) => sum + (Number(h.revenue) || 0), 0);
  const orderCount = historicalData.length;
  const hasContact = Boolean(opportunity.contactName || opportunity.contact);
  const relationshipStrength = Number(opportunity.relationshipStrength ?? opportunity.relationshipScore ?? estimateRelationshipStrength({
    orderCount,
    historicalRevenue,
    categories,
    hasContact
  }));
  const closeProbability = Number(opportunity.closeProbability ?? opportunity.probability ?? Math.min(95, Math.max(20, Math.round(relationshipStrength * 0.85))));
  const signal = pickBestSignal(businessSignals, opportunity);
  const play = inferPromoPlay({ rawOpportunity, industry, categories, suggestedProducts, signal });

  return {
    account,
    industry,
    contactName,
    rawOpportunity,
    opportunityName: play.opportunityName,
    simpleAsk: play.simpleAsk,
    productPhrase: play.productPhrase,
    suggestedProducts: play.products,
    historicalData,
    categories,
    orderCount,
    historicalRevenue,
    hasContact,
    relationshipStrength,
    closeProbability,
    signal,
    evidence: cleanEvidence(opportunity.opportunityEvidence || opportunity.evidence || ''),
    relationshipSummary: summarizeRelationship({ account, orderCount, historicalRevenue, categories })
  };
}

function chooseRelationshipMode(ctx, requestedStyle) {
  if (requestedStyle === 'direct') return 'warm';
  if (requestedStyle === 'executive') return 'lukewarm';
  if (requestedStyle === 'challenger') return 'cold';
  if (requestedStyle === 'friendly') return 'short';

  // Auto / Best Fit
  if (ctx.relationshipStrength >= 75 || (ctx.orderCount >= 3 && ctx.hasContact)) return 'warm';
  if (ctx.relationshipStrength >= 35 || ctx.orderCount > 0) return 'lukewarm';
  return 'cold';
}

function generateSubjectLine(ctx, mode) {
  if (mode === 'warm') return `Quick question for ${ctx.account}`;
  if (mode === 'lukewarm') return `Quick idea for ${ctx.account}`;
  if (mode === 'short') return `${ctx.account} idea`;
  if (ctx.signal && ctx.signal.type) return `${ctx.signal.type} idea for ${ctx.account}`;
  return `Question about ${ctx.account}`;
}

function generateOutreachEmail(ctx, mode) {
  if (mode === 'warm') return warmEmail(ctx);
  if (mode === 'lukewarm') return lukewarmEmail(ctx);
  if (mode === 'short') return shortNote(ctx);
  return coldSignalEmail(ctx);
}

function warmEmail(ctx) {
  const signalLine = ctx.signal ? `\n\nI noticed ${signalPhrase(ctx)} and it made me think there may be a simple way to support that.` : '';
  const historyLine = ctx.relationshipSummary ? `\n\n${ctx.relationshipSummary}` : '';

  return `Hey ${ctx.contactName},\n\nAppreciate being able to help with the branded merch work so far.${historyLine}${signalLine}\n\nQuick question — ${ctx.simpleAsk}\n\nIf useful, I can pull together a few simple options around ${ctx.productPhrase}.\n\nWorth a quick look?`;
}

function lukewarmEmail(ctx) {
  const signalLine = ctx.signal ? `\n\nI noticed ${signalPhrase(ctx)}, which seemed like a relevant reason to reconnect.` : '';
  const historyLine = ctx.relationshipSummary ? `\n\n${ctx.relationshipSummary}` : `\n\nI know there has been some prior activity with ${ctx.account}, so I wanted to reach out with something specific rather than a generic check-in.`;

  return `Hey ${ctx.contactName},\n\nIt's been a bit since we've connected.${historyLine}${signalLine}\n\nQuick question — ${ctx.simpleAsk}\n\nIf this is already covered, no worries. If not, I can send over a few practical ideas around ${ctx.productPhrase}.\n\nWorth a quick look?`;
}

function coldSignalEmail(ctx) {
  const signalLine = ctx.signal ? `I noticed ${signalPhrase(ctx)}.` : `I was looking at ${ctx.account} and thought there may be a timely branded merchandise opportunity.`;

  return `Hi ${ctx.contactName},\n\n${signalLine}\n\nWe help promotional products teams turn moments like that into practical sales opportunities — things like ${ctx.productPhrase}.\n\nQuick question — ${ctx.simpleAsk}\n\nIf you're not the right person, who would usually handle that?`;
}

function shortNote(ctx) {
  const opener = ctx.relationshipStrength >= 60
    ? `Hey ${ctx.contactName} — quick question.`
    : `Hi ${ctx.contactName} — quick idea for ${ctx.account}.`;
  const signalLine = ctx.signal ? ` I noticed ${signalPhrase(ctx)}.` : '';
  return `${opener}${signalLine} ${ctx.simpleAsk} If helpful, I can send a few options around ${ctx.productPhrase}.`;
}

function generateCallScript(ctx, mode) {
  const relationshipOpener = mode === 'warm'
    ? `You already have some relationship here, so keep it casual: “Appreciate all the work we've done together so far — quick question.”`
    : mode === 'lukewarm'
      ? `Position this as a specific reconnect, not a random check-in.`
      : `Lead with the verified signal or timely business reason first.`;

  return [
    {
      section: 'OPENING',
      text: mode === 'warm'
        ? `Hey ${ctx.contactName}, appreciate the business so far. I had one quick question for you.`
        : mode === 'lukewarm'
          ? `Hey ${ctx.contactName}, it's been a bit since we've connected. I had a specific idea for ${ctx.account}.`
          : `Hi ${ctx.contactName}, I noticed something timely about ${ctx.account} and wanted to ask a quick question.`
    },
    {
      section: 'WHY NOW',
      text: ctx.signal
        ? `The reason for reaching out: ${signalPhrase(ctx)}. That may create a timely need for ${ctx.productPhrase}.`
        : `The reason for reaching out: based on the account history, ${ctx.opportunityName.toLowerCase()} looks like a practical adjacent opportunity.`
    },
    {
      section: 'ASK',
      text: `Ask: “${ctx.simpleAsk}”`
    },
    {
      section: 'REP NOTE',
      text: relationshipOpener
    },
    {
      section: 'CLOSE',
      text: `If there is interest, suggest a low-friction next step: “I can send 2–3 options with rough pricing so you can see if it's worth pursuing.”`
    }
  ];
}

function generateDiscoveryQuestions(ctx, mode) {
  const questions = [
    ctx.simpleAsk,
    `Who usually owns decisions around ${ctx.productPhrase}?`,
    `Is there already a preferred vendor or internal process for this?`,
    `Would a simple good / better / best option set be useful?`,
    `Is there a specific timing, event, hiring class, or department need we should build around?`
  ];

  if (ctx.signal) {
    questions.unshift(`Is ${ctx.signal.type.toLowerCase()} creating any new merch, apparel, onboarding, event, or recognition needs?`);
  }

  return unique(questions).slice(0, 5);
}

function generateNextStep(ctx, mode) {
  if (mode === 'warm') return `Send 2–3 simple options tied to ${ctx.opportunityName.toLowerCase()} and ask who should weigh in.`;
  if (mode === 'lukewarm') return `Use the relationship history to reopen the conversation, then offer a small option set around ${ctx.productPhrase}.`;
  if (mode === 'short') return `Send a brief note and ask whether this is worth a quick look.`;
  return `Lead with the verified signal, ask for the right contact, and offer 2–3 practical product ideas.`;
}

function inferPromoPlay({ rawOpportunity, industry, categories, suggestedProducts, signal }) {
  const text = [rawOpportunity, industry, categories.join(' '), suggestedProducts.join(' '), signal?.title, signal?.type, signal?.evidence].join(' ').toLowerCase();

  if (/hiring|career|jobs|recruit|new hire|onboarding|employee/.test(text)) {
    return {
      opportunityName: 'New Hire / Employee Onboarding Program',
      simpleAsk: 'who handles onboarding gear or apparel for new hires these days?',
      productPhrase: 'welcome kits, department apparel, notebooks, drinkware, and recruiting giveaways',
      products: ['Welcome kits', 'Department apparel', 'Drinkware', 'Recruiting giveaways']
    };
  }

  if (/service|technician|mechanic|uniform/.test(text)) {
    return {
      opportunityName: 'Service Department Apparel Program',
      simpleAsk: 'who handles uniforms or apparel for the service team these days?',
      productPhrase: 'service polos, outerwear, hats, name-badge-ready apparel, and technician gear',
      products: ['Service polos', 'Outerwear', 'Technician hats', 'Uniform apparel']
    };
  }

  if (/event|conference|trade show|expo|booth|campaign|promotion/.test(text)) {
    return {
      opportunityName: 'Event / Campaign Merchandise Program',
      simpleAsk: 'is anyone planning branded giveaways or event merch for the next campaign?',
      productPhrase: 'event giveaways, booth merch, signage, attendee gifts, and staff apparel',
      products: ['Event giveaways', 'Booth merch', 'Signage', 'Staff apparel']
    };
  }

  if (/location|facility|expansion|opened|opening|branch/.test(text)) {
    return {
      opportunityName: 'New Location Launch Kit',
      simpleAsk: 'is there a plan for branded launch materials or team gear around the new location?',
      productPhrase: 'grand-opening kits, location-branded apparel, employee welcome items, and customer giveaways',
      products: ['Grand-opening kits', 'Location apparel', 'Welcome items', 'Customer giveaways']
    };
  }

  if (/leadership|president|ceo|director|vp|promoted|appointed|joined/.test(text)) {
    return {
      opportunityName: 'New Leader / Team Engagement Opportunity',
      simpleAsk: 'does the new leader have any team engagement, recognition, or internal brand initiatives coming up?',
      productPhrase: 'team recognition gifts, leadership welcome kits, employee appreciation items, and internal brand merch',
      products: ['Recognition gifts', 'Welcome kits', 'Internal brand merch']
    };
  }

  if (/apparel|shirt|hat|headwear|gear|quarter zip|jacket/.test(text)) {
    return {
      opportunityName: 'Department Apparel Expansion',
      simpleAsk: 'are there other departments that could use apparel or gear beyond the teams we have already helped?',
      productPhrase: 'department apparel, outerwear, hats, and employee gear programs',
      products: ['Department apparel', 'Outerwear', 'Headwear', 'Employee gear']
    };
  }

  if (/recognition|award|anniversary|appreciation|milestone/.test(text)) {
    return {
      opportunityName: 'Recognition / Appreciation Program',
      simpleAsk: 'who handles employee recognition, customer appreciation, or milestone gifts?',
      productPhrase: 'recognition gifts, milestone awards, customer appreciation items, and premium branded kits',
      products: ['Recognition gifts', 'Milestone awards', 'Appreciation kits']
    };
  }

  return {
    opportunityName: rawOpportunity || 'Account Expansion Opportunity',
    simpleAsk: 'is there a department, event, or upcoming initiative where branded merch could help?',
    productPhrase: suggestedProducts.length ? suggestedProducts.join(', ') : 'apparel, giveaways, recognition items, and customer-facing merch',
    products: suggestedProducts.length ? suggestedProducts : ['Apparel', 'Giveaways', 'Recognition items']
  };
}

function pickBestSignal(signals, opportunity) {
  const all = [];
  if (Array.isArray(signals)) all.push(...signals);
  if (opportunity.signal) all.push(opportunity.signal);
  if (opportunity.verifiedSignal) all.push(opportunity.verifiedSignal);

  const realish = all.filter(s => s && (s.sourceUrl || s.url || s.source || s.title || s.evidence));
  if (!realish.length) return null;

  const s = realish[0];
  const title = cleanText(s.title || s.signalTitle || s.name || opportunity.opportunityEvidence || 'verified external signal');
  const type = cleanSignalType(s.type || s.signalType || inferSignalType(title));
  const evidence = cleanEvidence(s.evidence || s.description || s.snippet || title);
  const sourceType = cleanText(s.sourceType || s.source || 'Public web source');
  const sourceUrl = s.sourceUrl || s.url || '';
  const confidence = Math.round(Number(s.confidence || s.score || 75));

  return { title, type, evidence, sourceType, sourceUrl, confidence };
}

function signalPhrase(ctx) {
  const s = ctx.signal;
  if (!s) return '';

  const account = ctx.account;
  const text = [s.title, s.evidence].join(' ').toLowerCase();

  if (/hiring|career|jobs|recruit/.test(text)) return `${account} appears to have recent hiring or recruiting activity`;
  if (/event|conference|show|expo|campaign|promotion/.test(text)) return `${account} appears to have an upcoming event or campaign`;
  if (/location|facility|expansion|opening|opened/.test(text)) return `${account} appears to be expanding or opening a location`;
  if (/leadership|appointed|joined|promoted|ceo|president|director|vp/.test(text)) return `${account} appears to have a leadership change`;
  if (/launch|product|release/.test(text)) return `${account} appears to have a product launch or promotion`;
  if (/award|recognition|anniversary|milestone/.test(text)) return `${account} appears to have a recognition or milestone moment`;

  return `${account} has a public business signal worth reviewing`;
}

function cleanSignalType(type) {
  const t = cleanText(type || 'Business Signal');
  if (/hiring|career|job|recruit/i.test(t)) return 'Hiring Activity';
  if (/event|conference|show|campaign/i.test(t)) return 'Event / Campaign';
  if (/expansion|location|facility/i.test(t)) return 'Expansion';
  if (/leader|ceo|president|director|vp/i.test(t)) return 'Leadership Change';
  if (/launch|product/i.test(t)) return 'Product Launch';
  return t;
}

function inferSignalType(text) {
  if (/hiring|career|jobs|recruit/i.test(text)) return 'Hiring Activity';
  if (/event|conference|show|expo|campaign/i.test(text)) return 'Event / Campaign';
  if (/location|facility|expansion|opening/i.test(text)) return 'Expansion';
  if (/leadership|appointed|joined|promoted|ceo|president|director|vp/i.test(text)) return 'Leadership Change';
  if (/launch|product|release/i.test(text)) return 'Product Launch';
  return 'Business Signal';
}

function estimateRelationshipStrength({ orderCount, historicalRevenue, categories, hasContact }) {
  let score = 0;
  score += Math.min(orderCount * 12, 35);
  score += Math.min(historicalRevenue / 1000, 25);
  score += Math.min((categories?.length || 0) * 10, 25);
  if (hasContact) score += 15;
  return Math.max(0, Math.min(100, Math.round(score)));
}

function summarizeRelationship({ account, orderCount, historicalRevenue, categories }) {
  if (!orderCount) return '';
  const parts = [];
  if (orderCount >= 3) parts.push(`there is already a real buying history here (${orderCount} orders)`);
  else parts.push(`there has already been some buying activity here`);

  if (historicalRevenue > 0) parts.push(`about $${Math.round(historicalRevenue).toLocaleString()} in tracked spend`);
  if (categories.length) parts.push(`including ${categories.slice(0, 3).join(', ')}`);

  return `${account} is not a cold account — ${parts.join(', ')}.`;
}

function normalizeProducts(products) {
  if (!Array.isArray(products)) products = [products];
  return unique(products.map(p => cleanText(p)).filter(Boolean));
}

function unique(arr) {
  return [...new Set(arr.filter(Boolean))];
}

function firstName(name) {
  if (!name || name.toLowerCase() === 'unknown') return 'there';
  return name.split(/\s+/)[0];
}

function cleanText(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

function cleanEvidence(text) {
  const cleaned = cleanText(text);
  if (!cleaned) return '';
  return cleaned
    .replace(/^Verified external signal:\s*/i, '')
    .replace(/^Source type:\s*/i, '')
    .replace(/\s*;\s*/g, '; ');
}
