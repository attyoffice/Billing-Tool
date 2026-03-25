# Ebill Auto-Filler Chrome Extension

Automatically fill ebill.publiccounsel.net time entries from PracticePanther billing exports.

## Installation

1. Open Chrome and go to `chrome://extensions/`
2. Enable "Developer mode" (toggle in top right)
3. Click "Load unpacked"
4. Select the `extension` folder

**Note:** You'll need to add icon files (icon16.png, icon48.png, icon128.png) to the `icons/` folder, or remove the icon references from manifest.json.

## Usage

1. Export your billing data from PracticePanther as CSV
2. Click the extension icon in Chrome toolbar
3. Upload your CSV file
4. Navigate to ebill.publiccounsel.net and select the appropriate case
5. Click "Fill Ebill Form" to auto-fill the entries

## CSV Format Expected

The parser expects columns including:
- Activity code (e.g., "03 Trial / Hearing")
- Status (e.g., "Billable")
- Date (e.g., "8/13/2025")
- Description (may include time range like "09:36-10:00 Meeting...")
- Hours
- Matter (e.g., "Client Name 25CPO034")

## Activity Code Mapping

| Code | Ebill Category |
|------|----------------|
| 01 | Emergency Hearing |
| 02 | Pre-Trial Hearing/Conference |
| 03 | Trial/Hearing |
| 04 | Disposition Proceedings |
| 05 | Draft Pleadings/Correspondence |
| 06 | Hearing/Trial Prep + Discovery |
| 07 | Court Waiting Time |
| 08 | In Person Client Contact |
| 09 | Negotiation/Case Conference |
| 10 | Legal Research |
| 11 | Investigation |
| 12 | Travel |
| 13 | Other Client Contact |

## Features

- Rounds hours to 1 decimal place (0.5 rounds up)
- Combines same activity on same day
- Validates total hours match after processing
- Groups entries by matter/case
- Shows preview before filling
