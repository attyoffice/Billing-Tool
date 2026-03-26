/**
 * Parser for PracticePanther billing exports (CSV / XLSX)
 * Maps activity item codes to ebill.publiccounsel.net categories
 *
 * Expected columns (order doesn't matter):
 *   "Is Time Entries Selected" — ignored
 *   "Item"                     — activity code, e.g. "05 Draft Cor" or "12 Travel"
 *   "Status"                   — only "Billable" rows are processed; others are skipped
 *   "Date"                     — entry date (M/D/YYYY or YYYY-MM-DD or Excel serial)
 *   "Description"              — notes; travel entries contain "City to City, Reason"
 *   "hrs."                     — hours worked (floored to 0.1)
 *   "Rate"                     — ignored
 *   "Total"                    — ignored
 *   "Billed By"                — ignored
 *   "Contact"                  — client name, may be prefixed "2658 - Paige Resendez"
 *   "Matter"                   — ignored
 */

// Activity code → ebill category key
const ACTIVITY_MAPPING = {
  '01': 'emergency_hearing',
  '02': 'pre_tri_hrg_conf',
  '03': 'trial_hearing',
  '04': 'dispo_proceedings',
  '05': 'dft_pleadings_cor',
  '06': 'hrg_tri_prep_disco',
  '07': 'court_waiting_time',
  '08': 'in_prsn_clt_contact',
  '09': 'negot_case_conf',
  '10': 'legal_research',
  '11': 'investigation',
  '12': 'travel',
  '13': 'other_clt_contact',
};

const CATEGORY_DISPLAY_NAMES = {
  'emergency_hearing':   'Emergency Hearing',
  'pre_tri_hrg_conf':    'Pre-Tri Hrg/Conf',
  'trial_hearing':       'Trial/Hearing',
  'dispo_proceedings':   'Dispo. Proceedings',
  'dft_pleadings_cor':   'Dft Pleadings/Cor',
  'hrg_tri_prep_disco':  'Hrg/Tri Prep+Disco',
  'court_waiting_time':  'Court Waiting Time',
  'in_prsn_clt_contact': 'In Prsn Clt Contact',
  'negot_case_conf':     'Negot/Case Conf',
  'legal_research':      'Legal Research',
  'investigation':       'Investigation',
  'travel':              'Travel',
  'other_clt_contact':   'Other Clt Contact',
};

const TRAVEL_REASONS = ['Court', 'Investigation', 'Research', 'Client Visit'];

/* ── Rounding ─────────────────────────────────────────────────────── */

/**
 * Round hours DOWN to the nearest 0.1 hr.
 * e.g. 1.37 → 1.3,  0.98 → 0.9,  2.40 → 2.4
 */
function roundHours(hours) {
  return Math.floor(Math.round(hours * 1000) / 100) / 10;
}

/* ── Date parsing ─────────────────────────────────────────────────── */

/**
 * Convert an Excel date serial number to M/D/YYYY string.
 * Excel epoch is Jan 1, 1900 = serial 1 (with the "1900 leap year" bug).
 */
