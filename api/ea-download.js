'use strict';

const fs   = require('fs');
const path = require('path');
const { getClient, cors } = require('./_db');
const { requirePlan }     = require('./_plan');

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  try {
    const sb   = getClient();
    const gate = await requirePlan(sb, req, 'pro');
    if (gate.error) return res.status(gate.status).json({ error: gate.error, upgrade: gate.upgrade });

    const filePath = path.join(__dirname, '..', 'mt5', 'NervaFX_EA.mq5');
    const content  = fs.readFileSync(filePath, 'utf8');

    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', 'attachment; filename="NervaFX_EA.mq5"');
    res.send(content);
  } catch (e) {
    console.error('[EA-DOWNLOAD]', e.message);
    res.status(500).json({ error: e.message });
  }
};
