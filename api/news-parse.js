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

  const { text, timezone } = req.body || {};
  if (!text || text.trim().length < 5)
    return res.status(400).json({ error: 'text required' });

  const tz = timezone || 'UTC';

  try {
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    const nowUtc = new Date().toISOString().slice(0, 10); // e.g. 2026-05-11
    const systemPrompt = `You are a forex economic calendar parser. Return ONLY a compact JSON array, no markdown.
Each object: {"event_time":"<UTC ISO8601>","currency":"<3-letter>","event_name":"<short name>","impact":"HIGH"|"MEDIUM"|"LOW","forecast":<string|null>,"previous":<string|null>}
TODAY is ${nowUtc} (UTC). Use this to resolve ambiguous dates and years.
DATE RULES: Accept any date format — ISO, US (MM/DD/YYYY), European (DD/MM/YYYY), named months (May 12), CSV numeric (05-11-2026), etc.
  - Use context clues from the whole calendar (sequence of days, nearby named dates, day-of-week labels) to determine the correct format.
  - If a numeric date like 05-11-2026 is ambiguous, check whether a value > 12 appears in the first or second position across the dataset to detect the format automatically.
  - When truly ambiguous prefer the date closest to TODAY that makes sense given the surrounding events.
  - If year is absent, use the current or next upcoming year.
TIMEZONE: Input times are in "${tz}". Convert every time to UTC before writing the ISO string.
IMPACT: ***=HIGH **=MEDIUM *=LOW; red=HIGH orange=MEDIUM yellow=LOW; High/Medium/Low words map directly.
Skip headers, bank holidays, separators. No explanation, no markdown fences.`;

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user',   content: text.slice(0, 15000) },
      ],
      temperature: 0,
      max_tokens: 6000,
    });

    const raw = completion.choices[0].message.content.trim();

    // Strip accidental markdown fences
    const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/,'');
    const events = JSON.parse(cleaned);

    if (!Array.isArray(events)) throw new Error('Response was not an array');

    return res.json({ events, count: events.length });
  } catch (e) {
    console.error('[news-parse] error:', e.message, e?.status, e?.code);
    return res.status(500).json({ error: 'AI parse failed: ' + e.message });
  }
};
