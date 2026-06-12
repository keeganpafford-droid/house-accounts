/**
 * Sales Play Generator v1
 * Rule-based templates with dynamic variables
 * No external APIs - entirely client-side
 */

const SALES_STYLES = {
  consultative: {
    name: 'Consultative',
    description: 'Focus on understanding needs and partnership',
    tone: 'thoughtful, collaborative, discovery-driven'
  },
  direct: {
    name: 'Direct',
    description: 'Straightforward value proposition and ROI',
    tone: 'clear, efficient, results-focused'
  },
  executive: {
    name: 'Executive',
    description: 'Business impact, strategic alignment, metrics',
    tone: 'professional, business-focused, confidence-building'
  },
  challenger: {
    name: 'Challenger',
    description: 'Challenge assumptions, bring fresh perspective',
    tone: 'thought-provoking, competitive analysis, industry insights'
  },
  friendly: {
    name: 'Friendly',
    description: 'Conversational, relationship-building, warm',
    tone: 'approachable, personable, collaborative'
  }
};

/**
 * Generate a complete Sales Play for an opportunity
 * @param {Object} opportunity - Opportunity data
 * @param {string} style - Selected sales style (consultative, direct, executive, challenger, friendly)
 * @returns {Object} Complete sales play with all 5 components
 */
function generateSalesPlay(opportunity, style = 'consultative') {
  const account = opportunity.account || 'Account';
  const industry = opportunity.industry || 'General Business';
  const oppName = opportunity.opportunityName || 'Growth Opportunity';
  const oppEvidence = opportunity.opportunityEvidence || '';
  const suggestedProducts = opportunity.suggestedProducts || [];
  const contactName = opportunity.contactName || 'there';
  const historicalData = opportunity.historicalPurchaseData || [];
  const businessSignals = opportunity.businessSignals || [];

  const play = {
    account,
    opportunity: oppName,
    style,
    generatedAt: new Date().toLocaleString(),
    subjectLine: generateSubjectLine(account, oppName, industry, style),
    email: generateOutreachEmail(account, industry, oppName, oppEvidence, contactName, historicalData, style),
    callScript: generateCallScript(account, industry, oppName, contactName, style),
    discoveryQuestions: generateDiscoveryQuestions(industry, oppName, style),
    suggestedNextStep: generateNextStep(oppName, style)
  };

  return play;
}

/**
 * Generate a subject line based on opportunity and style
 */
function generateSubjectLine(account, opportunity, industry, style) {
  const templates = {
    consultative: [
      `Quick idea for ${account}: ${opportunity}`,
      `Conversation starter: ${opportunity} at ${account}`,
      `Question for ${account} about ${opportunity}`
    ],
    direct: [
      `${opportunity} opportunity at ${account}`,
      `Improving ${opportunity} for ${account}`,
      `${opportunity} solution for ${account}`
    ],
    executive: [
      `Strategic ${opportunity} Opportunity at ${account}`,
      `${opportunity}: Impact & ROI for ${account}`,
      `Enabling ${opportunity} Growth at ${account}`
    ],
    challenger: [
      `Is ${account} falling behind on ${opportunity}?`,
      `${account}: Rethinking ${opportunity}`,
      `Why most ${industry} companies miss ${opportunity}`
    ],
    friendly: [
      `Let's talk about ${opportunity} at ${account}`,
      `Quick thought on ${opportunity}`,
      `${opportunity} idea I thought of for ${account}`
    ]
  };

  const styleTemplates = templates[style] || templates.consultative;
  return styleTemplates[Math.floor(Math.random() * styleTemplates.length)];
}

/**
 * Generate outreach email body
 */
