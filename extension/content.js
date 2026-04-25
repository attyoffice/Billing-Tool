/**
 * Content script for ebill.publiccounsel.net
 *
 * Two-phase workflow:
 *  Phase 1 – Work In Progress (WIP) grid page
 *    Receives fillForm message → finds client row → clicks Edit.
 *    Stores a queue in chrome.storage so the form page picks it up.
 *
 *  Phase 2 – Client ebill form page
 *    On page load: checks storage for pending queue → fills entries for
 *    the current client → shows progress overlay.
 *    Also accepts a direct fillForm message when the user is already on
 *    the form page.
 */

// Activity code → column index in the ebill time-entry table (1-based after date column)
const CATEGORY_COLUMN_MAP = {
  'emergency_hearing':   1,
  'pre_tri_hrg_conf':    2,
  'trial_hearing':       3,
  'dispo_proceedings':   4,
  'dft_pleadings_cor':   5,
  'hrg_tri_prep_disco':  6,
  'court_waiting_time':  7,
  'in_prsn_clt_contact': 8,
  'negot_case_conf':     9,
  'legal_research':      10,
  'investigation':       11,
  'travel':              12,
  'other_clt_contact':   13,
};

const TRAVEL_REASONS = ['Court', 'Investigation', 'Research', 'Client Visit'];

const US_STATES = [
  'AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA',
  'HI','ID','IL','IN','IA','KS','KY','LA','ME','MD',
  'MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ',
  'NM','NY','NC','ND','OH','OK','OR','PA','RI','SC',
  'SD','TN','TX','UT','VT','VA','WA','WV','WI','WY','DC',
];

/* ── Page detection ────────────────────────────────────────────────── */

function isOnWIPGridPage() {
  // Match the WIP grid page by the RadGrid1 element OR the UpdatePanel2 wrapper,
  // even if td.rgSorted cells haven't rendered yet (Telerik loads async).
  return !!(document.getElementById('RadGrid1') || document.getElementById('UpdatePanel2'));
}

function isOnFormPage() {
  return !!document.getElementById('ebill-page');
}

/** Read client name from the read-only fields at the top of the form page. */
function getFormPageClientName() {
  const last  = document.getElementById('txtCliLast');
  const first = document.getElementById('txtCliFirst');
  if (!last || !first) return null;
  const name = `${first.value.trim()} ${last.value.trim()}`.trim();
  return name || null;
}

/* ── Client name matching ──────────────────────────────────────────── */

/**
 * Normalise a name for comparison: uppercase, strip commas, sort words.
 * "RESENDEZ, PAIGE" and "Paige Resendez" both become "PAIGE RESENDEZ".
 */
function normalizeNameWords(name) {
  return name.toUpperCase().replace(/,/g, ' ').split(/\s+/).filter(Boolean).sort().join(' ');
}

function namesMatch(a, b) {
  return !!(a && b) && normalizeNameWords(a) === normalizeNameWords(b);
}

/* ── WIP grid helpers ──────────────────────────────────────────────── */

/** Find the Edit button for a given client name in the WIP grid. */
function findClientEditButton(clientName) {
  // td.rgSorted holds the client name; search all table rows that have one
  const nameCells = document.querySelectorAll('td.rgSorted');
  for (const nameCell of nameCells) {
    if (namesMatch(nameCell.textContent.trim(), clientName)) {
      const row = nameCell.closest('tr');
      if (!row) continue;
      const btn = row.querySelector('input[value="Edit"]');
      if (btn) return btn;
    }
  }
  return null;
}

/* ── Storage helpers ───────────────────────────────────────────────── */

async function getFillState() {
  const { ebillFillState } = await chrome.storage.local.get('ebillFillState');
  return ebillFillState || null;
}

async function setFillState(state) {
  if (state) await chrome.storage.local.set({ ebillFillState: state });
  else        await chrome.storage.local.remove('ebillFillState');
}

/* ── Filter parsed data for one client ────────────────────────────── */

