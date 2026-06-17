const { getClient, getLatestTime, cors } = require('./_db');

// Velocity = rate of change (3H vs 6H)
// Acceleration = is momentum speeding up or slowing down?
function velocityAccel(s3, s6, s12) {
  const v3  = parseFloat(s3)  || 0;
  const v6  = parseFloat(s6)  || 0;
  const v12 = parseFloat(s12) || 0;

  const shortVel = v3 - v6;    // 3H vs 6H momentum
  const longVel  = v6 - v12;   // 6H vs 12H momentum
  const accel    = shortVel - longVel; // positive = momentum accelerating

  const str = Math.abs(v6);

  // Momentum arrow (direction + intensity)
  let arrow;
  if (str > 0.15 && shortVel > 0.04) arrow = '↑↑';
  else if (shortVel > 0.01)          arrow = '↑';
  else if (str > 0.15 && shortVel < -0.04) arrow = '↓↓';
  else if (shortVel < -0.01)         arrow = '↓';
  else                               arrow = '→';

  // Acceleration label
  const accel_label = accel > 0.02 ? 'accelerating' : accel < -0.02 ? 'decelerating' : 'steady';

  return { arrow, velocity: shortVel, acceleration: accel, accel_label };
}

module.exports = async function handler(req, res) {
  cors(res);
  try {
    const t = await getLatestTime('currency_strength');
    if (!t) return res.json({ currencies: [] });
    const { data, error } = await getClient()
      .from('currency_strength')
      .select('currency, normalized_2h, normalized_3h, normalized_4h, normalized_6h, normalized_12h, normalized_1d, smooth_2h, smooth_3h, smooth_4h, smooth_6h, smooth_12h, smooth_1d, raw_2h, raw_3h, raw_6h, raw_12h')
      .eq('time', t);
    if (error) throw error;

    res.json({
      time: t,
      currencies: (data || []).map(c => {
        const va = velocityAccel(c.smooth_3h, c.smooth_6h, c.smooth_12h);
        return {
          ...c,
          momentum:     va.arrow,
          velocity:     va.velocity,
          acceleration: va.acceleration,
          accel_label:  va.accel_label,
        };
      }),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
};
