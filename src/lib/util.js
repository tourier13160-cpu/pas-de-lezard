const crypto = require('crypto');

/** Normalise une réponse : minuscules, sans accents, espaces réduits. "Vert foncé " → "vert fonce" */
function normalize(s) {
  return String(s || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/\s+/g, ' ').trim();
}

function token(bytes = 24) { return crypto.randomBytes(bytes).toString('hex'); }
function playerCode() { return 'PL-' + crypto.randomInt(1000, 10000); }
function smsCode() { return String(crypto.randomInt(0, 10000)).padStart(4, '0'); }
function hashIp(ip) {
  return crypto.createHash('sha256').update((process.env.IP_SALT || 'lezard') + String(ip)).digest('hex').slice(0, 32);
}
function fmtChrono(ms) {
  const m = Math.floor(ms / 60000), s = Math.floor((ms % 60000) / 1000), x = Math.floor(ms % 1000);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(x).padStart(3, '0')}`;
}

/**
 * Phase d'une vague à l'instant `now` (ms epoch). C'est LA source de vérité :
 * upcoming → registration → locked (dernière minute) → running (fenêtre de qualification) → finished → drawn
 * Les valeurs BIGINT remontent en Number grâce à bigNumberStrings:false, mais on caste par sécurité.
 */
function wavePhase(w, now) {
  if (!w) return 'none';
  if (w.status === 'drawn') return 'drawn';
  const start = Number(w.start_at);
  const regOpen = start - Number(w.registration_open_before_ms);
  const regClose = start - Number(w.registration_close_before_ms);
  const qualEnd = start + Number(w.qualification_ms);
  if (now < regOpen) return 'upcoming';
  if (now < regClose) return 'registration';
  if (now < start) return 'locked';
  if (now < qualEnd) return 'running';
  return 'finished';
}

/** Limiteur de débit en mémoire, par IP et par route. Suffisant pour un prototype mono-serveur. */
const buckets = new Map();
function rateLimit(name, max, windowMs) {
  return (req, res, next) => {
    const key = `${name}:${req.ip}`;
    const now = Date.now();
    let b = buckets.get(key);
    if (!b || now > b.reset) { b = { count: 0, reset: now + windowMs }; buckets.set(key, b); }
    b.count++;
    if (b.count > max) return res.status(429).json({ error: 'rate_limited', retry_in_ms: b.reset - now });
    next();
  };
}
setInterval(() => { const now = Date.now(); for (const [k, b] of buckets) if (now > b.reset) buckets.delete(k); }, 60000).unref();

/** Captchas côté serveur : le client reçoit une question + un id, la réponse n'est jamais envoyée au navigateur. */
const captchas = new Map();
function newCaptcha() {
  const a = crypto.randomInt(2, 9), b = crypto.randomInt(1, 9);
  const id = token(8);
  captchas.set(id, { answer: a + b, exp: Date.now() + 10 * 60000 });
  return { id, question: `${a} + ${b}` };
}
function checkCaptcha(id, answer) {
  const c = captchas.get(id);
  captchas.delete(id);
  return !!c && c.exp > Date.now() && String(c.answer) === String(answer).trim();
}
setInterval(() => { const now = Date.now(); for (const [k, c] of captchas) if (now > c.exp) captchas.delete(k); }, 60000).unref();

module.exports = { normalize, token, playerCode, smsCode, hashIp, fmtChrono, wavePhase, rateLimit, newCaptcha, checkCaptcha };