function dataForClient(parsedData, clientName) {
  const groups = {};
  for (const [key, group] of Object.entries(parsedData.groups)) {
    if (namesMatch(group.contact, clientName)) groups[key] = group;
  }
  return { ...parsedData, groups };
}

/* ── Message listener ──────────────────────────────────────────────── */

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'fillForm') {
    handleFill(request.data)
      .then(() => sendResponse({ success: true }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true; // keep channel open for async response
  }
});

async function handleFill(parsedData) {
  if (isOnWIPGridPage()) {
    const clients = Object.keys(parsedData.groups);
    if (!clients.length) throw new Error('No clients in parsed data');
    await setFillState({ parsedData, queue: clients });
    await processWIPQueue();

  } else if (isOnFormPage()) {
    const name     = getFormPageClientName();
    const filtered = name ? dataForClient(parsedData, name) : parsedData;
    if (!Object.keys(filtered.groups).length) {
      throw new Error(
        name
          ? `No entries for "${name}" in parsed data — check the client name matches the billing file.`
          : 'Cannot read client name from this page.'
      );
    }
    await fillEbillForm(filtered);

  } else {
    throw new Error(
      'Navigate to ebill.publiccounsel.net first — either the Work In Progress list or a client\'s form page.'
    );
  }
}

/* ── WIP grid phase ────────────────────────────────────────────────── */

async function processWIPQueue() {
  const state = await getFillState();
  if (!state || !state.queue.length) { await setFillState(null); return; }

  const next = state.queue[0];
  const btn  = findClientEditButton(next);

  if (!btn) {
    // Client not found in WIP grid — skip and try the next one
    showProgressOverlay(state.queue.length);
    updateProgress(0, state.queue.length, `"${next}" not found in WIP grid — skipping`);
    await setFillState({ ...state, queue: state.queue.slice(1) });
    await delay(1200);
    await processWIPQueue();
    return;
  }

  showProgressOverlay(state.queue.length);
  updateProgress(0, state.queue.length, `Opening form for ${next}…`);
  await delay(300);
  // Use native .click() — dispatchEvent with a synthetic MouseEvent does not
  // reliably trigger ASP.NET form submission; native .click() always does.
  btn.click();
  // The page now navigates to the client form.
  // init() on the form page will pick up from storage automatically.
}

/* ── Form page phase ───────────────────────────────────────────────── */

/** Called from the init IIFE when the form page loads with pending state. */
async function resumeOnFormPage(state) {
  const name = getFormPageClientName();
  if (!name) return;

  // Find this client in the pending queue
  const matchIdx = state.queue.findIndex(c => namesMatch(c, name));
  if (matchIdx < 0) return; // not our client

  // Remove from queue before filling (so navigating back won't re-fill)
  const newQueue = state.queue.filter((_, i) => i !== matchIdx);
  await setFillState(newQueue.length ? { ...state, queue: newQueue } : null);

  const filtered = dataForClient(state.parsedData, name);
  await fillEbillForm(filtered);

  if (newQueue.length > 0) {
    updateProgress(
      state.queue.length - newQueue.length,
      state.queue.length,
      `Done with ${name}. Navigate back to WIP list to continue (${newQueue.length} remaining).`
    );
  }
}

/* ── Auto-resume on page load ──────────────────────────────────────── */

(async function init() {
  await delay(600); // let Telerik controls finish rendering
  const state = await getFillState();
  if (!state) return;

  if (isOnFormPage()) {
    await resumeOnFormPage(state);
  } else if (isOnWIPGridPage() && state.queue && state.queue.length) {
    // User navigated back to WIP — continue with next client in queue
    await delay(400);
    await processWIPQueue();
  }
})();

/* ── Main fill orchestration ───────────────────────────────────────── */

