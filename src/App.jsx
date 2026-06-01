import { useState, useRef, useEffect, useCallback } from "react";

const SPREADSHEET_TAB = "Friday Report";
const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"];
const TODAY_IDX = Math.min(Math.max(new Date().getDay() - 1, 0), 4);
const COL_SALES = 1;   // B
const COL_SERVICE = 4; // E
const COL_DM = 12;     // M

function getCurrentWeekOf() {
  const now = new Date();
  const day = now.getDay();
  const diff = now.getDate() - day + (day === 0 ? -6 : 1);
  const monday = new Date(new Date(now).setDate(diff));
  return monday.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
}

function getSpreadsheetIdFromUrl(url) {
  const match = url.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  return match ? match[1] : null;
}

function colLetter(idx) {
  return idx < 26 ? String.fromCharCode(65 + idx) : "A" + String.fromCharCode(65 + idx - 26);
}

function detectDayFromText(text) {
  const t = text.toLowerCase();
  if (t.includes("yesterday")) return Math.max(TODAY_IDX - 1, 0);
  if (t.includes("monday")) return 0;
  if (t.includes("tuesday")) return 1;
  if (t.includes("wednesday")) return 2;
  if (t.includes("thursday")) return 3;
  if (t.includes("friday")) return 4;
  if (t.includes("today") || t.includes("this morning") || t.includes("this afternoon")) return TODAY_IDX;
  return null;
}

function detectTypeFromText(text) {
  const t = text.toLowerCase();
  const dmKw = ["district manager", "corporate support", "dm request", "support request", "dm support", "manager support"];
  // Admin checked FIRST — must not fall into service even if service words appear
  const adminKw = ["admin", "administrative", "fsr completion", "paperwork", "conference call", "meeting with team", "office work", "desk work"];
  const serviceKw = ["service call", "serviced", "field service", "treatment", "chemical feed", "dosing", "sampling", "disinfection", "legionella", "boiler", "cooling tower", "repair", "installed equipment", "maintenance"];
  for (const k of dmKw) if (t.includes(k)) return "dm";
  for (const k of adminKw) if (t.includes(k)) return "admin"; // admin before service
  for (const k of serviceKw) if (t.includes(k)) return "service";
  return "sales";
}

function useStateRef(initial) {
  const [state, setState] = useState(initial);
  const ref = useRef(initial);
  const set = useCallback((val) => { ref.current = val; setState(val); }, []);
  return [state, ref, set];
}

