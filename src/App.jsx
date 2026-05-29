import { useState, useRef, useEffect, useCallback } from "react";

// ─── CONFIG ────────────────────────────────────────────────────────────────
// Replace with your Google OAuth Client ID from console.cloud.google.com
const GOOGLE_CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID || "YOUR_GOOGLE_CLIENT_ID";
const SCOPES = "https://www.googleapis.com/auth/spreadsheets";
const SPREADSHEET_TAB = "Friday Report";

const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"];
const TODAY_IDX = Math.min(Math.max(new Date().getDay() - 1, 0), 4);

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

function useStateRef(initial) {
  const [state, setState] = useState(initial);
  const ref = useRef(initial);
  const setStateRef = useCallback((val) => {
    ref.current = val;
    setState(val);
  }, []);
  return [state, ref, setStateRef];
}

export default function App() {
  const [tokenClient, setTokenClient] = useState(null);
  const [accessToken, setAccessToken] = useState(null);
  const [userEmail, setUserEmail] = useState("");
  const [authLoading, setAuthLoading] = useState(false);

  const [sheetUrl, setSheetUrl] = useState(() => localStorage.getItem("gc_sheet_url") || "");
  const [spreadsheetId, setSpreadsheetId] = useState(null);
  const [sheetConnected, setSheetConnected] = useState(false);
  const [sheetName, setSheetName] = useState("");

  const [selectedDay, setSelectedDay] = useState(TODAY_IDX);
  const [entryType, setEntryType] = useState("sales");
  const [entries, setEntries] = useState({ 0: [], 1: [], 2: [], 3: [], 4: [] });
  const [currentTranscript, setCurrentTranscript] = useState("");
  const [aiProcessed, setAiProcessed] = useState("");
  const [isProcessing, setIsProcessing] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);
  const [syncStatus, setSyncStatus] = useState("");

  const [isRecording, isRecordingRef, setIsRecording] = useStateRef(false);
  const recognitionRef = useRef(null);

  const [qaAnswers, setQaAnswers] = useState({
    renewals: "",
    jeopardy: "",
    tssSupport: "",
    growth: "",
    comments: "",
  });

  // Load Google Identity Services
  useEffect(() => {
    const script = document.createElement("script");
    script.src = "https://accounts.google.com/gsi/client";
    script.onload = () => {
      if (window.google) {
        const tc = window.google.accounts.oauth2.initTokenClient({
          client_id: GOOGLE_CLIENT_ID,
          scope: SCOPES,
          callback: (resp) => {
            if (resp.access_token) {
              setAccessToken(resp.access_token);
              fetchUserInfo(resp.access_token);
            }
            setAuthLoading(false);
          },
        });
        setTokenClient(tc);
      }
    };
    document.head.appendChild(script);
  }, []);

  async function fetchUserInfo(token) {
    try {
      const res = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json();
      setUserEmail(data.email || "");
    } catch {}
  }

  function handleSignIn() {
    setAuthLoading(true);
    tokenClient?.requestAccessToken();
  }

  function handleSignOut() {
    if (accessToken && window.google) {
      window.google.accounts.oauth2.revoke(accessToken);
    }
    setAccessToken(null);
    setUserEmail("");
    setSheetConnected(false);
    setSpreadsheetId(null);
    setSyncStatus("");
  }

  async function connectSheet() {
    const id = getSpreadsheetIdFromUrl(sheetUrl);
    if (!id) {
      setSyncStatus("⚠️ Invalid Google Sheets URL.");
      return;
    }
    localStorage.setItem("gc_sheet_url", sheetUrl);
    try {
      const res = await fetch(
        `https://sheets.googleapis.com/v4/spreadsheets/${id}?fields=properties.title,sheets.properties.title`,
        { headers: { Authorization: `Bearer ${accessToken}` } }
      );
      const data = await res.json();
      if (data.error) { setSyncStatus(`⚠️ ${data.error.message}`); return; }
      const tabs = data.sheets?.map((s) => s.properties.title) || [];
      if (!tabs.includes(SPREADSHEET_TAB)) {
        setSyncStatus(`⚠️ Tab "${SPREADSHEET_TAB}" not found. Tabs: ${tabs.join(", ")}`);
        return;
      }
      setSpreadsheetId(id);
      setSheetName(data.properties?.title || "");
      setSheetConnected(true);
      setSyncStatus(`✅ Connected to "${data.properties?.title}"`);
    } catch {
      setSyncStatus("⚠️ Could not connect. Check the URL.");
    }
  }

  function startRecording() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) { setSyncStatus("⚠️ Voice not supported. Use Chrome (Android) or Safari (iOS)."); return; }
    const rec = new SR();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = "en-US";
    let final = "";
    rec.onresult = (e) => {
      let interim = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        if (e.results[i].isFinal) final += e.results[i][0].transcript + " ";
        else interim += e.results[i][0].transcript;
      }
      setCurrentTranscript(final + interim);
    };
    rec.onerror = () => { setIsRecording(false); };
    rec.onend = () => { setIsRecording(false); };
    rec.start();
    recognitionRef.current = rec;
    setIsRecording(true);
  }

  function stopRecording() {
    recognitionRef.current?.stop();
    setIsRecording(false);
  }

  function toggleRecording() {
    isRecordingRef.current ? stopRecording() : startRecording();
  }

  async function processWithAI() {
    if (!currentTranscript.trim()) return;
    setIsProcessing(true);
    setAiProcessed("");
    try {
      const typeLabel =
        entryType === "sales" ? "New Business / Sales Activity" :
        entryType === "service" ? "Service Call" : "Administrative";
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "claude-sonnet-4-20250514",
          max_tokens: 1000,
          messages: [{
            role: "user",
            content: `Clean up this voice-dictated work log into a concise professional one-liner under 25 words. Preserve customer names, actions, and next steps. Remove filler words. Respond with ONLY the cleaned text.\n\nCategory: ${typeLabel}\nDay: ${DAYS[selectedDay]}\nRaw: "${currentTranscript}"`
          }],
        }),
      });
      const data = await res.json();
      setAiProcessed(data.content?.[0]?.text?.trim() || currentTranscript);
    } catch {
      setAiProcessed(currentTranscript);
    }
    setIsProcessing(false);
  }

  function addEntry() {
    const text = aiProcessed || currentTranscript;
    if (!text.trim()) return;
    setEntries((prev) => ({
      ...prev,
      [selectedDay]: [...prev[selectedDay], { type: entryType, text, raw: currentTranscript }],
    }));
    setCurrentTranscript("");
    setAiProcessed("");
  }

  function removeEntry(dayIdx, idx) {
    setEntries((prev) => ({ ...prev, [dayIdx]: prev[dayIdx].filter((_, i) => i !== idx) }));
  }

  async function syncToSheet() {
    if (!spreadsheetId || !accessToken) return;
    setIsSyncing(true);
    setSyncStatus("Syncing to Google Sheets...");
    try {
      const readRes = await fetch(
        `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(SPREADSHEET_TAB)}!A1:M60`,
        { headers: { Authorization: `Bearer ${accessToken}` } }
      );
      const readData = await readRes.json();
      const rows = readData.values || [];

      const dayRowMap = {};
      rows.forEach((row, idx) => {
        const cell = (row[0] || "").trim().toLowerCase();
        DAYS.forEach((d) => { if (cell.startsWith(d.toLowerCase())) dayRowMap[d] = idx + 1; });
      });

      const batchData = [];
      DAYS.forEach((day, dayIdx) => {
        const dayEntries = entries[dayIdx];
        if (!dayEntries.length) return;
        const rowNum = dayRowMap[day];
        if (!rowNum) return;
        const salesLines = dayEntries.filter((e) => e.type === "sales" || e.type === "admin").map((e) => e.text);
        const serviceLines = dayEntries.filter((e) => e.type === "service").map((e) => e.text);
        if (salesLines.length) batchData.push({ range: `${SPREADSHEET_TAB}!B${rowNum + 1}`, values: [[salesLines.join("; ")]] });
        if (serviceLines.length) batchData.push({ range: `${SPREADSHEET_TAB}!E${rowNum + 1}`, values: [[serviceLines.join("; ")]] });
      });

      const qaMap = { renewals: "renewed and up to date", jeopardy: "jeopardy", tssSupport: "TSS support", growth: "personal develpment", comments: "Other Comments" };
      rows.forEach((row, idx) => {
        const cell = (row[0] || "").toLowerCase();
        Object.entries(qaMap).forEach(([key, kw]) => {
          if (cell.includes(kw.toLowerCase()) && qaAnswers[key])
            batchData.push({ range: `${SPREADSHEET_TAB}!B${idx + 2}`, values: [[qaAnswers[key]]] });
        });
      });

      if (!batchData.length) { setSyncStatus("⚠️ No entries to sync."); setIsSyncing(false); return; }

      const writeRes = await fetch(
        `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values:batchUpdate`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
          body: JSON.stringify({ valueInputOption: "USER_ENTERED", data: batchData }),
        }
      );
      const writeData = await writeRes.json();
      setSyncStatus(writeData.error ? `⚠️ ${writeData.error.message}` : `✅ Synced ${batchData.length} update(s) to Google Sheets!`);
    } catch { setSyncStatus("⚠️ Sync failed. Check connection."); }
    setIsSyncing(false);
  }

  const isLoggedIn = !!accessToken;
  const totalEntries = Object.values(entries).flat().length;

  return (
    <div style={S.root}>
      {/* Header */}
      <div style={S.header}>
        <div style={S.headerLeft}>
          <div style={S.logo}>GC</div>
          <div>
            <div style={S.appTitle}>Field Task Logger</div>
            <div style={S.appSub}>Garratt-Callahan · Weekly Report</div>
          </div>
        </div>
        <div>
          {isLoggedIn ? (
            <div style={S.userBadge}>
              <span style={S.userEmail}>{userEmail}</span>
              <button style={S.signOutBtn} onClick={handleSignOut}>Sign Out</button>
            </div>
          ) : (
            <button style={S.signInBtn} onClick={handleSignIn} disabled={authLoading}>
              {authLoading ? "Connecting..." : "Sign in with Google"}
            </button>
          )}
        </div>
      </div>

      <div style={S.body}>
        {/* Welcome / Sign In */}
        {!isLoggedIn && (
          <div style={S.card}>
            <div style={S.welcomeIcon}>🎙️</div>
            <div style={S.welcomeTitle}>Field Task Logger</div>
            <div style={S.welcomeSub}>Sign in with your Google account to log tasks by voice and sync to your Weekly Report spreadsheet.</div>
            <button style={S.primaryBtn} onClick={handleSignIn} disabled={authLoading}>
              {authLoading ? "Connecting..." : "Sign in with Google"}
            </button>
          </div>
        )}

        {/* Connect Sheet */}
        {isLoggedIn && !sheetConnected && (
          <div style={S.card}>
            <div style={S.cardTitle}>📋 Connect Your Google Sheet</div>
            <div style={S.cardSub}>Paste the full URL of your Weekly Report spreadsheet</div>
            <input style={S.input} placeholder="https://docs.google.com/spreadsheets/d/..." value={sheetUrl} onChange={(e) => setSheetUrl(e.target.value)} />
            <button style={S.primaryBtn} onClick={connectSheet}>Connect Sheet</button>
            {syncStatus && <div style={S.statusMsg}>{syncStatus}</div>}
          </div>
        )}

        {/* Main App */}
        {isLoggedIn && sheetConnected && (
          <>
            <div style={S.sheetBadge}>
              <span>📊</span>
              <span>{sheetName}</span>
              <span style={{ marginLeft: "auto", color: "#64748b", fontSize: 11 }}>Week of {getCurrentWeekOf()}</span>
            </div>

            {/* Day Tabs */}
            <div style={S.dayRow}>
              {DAYS.map((d, i) => (
                <button key={d} style={{ ...S.dayBtn, ...(selectedDay === i ? S.dayBtnActive : {}) }} onClick={() => setSelectedDay(i)}>
                  <span style={{ fontSize: 12, fontWeight: 700 }}>{d.slice(0, 3)}</span>
                  {entries[i].length > 0 && <span style={S.dayCount}>{entries[i].length}</span>}
                </button>
              ))}
            </div>

            {/* Entry Type */}
            <div style={S.typeRow}>
              {[
                { id: "sales", label: "💼 Sales / Biz Dev", col: "#1a6b3c" },
                { id: "service", label: "🔧 Service Call", col: "#1a4b8a" },
                { id: "admin", label: "📁 Admin", col: "#6b451a" },
              ].map((t) => (
                <button key={t.id} style={{ ...S.typeBtn, ...(entryType === t.id ? { background: t.col, color: "#fff", borderColor: t.col } : {}) }} onClick={() => setEntryType(t.id)}>
                  {t.label}
                </button>
              ))}
            </div>

            {/* Recorder Card */}
            <div style={S.card}>
              <div style={S.cardTitle}>{DAYS[selectedDay]} — {entryType === "sales" ? "Sales / Business" : entryType === "service" ? "Service Call" : "Admin"}</div>

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
                <button style={S.addBtn} onClick={addEntry}>+ Add to {DAYS[selectedDay]}</button>
              )}
            </div>

            {/* Entries by Day */}
            {DAYS.map((day, dayIdx) => {
              const de = entries[dayIdx];
              if (!de.length) return null;
              return (
                <div key={day} style={S.entriesCard}>
                  <div style={S.entriesDay}>{day}</div>
                  {de.map((e, i) => (
                    <div key={i} style={S.entryRow}>
                      <span style={{ fontSize: 16, flexShrink: 0 }}>{e.type === "sales" ? "💼" : e.type === "service" ? "🔧" : "📁"}</span>
                      <span style={{ flex: 1, fontSize: 13, color: "#e2e8f0", lineHeight: 1.4 }}>{e.text}</span>
                      <button style={S.removeBtn} onClick={() => removeEntry(dayIdx, i)}>✕</button>
                    </div>
                  ))}
                </div>
              );
            })}

            {/* Q&A */}
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

            {/* Sync */}
            <div style={{ marginBottom: 24 }}>
              {syncStatus && <div style={S.statusMsg}>{syncStatus}</div>}
              <button style={{ ...S.syncBtn, ...(isSyncing || !totalEntries ? S.syncBtnOff : {}) }} onClick={syncToSheet} disabled={isSyncing || !totalEntries}>
                {isSyncing ? "Syncing..." : `📤 Sync ${totalEntries} Entr${totalEntries === 1 ? "y" : "ies"} to Google Sheets`}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

const S = {
  root: { fontFamily: "'DM Sans','Segoe UI',sans-serif", background: "#0f172a", minHeight: "100vh", color: "#e2e8f0", maxWidth: 480, margin: "0 auto" },
  header: { background: "#1e293b", padding: "14px 16px", display: "flex", alignItems: "center", justifyContent: "space-between", borderBottom: "1px solid #334155", position: "sticky", top: 0, zIndex: 10 },
  headerLeft: { display: "flex", alignItems: "center", gap: 10 },
  logo: { background: "#2563eb", color: "#fff", fontWeight: 800, fontSize: 14, width: 36, height: 36, borderRadius: 8, display: "flex", alignItems: "center", justifyContent: "center", letterSpacing: 1 },
  appTitle: { fontWeight: 700, fontSize: 15, color: "#f1f5f9" },
  appSub: { fontSize: 11, color: "#94a3b8" },
  userBadge: { display: "flex", alignItems: "center", gap: 8 },
  userEmail: { fontSize: 11, color: "#94a3b8" },
  signInBtn: { background: "#2563eb", color: "#fff", border: "none", borderRadius: 8, padding: "8px 14px", fontSize: 13, fontWeight: 600, cursor: "pointer" },
  signOutBtn: { background: "transparent", color: "#94a3b8", border: "1px solid #334155", borderRadius: 6, padding: "4px 10px", fontSize: 11, cursor: "pointer" },
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
  typeRow: { display: "flex", gap: 6, marginBottom: 12 },
  typeBtn: { flex: 1, background: "#1e293b", border: "1px solid #334155", borderRadius: 8, padding: "8px 4px", color: "#94a3b8", fontSize: 11, fontWeight: 600, cursor: "pointer" },
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
};