async function fillEbillForm(parsedData) {
  const allEntries = Object.values(parsedData.groups).flatMap(g => g.entries);
  if (!allEntries.length) throw new Error('No entries to fill');

  const byDate = {};
  allEntries.forEach(entry => {
    if (!byDate[entry.date]) byDate[entry.date] = [];
    byDate[entry.date].push(entry);
  });

  const dates = Object.keys(byDate).sort();
  showProgressOverlay(allEntries.length);

  let done = 0;
  for (const date of dates) {
    const dayEntries     = byDate[date];
    const regularEntries = dayEntries.filter(e => e.category !== 'travel');
    const travelEntries  = dayEntries.filter(e => e.category === 'travel');

    for (const entry of regularEntries) {
      updateProgress(++done, allEntries.length, `Filling ${entry.date} — ${entry.categoryDisplay}`);
      await fillTimeEntry(entry);
      await delay(600);
    }

    if (travelEntries.length > 0) {
      for (const entry of travelEntries) {
        updateProgress(++done, allEntries.length, `Filling travel — ${entry.date}`);
        await fillTimeEntry(entry);
        await delay(800);
        await fillTravelSection(entry);
        await delay(600);
      }
    }
  }

  updateProgress(allEntries.length, allEntries.length, 'Complete! Please review all entries.');
  setTimeout(hideProgressOverlay, 3000);
}

/* ── Time entry row ─────────────────────────────────────────────────── */

async function fillTimeEntry(entry) {
  // Prefer the <a> link that fires __doPostBack (AJAX, no full page reload)
  const addLink = document.querySelector('a[title="Add new record"]') || findAddButton();
  if (!addLink) throw new Error('Cannot find "Add new record" button');

  clickElement(addLink);

  // Poll for the edit row — AJAX can take > 400ms on slower connections
  const row = await waitForEditRow(3000);
  if (!row) throw new Error('Edit row did not appear after clicking Add new record');

  // Set the date using Telerik's client API first, with a DOM fallback
  await setTelerikDate(row, entry.date);
  await delay(200);

  // Fill hours using the specific udbCatN classes on this form
  fillHoursInRow(row, entry);
  await delay(150);

  // Click Save — the button has class time-entry-insert on this form
  const saveBtn = row.querySelector('input.time-entry-insert') ||
                  row.querySelector('input[value="Save"]') ||
                  findSaveButton();
  if (saveBtn) {
    clickElement(saveBtn);
    await delay(1000); // wait for AJAX save postback
  }

  dismissDialog();
}

/** Poll for tr.rgEditRow to appear in the DOM (Telerik renders it via AJAX). */
async function waitForEditRow(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const row = document.querySelector('tr.rgEditRow');
    if (row) return row;
    await delay(150);
  }
  return null;
}

/**
 * Set the Telerik RadDatePicker value for the Date of Service field.
 * Tries the Telerik $find() client API first; falls back to typing into
 * the visible input and triggering Telerik's blur/change handler.
 */
async function setTelerikDate(row, dateStr) {
  // The visible text input has class riTextBox inside a .time-entry-dos wrapper
  const dateInput = row.querySelector('.time-entry-dos input.riTextBox') ||
                    row.querySelector('input[id*="dosTextBox_dateInput"]');
  if (!dateInput) return;

  // Method 1: Telerik client API ($find is Telerik's Sys.Application.findComponent)
  const pickerId = dateInput.id.replace(/_dateInput$/, '');
  if (typeof $find === 'function') {
    try {
      const picker = $find(pickerId);
      if (picker && typeof picker.set_selectedDate === 'function') {
        const [m, d, y] = dateStr.split('/').map(Number);
        picker.set_selectedDate(new Date(y, m - 1, d));
        return;
      }
    } catch (_) { /* fall through to Method 2 */ }
  }

  // Method 2: Set the visible input value and fire Telerik's blur handler
  dateInput.focus();
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
  if (setter) setter.set.call(dateInput, dateStr);
  else dateInput.value = dateStr;
  dateInput.dispatchEvent(new Event('input',  { bubbles: true }));
  dateInput.dispatchEvent(new Event('change', { bubbles: true }));
  dateInput.dispatchEvent(new Event('blur',   { bubbles: false })); // blur doesn't bubble
  dateInput.blur();
}

