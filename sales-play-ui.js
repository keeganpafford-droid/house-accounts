/**
 * Sales Play Generator UI
 * Handles the modal, style selector, and rendering of generated plays
 */

function createSalesPlayPanel(opportunity) {
  // Create a modal overlay
  const modal = document.createElement('div');
  modal.className = 'sales-play-modal';
  modal.id = `sales-play-modal-${Date.now()}`;

  const account = opportunity.account || 'Account';
  const oppName = opportunity.opportunity || 'Opportunity';

  modal.innerHTML = `
    <div class="sales-play-modal-content">
      <div class="sales-play-header">
        <div>
          <h2>Sales Play Generator</h2>
          <p class="sales-play-subheader">${account} · ${oppName}</p>
        </div>
        <button class="sales-play-close" aria-label="Close">&times;</button>
      </div>

      <div class="sales-play-style-selector">
        <label for="style-select">Sales Style:</label>
        <div class="style-buttons">
          ${Object.entries(SALES_STYLES).map(([key, style]) => `
            <button class="style-btn ${key === 'consultative' ? 'active' : ''}" data-style="${key}" title="${style.description}">
              ${style.name}
            </button>
          `).join('')}
        </div>
        <div class="style-description" id="style-desc">${SALES_STYLES.consultative.description}</div>
      </div>

      <div class="sales-play-output" id="sales-play-output">
        <!-- Dynamically populated -->
      </div>

      <div class="sales-play-actions">
        <button class="btn btn-secondary" id="copy-all-btn" style="background:var(--signal);">Copy All</button>
        <button class="btn btn-secondary" id="copy-email-btn">Copy Email</button>
        <button class="btn btn-secondary" id="copy-script-btn">Copy Script</button>
        <button class="btn btn-ghost" id="close-play-btn">Close</button>
      </div>
    </div>
  `;

  // Style buttons click handler
  const styleButtons = modal.querySelectorAll('.style-btn');
  styleButtons.forEach(btn => {
    btn.addEventListener('click', (e) => {
      styleButtons.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      
      const selectedStyle = btn.dataset.style;
      const desc = modal.querySelector('#style-desc');
      desc.textContent = SALES_STYLES[selectedStyle].description;
      
      // Regenerate play with new style
      const play = generateSalesPlay(opportunity, selectedStyle);
      renderSalesPlay(play, modal);
    });
  });

  // Close button
  modal.querySelector('.sales-play-close').addEventListener('click', () => modal.remove());
  modal.querySelector('#close-play-btn').addEventListener('click', () => modal.remove());

  // Copy All button
  modal.querySelector('#copy-all-btn').addEventListener('click', () => {
    const play = getCurrentPlayFromModal(modal);
    const allText = formatAllForClipboard(play);
    copyToClipboard(allText, 'Copy All');
  });

  // Copy Email button
  modal.querySelector('#copy-email-btn').addEventListener('click', () => {
    const emailText = modal.querySelector('.sales-play-email-body')?.innerText;
    if (emailText) copyToClipboard(emailText, 'Copy Email');
  });

  // Copy Script button
  modal.querySelector('#copy-script-btn').addEventListener('click', () => {
    const scriptText = modal.querySelector('.sales-play-call-script')?.innerText;
    if (scriptText) copyToClipboard(scriptText, 'Copy Script');
  });

  document.body.appendChild(modal);

  // Generate initial play
  const initialPlay = generateSalesPlay(opportunity, 'consultative');
  renderSalesPlay(initialPlay, modal);
}

