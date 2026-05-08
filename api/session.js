const { getCurrentSession, getSessionTimeline } = require('../src/sessionEngine');
const { cors } = require('./_db');

module.exports = async function handler(req, res) {
  cors(res);
  try {
    const now      = new Date();
    const session  = getCurrentSession(now);
    // DST-aware timeline: startHour/endHour computed dynamically from Intl offsets
    const timeline = getSessionTimeline(now);

    res.json({ session, timeline });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