function fillHoursInRow(row, entry) {
  const colIdx = CATEGORY_COLUMN_MAP[entry.category];
  if (!colIdx || colIdx === 12) return; // 12 = travel, handled by fillTravelSection

  // Primary: the form uses time-entry-udb-catN classes on each input
  const catInput = row.querySelector(`.time-entry-udb-cat${colIdx}`);
  if (catInput) {
    setInputValue(catInput, String(entry.hours));
    return;
  }

  // Fallback: positional (allInputs[0]=date, allInputs[1]=cat1, …)
  const allInputs = Array.from(row.querySelectorAll('input:not([type="hidden"])'))
    .filter(isVisible);
  if (allInputs.length > colIdx) {
    setInputValue(allInputs[colIdx], String(entry.hours));
  }
}

/* ── Travel section ─────────────────────────────────────────────────── */

async function fillTravelSection(entry) {
  const travelBtn = findButtonByText('Travel');
  if (!travelBtn) {
    console.warn('Ebill Auto-Filler: Travel button not found');
    return;
  }
  clickElement(travelBtn);
  await delay(600);

  const segments = (entry.travelInfos || []).filter(Boolean);
  if (segments.length === 0) {
    await addTravelRecord(entry, { reason: null, fromCity: null, toCity: null });
  } else {
    for (const seg of segments) {
      await addTravelRecord(entry, seg);
      await delay(400);
    }
  }

  const closeBtn = findButtonByText('Close Form') || findButtonByText('Close');
  if (closeBtn) {
    clickElement(closeBtn);
    await delay(400);
  }

  dismissDialog();
}

async function addTravelRecord(entry, seg) {
  const addBtn = findAddButton();
  if (!addBtn) return;
  clickElement(addBtn);
  await delay(400);

  if (seg.reason) {
    const reasonSelect = findSelectByLabel('reason') || findSelectByPosition(0);
    if (reasonSelect) {
      setSelectValue(reasonSelect, seg.reason);
      await delay(200);
    }
  }

  if (seg.fromCity) {
    await selectCity('from', seg.fromCity);
    await delay(200);
  }

  if (seg.toCity) {
    await selectCity('to', seg.toCity);
    await delay(200);
  }

  const isRoundTrip = seg.isRoundTrip ||
    (entry.description && /\bRT\b|round\s*trip/i.test(entry.description));
  if (isRoundTrip) {
    const rtCheck = findCheckboxByLabel('round') || document.querySelector('input[type="checkbox"]');
    if (rtCheck && !rtCheck.checked) {
      clickElement(rtCheck);
      await delay(1500);
    }
  }

  const timeInput = findInputByLabel('time') ||
    document.querySelector('input[name*="time"], input[name*="Time"], input[id*="time"]');
  if (timeInput) {
    setInputValue(timeInput, String(entry.hours));
    await delay(200);
  }

  const saveBtn = findSaveButton();
  if (saveBtn) {
    clickElement(saveBtn);
    await delay(600);
  }

  dismissDialog();
}

async function selectCity(fromOrTo, cityName) {
  const labelText = fromOrTo === 'from' ? 'from' : 'to';
  const citySelect = findSelectByLabel(labelText) || findSelectByPosition(fromOrTo === 'from' ? 1 : 2);
  if (!citySelect) return;

  const directOption = findOptionContaining(citySelect, cityName);
  if (directOption) {
    setSelectValue(citySelect, directOption.value);
    return;
  }

  const outOfStateOption = findOptionContaining(citySelect, 'out of state') ||
    findOptionContaining(citySelect, 'other');
  if (outOfStateOption) {
    setSelectValue(citySelect, outOfStateOption.value);
    await delay(300);

    const cityInput = document.querySelector('input[name*="city"], input[id*="city"], input[placeholder*="city" i]');
    if (cityInput) {
      setInputValue(cityInput, cityName);
      await delay(150);
    }

    const stateMatch = cityName.match(/,\s*([A-Z]{2})$/);
    if (stateMatch && US_STATES.includes(stateMatch[1])) {
      const stateSelect = document.querySelector('select[name*="state"], select[id*="state"]');
      if (stateSelect) {
        setSelectValue(stateSelect, stateMatch[1]);
        await delay(150);
      }
    }
  }
}

/* ── DOM helpers ─────────────────────────────────────────────────────── */

