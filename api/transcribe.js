// /api/transcribe — server-side Whisper call (keeps the OpenAI key off the browser)
export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  const key = process.env.OPENAI_API_KEY || process.env.VITE_OPENAI_API_KEY;
  if (!key) return res.status(500).json({ error: "OPENAI_API_KEY is not set on the server." });

  try {
    const { audio, mimeType = "audio/webm" } = req.body || {};
    if (!audio) return res.status(400).json({ error: "No audio received." });
    const buf = Buffer.from(audio, "base64");
    if (buf.length < 1000) return res.status(400).json({ error: "No audio captured — check the microphone." });

    const form = new FormData();
    const ext = mimeType.includes("mp4") ? "mp4" : "webm";
    form.append("file", new Blob([buf], { type: mimeType }), `recording.${ext}`);
    form.append("model", "whisper-1");
    form.append("language", "en");

    const r = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}` },
      body: form,
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) return res.status(r.status).json({ error: data.error?.message || `OpenAI HTTP ${r.status}` });
    return res.json({ text: (data.text || "").trim() });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
