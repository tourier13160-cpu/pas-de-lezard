/**
 * Envoi de SMS. En prototype : provider "console" (affiche le code dans les logs du serveur).
 * Pour la production : SMS_PROVIDER=twilio + identifiants dans .env.
 * Le numéro n'est utilisé qu'à la remise du lot et supprimé ensuite (voir routes/public.js → claim/verify).
 */
async function send(phone, message) {
  const provider = process.env.SMS_PROVIDER || 'console';

  if (provider === 'console') {
    console.log(`[SMS → ${phone}] ${message}`);
    return { ok: true, provider };
  }

  if (provider === 'twilio') {
    const sid = process.env.TWILIO_ACCOUNT_SID, auth = process.env.TWILIO_AUTH_TOKEN, from = process.env.TWILIO_FROM;
    if (!sid || !auth || !from) throw new Error('twilio_not_configured');
    const body = new URLSearchParams({ To: phone, From: from, Body: message });
    const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
      method: 'POST',
      headers: { Authorization: 'Basic ' + Buffer.from(`${sid}:${auth}`).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' },
      body
    });
    if (!r.ok) throw new Error('twilio_error_' + r.status);
    return { ok: true, provider };
  }

  throw new Error('unknown_sms_provider');
}

/** Normalise un numéro français saisi "06 12 34 56 78" → "+33612345678". */
function normalizePhone(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  if (/^0[67]\d{8}$/.test(digits)) return '+33' + digits.slice(1);
  if (/^33[67]\d{8}$/.test(digits)) return '+' + digits;
  return null;
}

module.exports = { send, normalizePhone };