function findAddButton() {
  const all = document.querySelectorAll('button, input[type="button"], input[type="submit"], a, [role="button"]');
  for (const el of all) {
    const text = (el.textContent || el.value || '').toLowerCase().trim();
    if (text.includes('add') && (text.includes('record') || text.includes('new') || text === 'add')) {
      return el;
    }
    if (el.title && el.title.toLowerCase().includes('add')) return el;
  }
  return null;
}

function findButtonByText(label) {
  const lower = label.toLowerCase();
  const all = document.querySelectorAll('button, input[type="button"], input[type="submit"], a, [role="button"]');
  for (const el of all) {
    const text = (el.textContent || el.value || '').toLowerCase().trim();
    if (text.includes(lower)) return el;
  }
  return null;
}

function findSaveButton() {
  return findButtonByText('save');
}

function findEditableRow() {
  // Telerik RadGrid marks the insert/edit row with rgEditRow
  return document.querySelector('tr.rgEditRow') || (() => {
    // Fallback: last tr with multiple visible inputs
    const rows = document.querySelectorAll('tr');
    for (let i = rows.length - 1; i >= 0; i--) {
      const inputs = Array.from(rows[i].querySelectorAll('input:not([type="hidden"])')).filter(isVisible);
      if (inputs.length > 1) return rows[i];
    }
    return null;
  })();
}

function findDateInputInRow(row) {
  // Specific to this form: date input is .riTextBox inside .time-entry-dos
  const specific = row.querySelector('.time-entry-dos input.riTextBox') ||
                   row.querySelector('input[id*="dosTextBox_dateInput"]');
  if (specific && isVisible(specific)) return specific;
  // Generic fallback
  let input = row.querySelector('input[name*="date" i], input[id*="date" i]');
  if (input && isVisible(input)) return input;
  const inputs = Array.from(row.querySelectorAll('input[type="text"], input:not([type])')).filter(isVisible);
  return inputs[0] || null;
}

function findInputByCategory(row, category) {
  const keywords = {
    'emergency_hearing':   ['emergency', 'emerg'],
    'pre_tri_hrg_conf':    ['pre-tri', 'pretri', 'pre tri', 'conf'],
    'trial_hearing':       ['trial', 'hearing'],
    'dispo_proceedings':   ['dispo', 'disposition'],
    'dft_pleadings_cor':   ['pleading', 'draft', 'correspondence'],
    'hrg_tri_prep_disco':  ['prep', 'discovery', 'disco'],
    'court_waiting_time':  ['waiting', 'court wait'],
    'in_prsn_clt_contact': ['in person', 'in prsn', 'client contact'],
    'negot_case_conf':     ['negot', 'case conf'],
    'legal_research':      ['research', 'legal res'],
    'investigation':       ['investigation', 'invest'],
    'travel':              ['travel'],
    'other_clt_contact':   ['other', 'other contact'],
  };

  const terms   = keywords[category] || [];
  const headers = document.querySelectorAll('th');

  for (let i = 0; i < headers.length; i++) {
    const headerText = headers[i].textContent.toLowerCase();
    if (terms.some(t => headerText.includes(t))) {
      const cells = row.querySelectorAll('td');
      if (cells[i]) {
        const inp = cells[i].querySelector('input');
        if (inp && isVisible(inp)) return inp;
      }
    }
  }
  return null;
}

function findSelectByLabel(labelFragment) {
  const frag   = labelFragment.toLowerCase();
  const labels = document.querySelectorAll('label');
  for (const lbl of labels) {
    if (lbl.textContent.toLowerCase().includes(frag)) {
      const sel = lbl.control || document.getElementById(lbl.htmlFor);
      if (sel && sel.tagName === 'SELECT') return sel;
    }
  }
  return document.querySelector(`select[name*="${frag}" i], select[id*="${frag}" i]`) || null;
}

function findSelectByPosition(idx) {
  const selects = Array.from(document.querySelectorAll('select')).filter(isVisible);
  return selects[idx] || null;
}

