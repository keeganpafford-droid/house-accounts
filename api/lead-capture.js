export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  try {
    const payload = req.body || {};

    // V1 lightweight capture: visible in Vercel Function Logs.
    // Next step: replace this with Supabase, Airtable, HubSpot, or a Google Sheet webhook.
    console.log('HOUSE_ACCOUNTS_LEAD_CAPTURE', JSON.stringify({
      receivedAt: new Date().toISOString(),
      stage: payload.stage,
      lead: payload.lead,
      beta: payload.beta,
      analysisSummary: payload.analysisSummary,
      page: payload.page
    }));

    return res.status(200).json({ ok: true });
  } catch (error) {
    console.error('Lead capture failed', error);
    return res.status(500).json({ ok: false, error: 'Lead capture failed' });
  }
}
