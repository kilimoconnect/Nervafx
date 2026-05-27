const { getClient, cors } = require('./_db');

function dayKey(isoTime) {
  const d = new Date(isoTime);
  return `${d.getUTCFullYear()}-${d.getUTCMonth()}-${d.getUTCDate()}`;
}

module.exports = async function handler(req, res) {
  cors(res);
  try {
    const sb    = getClient();
    const limit = parseInt(req.query?.limit || '200', 10);

    // Authenticate user so we can merge their personal trade levels
    const auth  = req.headers.authorization || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
    let userId  = null;

    if (token) {
      try {
        const { data: { user } } = await sb.auth.getUser(token);
        if (user) userId = user.id;
      } catch (_) {}
    }

    const { data, error } = await sb
      .from('hourly_market_journal')
      .select('id, time, session_name, session_quality, risk_sentiment, risk_confidence, trend_pairs, pullback_pairs, ready_pairs, no_trade_pairs, new_pullback_pairs, tracked_pullback_pairs, top_setups, risk_sentiment_details, currency_strength, ai_analysis, signals_summary, m15_impulses, energy_snapshot, summary, outcome_6h, outcome_12h, outcome_24h, created_at')
      .order('time', { ascending: false })
      .limit(limit);

    if (error) throw error;

    const entries = data || [];

    // Merge per-user entry/SL/TP from risk_checks into each journal entry's entered signals.
    // A user can only have one approved trade per instrument per day, so day+instrument is
    // unambiguous as a join key.
    if (userId && entries.length > 0) {
      const oldest = entries[entries.length - 1].time;
      const newest = entries[0].time;
      const newestPlus = new Date(new Date(newest).getTime() + 2 * 3600_000).toISOString();

      const { data: rcs } = await sb
        .from('risk_checks')
        .select('instrument, entry_price, stop_loss, take_profit, position_size, risk_amount, time')
        .eq('user_id', userId)
        .eq('status', 'APPROVED')
        .gte('time', oldest)
        .lte('time', newestPlus);

      if (rcs && rcs.length > 0) {
        // Build lookup: "YYYY-M-D:INSTRUMENT" → risk_check
        const rcMap = {};
        for (const rc of rcs) {
          const key = `${dayKey(rc.time)}:${rc.instrument}`;
          if (!rcMap[key] || rc.time > rcMap[key].time) rcMap[key] = rc;
        }

        for (const entry of entries) {
          const signals = entry.signals_summary;
          if (!signals?.entered?.length) continue;
          const dk = dayKey(entry.time);
          signals.entered = signals.entered.map(s => {
            const rc = rcMap[`${dk}:${s.instrument}`];
            if (!rc) return s;
            return {
              ...s,
              entry_price:   rc.entry_price,
              stop_loss:     rc.stop_loss,
              take_profit:   rc.take_profit,
              position_size: rc.position_size,
              risk_amount:   rc.risk_amount,
            };
          });
        }
      }
    }

    res.json({ entries });
  } catch (e) { res.status(500).json({ error: e.message }); }
};
