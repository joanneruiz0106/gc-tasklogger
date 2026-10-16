const { google } = require("googleapis");

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const serviceAccountJson = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
    const auth = new google.auth.GoogleAuth({
      credentials: serviceAccountJson,
      scopes: [
        "https://www.googleapis.com/auth/spreadsheets",
        "https://www.googleapis.com/auth/drive.readonly",
      ],
    });
    const sheets = google.sheets({ version: "v4", auth });
    const drive = google.drive({ version: "v3", auth });
    const { action, spreadsheetId, range, data, tab } = req.body;

    // READ
    if (action === "read") {
      const response = await sheets.spreadsheets.values.get({ spreadsheetId, range });
      const meta = await sheets.spreadsheets.get({ spreadsheetId, fields: "properties.title" });
      return res.json({
        values: response.data.values || [],
        sheetName: meta.data.properties?.title || "GC Weekly Report",
      });
    }

    // WRITE
    if (action === "write") {
      const response = await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId,
        requestBody: { valueInputOption: "USER_ENTERED", data },
      });
      return res.json({ updatedCells: response.data.totalUpdatedCells });
    }

    // WRITE QA — writes to merged cells one at a time using update (not batchUpdate)
    if (action === "writeQA") {
      const { qaData } = req.body;
      let totalUpdated = 0;
      const errors = [];
      for (const item of qaData) {
        try {
          const resp = await sheets.spreadsheets.values.update({
            spreadsheetId,
            range: item.range,
            valueInputOption: "RAW",
            requestBody: { values: item.values },
          });
          totalUpdated += resp.data.updatedCells || 0;
        } catch(e) {
          errors.push(`${item.range}: ${e.message}`);
        }
      }
      if (errors.length) return res.json({ updatedCells: totalUpdated, errors });
      return res.json({ updatedCells: totalUpdated });
    }

    // WEEK INFO — returns the sheet's current "Week of" date (source of truth for the app)
    if (action === "weekInfo") {
      const SPREADSHEET_TAB = tab || "Friday Report";
      const found = await findWeekOf(sheets, spreadsheetId, SPREADSHEET_TAB);
      const monday = mondayOf(found.date || todayPT());
      return res.json({ weekOf: toISO(monday), weekOfDisplay: toMDY(monday), fromSheet: !!found.date });
    }

    // EXPORT — download xlsx as base64, then clear template
    if (action === "finalize") {
      const SPREADSHEET_TAB = tab || "Friday Report";

      // Step 1: Read the "Week of" date from the sheet. The sheet — not today's date —
      // decides which week is being finalized, so late finalizing (Sat/Sun/next week) works.
      const found = await findWeekOf(sheets, spreadsheetId, SPREADSHEET_TAB);
      const today = todayPT();
      const weekMonday = mondayOf(found.date || today);
      const weekOf = toMDY(found.date || weekMonday);
      console.log("weekOf detected:", weekOf, "label row:", found.row, "date col:", found.dateCol);

      // Guard: if the sheet's week hasn't started yet, this report was already finalized.
      if (weekMonday > today) {
        return res.status(409).json({
          error: `Week of ${toMDY(weekMonday)} hasn't started yet — last week's report was already finalized.`,
        });
      }

      // Filename uses the Week of date (mmddyyyy)
      const fileDate = pad2(weekMonday.getUTCMonth() + 1) + pad2(weekMonday.getUTCDate()) + weekMonday.getUTCFullYear();
      const fileName = `GC Weekly Report.${fileDate}.xlsx`;

      // Step 2: Export current sheet as xlsx BEFORE clearing
      const exportRes = await drive.files.export(
        {
          fileId: spreadsheetId,
          mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        },
        { responseType: "arraybuffer" }
      );

      // Convert to base64 to send back to browser
      const base64 = Buffer.from(exportRes.data).toString("base64");

      // Step 3: Clear data using broad column ranges
      // Clear entire B, E, M columns for rows 6-78 (day data area) in one go
      // Clear entire A column for Q&A answer rows
      const clearRanges = [
        // Sales/Admin column - clear all data rows
        `${SPREADSHEET_TAB}!B6:B78`,
        // Service call column - clear all data rows  
        `${SPREADSHEET_TAB}!E6:E78`,
        // DM Support columns M and N - clear all data rows
        `${SPREADSHEET_TAB}!M6:N78`,
        // Q&A answer blocks (merged cells starting at col A)
        `${SPREADSHEET_TAB}!A80:A82`,
        `${SPREADSHEET_TAB}!A85:A87`,
        `${SPREADSHEET_TAB}!A90:A92`,
        `${SPREADSHEET_TAB}!A95:A97`,
        `${SPREADSHEET_TAB}!A100:A102`,
      ];

      await sheets.spreadsheets.values.batchClear({
        spreadsheetId,
        requestBody: { ranges: clearRanges },
      });

      // Step 4: Update "Week of" to the Monday after the finalized week (Week of + 7 days),
      // regardless of what day finalize was pressed or the server's timezone.
      const nextMonday = addDays(weekMonday, 7);
      const nextWeekStr = toMDY(nextMonday);

      if (found.row >= 0) {
        await sheets.spreadsheets.values.update({
          spreadsheetId,
          range: `${SPREADSHEET_TAB}!${colToLetter(found.dateCol)}${found.row + 1}`,
          valueInputOption: "USER_ENTERED",
          requestBody: { values: [[found.sameCell ? `Week of: ${nextWeekStr}` : nextWeekStr]] },
        });
      }

      // Return base64 file for browser download
      return res.json({
        fileName,
        base64,
        weekOf,
        nextWeek: nextWeekStr,
        nextWeekISO: toISO(nextMonday),
      });
    }

    return res.status(400).json({ error: "Unknown action" });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: e.message });
  }
}

