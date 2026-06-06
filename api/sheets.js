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

    // EXPORT — download xlsx as base64, then clear template
    if (action === "finalize") {
      const SPREADSHEET_TAB = tab || "Friday Report";

      // Step 1: Read sheet to find "Week of" date
      const allRows = await sheets.spreadsheets.values.get({
        spreadsheetId,
        range: `${SPREADSHEET_TAB}!A1:N80`,
      });
      const rows = allRows.data.values || [];

      // Find week of date - check multiple patterns
      let weekOf = "";
      let weekOfRow = -1, weekOfCol = -1;
      rows.forEach((row, ri) => {
        row.forEach((cell, ci) => {
          const cellStr = (cell || "").toString().toLowerCase();
          if (cellStr.includes("week of") || cellStr.includes("week of:")) {
            weekOfRow = ri; weekOfCol = ci;
            // Check adjacent cells for the date value
            for (let offset = 1; offset <= 4; offset++) {
              if (row[ci + offset] && row[ci + offset].toString().trim()) {
                weekOf = row[ci + offset].toString().trim();
                break;
              }
            }
          }
        });
        // Also check if "week of:" label and date are in same cell
        row.forEach((cell) => {
          const cellStr = (cell || "").toString();
          const match = cellStr.match(/week\s+of[:\s]+(\d+\/\d+\/\d+)/i);
          if (match) weekOf = match[1].trim();
        });
      });
      
      // Fallback to today's date if still not found
      if (!weekOf) {
        const now = new Date();
        weekOf = (now.getMonth()+1) + "/" + now.getDate() + "/" + now.getFullYear();
      }
      console.log("weekOf detected:", weekOf, "at row:", weekOfRow, "col:", weekOfCol);

      // Format date as mmddyyyy for filename
      let fileDate = new Date().toLocaleDateString("en-US", { month: "2-digit", day: "2-digit", year: "numeric" }).replace(/\//g, "");
      if (weekOf) {
        const parts = weekOf.split("/");
        if (parts.length === 3) {
          fileDate = parts[0].padStart(2, "0") + parts[1].padStart(2, "0") + parts[2];
        }
      }
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

      // Step 3: Clear data cells in original template
      const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"];
      const clearRanges = [];
      rows.forEach((row, idx) => {
        const cell = (row[0] || "").trim().toLowerCase();
        const isDay = DAYS.some(d => cell === d.toLowerCase() || cell.startsWith(d.toLowerCase() + " "));
        const isHeader = idx < 5;
        if (!isDay && !isHeader) {
          if (row[1]) clearRanges.push(`${SPREADSHEET_TAB}!B${idx + 1}`);
          if (row[4]) clearRanges.push(`${SPREADSHEET_TAB}!E${idx + 1}`);
          if (row[12]) clearRanges.push(`${SPREADSHEET_TAB}!M${idx + 1}`);
        }
      });

      // Clear Q&A rows
      const qaKeywords = ["renewed", "jeopardy", "tss", "personal dev", "other comments"];
      rows.forEach((row, idx) => {
        const cell = (row[0] || "").toLowerCase();
        if (qaKeywords.some(kw => cell.includes(kw)) && row[1]) {
          clearRanges.push(`${SPREADSHEET_TAB}!B${idx + 1}`);
        }
      });

      if (clearRanges.length) {
        await sheets.spreadsheets.values.batchClear({
          spreadsheetId,
          requestBody: { ranges: [...new Set(clearRanges)] },
        });
      }

      // Step 4: Update "Week of" to next Monday
      const nextMonday = new Date();
      const dayOfWeek = nextMonday.getDay();
      const daysUntilMonday = dayOfWeek === 0 ? 1 : 8 - dayOfWeek;
      nextMonday.setDate(nextMonday.getDate() + daysUntilMonday);
      const nextWeekStr = `${nextMonday.getMonth() + 1}/${nextMonday.getDate()}/${nextMonday.getFullYear()}`;

      if (weekOfRow >= 0) {
        const colLetter = String.fromCharCode(65 + weekOfCol + 1);
        await sheets.spreadsheets.values.update({
          spreadsheetId,
          range: `${SPREADSHEET_TAB}!${colLetter}${weekOfRow + 1}`,
          valueInputOption: "USER_ENTERED",
          requestBody: { values: [[nextWeekStr]] },
        });
      }

      // Return base64 file for browser download
      return res.json({
        fileName,
        base64,
        weekOf,
        nextWeek: nextWeekStr,
      });
    }

    return res.status(400).json({ error: "Unknown action" });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: e.message });
  }
}
