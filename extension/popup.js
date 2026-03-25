/**
 * Popup UI logic for Ebill Auto-Filler
 * Handles file selection, drag-and-drop, parsing (CSV/XLSX), and preview display.
 */

let parsedData = null;

document.addEventListener('DOMContentLoaded', () => {
  const fileInput       = document.getElementById('file-input');
  const fileNameDisplay = document.getElementById('file-name');
  const dropZone        = document.getElementById('drop-zone');
  const parseBtn        = document.getElementById('parse-btn');
  const statusSection   = document.getElementById('status-section');
  const statusMessage   = document.getElementById('status-message');
  const previewSection  = document.getElementById('preview-section');
  const summary         = document.getElementById('summary');
  const entriesList     = document.getElementById('entries-list');
  const validationErrors = document.getElementById('validation-errors');
  const fillBtn         = document.getElementById('fill-btn');

  /* ── File selection via input ── */
  fileInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file) handleFileSelected(file);
  });

  /* ── Drag-and-drop ── */
  dropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropZone.classList.add('drag-over');
  });

  dropZone.addEventListener('dragleave', (e) => {
    // Only remove if leaving the zone entirely (not a child element)
    if (!dropZone.contains(e.relatedTarget)) {
      dropZone.classList.remove('drag-over');
    }
  });

  dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropZone.classList.remove('drag-over');
    const file = e.dataTransfer.files[0];
    if (file) handleFileSelected(file);
  });

  function handleFileSelected(file) {
    fileNameDisplay.textContent = file.name;
    fileNameDisplay.classList.add('selected');
    parseBtn.disabled = false;
    // Reset previous results
    statusSection.classList.add('hidden');
    previewSection.classList.add('hidden');
    parsedData = null;
    // Store for parse button
    parseBtn._pendingFile = file;
  }

  /* ── Parse button ── */
  parseBtn.addEventListener('click', async () => {
    const file = parseBtn._pendingFile;
    if (!file) return;

    parseBtn.disabled = true;
    parseBtn.textContent = 'Parsing…';

    try {
      const ext = file.name.split('.').pop().toLowerCase();
      let input;

      if (ext === 'xlsx') {
        // Read as binary and parse with XLSXReader
        const ab = await readFileAsArrayBuffer(file);
        input = await XLSXReader.read(ab); // returns 2-D array
      } else {
        // CSV, TSV, TXT — read as text
        input = await readFileAsText(file);
      }

      parsedData = window.BillingParser.processBillingFile(input);

      if (parsedData.success) {
        showSuccess(parsedData);
      } else {
        showError(parsedData.errors);
      }
    } catch (e) {
      showError([`Failed to read/parse file: ${e.message}`]);
    } finally {
      parseBtn.disabled = false;
      parseBtn.textContent = 'Parse File';
    }
  });

  /* ── Fill button ── */
  fillBtn.addEventListener('click', async () => {
    if (!parsedData || !parsedData.success) return;

    try {
      await chrome.storage.local.set({ billingData: parsedData });

      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });

      if (!tab || !tab.url || !tab.url.includes('ebill.publiccounsel.net')) {
        showStatus('Please navigate to ebill.publiccounsel.net first, then click Fill again.', 'info');
        return;
      }

      chrome.tabs.sendMessage(tab.id, { action: 'fillForm', data: parsedData }, (response) => {
        if (chrome.runtime.lastError) {
          showStatus('Could not connect to page — try refreshing ebill and clicking Fill again.', 'error');
        } else if (response && response.success) {
          showStatus('Form filled! Please review the entries before submitting.', 'success');
        } else {
          showStatus(response?.error || 'Failed to fill form', 'error');
        }
      });
    } catch (e) {
      showStatus(`Error: ${e.message}`, 'error');
    }
  });

  /* ── File readers ── */
  function readFileAsText(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload  = (e) => resolve(e.target.result);
      reader.onerror = () => reject(new Error('Failed to read file'));
      reader.readAsText(file);
    });
  }

  function readFileAsArrayBuffer(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload  = (e) => resolve(e.target.result);
      reader.onerror = () => reject(new Error('Failed to read file'));
      reader.readAsArrayBuffer(file);
    });
  }

  /* ── Display functions ── */

  function showSuccess(data) {
    statusSection.classList.remove('hidden');
    statusMessage.className = 'success';
    statusMessage.textContent =
      `Successfully parsed ${data.summary.originalEntries} entries → ${data.summary.aggregatedEntries} combined`;

    // Summary stats
    summary.innerHTML = `
      <div class="stat"><span>Original entries:</span><span>${data.summary.originalEntries}</span></div>
      <div class="stat"><span>After combining:</span><span>${data.summary.aggregatedEntries}</span></div>
      <div class="stat"><span>Clients:</span><span>${data.summary.clientCount}</span></div>
      <div class="stat total"><span>Total Hours:</span><span>${data.summary.totalHours} hrs</span></div>
    `;

    // Entries grouped by client
    entriesList.innerHTML = '';
    for (const [client, group] of Object.entries(data.groups)) {
      const groupEl = document.createElement('div');
      groupEl.className = 'client-group';

      const headerEl = document.createElement('div');
      headerEl.className = 'client-header';
      headerEl.innerHTML = `
        <span class="client-name">${escapeHtml(group.contact)}</span>
        <span class="client-hours">${group.totalHours} hrs</span>
      `;
      groupEl.appendChild(headerEl);

      group.entries.forEach(entry => {
        const entryEl = document.createElement('div');
        entryEl.className = 'entry-item';

        let travelHtml = '';
        if (entry.travelInfos && entry.travelInfos.length > 0) {
          const travels = entry.travelInfos
            .filter(t => t)
            .map(t => {
              const parts = [];
              if (t.fromCity) parts.push(`${escapeHtml(t.fromCity)} → ${escapeHtml(t.toCity || '?')}`);
              if (t.reason) parts.push(`<em>${escapeHtml(t.reason)}</em>`);
              return parts.join(', ');
            })
            .filter(Boolean);
          if (travels.length) {
            travelHtml = `<div class="travel-detail">✈ ${travels.join(' | ')}</div>`;
          }
        }

        entryEl.innerHTML = `
          <span class="entry-date">${entry.date}</span>
          <span class="entry-hours">${entry.hours} hrs</span>
          <br>
          <span class="entry-category">${escapeHtml(entry.categoryDisplay)}</span>
          ${travelHtml}
        `;
        groupEl.appendChild(entryEl);
      });

      entriesList.appendChild(groupEl);
    }

    // Warnings
    if (data.warnings && data.warnings.length > 0) {
      validationErrors.classList.remove('hidden');
      validationErrors.innerHTML = `
        <h3>Warnings (${data.warnings.length})</h3>
        <ul>${data.warnings.map(w => `<li>${escapeHtml(w)}</li>`).join('')}</ul>
      `;
    } else {
      validationErrors.classList.add('hidden');
    }

    previewSection.classList.remove('hidden');
  }

  function showError(errors) {
    statusSection.classList.remove('hidden');
    statusMessage.className = 'error';
    statusMessage.innerHTML = `
      <strong>Parse errors:</strong>
      <ul style="margin-top:8px;margin-left:16px">
        ${errors.map(e => `<li>${escapeHtml(e)}</li>`).join('')}
      </ul>
    `;
    previewSection.classList.add('hidden');
  }

  function showStatus(message, type) {
    statusSection.classList.remove('hidden');
    statusMessage.className = type;
    statusMessage.textContent = message;
  }

  function escapeHtml(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
});
