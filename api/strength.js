const { getClient, getLatestTime, cors } = require('./_db');

function momentum(s3, s6, s12) {
  const delta = (parseFloat(s3) || 0) - (parseFloat(s6) || 0);
  const str   = Math.abs(parseFloat(s6) || 0);
  if (str > 0.25 && delta > 0.06) return '↑↑';
  if (delta > 0.02)                return '↑';
  if (str > 0.25 && delta < -0.06) return '↓↓';
  if (delta < -0.02)               return '↓';
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
