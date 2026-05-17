'use strict';

const { sendEmail, signalAlertEmail } = require('./emailService');

async function sendSignalAlerts(sb) {
  if (!process.env.BREVO_API_KEY) return;

  const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();

  const { data: signals } = await sb
    .from('trade_signals')
    .select('instrument, direction, confidence, reason')
    .gte('time', twoHoursAgo)
    .in('signal', ['BUY', 'SELL'])
    .gte('confidence', 65)
    .order('confidence', { ascending: false })
    .limit(10);

  if (!signals?.length) return;

  const { data: sessions } = await sb
    .from('session_activity')
    .select('session_name, energy_cycle, market_energy')
    .order('time', { ascending: false })
    .limit(3);

  const sessionSummary = sessions?.map(s =>
    `${s.session_name}: ${s.energy_cycle} (E:${Math.round(s.market_energy || 0)})`
  ).join(' · ') || '';

  const { data: allUsers } = await sb.auth.admin.listUsers({ perPage: 1000 });
  if (!allUsers?.users?.length) return;

  const { data: prefs } = await sb
    .from('email_preferences')
    .select('user_id, signal_alerts, unsubscribed');

  const prefMap = {};
  for (const p of prefs || []) prefMap[p.user_id] = p;

  const recipients = allUsers.users.filter(u => {
    const p = prefMap[u.id];
    if (p?.unsubscribed) return false;
    if (p?.signal_alerts === false) return false;
    return true;
  });

  if (!recipients.length) return;

  const template = signalAlertEmail(signals, sessionSummary);

  for (const u of recipients) {
    try {
      await sendEmail(u.email, template);
    } catch (e) {
      console.error(`[email-alert] failed for ${u.email}:`, e.message);
    }
  }

  console.log(`[email-alert] sent to ${recipients.length} users (${signals.length} signals)`);
}

module.exports = { sendSignalAlerts };