// ---------- Date helpers (all dates are UTC-midnight Date objects for a calendar day) ----------
const TZ = "America/Los_Angeles";
const DAY_MS = 86400000;
const pad2 = (n) => String(n).padStart(2, "0");

// Today's calendar date in Pacific time (Vercel servers run in UTC)
function todayPT() {
  const [y, m, d] = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" })
    .format(new Date()).split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}
const addDays = (d, n) => new Date(d.getTime() + n * DAY_MS);
function mondayOf(d) {
  const dow = d.getUTCDay();
  return addDays(d, dow === 0 ? -6 : 1 - dow);
}
const toMDY = (d) => `${d.getUTCMonth() + 1}/${d.getUTCDate()}/${d.getUTCFullYear()}`;
const toISO = (d) => `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
function colToLetter(idx) {
  let s = ""; idx += 1;
  while (idx > 0) { const r = (idx - 1) % 26; s = String.fromCharCode(65 + r) + s; idx = Math.floor((idx - 1) / 26); }
  return s;
}

// Accepts a Sheets serial number, "9/21/2026", "09-21-26", "2026-09-21", "September 21, 2026"
function parseSheetDate(v) {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "number" && v > 20000 && v < 80000) {
    const d = new Date(Date.UTC(1899, 11, 30) + Math.round(v) * DAY_MS);
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  }
  const str = v.toString().trim();
  let m = str.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  m = str.match(/(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})/);
  if (m) {
    let y = +m[3]; if (y < 100) y += 2000;
    return new Date(Date.UTC(y, +m[1] - 1, +m[2]));
  }
  const t = Date.parse(str);
  if (!isNaN(t)) { const d = new Date(t); return new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate())); }
  return null;
}

// Finds the "Week of:" label and the date cell next to it
async function findWeekOf(sheets, spreadsheetId, tab) {
  const resp = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${tab}!A1:N10`,
    valueRenderOption: "UNFORMATTED_VALUE",
    dateTimeRenderOption: "SERIAL_NUMBER",
  });
  const rows = resp.data.values || [];
  for (let ri = 0; ri < rows.length; ri++) {
    const row = rows[ri] || [];
    for (let ci = 0; ci < row.length; ci++) {
      const cellStr = (row[ci] ?? "").toString();
      if (!/week\s+of/i.test(cellStr)) continue;
      // Date in the same cell, e.g. "Week of: 9/21/2026"
      const same = parseSheetDate(cellStr.replace(/.*week\s+of[:\s]*/i, ""));
      if (same) return { date: same, row: ri, dateCol: ci, sameCell: true };
      // Otherwise check the next few cells to the right
      for (let off = 1; off <= 4; off++) {
        const val = row[ci + off];
        if (val === undefined || val === "") continue;
        const d = parseSheetDate(val);
        if (d) return { date: d, row: ri, dateCol: ci + off };
      }
      return { date: null, row: ri, dateCol: ci + 1 };
    }
  }
  return { date: null, row: -1, dateCol: -1 };
}
