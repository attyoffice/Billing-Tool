/**
 * Content script for ebill.publiccounsel.net
 * Fills time entry forms from parsed billing data.
 *
 * Workflow per date entry:
 *  1. Click "Add new record"
 *  2. Fill date (M/D/YYYY) and hours for each activity item
 *  3. Click Save
 *  4. If any travel entries (item 12) exist for that date:
 *     a. Click the "Travel" button
 *     b. For each travel segment: Add new record → select Reason → From city → To city
 *        → Round trip checkbox → Time field → Save
 *     c. Click "Close Form"
 *     d. Dismiss any popup dialog ("OK")
 *  5. Repeat for next date
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

// US state abbreviations for detecting out-of-state cities
const US_STATES = [
  'AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA',
  'HI','ID','IL','IN','IA','KS','KY','LA','ME','MD',
  'MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ',
  'NM','NY','NC','ND','OH','OK','OR','PA','RI','SC',
  'SD','TN','TX','UT','VT','VA','WA','WV','WI','WY','DC',
];

/* ── Message listener ── */

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'fillForm') {
    fillEbillForm(request.data)
      .then(() => sendResponse({ success: true }))
      .catch(err  => sendResponse({ success: false, error: err.message }));
    return true; // keep channel open for async response
  }
});

/* ── Main orchestration ─────────────────────────────────────────── */

