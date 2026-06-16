'use strict';

const JPY_PAIRS = new Set([
  'USDJPY','EURJPY','GBPJPY','AUDJPY','NZDJPY','CADJPY','CHFJPY',
]);

function oandaToMt5(instrument) {
  return instrument.replace('_', '');
}

function pipValue(mt5Symbol) {
  return JPY_PAIRS.has(mt5Symbol) ? 0.01 : 0.0001;
}

async function evaluateAutoTrader(sb) {
  const now = new Date();

  // Expire stale pending commands (> 5 min old)
  await sb
    .from('ea_commands')
    .update({ status: 'expired' })
    .eq('status', 'pending')
    .lt('created_at', new Date(now.getTime() - 5 * 60000).toISOString());

  // Find users with auto trading enabled
  const { data: enabledUsers, error: settingsErr } = await sb
    .from('ea_settings')
    .select('user_id, risk_pct, max_trades, direction_threshold')
    .eq('auto_trading_enabled', true);
  if (settingsErr) throw new Error(settingsErr.message);
  if (!enabledUsers?.length) return { evaluated: 0 };

  // Get active signal pairs in ENTRY or MOVING phase
  const { data: signals } = await sb
    .from('energy_signal_pairs')
    .select('instrument, dir, phase, de_combined, spread_6h')
    .eq('active', true)
    .in('phase', ['ENTRY', 'MOVING']);
  if (!signals?.length) return { evaluated: enabledUsers.length, commands: 0 };

  let totalCommands = 0;

  for (const user of enabledUsers) {
    // Check EA is connected (heartbeat within 60s)
    const { data: account } = await sb
      .from('ea_accounts')
      .select('balance, open_positions, last_heartbeat')
      .eq('user_id', user.user_id)
      .single();

    if (!account) continue;
    const hbAge = now.getTime() - new Date(account.last_heartbeat).getTime();
    if (hbAge > 60000) continue;
    if (!account.balance || account.balance <= 0) continue;

    const openPositions = account.open_positions || [];

    // Get pending commands for this user
    const { data: pendingCmds } = await sb
      .from('ea_commands')
      .select('instrument')
      .eq('user_id', user.user_id)
      .eq('status', 'pending');
    const pendingInstruments = new Set((pendingCmds || []).map(c => c.instrument));
    const openInstruments = new Set(openPositions.map(p => p.instrument));

    const slotsAvailable = user.max_trades - openPositions.length - pendingInstruments.size;
    if (slotsAvailable <= 0) continue;

    let filled = 0;
    for (const sig of signals) {
      if (filled >= slotsAvailable) break;

      // Check score threshold
      if ((sig.de_combined || 0) < user.direction_threshold) continue;

      const mt5Symbol = oandaToMt5(sig.instrument);

      // Skip if already open or pending
      if (openInstruments.has(mt5Symbol)) continue;
      if (pendingInstruments.has(mt5Symbol)) continue;

      // Calculate lot size from risk % and balance
      const riskAmount = account.balance * (user.risk_pct / 100);
      const slPips = 30;
      const pip = pipValue(mt5Symbol);
      const pipValuePerLot = pip * 100000;
      let lots = riskAmount / (slPips * pipValuePerLot);
      lots = Math.max(0.01, Math.round(lots * 100) / 100);

      const action = sig.dir === 'BUY' ? 'OPEN_BUY' : 'OPEN_SELL';

      const { error: cmdErr } = await sb
        .from('ea_commands')
        .insert({
          user_id:        user.user_id,
          instrument:     mt5Symbol,
          action,
          params:         { lots, sl_pips: slPips, tp_pips: slPips * 2 },
          status:         'pending',
          signal_pair_id: sig.instrument,
        });
      if (cmdErr) {
        console.error(`[AUTOTRADER] Command insert error for ${user.user_id}:`, cmdErr.message);
        continue;
      }

      filled++;
      totalCommands++;
      pendingInstruments.add(mt5Symbol);
    }
  }

  console.log(`[AUTOTRADER] Evaluated ${enabledUsers.length} users, queued ${totalCommands} commands`);
  return { evaluated: enabledUsers.length, commands: totalCommands };
}

module.exports = { evaluateAutoTrader };
