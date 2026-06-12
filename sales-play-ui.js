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
        <button class="btn btn-secondary" id="copy-email-btn">Copy Email</button>
        <button class="btn btn-secondary" id="copy-script-btn">Copy Call Script</button>
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

  // Copy buttons
  modal.querySelector('#copy-email-btn').addEventListener('click', () => {
    const emailText = modal.querySelector('.sales-play-email-body')?.innerText;
    if (emailText) copyToClipboard(emailText);
  });

  modal.querySelector('#copy-script-btn').addEventListener('click', () => {
    const scriptText = modal.querySelector('.sales-play-call-script')?.innerText;
    if (scriptText) copyToClipboard(scriptText);
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
        <div class="section-content subject-line">${escapeHtml(play.subjectLine)}</div>
      </div>

      <!-- Outreach Email -->
      <div class="sales-play-section">
        <h3 class="section-title">📨 Outreach Email</h3>
        <div class="section-content sales-play-email-body">${escapeHtml(play.email).replace(/\n/g, '<br>')}</div>
      </div>

      <!-- Call Script -->
      <div class="sales-play-section">
        <h3 class="section-title">☎️ Call Script</h3>
        <div class="section-content sales-play-call-script">
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
        <div class="section-content">
          <ul class="discovery-list">
            ${play.discoveryQuestions.map(q => `<li>${escapeHtml(q)}</li>`).join('')}
          </ul>
        </div>
      </div>

      <!-- Suggested Next Step -->
      <div class="sales-play-section">
        <h3 class="section-title">🎯 Suggested Next Step</h3>
        <div class="section-content next-step">${escapeHtml(play.suggestedNextStep)}</div>
      </div>

      <div class="sales-play-meta">
        <small>Generated with <strong>${SALES_STYLES[play.style].name}</strong> style · ${play.generatedAt}</small>
      </div>
    </div>
  `;
}

function copyToClipboard(text) {
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