function generateOutreachEmail(account, industry, opportunity, evidence, contactName, historicalData, style) {
  let opening = '';
  let context = '';
  let value = '';
  let closing = '';

  // Openings by style
  const openings = {
    consultative: [
      `Hi ${contactName},\n\nI was looking at ${account}'s recent activity and noticed something interesting.`,
      `Hi ${contactName},\n\nI hope this finds you well. I've been studying how ${industry} companies are approaching ${opportunity}, and I think we should talk.`
    ],
    direct: [
      `Hi ${contactName},\n\nI work with ${industry} companies on ${opportunity}. Given ${account}'s background, I believe we could create immediate value.`,
      `Hi ${contactName},\n\n${account} has a clear opportunity for ${opportunity}. Here's why it matters right now.`
    ],
    executive: [
      `Dear ${contactName},\n\nI wanted to reach out regarding a strategic opportunity we've identified for ${account} around ${opportunity}.`,
      `${contactName},\n\nOur analysis shows ${account} could realize significant value by addressing ${opportunity}. I'd like to discuss.`
    ],
    challenger: [
      `Hi ${contactName},\n\nMost ${industry} companies approach ${opportunity} reactively. ${account} could be proactive—and that's worth a conversation.`,
      `${contactName},\n\nWe've noticed that companies leading in ${industry} are shifting their strategy on ${opportunity}. Has ${account} considered this?`
    ],
    friendly: [
      `Hey ${contactName},\n\nHope you're having a good week! I was thinking about ${account} and ${opportunity}.`,
      `Hi ${contactName},\n\nI came across something that reminded me of ${account}. Wanted to share a thought on ${opportunity}.`
    ]
  };

  opening = openings[style][Math.floor(Math.random() * openings[style].length)];

  // Context (reference historical data or signals)
  if (historicalData.length > 0) {
    const categories = historicalData.slice(0, 2).map(h => h.category || h).join(', ');
    context = `\n\nBased on ${account}'s recent purchases (${categories}), this seems like a natural next step.`;
  } else if (evidence) {
    context = `\n\nThe reason I'm reaching out: ${evidence}`;
  } else {
    context = `\n\nI think there's a real opportunity here for ${account}.`;
  }

  // Value proposition by style
  const values = {
    consultative: `\n\nI'm not here to pitch a solution yet—I'd just like to understand how ${account} is currently thinking about ${opportunity}. Maybe we see something you haven't, or maybe you're already ahead of the curve. Either way, worth a quick conversation.`,
    direct: `\n\nWe've helped similar companies in ${industry} improve ${opportunity} by 20-40% in the first quarter. Happy to share specific examples.`,
    executive: `\n\nOur research indicates companies that prioritize ${opportunity} see measurable improvements in revenue, retention, and market position. ${account} has the market position to lead here.`,
    challenger: `\n\nFast-growing ${industry} players are already moving here. The question for ${account} is: do you want to set the pace or follow?`,
    friendly: `\n\nI just think you'd appreciate how other companies are thinking about ${opportunity}, and I'd love to swap ideas.`
  };

  value = values[style] || values.consultative;

  // Closings by style
  const closings = {
    consultative: `\n\nWould you be open to a brief 15-minute call next week? No pressure—just a conversation.\n\nBest,`,
    direct: `\n\nLet's schedule a quick 15-minute call to discuss. I'm confident this is worth your time.\n\nBest regards,`,
    executive: `\n\nI'd welcome the opportunity to discuss this with you. Are you available for 15 minutes next week?\n\nBest regards,`,
    challenger: `\n\nCurious what you think? Grab 15 minutes on my calendar if you want to explore this.\n\nBest regards,`,
    friendly: `\n\nLet me know if you'd like to grab 15 minutes and chat about it!\n\nTalk soon,`
  };

  closing = closings[style] || closings.consultative;

  return `${opening}${context}${value}${closing}`;
}

/**
 * Generate call script structure
 */
