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

    // FINALIZE
    if (action === "finalize") {
      const SPREADSHEET_TAB = tab || "Friday Report";

      // Step 1: Read sheet to find "Week of" date
      const allRows = await sheets.spreadsheets.values.get({
        spreadsheetId,
        range: `${SPREADSHEET_TAB}!A1:N80`,
      });
      const rows = allRows.data.values || [];

      // Find week of date
      let weekOf = "";
      let weekOfRow = -1, weekOfCol = -1;
      rows.forEach((row, ri) => {
        row.forEach((cell, ci) => {
          if (typeof cell === "string" && cell.toLowerCase().includes("week of")) {
            weekOfRow = ri; weekOfCol = ci;
            // Check adjacent cell for date value
            if (row[ci + 1]) weekOf = row[ci + 1].toString().trim();
          }
        });
      });

      // Format date as mmddyyyy for filename
      let fileDate = "unknown";
      if (weekOf) {
        const parts = weekOf.split("/");
        if (parts.length === 3) {
          const mm = parts[0].padStart(2, "0");
          const dd = parts[1].padStart(2, "0");
          const yyyy = parts[2];
          fileDate = `${mm}${dd}${yyyy}`;
        } else {
          fileDate = weekOf.replace(/\//g, "");
        }
      }
      const copyName = `GC Weekly Report.${fileDate}.xlsx`;

      // Step 2: Export current sheet as xlsx BEFORE clearing
      // Get the file using drive export - this captures current data
      const exportRes = await drive.files.export(
        {
          fileId: spreadsheetId,
          mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        },
        { responseType: "arraybuffer" }
      );

      // Step 3: Upload the exported xlsx as a new file in same folder as original
      // First get parent folder of original file
      const fileMeta = await drive.files.get({
        fileId: spreadsheetId,
        fields: "parents",
      });
      const parents = fileMeta.data.parents || [];

      // Upload xlsx copy to user's drive (shared with service account)
      const { Readable } = require("stream");
      const buffer = Buffer.from(exportRes.data);
      const stream = Readable.from(buffer);

      const uploadRes = await drive.files.create({
        requestBody: {
          name: copyName,
          mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          parents: parents,
        },
        media: {
          mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          body: stream,
        },
        fields: "id, name, webViewLink",
      });

      // Step 4: Clear data cells in original template
      const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"];
      const clearRanges = [];
      rows.forEach((row, idx) => {
        const cell = (row[0] || "").trim().toLowerCase();
        const isDay = DAYS.some(d => cell === d.toLowerCase() || cell.startsWith(d.toLowerCase() + " "));
        const isHeader = idx < 5; // keep header rows
        if (!isDay && !isHeader) {
          if (row[1] || row[4] || row[12]) {
            clearRanges.push(`${SPREADSHEET_TAB}!B${idx + 1}`);
            clearRanges.push(`${SPREADSHEET_TAB}!E${idx + 1}`);
            clearRanges.push(`${SPREADSHEET_TAB}!M${idx + 1}`);
          }
        }
      });
      // Also clear Q&A section rows
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
          requestBody: { ranges: clearRanges },
        });
      }

      // Step 5: Update "Week of" to next Monday
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

      return res.json({
        copyName,
        weekOf,
        nextWeek: nextWeekStr,
        driveLink: uploadRes.data.webViewLink,
        fileId: uploadRes.data.id,
      });
    }

    return res.status(400).json({ error: "Unknown action" });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: e.message });
  }
}
