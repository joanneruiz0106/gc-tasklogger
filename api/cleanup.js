// /api/cleanup — server-side Claude call for AI cleanup of field notes
export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return res.status(500).json({ error: "ANTHROPIC_API_KEY is not set on the server." });

  try {
    const { text } = req.body || {};
    if (!text || !text.trim()) return res.status(400).json({ error: "No text to process." });

    const prompt = `You are a field sales assistant for Garratt-Callahan water treatment. The input may contain multiple activities. Split them into separate lines, one activity per line. Each line must: start with a capital letter, start with an action verb or customer name, never start with "I", be under 20 words, remove all filler words. Output only the lines, nothing else.

Examples:
"service call Omni hospital. sales call ABC hospital" →
Serviced Omni Hospital.
Called ABC Hospital for new business.

"administrative work UCSD Health. service call Google services" →
Completed administrative work at UCSD Health.
Serviced Google Services Center.

Now process: "${text}"`;

    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: process.env.ANTHROPIC_MODEL || "claude-sonnet-4-20250514",
        max_tokens: 1000,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) return res.status(r.status).json({ error: data.error?.message || `Anthropic HTTP ${r.status}` });
    return res.json({ text: data.content?.[0]?.text?.trim() || "" });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