function generateCallScript(account, industry, opportunity, contactName, style) {
  const scripts = {
    consultative: {
      opening: `Hi ${contactName}, thanks for taking my call. I know your time is valuable, so I'll keep this brief. I've been researching ${account} and the ${industry} space, and I noticed something around ${opportunity} that I thought might be worth discussing. Do you have 10 minutes?`,
      reasonForCall: `The reason for my call is to understand how ${account} is currently approaching ${opportunity}. We work with companies in your space, and I'm seeing a pattern—some are really nailing this, others haven't yet. I'm curious where ${account} sits.`,
      bridge: `Before we dive deeper, let me ask—what does success look like for you on ${opportunity}?`,
      closeQualify: `Based on what you've shared, I think there's a real conversation to be had here. Would you be open to a more detailed discussion, maybe with a couple of our team members who specialize in ${opportunity}?`
    },
    direct: {
      opening: `Hi ${contactName}, thanks for picking up. I'm calling because we've worked with several ${industry} companies like ${account} on ${opportunity}, and I believe we can help you see results quickly. Do you have 10 minutes?`,
      reasonForCall: `The reason I'm calling: ${account} has a clear opportunity to improve ${opportunity}. We've seen companies in your industry achieve 20-40% improvements within the first 90 days. I wanted to see if that's something you'd be interested in exploring.`,
      bridge: `Here's what typically happens: we do an assessment, identify the gaps, and create a specific improvement plan. Straightforward.`,
      closeQualify: `I'd like to schedule an assessment with our team. What does your calendar look like for next week?`
    },
    executive: {
      opening: `Good morning, ${contactName}. Thank you for making time. I'm reaching out because we've identified a strategic opportunity for ${account} around ${opportunity} that I believe warrants your attention. Is this still a good time for a brief conversation?`,
      reasonForCall: `Our analysis of ${industry} leaders shows that companies prioritizing ${opportunity} are seeing measurable advantages in market position, revenue growth, and operational efficiency. ${account} is well-positioned to lead in this area. I wanted to discuss how we might support that.`,
      bridge: `The companies we've worked with most effectively have executive alignment on the vision. So I wanted to start this conversation with you directly.`,
      closeQualify: `I'd like to propose we schedule a strategic discussion with your leadership team. We can come prepared with benchmark data specific to ${account}'s market. Would that be valuable?`
    },
    challenger: {
      opening: `Hi ${contactName}, thanks for the time. I'm calling because I think ${account} might be missing something critical about ${opportunity}. The leaders in your industry are already moving here—I wanted to see if you'd seen the trend.`,
      reasonForCall: `Here's my observation: most ${industry} companies treat ${opportunity} as a "nice to have." The winners are treating it as strategic. It's not too late for ${account}, but the window is closing. I wanted to give you a heads-up.`,
      bridge: `The companies that move first on this are going to have a competitive advantage. Is that something ${account} is thinking about?`,
      closeQualify: `I think you should see what your competitors are doing. Let's schedule a time where I can walk you through the competitive landscape and what's possible. Can we find time next week?`
    },
    friendly: {
      opening: `Hey ${contactName}, thanks for picking up! I hope you're having a good day. I was thinking about ${account} and thought of you. Got a quick sec to chat about ${opportunity}?`,
      reasonForCall: `So the thing is, I've been working with a bunch of companies similar to ${account}, and they're getting really creative with ${opportunity}. I know it's something you've dealt with, and I just thought you'd appreciate seeing what others are doing. Could be helpful.`,
      bridge: `I'm not trying to sell you anything—just thought you'd want to see what's working elsewhere. Actually curious what you think about it.`,
      closeQualify: `Would you be open to hopping on a more detailed call where we could brainstorm? I think you'd find it useful, and I'd love to get your take.`
    }
  };

  const script = scripts[style] || scripts.consultative;
  return [
    { section: 'OPENING', text: script.opening },
    { section: 'REASON FOR CALL', text: script.reasonForCall },
    { section: 'BRIDGE TO DISCOVERY', text: script.bridge },
    { section: 'CLOSE & QUALIFY', text: script.closeQualify }
  ];
}

/**
 * Generate discovery questions
 */
function generateDiscoveryQuestions(industry, opportunity, style) {
  const questionSets = {
    consultative: [
      `How is ${industry === 'Automotive / Dealership' ? 'your team' : 'your organization'} currently approaching ${opportunity}?`,
      `What are the biggest challenges you're facing right now with ${opportunity}?`,
      `Who else is involved in decisions around ${opportunity}?`,
      `What would success look like for you in this area?`,
      `Are there other initiatives that tie into ${opportunity}?`
    ],
    direct: [
      `What's your current process for ${opportunity}?`,
      `Where do you see the biggest inefficiencies?`,
      `What's preventing faster progress on ${opportunity}?`,
      `What would it be worth to improve this by 25%?`,
      `Who's the decision-maker on initiatives like this?`
    ],
    executive: [
      `How does ${opportunity} align with your 2-3 year strategic goals?`,
      `What metrics are most important for measuring success?`,
      `How are your competitors approaching this?`,
      `What's your target timeline for improvement?`,
      `What would it take to make this a top priority?`
    ],
    challenger: [
      `How is your current approach to ${opportunity} different from what leaders in your space are doing?`,
      `What assumptions are you making about ${opportunity}?`,
      `If you had to reimagine this from scratch, what would you change?`,
      `What's holding you back from being more aggressive here?`,
      `What would it look like to be the market leader on ${opportunity}?`
    ],
    friendly: [
      `Tell me about your current approach to ${opportunity}—what's working?`,
      `What frustrates you most about how things are now?`,
      `Is this something you think about a lot, or more on the periphery?`,
      `Who else in the organization cares about this?`,
      `If you could snap your fingers and fix one thing about ${opportunity}, what would it be?`
    ]
  };

  return (questionSets[style] || questionSets.consultative).slice(0, 5);
}

/**
 * Generate suggested next step
 */
function generateNextStep(opportunity, style) {
  const nextSteps = {
    consultative: `15-minute planning conversation to understand ${opportunity} priorities and timeline`,
    direct: `Schedule a 20-minute assessment to identify specific improvements and ROI`,
    executive: `Executive alignment call to discuss strategy and KPIs for ${opportunity}`,
    challenger: `Competitive intelligence briefing: show what market leaders are doing on ${opportunity}`,
    friendly: `Casual 15-minute brainstorm to explore what's possible with ${opportunity}`
  };

  return nextSteps[style] || nextSteps.consultative;
}
