const { getClient } = require('./_db');
const OpenAI = require('openai');

const ADMIN_ID = '140f3854-2c85-488c-8e0a-0f965d562654';

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Admin auth
  const sb   = getClient();
  const auth = (req.headers.authorization || '').replace('Bearer ', '');
  if (!auth) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const { data, error } = await sb.auth.getUser(auth);
    if (error || data?.user?.id !== ADMIN_ID)
      return res.status(403).json({ error: 'Admin only' });
  } catch { return res.status(403).json({ error: 'Admin only' }); }

  const { text } = req.body || {};
  if (!text || text.trim().length < 5)
    return res.status(400).json({ error: 'text required' });

  try {
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    const systemPrompt = `You are a forex economic calendar parser.
Extract ALL news events from the raw text/CSV provided and return ONLY a valid JSON array.
Each event object must have exactly these fields:
  - event_time: ISO 8601 UTC datetime string (e.g. "2026-05-12T08:30:00Z")
  - currency: 3-letter currency code (USD, EUR, GBP, JPY, CHF, CAD, AUD, NZD, etc.)
  - event_name: concise event name (e.g. "CPI m/m", "NFP", "Interest Rate Decision")
  - impact: exactly "HIGH", "MEDIUM", or "LOW"
  - forecast: string or null
  - previous: string or null

Rules:
- If impact is shown as stars (***=HIGH, **=MEDIUM, *=LOW), red/orange/yellow colors, or words like "high","medium","low", map accordingly
- If the source timezone is not UTC, convert to UTC. Assume EST (UTC-5) or EDT (UTC-4) if unclear
- If year is missing, assume the current or next upcoming year
- Skip any non-event rows (headers, separators, totals)
- Return ONLY the JSON array — no markdown, no explanation, no \`\`\`json fences`;

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user',   content: `Parse this forex calendar:\n\n${text.slice(0, 12000)}` },
      ],
      temperature: 0.1,
      max_tokens: 4000,
    });

    const raw = completion.choices[0].message.content.trim();

    // Strip accidental markdown fences
    const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/,'');
    const events = JSON.parse(cleaned);

    if (!Array.isArray(events)) throw new Error('Response was not an array');

    return res.json({ events, count: events.length });
  } catch (e) {
    return res.status(500).json({ error: 'AI parse failed: ' + e.message });
  }
};
