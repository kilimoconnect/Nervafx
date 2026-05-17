require('dotenv').config();

const config = {
  brevo: {
    apiKey:      process.env.BREVO_API_KEY,
    senderName:  process.env.BREVO_SENDER_NAME  || 'NervaFX',
    senderEmail: process.env.BREVO_SENDER_EMAIL || 'noreply@nervafx.com',
  },
  oanda: {
    apiKey: process.env.OANDA_API_KEY,
    accountId: process.env.OANDA_ACCOUNT_ID,
    baseUrl: process.env.OANDA_BASE_URL || 'https://api-fxpractice.oanda.com',
  },
  supabase: {
    url: process.env.SUPABASE_URL,
    serviceKey: process.env.SUPABASE_SERVICE_KEY,
  },
  instruments: [
    'EUR_USD', 'GBP_USD', 'AUD_USD', 'NZD_USD',
    'USD_JPY', 'USD_CHF', 'USD_CAD',
    'EUR_GBP', 'EUR_JPY', 'EUR_CHF', 'EUR_CAD', 'EUR_AUD', 'EUR_NZD',
    'GBP_JPY', 'GBP_CHF', 'GBP_CAD', 'GBP_AUD', 'GBP_NZD',
    'AUD_JPY', 'AUD_CHF', 'AUD_CAD', 'AUD_NZD',
    'NZD_JPY', 'NZD_CHF', 'NZD_CAD',
    'CAD_JPY', 'CAD_CHF',
    'CHF_JPY',
  ],
  granularity: 'H1',
  initialCount: 200,
  risk: {
    accountBalance: parseFloat(process.env.ACCOUNT_BALANCE || '1000'),
    riskPercent: 0.005,
    maxDailyLossPercent: 0.02,
    maxOpenTrades: 3,
    minRR: 2.0,
    minConfidence: 75,
  },
};

function validate() {
  const missing = [];
  if (!config.oanda.apiKey) missing.push('OANDA_API_KEY');
  if (!config.oanda.accountId) missing.push('OANDA_ACCOUNT_ID');
  if (!config.supabase.url) missing.push('SUPABASE_URL');
  if (!config.supabase.serviceKey) missing.push('SUPABASE_SERVICE_KEY');
  if (missing.length > 0) {
    throw new Error(`Missing env vars: ${missing.join(', ')}. Copy .env.example to .env and fill in values.`);
  }
}

module.exports = { config, validate };
