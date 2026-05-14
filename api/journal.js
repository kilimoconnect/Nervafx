const { getClient, cors } = require('./_db');

module.exports = async function handler(req, res) {
  cors(res);
  try {
    const limit = parseInt(req.query?.limit || '200', 10);

    const { data, error } = await getClient()
      .from('hourly_market_journal')
      .select('id, time, session_name, session_quality, risk_sentiment, risk_confidence, trend_pairs, pullback_pairs, ready_pairs, no_trade_pairs, top_setups, risk_sentiment_details, currency_strength, ai_analysis, signals_summary, m15_impulses, summary, outcome_6h, outcome_12h, outcome_24h, created_at')
      .order('time', { ascending: false })
      .limit(limit);

    if (error) throw error;

    res.json({ entries: data || [] });
  } catch (e) { res.status(500).json({ error: e.message }); }
};
