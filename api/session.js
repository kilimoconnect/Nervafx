const { getCurrentSession, SESSIONS } = require('../src/sessionEngine');
const { cors } = require('./_db');

module.exports = async function handler(req, res) {
  cors(res);
  try {
    const session = getCurrentSession();

    // Include the full session timeline so the dashboard can render progress
    const timeline = SESSIONS.filter(s => s.name !== 'PRE_LONDON').map(s => ({
      name:       s.name,
      label:      s.label,
      startHour:  s.startHour,
      endHour:    s.endHour,
      quality:    s.quality,
      isCurrent:  s.name === session.session,
    }));

    res.json({ session, timeline });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