export default function App() {
  const [sheetUrl, setSheetUrl] = useState(() => localStorage.getItem("gc_sheet_url") || "");
  const [spreadsheetId, setSpreadsheetId] = useState(() => {
    const saved = localStorage.getItem("gc_sheet_url") || "";
    return getSpreadsheetIdFromUrl(saved);
  });
  const [sheetConnected, setSheetConnected] = useState(() => !!localStorage.getItem("gc_sheet_url") && !!getSpreadsheetIdFromUrl(localStorage.getItem("gc_sheet_url") || ""));
  const [sheetName, setSheetName] = useState(() => localStorage.getItem("gc_sheet_name") || "");
  const [userName, setUserName] = useState(() => localStorage.getItem("gc_user_name") || "");
  const [nameSet, setNameSet] = useState(() => !!localStorage.getItem("gc_user_name"));

  const [selectedDay, setSelectedDay] = useState(TODAY_IDX);
  const [entryType, setEntryType] = useState("sales");
  const [entries, setEntries] = useState({ 0: [], 1: [], 2: [], 3: [], 4: [] });
  const [currentTranscript, setCurrentTranscript] = useState("");
  const [aiProcessed, setAiProcessed] = useState("");
  const [isProcessing, setIsProcessing] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);
  const [syncStatus, setSyncStatus] = useState("");
  const [syncLog, setSyncLog] = useState([]);
  const [showLog, setShowLog] = useState(false);
  const [isFinalizing, setIsFinalizing] = useState(false);
  const [finalizeStatus, setFinalizeStatus] = useState("");

  const [isRecording, isRecordingRef, setIsRecording] = useStateRef(false);
  const recognitionRef = useRef(null);
  const confirmedDayRef = useRef(TODAY_IDX);

  const [qaAnswers, setQaAnswers] = useState({ renewals: "", jeopardy: "", tssSupport: "", growth: "", comments: "" });

  async function connectSheet() {
    const id = getSpreadsheetIdFromUrl(sheetUrl);
    if (!id) { setSyncStatus("⚠️ Invalid Google Sheets URL."); return; }
    setSyncStatus("Connecting...");
    try {
      const res = await fetch("/api/sheets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "read", spreadsheetId: id, range: `${SPREADSHEET_TAB}!A1:A5` }),
      });
      const data = await res.json();
      if (data.error) { setSyncStatus(`⚠️ ${data.error}`); return; }
      localStorage.setItem("gc_sheet_url", sheetUrl);
      localStorage.setItem("gc_sheet_name", data.sheetName || "GC Weekly Report");
      setSpreadsheetId(id);
      setSheetName(data.sheetName || "GC Weekly Report");
      setSheetConnected(true);
      setSyncStatus(`✅ Connected!`);
    } catch (e) { setSyncStatus(`⚠️ ${e.message}`); }
  }

  function startRecording() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) { setSyncStatus("⚠️ Voice not supported. Use Chrome (Android) or Safari (iOS)."); return; }
    const rec = new SR();
    rec.continuous = true;  // keep mic open so low voice / unstable phone doesn't stop early
    rec.interimResults = true;
    rec.lang = "en-US";
    rec.maxAlternatives = 1;
    let accumulated = "";
    rec.onresult = (e) => {
      let interim = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        if (e.results[i].isFinal) accumulated += e.results[i][0].transcript + " ";
        else interim = e.results[i][0].transcript;
      }
      const t = (accumulated + interim).trim();
      setCurrentTranscript(t);
      const detDay = detectDayFromText(t);
      const detType = detectTypeFromText(t);
      if (detDay !== null) { confirmedDayRef.current = detDay; setSelectedDay(detDay); }
      else { confirmedDayRef.current = TODAY_IDX; }
      if (detType) setEntryType(detType);
    };
    rec.onerror = () => setIsRecording(false);
    rec.onend = () => setIsRecording(false);
    rec.start();
    recognitionRef.current = rec;
    setIsRecording(true);
  }

  function stopRecording() { recognitionRef.current?.stop(); setIsRecording(false); }
  function toggleRecording() { isRecordingRef.current ? stopRecording() : startRecording(); }

  async function processWithAI() {
    if (!currentTranscript.trim()) return;
    setIsProcessing(true); setAiProcessed("");
    try {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "claude-sonnet-4-20250514",
          max_tokens: 1000,
          messages: [{ role: "user", content: `You are a field sales assistant for Garratt-Callahan water treatment. Clean up this voice-dictated work log entry into ONE professional sentence under 20 words. Rules: (1) Remove ALL day/time references: "yesterday", "today", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "this morning", "this afternoon" (2) Remove filler: "I did", "I called", "I went", "I did some", "such as", "etc" (3) Start with the action verb or customer name (4) Preserve customer names, specific actions, next steps (5) Respond with ONLY the final sentence, nothing else.\n\nExamples:\n"yesterday I did service call on Omni Hospital" → "Serviced Omni Hospital."\n"today I called Jensen Foods Juan Carlos to get water use log" → "Called Jensen Foods; Juan Carlos to provide water use log."\n"Thursday I did administrative work FSR completion" → "Completed FSRs; administrative work."\n"I met with Heritage bag to review the scale process" → "Met with Heritage Bag; reviewed descale process."\n\nNow clean this: "${currentTranscript}"` }],
        }),
      });
      const data = await res.json();
      setAiProcessed(data.content?.[0]?.text?.trim() || currentTranscript);
    } catch { setAiProcessed(currentTranscript); }
    setIsProcessing(false);
  }

  function addEntry() {
    const text = aiProcessed || currentTranscript;
    if (!text.trim()) return;
    const targetDay = confirmedDayRef.current;
    setEntries((prev) => ({ ...prev, [targetDay]: [...(prev[targetDay] || []), { type: entryType, text, day: targetDay }] }));
    setCurrentTranscript(""); setAiProcessed("");
  }

  function removeEntry(dayIdx, idx) {
    setEntries((prev) => ({ ...prev, [dayIdx]: prev[dayIdx].filter((_, i) => i !== idx) }));
  }

  async function finalizeWeek() {
    if (!spreadsheetId) return;
    setIsFinalizing(true);
    setFinalizeStatus("Finalizing weekly report...");
    try {
      const res = await fetch("/api/sheets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "finalize", spreadsheetId, tab: SPREADSHEET_TAB }),
      });
      const data = await res.json();
      if (data.error) {
        setFinalizeStatus(`⚠️ ${data.error}`);
      } else {
        setFinalizeStatus(`✅ Report saved as "${data.copyName}". Template cleared for next week.`);
      }
    } catch (e) {
      setFinalizeStatus(`⚠️ ${e.message}`);
    }
    setIsFinalizing(false);
  }

  async function syncToSheet() {
    if (!spreadsheetId) return;
    setIsSyncing(true); setSyncStatus("Reading sheet..."); setSyncLog([]); setShowLog(true);
    const log = [];

    try {
      const readRes = await fetch("/api/sheets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "read", spreadsheetId, range: `${SPREADSHEET_TAB}!A1:N80` }),
      });
      const readData = await readRes.json();
      if (readData.error) { setSyncStatus(`⚠️ ${readData.error}`); setIsSyncing(false); return; }

      const rows = readData.values || [];
      log.push(`📋 Read ${rows.length} rows`);

      const dayPositions = {};
      rows.forEach((row, idx) => {
        const cell = (row[0] || "").trim().toLowerCase();
        DAYS.forEach((d) => { if (cell === d.toLowerCase() || cell.startsWith(d.toLowerCase() + " ")) dayPositions[d] = idx; });
      });
      log.push(`📍 Days: ${JSON.stringify(dayPositions)}`);

      if (!Object.keys(dayPositions).length) {
        setSyncStatus("⚠️ Day labels not found in column A"); setSyncLog(log); setIsSyncing(false); return;
      }

      const batchData = [];
      DAYS.forEach((day, dayIdx) => {
        const dayEntries = entries[dayIdx];
        if (!dayEntries.length) return;
        const dayRow = dayPositions[day];
        if (dayRow === undefined) { log.push(`⚠️ "${day}" not found`); return; }
        const nextDayRow = DAYS.slice(dayIdx + 1).reduce((found, nd) =>
          found !== null ? found : (dayPositions[nd] !== undefined ? dayPositions[nd] : null), null) ?? rows.length;

        const cursors = { [COL_SALES]: dayRow + 1, [COL_SERVICE]: dayRow + 1, [COL_DM]: dayRow + 1 };
        dayEntries.forEach((entry) => {
          const colIdx = entry.type === "service" ? COL_SERVICE : entry.type === "dm" ? COL_DM : COL_SALES;
          let r = cursors[colIdx];
          while (r < nextDayRow && (rows[r]?.[colIdx] || "").toString().trim()) r++;
          if (r >= nextDayRow) r = nextDayRow - 1;
          const range = `'${SPREADSHEET_TAB}'!${colLetter(colIdx)}${r + 1}`;
          batchData.push({ range, values: [[entry.text]] });
          log.push(`✍️ ${day}/${entry.type} → ${colLetter(colIdx)}${r + 1}: "${entry.text.slice(0, 30)}"`);
          cursors[colIdx] = r + 1;
        });
      });

      const qaMap = { renewals: ["renewed", "up to date"], jeopardy: ["jeopardy"], tssSupport: ["tss"], growth: ["personal dev"], comments: ["other comments"] };
      rows.forEach((row, idx) => {
        const cell = (row[0] || "").toLowerCase();
        Object.entries(qaMap).forEach(([key, kws]) => {
          if (qaAnswers[key] && kws.some(kw => cell.includes(kw)))
            batchData.push({ range: `'${SPREADSHEET_TAB}'!B${idx + 2}`, values: [[qaAnswers[key]]] });
        });
      });

      if (!batchData.length) { setSyncStatus("⚠️ Nothing to write"); setSyncLog(log); setIsSyncing(false); return; }

      const writeRes = await fetch("/api/sheets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "write", spreadsheetId, data: batchData }),
      });
      const writeData = await writeRes.json();
      if (writeData.error) {
        log.push(`❌ ${writeData.error}`); setSyncStatus(`⚠️ ${writeData.error}`);
      } else {
        log.push(`✅ ${writeData.updatedCells} cells written`);
        setSyncStatus(`✅ Synced! ${writeData.updatedCells} cell(s) updated.`);
        setEntries({ 0: [], 1: [], 2: [], 3: [], 4: [] });
        setQaAnswers({ renewals: "", jeopardy: "", tssSupport: "", growth: "", comments: "" });
      }
    } catch (e) { log.push(`❌ ${e.message}`); setSyncStatus(`⚠️ ${e.message}`); }
    setSyncLog(log); setIsSyncing(false);
  }

  const [isFinalizing, setIsFinalizing] = useState(false);
  const [finalizeStatus, setFinalizeStatus] = useState("");
  const totalEntries = Object.values(entries).flat().length;
  async function finalizeSheet() {
    if (!spreadsheetId) return;
    const confirmed = window.confirm("Finalize this week's report?\n\nThis will:\n• Copy the sheet as a new dated file\n• Clear the original template for next week");
    if (!confirmed) return;
    setIsFinalizing(true); setFinalizeStatus("Finalizing...");
    try {
      const res = await fetch("/api/sheets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "finalize", spreadsheetId }),
      });
      const data = await res.json();
      if (data.error) { setFinalizeStatus(`⚠️ ${data.error}`); }
      else { setFinalizeStatus(`✅ Saved as "${data.fileName}". Template cleared for next week.`); }
    } catch (e) { setFinalizeStatus(`⚠️ ${e.message}`); }
    setIsFinalizing(false);
  }

  const TYPE_CONFIG = [
    { id: "sales", label: "💼 Sales / Biz Dev", col: "#1a6b3c" },
    { id: "service", label: "🔧 Service Call", col: "#1a4b8a" },
    { id: "admin", label: "📁 Admin", col: "#6b451a" },
    { id: "dm", label: "🏢 DM Support", col: "#6b1a5a" },
  ];

  // Name setup screen
  if (!nameSet) {
    return (
      <div style={S.root}>
        <div style={S.header}>
          <div style={S.headerLeft}>
            <div style={S.logo}>GC</div>
            <div><div style={S.appTitle}>Field Task Logger</div><div style={S.appSub}>Garratt-Callahan</div></div>
          </div>
        </div>
        <div style={S.body}>
          <div style={S.card}>
            <div style={S.welcomeIcon}>👤</div>
            <div style={S.welcomeTitle}>Who are you?</div>
            <div style={S.welcomeSub}>Enter your name to get started. This is saved on your device.</div>
            <input style={S.input} placeholder="e.g. John Ruiz" value={userName} onChange={e => setUserName(e.target.value)} />
            <button style={S.primaryBtn} onClick={() => { if (userName.trim()) { localStorage.setItem("gc_user_name", userName.trim()); setNameSet(true); } }}>
              Continue
            </button>
          </div>
        </div>
      </div>
    );
  }

  // Sheet connect screen
  if (!sheetConnected) {
    return (
      <div style={S.root}>
        <div style={S.header}>
          <div style={S.headerLeft}>
            <div style={S.logo}>GC</div>
            <div><div style={S.appTitle}>Field Task Logger</div><div style={S.appSub}>Hi {userName} 👋</div></div>
          </div>
        </div>
        <div style={S.body}>
          <div style={S.card}>
            <div style={S.cardTitle}>📋 Connect Your Google Sheet</div>
            <div style={S.cardSub}>Paste the full URL of your Weekly Report Google Sheet</div>
            <input style={S.input} placeholder="https://docs.google.com/spreadsheets/d/..." value={sheetUrl} onChange={(e) => setSheetUrl(e.target.value)} />
            <button style={S.primaryBtn} onClick={connectSheet}>Connect Sheet</button>
            {syncStatus && <div style={S.statusMsg}>{syncStatus}</div>}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div style={S.root}>
      <div style={S.header}>
        <div style={S.headerLeft}>
          <div style={S.logo}>GC</div>
          <div><div style={S.appTitle}>Field Task Logger</div><div style={S.appSub}>Garratt-Callahan · {userName}</div></div>
        </div>
        <div style={{display:"flex",gap:6}}>
          <button style={S.signOutBtn} onClick={() => { localStorage.removeItem("gc_sheet_url"); localStorage.removeItem("gc_sheet_name"); setSheetConnected(false); setSpreadsheetId(null); setSheetUrl(""); setSyncStatus(""); }}>📋 Change Sheet</button>
          <button style={S.signOutBtn} onClick={() => { localStorage.clear(); setNameSet(false); setSheetConnected(false); setSpreadsheetId(null); setSheetUrl(""); setUserName(""); }}>Reset</button>
        </div>
      </div>

      <div style={S.body}>
        <div style={S.sheetBadge}>
          <span>📊</span><span>{sheetName}</span>
          <span style={{ marginLeft: "auto", color: "#64748b", fontSize: 11 }}>Week of {getCurrentWeekOf()}</span>
        </div>

        <div style={S.dayRow}>
          {DAYS.map((d, i) => (
            <button key={d} style={{ ...S.dayBtn, ...(selectedDay === i ? S.dayBtnActive : {}) }}
              onClick={() => { setSelectedDay(i); confirmedDayRef.current = i; }}>
              <span style={{ fontSize: 12, fontWeight: 700 }}>{d.slice(0, 3)}</span>
              {entries[i].length > 0 && <span style={S.dayCount}>{entries[i].length}</span>}
            </button>
          ))}
        </div>

        <div style={S.typeGrid}>
          {TYPE_CONFIG.map((t) => (
            <button key={t.id} style={{ ...S.typeBtn, ...(entryType === t.id ? { background: t.col, color: "#fff", borderColor: t.col } : {}) }}
              onClick={() => setEntryType(t.id)}>{t.label}</button>
          ))}
        </div>

        <div style={S.card}>
          <div style={S.cardTitle}>{DAYS[selectedDay]} — {TYPE_CONFIG.find(t => t.id === entryType)?.label}</div>
          <button style={{ ...S.recordBtn, ...(isRecording ? S.recordBtnActive : {}) }} onClick={toggleRecording}>
            <span style={{ fontSize: 24 }}>{isRecording ? "⏹" : "🎙️"}</span>
            <span>{isRecording ? "Tap to Stop" : "Tap to Record"}</span>
          </button>
          {isRecording && <div style={S.listeningBadge}>● Listening...</div>}

          {currentTranscript && (
            <div style={S.transcriptBox}>
              <div style={S.transcriptLabel}>📝 Transcript</div>
              <div style={{ fontSize: 13, color: "#cbd5e1", lineHeight: 1.5 }}>{currentTranscript}</div>
            </div>
          )}

          {currentTranscript && !aiProcessed && (
            <button style={S.aiBtn} onClick={processWithAI} disabled={isProcessing}>
              {isProcessing ? "✨ Cleaning up..." : "✨ Clean Up with AI"}
            </button>
          )}

          {aiProcessed && (
            <div style={S.aiBox}>
              <div style={{ fontSize: 10, color: "#4ade80", fontWeight: 700, marginBottom: 6, textTransform: "uppercase" }}>✅ AI-Cleaned Entry</div>
              <textarea style={S.aiTextarea} value={aiProcessed} onChange={(e) => setAiProcessed(e.target.value)} rows={2} />
            </div>
          )}

          {(currentTranscript || aiProcessed) && (
            <button style={S.addBtn} onClick={addEntry}>+ Add</button>
          )}
        </div>

        {DAYS.map((day, dayIdx) => {
          const de = entries[dayIdx];
          if (!de.length) return null;
          return (
            <div key={day} style={S.entriesCard}>
              <div style={S.entriesDay}>{day}</div>
              {de.map((e, i) => (
                <div key={i} style={S.entryRow}>
                  <span style={{ fontSize: 16, flexShrink: 0 }}>{e.type === "sales" ? "💼" : e.type === "service" ? "🔧" : e.type === "dm" ? "🏢" : "📁"}</span>
                  <span style={{ flex: 1, fontSize: 13, color: "#e2e8f0", lineHeight: 1.4 }}>{e.text}</span>
                  <button style={S.removeBtn} onClick={() => removeEntry(dayIdx, i)}>✕</button>
                </div>
              ))}
            </div>
          );
        })}

        <div style={S.card}>
          <div style={S.cardTitle}>📋 End-of-Week Questions</div>
          {[
            { key: "renewals", label: "Accounts renewed/up to date? Any expiring in 30 days?" },
            { key: "jeopardy", label: "Accounts in jeopardy? Actions to save them?" },
            { key: "tssSupport", label: "Enough TSS support? Ideas for more?" },
            { key: "growth", label: "Personal development goals this week?" },
            { key: "comments", label: "Other comments?" },
          ].map(({ key, label }) => (
            <div key={key} style={{ marginBottom: 12 }}>
              <div style={{ fontSize: 12, color: "#94a3b8", marginBottom: 4, fontWeight: 600 }}>{label}</div>
              <textarea style={S.qaInput} value={qaAnswers[key]} onChange={(e) => setQaAnswers((p) => ({ ...p, [key]: e.target.value }))} placeholder="Type your answer..." rows={2} />
            </div>
          ))}
        </div>

        <div style={{ marginBottom: 24 }}>
          {syncStatus && <div style={S.statusMsg}>{syncStatus}</div>}
          {syncLog.length > 0 && (
            <div style={{ marginBottom: 8 }}>
              <button style={S.logToggle} onClick={() => setShowLog(v => !v)}>
                {showLog ? "▲ Hide" : "▼ Show"} Sync Log
              </button>
              {showLog && (
                <div style={S.syncLogBox}>
                  {syncLog.map((l, i) => (
                    <div key={i} style={{ fontSize: 11, color: l.startsWith("❌") ? "#f87171" : l.startsWith("✅") ? "#4ade80" : l.startsWith("✍️") ? "#93c5fd" : "#64748b", marginBottom: 2 }}>{l}</div>
                  ))}
                </div>
              )}
            </div>
          )}
          <button style={{ ...S.syncBtn, ...(isSyncing || !totalEntries ? S.syncBtnOff : {}) }} onClick={syncToSheet} disabled={isSyncing || !totalEntries}>
            {isSyncing ? "Syncing..." : `📤 Sync ${totalEntries} Entr${totalEntries === 1 ? "y" : "ies"} to Google Sheets`}
          </button>

          <div style={S.divider} />
          <div style={S.finalizeSection}>
            <div style={S.finalizeTitle}>🏁 End of Week</div>
            <div style={S.finalizeSub}>Saves a copy of this week's report, clears the template, and updates the date for next week.</div>
            {finalizeStatus && <div style={{...S.statusMsg, marginBottom: 8}}>{finalizeStatus}</div>}
            <button style={{ ...S.finalizeBtn, ...(isFinalizing ? S.syncBtnOff : {}) }} onClick={finalizeWeek} disabled={isFinalizing}>
              {isFinalizing ? "Finalizing..." : "🏁 Finalize & Archive This Week"}
            </button>
          </div>
        </div>

        {/* Finalize Button */}
        <div style={S.finalizeSection}>
          <div style={{ fontSize: 12, color: "#64748b", marginBottom: 8, textAlign: "center" }}>
            Ready to submit? Finalize copies the report and clears the template.
          </div>
          {finalizeStatus && <div style={S.statusMsg}>{finalizeStatus}</div>}
          <button
            style={{ ...S.finalizeBtn, ...(isFinalizing ? S.syncBtnOff : {}) }}
            onClick={finalizeSheet}
            disabled={isFinalizing}
          >
            {isFinalizing ? "Finalizing..." : "🏁 Finalize & Submit Report"}
          </button>
        </div>
      </div>
    </div>
  );
}

