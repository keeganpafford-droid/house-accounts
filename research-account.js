export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const account = req.body || {};
    const apiKey = process.env.OPENAI_API_KEY;

    if (!apiKey) {
      return res.status(200).json({
        research: demoResearch(account)
      });
    }

    const prompt = buildPrompt(account);

    const response = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'gpt-4.1-mini',
        tools: [{ type: 'web_search_preview' }],
        input: prompt
      })
    });

    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json({
        error: data.error?.message || 'OpenAI request failed'
      });
    }

    const text = extractText(data);
    return res.status(200).json({ research: text || 'No research returned.' });
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Server error' });
  }
}

function buildPrompt(account) {
  return `You are Account Radar, a promo-industry account intelligence analyst.

Analyze this existing promotional products customer and use current public web signals when available.

Customer data:
${JSON.stringify(account, null, 2)}

Your job: tell a promo distributor who to contact, why now, and what to sell.

Return in this exact structure:

ACCOUNT SNAPSHOT
- 2-3 bullets from internal order history.

CURRENT BUSINESS SIGNALS
- 2-4 current public signals if found. Include dates when available. Do not invent. If signals are weak, say so.

PROMO PLAYS
- 2-4 specific promotional product opportunities tied to the signals and order history.
- Be specific: launch kits, technician onboarding, sales event giveaways, service department apparel, recruiting kits, recognition awards, etc.

ESTIMATED OPPORTUNITY
- Give a realistic budget range and why.

WHO TO CONTACT
- Suggest likely titles, not made-up names unless public sources clearly identify someone.

OUTREACH ANGLE
- Write one concise email a rep could send.

Be practical, skeptical, and promo-specific.`;
}

function extractText(data) {
  if (data.output_text) return data.output_text;
  const parts = [];
  for (const item of data.output || []) {
    for (const content of item.content || []) {
      if (content.type === 'output_text' && content.text) parts.push(content.text);
    }
  }
  return parts.join('\n');
}

function demoResearch(account) {
  const client = account.client || 'This account';
  const projects = (account.projects || []).map(p => p.project).filter(Boolean).slice(0, 5).join(', ');
  return `DEMO MODE - add OPENAI_API_KEY to enable live web research.

ACCOUNT SNAPSHOT
- ${client} has ${account.orderCount || 0} recorded order(s) and roughly $${Math.round(account.totalRevenue || 0).toLocaleString()} in tracked revenue.
- Recent project themes: ${projects || 'not enough project detail available'}.

CURRENT BUSINESS SIGNALS
- Live web research is not enabled yet.
- In production, this section will scan public news, company websites, press releases, hiring activity, and event/product launch signals.

PROMO PLAYS
- Build a timely account-specific merch play based on recent activity.
- If this is a dealership: sales event giveaways, technician onboarding kits, service apparel refresh, vehicle launch/customer test-drive kits.
- If this is a manufacturer: safety recognition, new hire kits, recruiting/event giveaways, department apparel.

ESTIMATED OPPORTUNITY
- Initial suggested range: $5,000-$15,000 depending on account size, timing, and department scope.

WHO TO CONTACT
- Marketing Director, Sales Manager, HR/People Operations, General Manager, or Operations Manager depending on the play.

OUTREACH ANGLE
Subject: Quick idea for ${client}

Hey — noticed a few recent branded projects around ${projects || 'your team'} and had an idea for a more intentional follow-up program. Rather than treating each order separately, we could package the next initiative around a specific business moment — sales event, hiring push, department refresh, or employee recognition. Worth a quick look?`;
}
