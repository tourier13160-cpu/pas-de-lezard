const express = require('express');
const { q, one } = require('../db');
const util = require('../lib/util');
const sms = require('../services/sms');

const router = express.Router();
const DEV = process.env.DEV_MODE === '1';
const MAX_PER_IP = parseInt(process.env.MAX_PLAYERS_PER_IP || '3', 10);

/* ---------- Accès aux données (remplace les requêtes préparées de la version SQLite) ---------- */
const D = {
  wave: id => one('SELECT * FROM waves WHERE id = ?', [id]),
  partner: id => one('SELECT id, name, shop_url FROM partners WHERE id = ?', [id]),
  playerCount: async id => (await one('SELECT COUNT(*) AS n FROM players WHERE wave_id = ?', [id])).n,
  qualifiedCount: async id => (await one('SELECT COUNT(*) AS n FROM players WHERE wave_id = ? AND qualified = 1', [id])).n,
  rank: async (waveId, answeredAt) => (await one('SELECT COUNT(*) + 1 AS r FROM players WHERE wave_id = ? AND qualified = 1 AND answered_at < ?', [waveId, answeredAt])).r,
  byToken: token => one('SELECT * FROM players WHERE token = ?', [token]),
  ipCount: async (waveId, hash) => (await one('SELECT COUNT(*) AS n FROM players WHERE wave_id = ? AND ip_hash = ?', [waveId, hash])).n,
  // Énigmes : MySQL utilise ORDER BY RAND() dans la sous-requête
  randomPuzzles: (partnerId, limit = 2) => q(
    `SELECT id FROM puzzles WHERE partner_id = ? AND active = 1 ORDER BY RAND() LIMIT ${parseInt(limit, 10)}`, [partnerId]),
  puzzle: id => one('SELECT id, question, answers, hint_url FROM puzzles WHERE id = ?', [id]),
  insertPlayer: (waveId, pseudo, code, token, ipHash, joinedAt, puzzleIds) => q(
    'INSERT INTO players (wave_id, pseudo, player_code, token, ip_hash, joined_at, puzzle_ids) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [waveId, pseudo, code, token, ipHash, joinedAt, puzzleIds]),
  insertAttempt: (playerId, receivedAt, elapsedMs, result) => q(
    'INSERT INTO attempts (player_id, received_at, elapsed_ms, result) VALUES (?, ?, ?, ?)',
    [playerId, receivedAt, elapsedMs, result]),
  // Vagues candidates : on filtre en SQL sur une borne large puis on tranche en JS avec wavePhase
  candidates: now => q('SELECT * FROM waves WHERE status != ? ORDER BY start_at ASC LIMIT 20', ['drawn'])
};

async function currentWave(now) {
  const rows = await D.candidates(now);
  const live = rows.find(w => Number(w.start_at) + Number(w.qualification_ms) > now);
  if (live) return live;
  const last = await one('SELECT * FROM waves ORDER BY start_at DESC LIMIT 1');
  return last;
}
function nextWaveAfter(w, rows) {
  if (!w) return null;
  return rows.find(x => x.id !== w.id && Number(x.start_at) > Number(w.start_at)) || null;
}

/** Vue publique d'une vague : jamais les énigmes, jamais les réponses. */
async function publicWave(w, now) {
  if (!w) return null;
  const partner = await D.partner(w.partner_id);
  const places = await D.playerCount(w.id);
  return {
    id: w.id,
    partner: { name: partner.name, shop_url: partner.shop_url },
    phase: util.wavePhase(w, now),
    start_at: Number(w.start_at),
    end_at: Number(w.end_at),
    registration_open_at: Number(w.start_at) - Number(w.registration_open_before_ms),
    registration_close_at: Number(w.start_at) - Number(w.registration_close_before_ms),
    qualification_end_at: Number(w.start_at) + Number(w.qualification_ms),
    qualification_ms: Number(w.qualification_ms),
    capacity: Number(w.capacity),
    places_left: Math.max(0, Number(w.capacity) - places),
    qualified_count: await D.qualifiedCount(w.id),
    prizes_count: Number(w.prizes_count),
    max_attempts: Number(w.max_attempts),
    status: w.status,
    server_now: now,
    dev_mode: DEV
  };
}

async function auth(req, res, next) {
  try {
    const h = req.get('authorization') || '';
    const tok = h.startsWith('Bearer ') ? h.slice(7) : null;
    const player = tok ? await D.byToken(tok) : null;
    if (!player) return res.status(401).json({ error: 'invalid_token' });
    req.player = player;
    req.wave = await D.wave(player.wave_id);
    next();
  } catch (e) { next(e); }
}

async function playerPuzzles(player) {
  const ids = JSON.parse(player.puzzle_ids);
  const out = [];
  for (const id of ids) out.push(await D.puzzle(id));
  return out;
}

/* ---------- Routes publiques ---------- */

router.get('/time', (req, res) => res.json({ now: Date.now() }));

router.get('/captcha', util.rateLimit('captcha', 20, 60000), (req, res) => res.json(util.newCaptcha()));

router.get('/waves/current', async (req, res, next) => {
  try {
    const now = Date.now();
    const w = await currentWave(now);
    if (!w) return res.json({ current: null, next: null });
    const rows = await D.candidates(now);
    res.json({ current: await publicWave(w, now), next: await publicWave(nextWaveAfter(w, rows), now) });
  } catch (e) { next(e); }
});

router.get('/waves/:id/leaderboard', async (req, res, next) => {
  try {
    const w = await D.wave(req.params.id);
    if (!w) return res.status(404).json({ error: 'wave_not_found' });
    const rows = await q('SELECT pseudo, answered_at, is_winner FROM players WHERE wave_id = ? AND qualified = 1 ORDER BY answered_at ASC LIMIT 50', [w.id]);
    res.json({
      wave_id: w.id, status: w.status, qualified_count: await D.qualifiedCount(w.id),
      entries: rows.map((p, i) => ({ rank: i + 1, pseudo: p.pseudo, chrono: util.fmtChrono(Number(p.answered_at) - Number(w.start_at)), winner: w.status === 'drawn' && !!p.is_winner }))
    });
  } catch (e) { next(e); }
});

/** Gagnants de la dernière vague tirée : alimente le bloc « Derniers gagnants ». */
router.get('/winners/recent', async (req, res, next) => {
  try {
    const w = await one('SELECT * FROM waves WHERE status = ? ORDER BY drawn_at DESC LIMIT 1', ['drawn']);
    if (!w) return res.json({ wave: null, winners: [] });
    const rows = await q('SELECT pseudo, answered_at FROM players WHERE wave_id = ? AND is_winner = 1 ORDER BY answered_at ASC LIMIT 10', [w.id]);
    res.json({
      wave: { id: w.id, start_at: Number(w.start_at), draw_mode: w.draw_mode },
      winners: rows.map(p => ({ pseudo: p.pseudo, chrono: util.fmtChrono(Number(p.answered_at) - Number(w.start_at)) }))
    });
  } catch (e) { next(e); }
});

/** Inscription : pseudo + captcha serveur. Aucun téléphone. */
router.post('/waves/:id/join', util.rateLimit('join', 5, 60000), async (req, res, next) => {
  try {
    const now = Date.now();
    const w = await D.wave(req.params.id);
    if (!w) return res.status(404).json({ error: 'wave_not_found' });
    const b = req.body || {};

    if (b.website_url_check) return res.status(400).json({ error: 'bot_detected' });
    const phase = util.wavePhase(w, now);
    if (phase !== 'registration') return res.status(409).json({ error: 'registration_closed', phase });
    if (!util.checkCaptcha(b.captcha_id, b.captcha_answer)) return res.status(400).json({ error: 'captcha_failed' });

    const pseudo = String(b.pseudo || '').trim();
    if (!/^[A-Za-z0-9_\-]{3,20}$/.test(pseudo)) return res.status(400).json({ error: 'invalid_pseudo', hint: '3 à 20 caractères : lettres, chiffres, _ ou -' });

    if (await D.playerCount(w.id) >= Number(w.capacity)) return res.status(409).json({ error: 'wave_full' });
    const ipHash = util.hashIp(req.ip);
    if (await D.ipCount(w.id, ipHash) >= MAX_PER_IP) return res.status(429).json({ error: 'too_many_from_ip' });

    const puzzles = (await D.randomPuzzles(w.partner_id, 2)).map(r => r.id);
    if (puzzles.length < 2) return res.status(503).json({ error: 'no_puzzles_configured' });

    const token = util.token();
    let code = null;
    for (let i = 0; i < 20; i++) {
      code = util.playerCode();
      try {
        await D.insertPlayer(w.id, pseudo, code, token, ipHash, now, JSON.stringify(puzzles));
        break;
      } catch (e) {
        if (e.code === 'ER_DUP_ENTRY' && String(e.message).includes('uniq_pseudo')) return res.status(409).json({ error: 'pseudo_taken' });
        if (e.code !== 'ER_DUP_ENTRY') throw e; // collision de code → on retente
      }
    }
    res.status(201).json({ token, player_code: code, pseudo, wave: await publicWave(w, now) });
  } catch (e) { next(e); }
});

/** État du joueur : la salle d'attente et l'écran de jeu se pilotent avec ça. */
router.get('/me', auth, async (req, res, next) => {
  try {
    const now = Date.now();
    const { player: p, wave: w } = req;
    const phase = util.wavePhase(w, now);
    const out = {
      pseudo: p.pseudo, player_code: p.player_code, joined_at: Number(p.joined_at),
      phase, wave: await publicWave(w, now),
      starts_in_ms: Math.max(0, Number(w.start_at) - now),
      time_left_ms: Math.max(0, Number(w.start_at) + Number(w.qualification_ms) - now),
      attempts_left: Math.max(0, Number(w.max_attempts) - Number(p.attempts)),
      answered: !!p.answered_at, qualified: !!p.qualified, reject_reason: p.reject_reason,
      is_winner: w.status === 'drawn' && !!p.is_winner, claimed: !!p.claimed_at
    };
    if (['running', 'finished', 'drawn'].includes(phase)) {
      out.puzzles = (await playerPuzzles(p)).map(z => ({ id: z.id, question: z.question, hint_url: z.hint_url }));
    }
    if (p.answered_at && p.qualified) {
      out.chrono_ms = Number(p.answered_at) - Number(w.start_at);
      out.chrono = util.fmtChrono(out.chrono_ms);
      out.rank = await D.rank(w.id, p.answered_at);
      out.qualified_count = await D.qualifiedCount(w.id);
    }
    res.json(out);
  } catch (e) { next(e); }
});

/** Réponse aux énigmes. L'horodatage est celui de la réception serveur, jamais celui du client. */
router.post('/answer', util.rateLimit('answer', 30, 60000), auth, async (req, res, next) => {
  try {
    const received_at = Date.now();
    const { player: p, wave: w } = req;
    const phase = util.wavePhase(w, received_at);
    if (phase !== 'running') return res.status(409).json({ error: 'window_closed', phase });
    if (p.answered_at) return res.status(409).json({ error: 'already_answered' });
    if (Number(p.attempts) >= Number(w.max_attempts)) return res.status(409).json({ error: 'no_attempts_left' });

    const b = req.body || {};
    const elapsed = received_at - Number(w.start_at);

    if (String(b.player_code || '').trim().toUpperCase() !== p.player_code) {
      await D.insertAttempt(p.id, received_at, elapsed, 'bad_code');
      return res.status(400).json({ error: 'bad_player_code' });
    }

    if (elapsed < Number(w.min_human_ms)) {
      await D.insertAttempt(p.id, received_at, elapsed, 'too_fast');
      await q('UPDATE players SET answered_at = ?, qualified = 0, reject_reason = ? WHERE id = ?', [received_at, 'too_fast', p.id]);
      return res.json({ result: 'rejected', reason: 'too_fast', chrono: util.fmtChrono(elapsed) });
    }

    const puzzles = await playerPuzzles(p);
    const answers = Array.isArray(b.answers) ? b.answers : [];
    const allOk = puzzles.every((z, i) => JSON.parse(z.answers).map(util.normalize).includes(util.normalize(answers[i])));

    if (!allOk) {
      const attempts = Number(p.attempts) + 1;
      const left = Number(w.max_attempts) - attempts;
      await D.insertAttempt(p.id, received_at, elapsed, 'wrong');
      if (left <= 0) {
        await q('UPDATE players SET attempts = ?, answered_at = ?, qualified = 0, reject_reason = ? WHERE id = ?', [attempts, received_at, 'no_attempts', p.id]);
      } else {
        await q('UPDATE players SET attempts = ? WHERE id = ?', [attempts, p.id]);
      }
      // On ne dit pas laquelle des 2 énigmes est fausse : ça empêche de les forcer une par une.
      return res.json({ result: 'wrong', attempts_left: left });
    }

    await D.insertAttempt(p.id, received_at, elapsed, 'qualified');
    await q('UPDATE players SET attempts = attempts + 1, answered_at = ?, qualified = 1 WHERE id = ?', [received_at, p.id]);
    res.json({
      result: 'qualified', chrono_ms: elapsed, chrono: util.fmtChrono(elapsed),
      rank: await D.rank(w.id, received_at), qualified_count: await D.qualifiedCount(w.id),
      draw_at: Number(w.start_at) + Number(w.qualification_ms)
    });
  } catch (e) { next(e); }
});

/* ---------- Réclamation du lot : le SEUL endroit où un numéro est demandé ---------- */

router.post('/claim/request', util.rateLimit('claim', 5, 60000), auth, async (req, res, next) => {
  try {
    const { player: p, wave: w } = req;
    if (w.status !== 'drawn' || !p.is_winner) return res.status(403).json({ error: 'not_a_winner' });
    if (p.claimed_at) return res.status(409).json({ error: 'already_claimed' });
    const phone = sms.normalizePhone(req.body?.phone);
    if (!phone) return res.status(400).json({ error: 'invalid_phone' });

    const code = util.smsCode();
    await q('UPDATE players SET claim_phone = ?, claim_code = ?, claim_expires_at = ? WHERE id = ?', [phone, code, Date.now() + 10 * 60000, p.id]);
    try {
      await sms.send(phone, `Pas-de-Lézard : votre code pour réclamer votre lot est ${code}. Valable 10 min.`);
    } catch (e) {
      console.error('SMS error', e.message);
      return res.status(502).json({ error: 'sms_failed' });
    }
    res.json({ ok: true, phone_masked: phone.replace(/(\+33\d)\d{5}(\d{3})/, '$1•••••$2'), ...(DEV ? { dev_code: code } : {}) });
  } catch (e) { next(e); }
});

router.post('/claim/verify', util.rateLimit('claim', 10, 60000), auth, async (req, res, next) => {
  try {
    const { player: p } = req;
    if (!p.claim_code || Date.now() > Number(p.claim_expires_at)) return res.status(410).json({ error: 'code_expired' });
    if (String(req.body?.code || '').trim() !== p.claim_code) return res.status(400).json({ error: 'bad_code' });
    // Le numéro a servi : on efface le code de vérification.
    await q('UPDATE players SET claimed_at = ?, claim_code = NULL, claim_expires_at = NULL WHERE id = ?', [Date.now(), p.id]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

/* ---------- Routes de test (DEV_MODE uniquement) ---------- */
if (DEV) {
  router.post('/dev/start-now', auth, async (req, res, next) => {
    try {
      const w = req.wave, now = Date.now();
      await q('UPDATE waves SET start_at = ?, end_at = ? WHERE id = ?', [now, now + (Number(w.end_at) - Number(w.start_at)), w.id]);
      res.json({ ok: true, start_at: now });
    } catch (e) { next(e); }
  });
  router.post('/dev/draw', auth, async (req, res, next) => {
    try {
      const w = req.wave, now = Date.now();
      const winners = await q('SELECT id FROM players WHERE wave_id = ? AND qualified = 1 ORDER BY RAND() LIMIT ?', [w.id, Number(w.prizes_count)]);
      for (const p of winners) await q('UPDATE players SET is_winner = 1 WHERE id = ?', [p.id]);
      await q('UPDATE waves SET status = ?, draw_mode = ?, drawn_at = ? WHERE id = ?', ['drawn', 'random', now, w.id]);
      res.json({ ok: true, winners: winners.length });
    } catch (e) { next(e); }
  });
}

module.exports = router;