const S = {
  root: { fontFamily: "'DM Sans','Segoe UI',sans-serif", background: "#0f172a", minHeight: "100vh", color: "#e2e8f0", maxWidth: 480, margin: "0 auto" },
  header: { background: "#1e293b", padding: "14px 16px", display: "flex", alignItems: "center", justifyContent: "space-between", borderBottom: "1px solid #334155", position: "sticky", top: 0, zIndex: 10 },
  headerLeft: { display: "flex", alignItems: "center", gap: 10 },
  logo: { background: "#2563eb", color: "#fff", fontWeight: 800, fontSize: 14, width: 36, height: 36, borderRadius: 8, display: "flex", alignItems: "center", justifyContent: "center" },
  appTitle: { fontWeight: 700, fontSize: 15, color: "#f1f5f9" },
  appSub: { fontSize: 11, color: "#94a3b8" },
  signOutBtn: { background: "transparent", color: "#64748b", border: "1px solid #334155", borderRadius: 6, padding: "4px 10px", fontSize: 11, cursor: "pointer" },
  body: { padding: "16px 14px 40px" },
  card: { background: "#1e293b", borderRadius: 14, padding: 16, marginBottom: 14, border: "1px solid #334155" },
  cardTitle: { fontWeight: 700, fontSize: 15, marginBottom: 4, color: "#f1f5f9" },
  cardSub: { fontSize: 12, color: "#94a3b8", marginBottom: 12 },
  input: { width: "100%", background: "#0f172a", border: "1px solid #334155", borderRadius: 8, padding: "10px 12px", color: "#e2e8f0", fontSize: 13, marginBottom: 10, boxSizing: "border-box", outline: "none", fontFamily: "inherit" },
  primaryBtn: { background: "#2563eb", color: "#fff", border: "none", borderRadius: 10, padding: "12px 20px", fontSize: 14, fontWeight: 600, cursor: "pointer", width: "100%" },
  welcomeIcon: { fontSize: 48, textAlign: "center", marginBottom: 8 },
  welcomeTitle: { fontWeight: 700, fontSize: 18, color: "#f1f5f9", textAlign: "center", marginBottom: 6 },
  welcomeSub: { fontSize: 13, color: "#94a3b8", textAlign: "center", marginBottom: 16, lineHeight: 1.5 },
  sheetBadge: { background: "#1e3a5f", borderRadius: 10, padding: "8px 14px", display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: "#93c5fd", marginBottom: 14 },
  dayRow: { display: "flex", gap: 6, marginBottom: 12 },
  dayBtn: { flex: 1, background: "#1e293b", border: "1px solid #334155", borderRadius: 10, padding: "8px 4px", color: "#94a3b8", fontSize: 12, fontWeight: 600, cursor: "pointer", display: "flex", flexDirection: "column", alignItems: "center", gap: 3 },
  dayBtnActive: { background: "#2563eb", borderColor: "#2563eb", color: "#fff" },
  dayCount: { background: "#ef4444", color: "#fff", borderRadius: 999, fontSize: 10, fontWeight: 700, padding: "1px 5px" },
  typeGrid: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6, marginBottom: 12 },
  typeBtn: { background: "#1e293b", border: "1px solid #334155", borderRadius: 8, padding: "10px 6px", color: "#94a3b8", fontSize: 12, fontWeight: 600, cursor: "pointer" },
  recordBtn: { width: "100%", background: "#1a4b1a", border: "2px solid #22c55e", borderRadius: 12, padding: 18, color: "#4ade80", fontSize: 16, fontWeight: 700, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: 10, marginBottom: 12 },
  recordBtnActive: { background: "#4a1a1a", border: "2px solid #ef4444", color: "#f87171" },
  listeningBadge: { textAlign: "center", color: "#f87171", fontSize: 12, fontWeight: 600, marginBottom: 8 },
  transcriptBox: { background: "#0f172a", borderRadius: 8, padding: 12, marginBottom: 10, border: "1px solid #334155" },
  transcriptLabel: { fontSize: 10, color: "#64748b", fontWeight: 700, marginBottom: 4, textTransform: "uppercase" },
  aiBtn: { width: "100%", background: "#2d1b69", border: "1px solid #6d28d9", borderRadius: 8, padding: 10, color: "#c4b5fd", fontSize: 13, fontWeight: 600, cursor: "pointer", marginBottom: 10 },
  aiBox: { background: "#0f172a", borderRadius: 8, padding: 12, marginBottom: 10, border: "1px solid #22c55e" },
  aiTextarea: { width: "100%", background: "transparent", border: "none", color: "#e2e8f0", fontSize: 13, resize: "none", outline: "none", lineHeight: 1.5, boxSizing: "border-box", fontFamily: "inherit" },
  addBtn: { width: "100%", background: "#065f46", border: "1px solid #10b981", borderRadius: 8, padding: 11, color: "#6ee7b7", fontSize: 14, fontWeight: 700, cursor: "pointer" },
  entriesCard: { background: "#1e293b", borderRadius: 14, padding: 14, marginBottom: 10, border: "1px solid #334155" },
  entriesDay: { fontWeight: 700, fontSize: 13, color: "#94a3b8", marginBottom: 8, textTransform: "uppercase", letterSpacing: 1 },
  entryRow: { display: "flex", alignItems: "flex-start", gap: 8, padding: "8px 0", borderBottom: "1px solid #0f172a" },
  removeBtn: { background: "transparent", border: "none", color: "#64748b", fontSize: 14, cursor: "pointer", padding: "2px 4px" },
  qaInput: { width: "100%", background: "#0f172a", border: "1px solid #334155", borderRadius: 8, padding: "8px 10px", color: "#e2e8f0", fontSize: 13, resize: "none", outline: "none", boxSizing: "border-box", fontFamily: "inherit", lineHeight: 1.4 },
  syncBtn: { width: "100%", background: "#1d4ed8", border: "none", borderRadius: 12, padding: 16, color: "#fff", fontSize: 15, fontWeight: 700, cursor: "pointer" },
  syncBtnOff: { background: "#334155", color: "#64748b", cursor: "not-allowed" },
  statusMsg: { fontSize: 13, color: "#94a3b8", marginBottom: 8, padding: "8px 12px", background: "#0f172a", borderRadius: 8 },
  logToggle: { background: "transparent", border: "1px solid #334155", borderRadius: 6, padding: "4px 10px", color: "#64748b", fontSize: 11, cursor: "pointer", marginBottom: 4, width: "100%" },
  syncLogBox: { background: "#0f172a", borderRadius: 8, padding: "10px 12px", border: "1px solid #1e293b", maxHeight: 200, overflowY: "auto" },
  finalizeSection: { background: "#1e293b", borderRadius: 14, padding: 16, marginBottom: 24, border: "1px dashed #334155" },
  finalizeBtn: { width: "100%", background: "#7c3aed", border: "none", borderRadius: 12, padding: 16, color: "#fff", fontSize: 15, fontWeight: 700, cursor: "pointer" },
};
