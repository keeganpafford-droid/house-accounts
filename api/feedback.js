function clean(value = ''){
  return String(value || '').trim();
}

function escapeHtml(value = ''){
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

async function sendFeedbackEmail({type, message, email, currentPage, timestamp}){
  const key = process.env.RESEND_API_KEY;
  if(!key) return {skipped: true, reason: 'Missing RESEND_API_KEY'};

  const from = process.env.ALERTS_FROM_EMAIL || 'House Accounts <alerts@houseaccounts.ai>';
  const to = process.env.FEEDBACK_TO_EMAIL || 'hello@houseaccounts.ai';
  const subject = `House Accounts Beta ${type}`;
  const html = `
    <div style="font-family:Arial,sans-serif;line-height:1.5;color:#17375E;">
      <h2 style="margin:0 0 16px;">New ${escapeHtml(type)}</h2>
      <p><strong>Submitted:</strong> ${escapeHtml(timestamp)}</p>
      ${email ? `<p><strong>Email:</strong> ${escapeHtml(email)}</p>` : ''}
      ${currentPage ? `<p><strong>Page:</strong> ${escapeHtml(currentPage)}</p>` : ''}
      <div style="margin-top:18px;padding:16px;border:1px solid #D8DEE9;border-radius:8px;background:#F7F8FA;white-space:pre-wrap;">${escapeHtml(message)}</div>
    </div>
  `;

  const resp = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from, to, subject, html })
  });

  const data = await resp.json().catch(() => ({}));
  if(!resp.ok) throw new Error(`Resend ${resp.status}: ${data.message || JSON.stringify(data)}`);
  return data;
}

export default async function handler(req, res){
  if(req.method !== 'POST'){
    return res.status(405).json({success: false, error: 'Method not allowed'});
  }

  try{
    const body = req.body || {};
    const type = clean(body.type || body.feedbackType || 'Feedback');
    const message = clean(body.message);
    const email = clean(body.email);
    const currentPage = clean(body.currentPage);
    const timestamp = clean(body.timestamp || new Date().toISOString());

    if(!message){
      return res.status(400).json({success: false, error: 'Feedback message is required'});
    }

    const payload = {type, message, email, currentPage, timestamp};
    console.log('House Accounts feedback submission:', payload);

    await sendFeedbackEmail(payload);

    return res.status(200).json({success: true});
  }catch(error){
    console.error('Feedback submission error:', error);
    return res.status(500).json({success: false, error: 'Feedback submission failed'});
  }
}
