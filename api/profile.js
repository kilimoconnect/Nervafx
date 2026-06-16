const { getClient } = require('./_db');

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, PATCH, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

async function verifyToken(sb, req) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return { user: null, error: 'No token' };
  const { data: { user }, error } = await sb.auth.getUser(token);
  return { user: user || null, error: error?.message || null };
}

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const sb = getClient();
    const { user, error: authErr } = await verifyToken(sb, req);
    if (!user) return res.status(401).json({ error: authErr || 'Unauthorized' });

    // ── GET — fetch profile ────────────────────────────────────────────────
    if (req.method === 'GET') {
      const { data, error } = await sb
        .from('profiles')
        .select('*')
        .eq('id', user.id)
        .single();

      // Check for broker balance (EA connected within 60s)
      const { data: eaAccount } = await sb
        .from('ea_accounts')
        .select('balance, last_heartbeat')
        .eq('user_id', user.id)
        .single();

      const brokerConnected = eaAccount?.last_heartbeat
        && (Date.now() - new Date(eaAccount.last_heartbeat).getTime()) < 60000;
      const brokerBalance = brokerConnected && eaAccount.balance > 0
        ? eaAccount.balance : null;

      const meta = user.user_metadata || {};

      if (error?.code === 'PGRST116' || !data) {
        return res.json({
          id:                 user.id,
          email:              user.email,
          first_name:         meta.first_name || '',
          last_name:          meta.last_name  || '',
          account_size:       10000,
          max_daily_risk_pct: 2,
          max_trades:         3,
          min_rr:             2,
          timezone:           null,
          broker_balance:     brokerBalance,
        });
      }
      if (error) throw error;

      return res.json({
        ...data,
        email:          user.email,
        first_name:     data.first_name || meta.first_name || '',
        last_name:      data.last_name  || meta.last_name  || '',
        broker_balance: brokerBalance,
      });
    }

    // ── PATCH — update profile ─────────────────────────────────────────────
    if (req.method === 'PATCH') {
      const {
        first_name,
        last_name,
        account_size,
        max_daily_risk_pct,
        max_trades,
        min_rr,
        timezone,
        new_password,
        current_password,
      } = req.body || {};

      // Build profile update
      const profileUpdate = { id: user.id, updated_at: new Date().toISOString() };
      if (first_name         !== undefined) profileUpdate.first_name         = first_name.trim();
      if (last_name          !== undefined) profileUpdate.last_name          = last_name.trim();
      if (account_size       !== undefined) profileUpdate.account_size       = Number(account_size);
      if (max_daily_risk_pct !== undefined) profileUpdate.max_daily_risk_pct = Number(max_daily_risk_pct);
      if (max_trades         !== undefined) profileUpdate.max_trades         = Number(max_trades);
      if (min_rr             !== undefined) profileUpdate.min_rr             = Number(min_rr);
      if (timezone           !== undefined) profileUpdate.timezone           = String(timezone);

      const { error: upsertErr } = await sb
        .from('profiles')
        .upsert(profileUpdate, { onConflict: 'id' });
      if (upsertErr) throw upsertErr;

      // Sync name to Supabase auth metadata
      if (first_name !== undefined || last_name !== undefined) {
        const meta = user.user_metadata || {};
        const fn   = first_name ?? meta.first_name ?? '';
        const ln   = last_name  ?? meta.last_name  ?? '';
        await sb.auth.admin.updateUserById(user.id, {
          user_metadata: {
            ...meta,
            first_name: fn,
            last_name:  ln,
            full_name:  `${fn} ${ln}`.trim(),
          },
        });
      }

      // Change password
      if (new_password) {
        if (new_password.length < 6)
          return res.status(400).json({ error: 'New password must be at least 6 characters.' });
        const { error: pwErr } = await sb.auth.admin.updateUserById(user.id, { password: new_password });
        if (pwErr) return res.status(400).json({ error: pwErr.message });
      }

      return res.json({ success: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