async function fillEbillForm(parsedData) {
  const allEntries = Object.values(parsedData.groups).flatMap(g => g.entries);
  if (!allEntries.length) throw new Error('No entries to fill');

  // Group by date so we can handle travel per-date after the time entry is saved
  const byDate = {};
  allEntries.forEach(entry => {
    if (!byDate[entry.date]) byDate[entry.date] = [];
    byDate[entry.date].push(entry);
  });

  const dates = Object.keys(byDate).sort();
  showProgressOverlay(allEntries.length);

  let done = 0;
  for (const date of dates) {
    const dayEntries = byDate[date];
    const regularEntries = dayEntries.filter(e => e.category !== 'travel');
    const travelEntries  = dayEntries.filter(e => e.category === 'travel');

    // ── Step 1: fill regular time entries for this date ──
    for (const entry of regularEntries) {
      updateProgress(++done, allEntries.length, `Filling ${entry.date} — ${entry.categoryDisplay}`);
      await fillTimeEntry(entry);
      await delay(600);
    }

    // ── Step 2: fill travel entries for this date ──
    if (travelEntries.length > 0) {
      for (const entry of travelEntries) {
        updateProgress(++done, allEntries.length, `Filling travel — ${entry.date}`);
        // Save the time entry first, then open travel section
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

/* ── Time entry row ─────────────────────────────────────────────── */

async function fillTimeEntry(entry) {
  const addBtn = findAddButton();
  if (!addBtn) throw new Error('Cannot find "Add new record" button');

  clickElement(addBtn);
  await delay(400);

  const row = findEditableRow();
  if (!row) throw new Error('No editable row appeared after clicking Add');

  // Fill date
  const dateInput = findDateInputInRow(row);
  if (dateInput) {
    setInputValue(dateInput, entry.date);
    await delay(150);
  }

  // Fill hours in the correct category column
  await fillHoursInRow(row, entry);
  await delay(200);

  // Save
  const saveBtn = findSaveButton();
  if (saveBtn) {
    clickElement(saveBtn);
    await delay(500);
  }

  // Dismiss any system dialog that might appear
  dismissDialog();
}

async function fillHoursInRow(row, entry) {
  const colIdx = CATEGORY_COLUMN_MAP[entry.category];

  // Strategy 1: use column index — skip the date cell (index 0) and find the Nth input
  const allInputs = Array.from(row.querySelectorAll('input:not([type="hidden"])'))
    .filter(inp => isVisible(inp));

  if (colIdx && allInputs.length > colIdx) {
    setInputValue(allInputs[colIdx], String(entry.hours));
    return;
  }

  // Strategy 2: match by column header keyword
  const input = findInputByCategory(row, entry.category);
  if (input) {
    setInputValue(input, String(entry.hours));
    return;
  }

  // Strategy 3: use second visible input as fallback
  if (allInputs.length > 1) {
    setInputValue(allInputs[1], String(entry.hours));
  }
}

/* ── Travel section ─────────────────────────────────────────────── */

async function fillTravelSection(entry) {
  // Click the "Travel" button on the page
  const travelBtn = findButtonByText('Travel');
  if (!travelBtn) {
    console.warn('Ebill Auto-Filler: Travel button not found');
    return;
  }
  clickElement(travelBtn);
  await delay(600);

  // Travel segments: each travelInfo object in the entry
  const segments = (entry.travelInfos || []).filter(Boolean);
  if (segments.length === 0) {
    // No structured info — add one generic travel record
    await addTravelRecord(entry, { reason: null, fromCity: null, toCity: null });
  } else {
    for (const seg of segments) {
      await addTravelRecord(entry, seg);
      await delay(400);
    }
  }

  // Close the travel form
  const closeBtn = findButtonByText('Close Form') || findButtonByText('Close');
  if (closeBtn) {
    clickElement(closeBtn);
    await delay(400);
  }

  // Dismiss any popup dialog
  dismissDialog();
}

async function addTravelRecord(entry, seg) {
  // Click "Add new record" inside the travel section
  const addBtn = findAddButton();
  if (!addBtn) return;
  clickElement(addBtn);
  await delay(400);

  // Reason dropdown
  if (seg.reason) {
    const reasonSelect = findSelectByLabel('reason') || findSelectByPosition(0);
    if (reasonSelect) {
      setSelectValue(reasonSelect, seg.reason);
      await delay(200);
    }
  }

  // From city
  if (seg.fromCity) {
    await selectCity('from', seg.fromCity);
    await delay(200);
  }

  // To city
  if (seg.toCity) {
    await selectCity('to', seg.toCity);
    await delay(200);
  }

  // Round trip — check if description mentions "round trip"
  const isRoundTrip = entry.description &&
    entry.description.toLowerCase().includes('round trip');
  if (isRoundTrip) {
    const rtCheck = findCheckboxByLabel('round') || document.querySelector('input[type="checkbox"]');
    if (rtCheck && !rtCheck.checked) {
      clickElement(rtCheck);
      await delay(1500); // site recalculates mileage after round-trip toggle
    }
  }

  // Time field (hours)
  const timeInput = findInputByLabel('time') ||
    document.querySelector('input[name*="time"], input[name*="Time"], input[id*="time"]');
  if (timeInput) {
    setInputValue(timeInput, String(entry.hours));
    await delay(200);
  }

  // Save
  const saveBtn = findSaveButton();
  if (saveBtn) {
    clickElement(saveBtn);
    await delay(600);
  }

  dismissDialog();
}

/**
 * Select a city in a From or To dropdown.
 * Handles in-state (dropdown only) and out-of-state (extra city + state dropdowns).
 */
async function selectCity(fromOrTo, cityName) {
  // Find the correct select by label proximity or name attribute
  const labelText = fromOrTo === 'from' ? 'from' : 'to';
  const citySelect = findSelectByLabel(labelText) || findSelectByPosition(fromOrTo === 'from' ? 1 : 2);
  if (!citySelect) return;

  // Try to find the city option directly in the dropdown
  const directOption = findOptionContaining(citySelect, cityName);
  if (directOption) {
    setSelectValue(citySelect, directOption.value);
    return;
  }

  // Not in dropdown — might be an out-of-state city; look for "Out of State" option
  const outOfStateOption = findOptionContaining(citySelect, 'out of state') ||
    findOptionContaining(citySelect, 'other');
  if (outOfStateOption) {
    setSelectValue(citySelect, outOfStateOption.value);
    await delay(300); // wait for extra fields to appear

    // Type city name in the free-text input
    const cityInput = document.querySelector('input[name*="city"], input[id*="city"], input[placeholder*="city" i]');
    if (cityInput) {
      setInputValue(cityInput, cityName);
      await delay(150);
    }

    // Select state — try to detect a state abbreviation in the city string
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

/* ── DOM helpers ─────────────────────────────────────────────────── */

function findAddButton() {
  const all = document.querySelectorAll('button, input[type="button"], input[type="submit"], a, [role="button"]');
  for (const el of all) {
    const text = (el.textContent || el.value || '').toLowerCase().trim();
    if (text.includes('add') && (text.includes('record') || text.includes('new') || text === 'add')) {
      return el;
    }
    // "+" icon button next to "add new record" text
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
  const rows = document.querySelectorAll('tr');
  // Prefer the last row with visible inputs (newly added row is typically last)
  for (let i = rows.length - 1; i >= 0; i--) {
    const inputs = Array.from(rows[i].querySelectorAll('input:not([type="hidden"])')).filter(isVisible);
    if (inputs.length > 1) return rows[i];
  }
  return null;
}

function findDateInputInRow(row) {
  // Try name/id attributes first
  let input = row.querySelector('input[name*="date" i], input[id*="date" i]');
  if (input && isVisible(input)) return input;
  // Fall back to first visible text input
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

  const terms = keywords[category] || [];
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
  const frag = labelFragment.toLowerCase();
  // Try label elements
  const labels = document.querySelectorAll('label');
  for (const lbl of labels) {
    if (lbl.textContent.toLowerCase().includes(frag)) {
      const sel = lbl.control || document.getElementById(lbl.htmlFor);
      if (sel && sel.tagName === 'SELECT') return sel;
    }
  }
  // Try name/id attributes
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
  const frag = labelFragment.toLowerCase();
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
  const frag = labelFragment.toLowerCase();
  const labels = document.querySelectorAll('label');
  for (const lbl of labels) {
    if (lbl.textContent.toLowerCase().includes(frag)) {
      const input = lbl.control || document.getElementById(lbl.htmlFor);
      if (input && input.tagName === 'INPUT') return input;
    }
  }
  return null;
}

/** Dismiss any open confirm/alert dialog by clicking an OK button */
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

/**
 * Click an element using Method 2 (full MouseEvent dispatch) — confirmed working
 * on ebill.publiccounsel.net. Falls back to native .click() if dispatch is cancelled.
 */
function clickElement(el) {
  const evt = new MouseEvent('click', {
    bubbles: true,
    cancelable: true,
    view: window,
  });
  const notCancelled = el.dispatchEvent(evt);
  // If the event was cancelled by the page (preventDefault), fall back to .click()
  if (!notCancelled) el.click();
}

/** Set an input value and fire the events that the page might listen for. */
function setInputValue(input, value) {
  input.focus();
  // Use native setter to bypass React/Vue value tracking
  const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
  if (nativeSetter) nativeSetter.set.call(input, value);
  else input.value = value;

  input.dispatchEvent(new Event('input',  { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
  input.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true }));
  input.blur();
}

/** Set a select value and fire change event. */
function setSelectValue(select, value) {
  // Try to match by value or text
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

/* ── Progress overlay ────────────────────────────────────────────── */

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
  if (bar) bar.style.width = `${(current / total) * 100}%`;
}

function hideProgressOverlay() {
  if (overlayEl) { overlayEl.remove(); overlayEl = null; }
}

console.log('Ebill Auto-Filler v1.1 content script loaded');