function findOptionContaining(select, text) {
  const lower = text.toLowerCase();
  for (const opt of select.options) {
    if (opt.text.toLowerCase().includes(lower) || opt.value.toLowerCase().includes(lower)) {
      return opt;
    }
  }
  return null;
}

function findCheckboxByLabel(labelFragment) {
  const frag   = labelFragment.toLowerCase();
  const labels = document.querySelectorAll('label');
  for (const lbl of labels) {
    if (lbl.textContent.toLowerCase().includes(frag)) {
      const input = lbl.control || document.getElementById(lbl.htmlFor);
      if (input && input.type === 'checkbox') return input;
    }
  }
  return document.querySelector(`input[type="checkbox"][name*="${frag}" i]`) || null;
}

function findInputByLabel(labelFragment) {
  const frag   = labelFragment.toLowerCase();
  const labels = document.querySelectorAll('label');
  for (const lbl of labels) {
    if (lbl.textContent.toLowerCase().includes(frag)) {
      const input = lbl.control || document.getElementById(lbl.htmlFor);
      if (input && input.tagName === 'INPUT') return input;
    }
  }
  return null;
}

function dismissDialog() {
  const btns = document.querySelectorAll('button, input[type="button"], input[type="submit"]');
  for (const btn of btns) {
    const text = (btn.textContent || btn.value || '').trim().toLowerCase();
    if (text === 'ok' || text === 'okay') {
      clickElement(btn);
      return;
    }
  }
}

function isVisible(el) {
  const s = window.getComputedStyle(el);
  return s.display !== 'none' && s.visibility !== 'hidden' && el.offsetParent !== null;
}

function clickElement(el) {
  const evt = new MouseEvent('click', { bubbles: true, cancelable: true, view: window });
  const notCancelled = el.dispatchEvent(evt);
  if (!notCancelled) el.click();
}

function setInputValue(input, value) {
  input.focus();
  const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
  if (nativeSetter) nativeSetter.set.call(input, value);
  else input.value = value;

  input.dispatchEvent(new Event('input',  { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
  input.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true }));
  input.blur();
}

function setSelectValue(select, value) {
  let found = false;
  for (const opt of select.options) {
    if (opt.value === value || opt.text === value ||
        opt.text.toLowerCase().includes(value.toLowerCase())) {
      select.value = opt.value;
      found = true;
      break;
    }
  }
  if (!found) return;
  select.dispatchEvent(new Event('change', { bubbles: true }));
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/* ── Progress overlay ────────────────────────────────────────────────── */

let overlayEl = null;

function showProgressOverlay(total) {
  if (overlayEl) overlayEl.remove();
  overlayEl = document.createElement('div');
  overlayEl.id = 'ebill-filler-overlay';
  overlayEl.innerHTML = `
    <div style="
      position: fixed; bottom: 20px; right: 20px;
      background: white; padding: 16px 20px;
      border-radius: 10px; box-shadow: 0 4px 24px rgba(0,0,0,0.18);
      z-index: 99999; min-width: 260px;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    ">
      <div style="font-weight:700; margin-bottom:6px; color:#1a365d; font-size:14px;">
        Ebill Auto-Filler
      </div>
      <div id="ebill-progress-text" style="color:#4a5568; font-size:13px;">Starting…</div>
      <div style="margin-top:8px; height:4px; background:#e2e8f0; border-radius:2px; overflow:hidden;">
        <div id="ebill-progress-bar"
          style="width:0%; height:100%; background:#3182ce; transition:width 0.3s;"></div>
      </div>
    </div>
  `;
  document.body.appendChild(overlayEl);
}

function updateProgress(current, total, message) {
  const txt = document.getElementById('ebill-progress-text');
  const bar = document.getElementById('ebill-progress-bar');
  if (txt) txt.textContent = message || `Processing ${current} of ${total}…`;
  if (bar) bar.style.width = `${total > 0 ? (current / total) * 100 : 0}%`;
}

function hideProgressOverlay() {
  if (overlayEl) { overlayEl.remove(); overlayEl = null; }
}

console.log('Ebill Auto-Filler v1.2 content script loaded');
