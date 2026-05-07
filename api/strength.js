const { getClient, getLatestTime, cors } = require('./_db');

// Arrow + intensity based on normalized smooth values
// smooth_6h is the base strength; delta = short-term change
function momentum(s3, s6, s12) {
  const v3  = parseFloat(s3)  || 0;
  const v6  = parseFloat(s6)  || 0;
  const v12 = parseFloat(s12) || 0;
  const delta = v3 - v6;       // short-term direction vs medium-term
  const str   = Math.abs(v6);  // absolute strength magnitude

  // Double arrows: strong absolute strength AND moving fast
  if (str > 0.15 && delta > 0.04) return '↑↑';
  if (str > 0.15 && delta < -0.04) return '↓↓';
  // Single arrows: meaningful directional momentum
  if (delta > 0.01) return '↑';
  if (delta < -0.01) return '↓';
  // Flat
  return '→';
}

module.exports = async function handler(req, res) {
  cors(res);
  try {
    const t = await getLatestTime('currency_strength');
    if (!t) return res.json({ currencies: [] });
    const { data, error } = await getClient()
      .from('currency_strength')
      .select('currency, normalized_3h, normalized_6h, normalized_12h, smooth_3h, smooth_6h, smooth_12h')
      .eq('time', t);
    if (error) throw error;
    res.json({
      time: t,
      currencies: (data || []).map(c => ({
        ...c,
        momentum: momentum(c.smooth_3h, c.smooth_6h, c.smooth_12h),
      })),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
};