function excelSerialToDate(serial) {
  const d = new Date(Date.UTC(1900, 0, 1));
  d.setUTCDate(d.getUTCDate() + serial - (serial >= 60 ? 2 : 1));
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}/${d.getUTCFullYear()}`;
}

/**
 * Parse a date string to M/D/YYYY format.
 * Accepts: "8/13/2025", "08/13/2025", "2025-08-13", or Excel serial numbers.
 */
function parseDate(dateStr) {
  if (!dateStr || typeof dateStr !== 'string') return null;
  const s = dateStr.trim();

  // M/D/YYYY or MM/DD/YYYY
  let m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return `${parseInt(m[1])}/${parseInt(m[2])}/${m[3]}`;

  // YYYY-MM-DD
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return `${parseInt(m[2])}/${parseInt(m[3])}/${m[1]}`;

  // Excel date serial number (plausible range: 1990–2070)
  const num = parseInt(s, 10);
  if (!isNaN(num) && String(num) === s && num >= 32874 && num <= 62091) {
    return excelSerialToDate(num);
  }

  return null;
}

/* ── Activity code ────────────────────────────────────────────────── */

/**
 * Extract a 2-digit activity code from the "Item" column.
 * The column may contain just a number ("12") or number + label ("12 Travel").
 */
function extractActivityCode(itemStr) {
  if (!itemStr && itemStr !== 0) return null;
  const s = String(itemStr).trim();
  const m = s.match(/^(\d{1,2})/);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  if (n < 1 || n > 13) return null;
  return n.toString().padStart(2, '0');
}

/* ── Contact name ─────────────────────────────────────────────────── */

/**
 * Strip the numeric ID prefix that PracticePanther prepends to contact names.
 * "2658 - Paige Resendez"  →  "Paige Resendez"
 * "Paige Resendez"         →  "Paige Resendez"  (unchanged)
 */
function extractClientName(contactStr) {
  if (!contactStr) return '';
  const m = contactStr.trim().match(/^\d+\s*-\s*(.+)/);
  return m ? m[1].trim() : contactStr.trim();
}

/* ── Travel description parsing ───────────────────────────────────── */

/**
 * Parse a travel description into structured travel info.
 *
 * Handles PracticePanther formats such as:
 *   "15:17-15:59 Travel from Carlisle to Lawrence for client meeting."
 *   "10:56-11:50\n\nTravel from Carlisle to Georgetown for client visit RT."
 *   "Travel from Carlisle to Natick for client visit RT"
 *   "Los Angeles to Sacramento, Court"
 *
 * Returns { fromCity, toCity, reason, isRoundTrip } or null if nothing useful found.
 */
function parseTravelDescription(description) {
  if (!description) return null;

  // 1. Normalize multiline content and collapse whitespace
  let text = description.replace(/\r?\n/g, ' ').replace(/\s+/g, ' ').trim();

  // 2. Strip leading time range  e.g. "15:17-15:59" or "10:56-11:50"
  text = text.replace(/^\d{1,2}:\d{2}\s*[-–]\s*\d{1,2}:\d{2}\s*/i, '').trim();

  // 3. Strip leading "Travel [back]" keyword
  text = text.replace(/^travel\s+(back\s+)?/i, '').trim();

  // 4. Round-trip detection ("RT" abbreviation or "round trip" phrase)
  const isRoundTrip = /\bRT\b/.test(text) || /round\s*trip/i.test(text);

  // 5. Reason detection (most-specific patterns first)
  const REASON_PATTERNS = [
    { re: /\bclient\s+(visit|meeting)\b/i, reason: 'Client Visit' },
    { re: /\bcourt\b/i,                    reason: 'Court'        },
    { re: /\binvestigation\b/i,            reason: 'Investigation'},
    { re: /\bresearch\b/i,                 reason: 'Research'     },
  ];
  let reason = null;
  for (const { re, reason: r } of REASON_PATTERNS) {
    if (re.test(text)) { reason = r; break; }
  }

  // 6. City extraction
  //    Try "from X to Y [for / RT / punctuation / end]" first, then plain "X to Y"
  let fromCity = null, toCity = null;
  let m = text.match(
    /\bfrom\s+([A-Za-z][A-Za-z\s]+?)\s+to\s+([A-Za-z][A-Za-z\s]+?)(?=\s+for\b|\s+RT\b|\s*[.,]|$)/i
  );
  if (!m) {
    m = text.match(
      /^([A-Za-z][A-Za-z\s]+?)\s+to\s+([A-Za-z][A-Za-z\s]+?)(?=\s+for\b|\s+RT\b|\s*[.,]|$)/i
    );
  }
  if (m) {
    fromCity = m[1].trim();
    toCity   = m[2].trim();
  }

  if (!reason && !fromCity) return null;
  return { fromCity, toCity, reason, isRoundTrip };
}

/* ── CSV parsing ──────────────────────────────────────────────────── */

/**
 * Parse a full CSV string character-by-character.
 * Correctly handles quoted fields that contain embedded commas AND newlines
 * (e.g. PracticePanther multi-line description cells).
 * Returns a 2-D array of trimmed strings.
 */
function parseCSVFull(content) {
  const rows = [];
  let row = [];
  let cell = '';
  let inQuotes = false;

  for (let i = 0; i < content.length; i++) {
    const ch = content[i];

    if (inQuotes) {
      if (ch === '"') {
        if (content[i + 1] === '"') { cell += '"'; i++; } // escaped ""
        else { inQuotes = false; }                         // closing quote
      } else {
        cell += ch; // includes embedded newlines — kept as-is
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ',') {
        row.push(cell.trim()); cell = '';
      } else if (ch === '\r' || ch === '\n') {
        if (ch === '\r' && content[i + 1] === '\n') i++; // skip \n of \r\n
        row.push(cell.trim());
        if (row.some(c => c !== '')) rows.push(row);
        row = []; cell = '';
      } else {
        cell += ch;
      }
    }
  }

  // Last row (file may not end with a newline)
  if (cell !== '' || row.length > 0) {
    row.push(cell.trim());
    if (row.some(c => c !== '')) rows.push(row);
  }

  return rows;
}

/**
 * Parse CSV or TSV text into a 2-D array of strings.
 * Auto-detects delimiter from the first line.
 * Returns { rows, errors }.
 */
function parseDelimited(content) {
  if (!content || !content.trim()) {
    return { rows: [], errors: ['File is empty'] };
  }

  // TSV: if the header row contains a tab, split on tabs (no quoting needed)
  const firstNewline = content.indexOf('\n');
  const firstLine = firstNewline >= 0 ? content.slice(0, firstNewline) : content;
  if (firstLine.includes('\t')) {
    const rows = content.split(/\r?\n/)
      .filter(l => l.trim())
      .map(l => l.split('\t').map(s => s.trim()));
    if (rows.length < 2) return { rows: [], errors: ['File has no data rows'] };
    return { rows, errors: [] };
  }

  // CSV: use the character-by-character parser (handles multiline quoted fields)
  const rows = parseCSVFull(content);
  if (rows.length < 2) return { rows: [], errors: ['File is empty or has no data rows'] };
  return { rows, errors: [] };
}

/* ── Core row processing ──────────────────────────────────────────── */

/**
 * Return true if a row looks like a totals/summary row that should be skipped.
 * A totals row typically has no valid date, no recognisable item code,
 * or contains the word "Total".
 */
function isTotalsRow(row, cols) {
  // Contains "Total" anywhere
  if (row.some(cell => /\btotal\b/i.test(cell || ''))) return true;
  // Date cell exists but can't be parsed as a date
  const dateVal = (cols.date >= 0 ? row[cols.date] : '') || '';
  if (dateVal && !parseDate(dateVal)) return true;
  // Item cell is blank or has no recognisable activity code
  const itemVal = (cols.item >= 0 ? row[cols.item] : '') || '';
  if (!itemVal.trim() || !extractActivityCode(itemVal)) return true;
  return false;
}

/**
 * Given a 2-D array of rows (first row = headers), process into entry objects.
 * - Skips the "Is Time Entries Selected" column
 * - Skips any row where item is blank
 * - Skips the LAST non-empty row (total hours row)
 * - Floors hours to 0.1
 */
function processRows(rows) {
  if (rows.length < 2) return { entries: [], errors: ['No data rows found'] };

  const headers = rows[0];
  const headerMap = {};
  headers.forEach((h, i) => {
    if (h) headerMap[h.toLowerCase().trim()] = i;
  });

  // Flexible column finder — tries each name in order
  const findColumn = (...names) => {
    for (const name of names) {
      for (const [key, idx] of Object.entries(headerMap)) {
        if (key.includes(name.toLowerCase())) return idx;
      }
    }
    return -1;
  };

  const cols = {
    date:        findColumn('date'),
    contact:     findColumn('contact'),
    item:        findColumn('item'),
    hours:       findColumn('hrs.', 'hrs', 'hours', 'time', 'duration'),
    description: findColumn('descriptions', 'description', 'desc', 'notes'),
    status:      findColumn('status'),
    // "Is Time Entries Selected", "Rate", "Total", "Billed By", "Matter" — all ignored
  };

  const errors = [];
  if (cols.date < 0)    errors.push('Column "Date" not found');
  if (cols.contact < 0) errors.push('Column "Contact" not found');
  if (cols.item < 0)    errors.push('Column "Item" not found');
  if (cols.hours < 0)   errors.push('Column "hrs." not found');
  if (errors.length)    return { entries: [], errors };

  // All non-empty data rows
  const dataRows = rows.slice(1).filter(r => r.some(c => c && c.trim()));

  // Drop the last row only if it looks like a totals/summary row.
  // (Some exports append a total-hours row; others don't — don't blindly drop.)
  const lastRow = dataRows[dataRows.length - 1];
  const lastIsTotals = lastRow && isTotalsRow(lastRow, cols);
  const rowsToProcess = lastIsTotals ? dataRows.slice(0, -1) : dataRows;

  const entries = [];
  const warnings = [];
  let skippedNonBillable = 0;

  rowsToProcess.forEach((row, idx) => {
    const rowNum = idx + 2; // 1-based, accounting for header

    // Skip non-Billable rows (Billed, Paid, Not Billable, etc.)
    if (cols.status >= 0) {
      const status = (row[cols.status] || '').trim();
      if (status && status !== 'Billable') {
        skippedNonBillable++;
        return;
      }
    }

    // Skip rows with blank item (not an activity entry)
    const itemVal = cols.item >= 0 ? row[cols.item] : '';
    if (!itemVal || !itemVal.trim()) return;

    const activityCode = extractActivityCode(itemVal);
    if (!activityCode) {
      warnings.push(`Row ${rowNum}: unrecognised item value "${itemVal}" — skipped`);
      return;
    }

    // Date
    const dateStr = cols.date >= 0 ? row[cols.date] : '';
    const date = parseDate(dateStr);
    if (!date) {
      warnings.push(`Row ${rowNum}: invalid date "${dateStr}" — skipped`);
      return;
    }

    // Hours
    const hoursRaw = cols.hours >= 0 ? row[cols.hours] : '';
    const hoursNum = parseFloat(hoursRaw);
    if (isNaN(hoursNum) || hoursNum <= 0) {
      warnings.push(`Row ${rowNum}: invalid or zero hours "${hoursRaw}" — skipped`);
      return;
    }
    const hours = roundHours(hoursNum);
    if (hours <= 0) {
      warnings.push(`Row ${rowNum}: hours rounded to 0 (was ${hoursNum}) — skipped`);
      return;
    }

    // Client — strip numeric prefix e.g. "2658 - Paige Resendez" → "Paige Resendez"
    const contact = extractClientName(cols.contact >= 0 ? row[cols.contact] : '');
    if (!contact) {
      warnings.push(`Row ${rowNum}: blank contact — skipped`);
      return;
    }

    // Description (may contain travel info)
    const description = cols.description >= 0 ? row[cols.description].trim() : '';

    const category = ACTIVITY_MAPPING[activityCode] || 'other_clt_contact';

    // Parse travel details when item is 12
    let travelInfo = null;
    if (activityCode === '12' && description) {
      travelInfo = parseTravelDescription(description);
    }

    entries.push({
      date,
      contact,        // client name
      activityCode,
      category,
      categoryDisplay: CATEGORY_DISPLAY_NAMES[category] || category,
      hours,
      description,
      travelInfo,
      rowNum,
    });
  });

  if (skippedNonBillable > 0) {
    warnings.unshift(`${skippedNonBillable} row(s) skipped — status is not "Billable" (already billed, paid, or marked not billable)`);
  }

  return { entries, errors: [], warnings };
}

/* ── Aggregation & grouping ───────────────────────────────────────── */

/**
 * Combine entries that share the same client + date + item.
 * Hours are summed then floored to 0.1.
 * Travel infos from combined rows are merged into an array.
 */
function aggregateEntries(entries) {
  const map = {};

  entries.forEach(entry => {
    const key = `${entry.contact}|${entry.date}|${entry.activityCode}`;
    if (!map[key]) {
      map[key] = {
        ...entry,
        hours: entry.hours,
        descriptions: [entry.description],
        travelInfos: entry.travelInfo ? [entry.travelInfo] : [],
      };
    } else {
      map[key].hours += entry.hours;
      if (entry.description) map[key].descriptions.push(entry.description);
      if (entry.travelInfo)  map[key].travelInfos.push(entry.travelInfo);
    }
  });

  return Object.values(map).map(entry => ({
    ...entry,
    hours: roundHours(entry.hours),
    description: entry.descriptions.filter(Boolean).join('; '),
    // Keep unique travel infos
    travelInfos: entry.travelInfos,
  }));
}

/**
 * Group aggregated entries by client (contact).
 * Returns { [contactName]: { contact, entries[], totalHours } }
 */
function groupByClient(entries) {
  const groups = {};

  entries.forEach(entry => {
    if (!groups[entry.contact]) {
      groups[entry.contact] = {
        contact: entry.contact,
        entries: [],
        totalHours: 0,
      };
    }
    groups[entry.contact].entries.push(entry);
    groups[entry.contact].totalHours += entry.hours;
  });

  Object.values(groups).forEach(g => {
    g.totalHours = roundHours(g.totalHours);
  });

  return groups;
}

/* ── Main entry point ─────────────────────────────────────────────── */

/**
 * Process billing file content (CSV/TSV text, or 2-D array from XLSX).
 * @param {string|Array} input — CSV/TSV string, or already-parsed 2-D array
 * @returns result object with success, entries, groups, summary, warnings, errors
 */
function processBillingFile(input) {
  let rows;
  let parseErrors = [];

  if (Array.isArray(input)) {
    // Already a 2-D array (from xlsx_reader.js)
    rows = input;
  } else {
    // CSV or TSV text
    const parsed = parseDelimited(input);
    rows = parsed.rows;
    parseErrors = parsed.errors;
  }

  if (parseErrors.length) {
    return { success: false, errors: parseErrors, entries: [], groups: {} };
  }

  const { entries: rawEntries, errors: rowErrors, warnings } = processRows(rows);

  if (rowErrors.length) {
    return { success: false, errors: rowErrors, entries: [], groups: {}, warnings: warnings || [] };
  }

  if (rawEntries.length === 0) {
    return {
      success: false,
      errors: ['No valid entries found — check that the file has the expected columns (Date, Contact, Item, hrs.)'],
      entries: [],
      groups: {},
      warnings: warnings || [],
    };
  }

  const aggregated = aggregateEntries(rawEntries);
  const groups = groupByClient(aggregated);
  const totalHours = roundHours(aggregated.reduce((s, e) => s + e.hours, 0));

  return {
    success: true,
    errors: [],
    warnings: warnings || [],
    entries: aggregated,
    groups,
    summary: {
      originalEntries:   rawEntries.length,
      aggregatedEntries: aggregated.length,
      totalHours,
      clientCount:       Object.keys(groups).length,
    },
  };
}

// Expose to popup.js
if (typeof window !== 'undefined') {
  window.BillingParser = {
    processBillingFile,
    roundHours,
    parseDate,
    parseTravelDescription,
    CATEGORY_DISPLAY_NAMES,
    TRAVEL_REASONS,
  };
}