function renderSalesPlay(play, modal) {
  const output = modal.querySelector('#sales-play-output');
  
  output.innerHTML = `
    <div class="sales-play-sections">
      <!-- Subject Line -->
      <div class="sales-play-section">
        <h3 class="section-title">📧 Subject Line</h3>
        <div class="section-content subject-line" data-play-field="subjectLine">${escapeHtml(play.subjectLine)}</div>
      </div>

      <!-- Outreach Email -->
      <div class="sales-play-section">
        <h3 class="section-title">📨 Outreach Email</h3>
        <div class="section-content sales-play-email-body" data-play-field="email">${escapeHtml(play.email).replace(/\n/g, '<br>')}</div>
      </div>

      <!-- Call Script -->
      <div class="sales-play-section">
        <h3 class="section-title">☎️ Call Script</h3>
        <div class="section-content sales-play-call-script" data-play-field="callScript">
          ${play.callScript.map(part => `
            <div class="script-section">
              <div class="script-label">${part.section}</div>
              <div class="script-text">${escapeHtml(part.text)}</div>
            </div>
          `).join('')}
        </div>
      </div>

      <!-- Discovery Questions -->
      <div class="sales-play-section">
        <h3 class="section-title">❓ Discovery Questions</h3>
        <div class="section-content" data-play-field="discoveryQuestions">
          <ul class="discovery-list">
            ${play.discoveryQuestions.map(q => `<li>${escapeHtml(q)}</li>`).join('')}
          </ul>
        </div>
      </div>

      <!-- Suggested Next Step -->
      <div class="sales-play-section">
        <h3 class="section-title">🎯 Suggested Next Step</h3>
        <div class="section-content next-step" data-play-field="nextStep">${escapeHtml(play.suggestedNextStep)}</div>
      </div>

      <div class="sales-play-meta">
        <small>Generated with <strong>${SALES_STYLES[play.style].name}</strong> style · ${play.generatedAt}</small>
      </div>
    </div>
  `;

  // Store play data in modal for Copy All
  modal.dataset.currentPlay = JSON.stringify(play);
}

function getCurrentPlayFromModal(modal) {
  try {
    return JSON.parse(modal.dataset.currentPlay);
  } catch (e) {
    return null;
  }
}

function formatAllForClipboard(play) {
  if (!play) return '';

  const lines = [
    '═══════════════════════════════════════════════════════════════',
    'SALES PLAY: ' + play.account + ' · ' + play.opportunity,
    'STYLE: ' + SALES_STYLES[play.style].name.toUpperCase(),
    '═══════════════════════════════════════════════════════════════',
    '',
    '─────────────────────────────────────────────────────────────',
    'SUBJECT LINE',
    '─────────────────────────────────────────────────────────────',
    play.subjectLine,
    '',
    '─────────────────────────────────────────────────────────────',
    'OUTREACH EMAIL',
    '─────────────────────────────────────────────────────────────',
    play.email,
    '',
    '─────────────────────────────────────────────────────────────',
    'CALL SCRIPT',
    '─────────────────────────────────────────────────────────────'
  ];

  // Add call script sections
  play.callScript.forEach(section => {
    lines.push('');
    lines.push('[' + section.section + ']');
    lines.push(section.text);
  });

  lines.push('');
  lines.push('─────────────────────────────────────────────────────────────');
  lines.push('DISCOVERY QUESTIONS');
  lines.push('─────────────────────────────────────────────────────────────');
  lines.push('');

  // Add questions
  play.discoveryQuestions.forEach((q, idx) => {
    lines.push((idx + 1) + '. ' + q);
  });

  lines.push('');
  lines.push('─────────────────────────────────────────────────────────────');
  lines.push('SUGGESTED NEXT STEP');
  lines.push('─────────────────────────────────────────────────────────────');
  lines.push(play.suggestedNextStep);
  lines.push('');
  lines.push('═══════════════════════════════════════════════════════════════');
  lines.push('Generated: ' + play.generatedAt);
  lines.push('═══════════════════════════════════════════════════════════════');

  return lines.join('\n');
}

function copyToClipboard(text, label = 'Copy') {
  navigator.clipboard.writeText(text).then(() => {
    const btn = event.target;
    const originalText = btn.textContent;
    btn.textContent = 'Copied!';
    setTimeout(() => {
      btn.textContent = originalText;
    }, 2000);
  }).catch(err => {
    console.error('Failed to copy:', err);
    alert('Could not copy to clipboard');
  });
}

function escapeHtml(text) {
  const map = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;'
  };
  return text.replace(/[&<>"']/g, m => map[m]);
}
