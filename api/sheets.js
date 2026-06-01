const { google } = require("googleapis");

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const serviceAccountJson = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
    const auth = new google.auth.GoogleAuth({
      credentials: serviceAccountJson,
      scopes: [
        "https://www.googleapis.com/auth/spreadsheets",
        "https://www.googleapis.com/auth/drive",
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

    // FINALIZE — copy file, rename with date, clear template, update week date
    if (action === "finalize") {
      const SPREADSHEET_TAB = tab || "Friday Report";

      // 1. Read current sheet to find "Week of" date
      const readRes = await sheets.spreadsheets.values.get({
        spreadsheetId,
        range: `${SPREADSHEET_TAB}!A1:N5`,
      });
      const rows = readRes.data.values || [];
      let weekOf = "";
      rows.forEach(row => {
        row.forEach(cell => {
          if (typeof cell === "string" && cell.toLowerCase().includes("week of")) {
            // Extract date from cell like "Week of: 5/4/2026" or adjacent cell
            const match = cell.match(/\d+\/\d+\/\d+/);
            if (match) weekOf = match[0].replace(/\//g, "-");
          }
        });
        // Also check if week of label is in one cell and date in next
        if ((row[0] || "").toLowerCase().includes("week of") && row[1]) {
          weekOf = row[1].toString().replace(/\//g, "-").trim();
        }
      });

      if (!weekOf) weekOf = new Date().toISOString().slice(0, 10);

      // 2. Copy the file
      const copyRes = await drive.files.copy({
        fileId: spreadsheetId,
        requestBody: { name: `GC Weekly Report - Week of ${weekOf}` },
      });
      const copyName = `GC Weekly Report - Week of ${weekOf}`;

      // 3. Get sheet metadata to find data rows to clear
      const metaRes = await sheets.spreadsheets.get({ spreadsheetId });
      const sheetObj = metaRes.data.sheets?.find(s => s.properties.title === SPREADSHEET_TAB);
      if (!sheetObj) return res.status(400).json({ error: `Tab "${SPREADSHEET_TAB}" not found` });

      // 4. Clear data rows — read all rows, find day blocks, clear cols B, E, M
      const allRows = await sheets.spreadsheets.values.get({
        spreadsheetId,
        range: `${SPREADSHEET_TAB}!A1:N80`,
      });
      const allData = allRows.data.values || [];
      const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"];
      const clearRanges = [];

      allData.forEach((row, idx) => {
        const cell = (row[0] || "").trim().toLowerCase();
        const isDay = DAYS.some(d => cell === d.toLowerCase() || cell.startsWith(d.toLowerCase() + " "));
        if (!isDay) {
          // Clear data columns B, E, M on non-header rows that have data
          if (row[1] || row[4] || row[12]) {
            clearRanges.push(`${SPREADSHEET_TAB}!B${idx + 1}:B${idx + 1}`);
            clearRanges.push(`${SPREADSHEET_TAB}!E${idx + 1}:E${idx + 1}`);
            clearRanges.push(`${SPREADSHEET_TAB}!M${idx + 1}:M${idx + 1}`);
          }
        }
      });

      if (clearRanges.length) {
        await sheets.spreadsheets.values.batchClear({
          spreadsheetId,
          requestBody: { ranges: clearRanges },
        });
      }

      // 5. Update "Week of" to next Monday
      const nextMonday = new Date();
      const dayOfWeek = nextMonday.getDay();
      const daysUntilMonday = dayOfWeek === 0 ? 1 : 8 - dayOfWeek;
      nextMonday.setDate(nextMonday.getDate() + daysUntilMonday);
      const nextWeekStr = `${nextMonday.getMonth() + 1}/${nextMonday.getDate()}/${nextMonday.getFullYear()}`;

      // Find and update the Week of cell
      let weekOfRow = -1, weekOfCol = -1;
      allData.forEach((row, ri) => {
        row.forEach((cell, ci) => {
          if (typeof cell === "string" && cell.toLowerCase().includes("week of")) {
            weekOfRow = ri; weekOfCol = ci;
          }
        });
      });

      if (weekOfRow >= 0) {
        // Update adjacent cell (col + 1) with new date
        const colLetter = String.fromCharCode(65 + weekOfCol + 1);
        await sheets.spreadsheets.values.update({
          spreadsheetId,
          range: `${SPREADSHEET_TAB}!${colLetter}${weekOfRow + 1}`,
          valueInputOption: "USER_ENTERED",
          requestBody: { values: [[nextWeekStr]] },
        });
      }

      return res.json({ copyName, weekOf, nextWeek: nextWeekStr });
    }

    return res.status(400).json({ error: "Unknown action" });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: e.message });
  }
}
