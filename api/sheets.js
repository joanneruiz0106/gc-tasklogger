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

    // EXPORT — download xlsx as base64, then clear template
    if (action === "finalize") {
      const SPREADSHEET_TAB = tab || "Friday Report";

      // Step 1: Read sheet to find "Week of" date
      const allRows = await sheets.spreadsheets.values.get({
        spreadsheetId,
        range: `${SPREADSHEET_TAB}!A1:N110`,
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

      // Step 3: Clear data using hardcoded ranges based on confirmed sheet structure
      // Day blocks: cols B, E, M for data rows (rows 6-78)
      // Q&A answer blocks: rows 80-82, 85-87, 90-92, 95-97, 100-102 in col A

      const clearRanges = [];

      // Clear all data in Sales col B, Service col E, DM col M for rows 6-78
      const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"];
      rows.forEach((row, idx) => {
        const rowNum = idx + 1;
        if (rowNum < 6 || rowNum > 78) return; // skip headers and Q&A area
        const cell = (row[0] || "").trim().toLowerCase();
        const isDay = DAYS.some(d => cell === d.toLowerCase() || cell.startsWith(d.toLowerCase() + " "));
        if (!isDay) {
          // Clear data columns regardless of whether they have content
          // (some may have been cleared already or have empty strings)
          clearRanges.push(`${SPREADSHEET_TAB}!B${rowNum}`);
          clearRanges.push(`${SPREADSHEET_TAB}!E${rowNum}`);
          clearRanges.push(`${SPREADSHEET_TAB}!M${rowNum}`);
        }
      });

      // Clear Q&A answer areas (hardcoded based on confirmed structure)
      const qaAnswerRows = [80, 81, 82, 85, 86, 87, 90, 91, 92, 95, 96, 97, 100, 101, 102];
      qaAnswerRows.forEach(r => clearRanges.push(`${SPREADSHEET_TAB}!A${r}`));

      if (clearRanges.length) {
        // Split into chunks of 100 to avoid API limits
        const chunks = [];
        for (let i = 0; i < clearRanges.length; i += 100) {
          chunks.push(clearRanges.slice(i, i + 100));
        }
        for (const chunk of chunks) {
          await sheets.spreadsheets.values.batchClear({
            spreadsheetId,
            requestBody: { ranges: [...new Set(chunk)] },
          });
        }
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
