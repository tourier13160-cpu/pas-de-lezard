const express = require('express');
const { q, one } = require('../db');
const { wavePhase, fmtChrono } = require('../lib/util');

const router = express.Router();

/** Toutes les routes admin exigent l'en-tête x-admin-token. */
router.use((req, res, next) => {
  const expected = process.env.ADMIN_TOKEN;
  if (!expected || req.get('x-admin-token') !== expected) return res.status(401).json({ error: 'unauthorized' });
  next();
});

/* ---- Partenaires ---- */
router.get('/partners', async (req, res, next) => {
  try { res.json(await q('SELECT * FROM partners ORDER BY id')); } catch (e) { next(e); }
});

router.post('/partners', async (req, res, next) => {
  try {
    const { name, shop_url } = req.body || {};
    if (!name || !/^https?:\/\//.test(shop_url || '')) return res.status(400).json({ error: 'invalid_partner' });
    const r = await q('INSERT INTO partners (name, shop_url, created_at) VALUES (?, ?, ?)', [name, shop_url, Date.now()]);
    res.status(201).json({ id: r.insertId, name, shop_url });
  } catch (e) { next(e); }
});

/* ---- Énigmes ---- */
router.get('/partners/:id/puzzles', async (req, res, next) => {
  try {
    const rows = await q('SELECT * FROM puzzles WHERE partner_id = ? ORDER BY id', [req.params.id]);
    res.json(rows.map(p => ({ ...p, answers: JSON.parse(p.answers), active: !!p.active })));
  } catch (e) { next(e); }
});

router.post('/puzzles', async (req, res, next) => {
  try {
    const { partner_id, question, answers, hint_url } = req.body || {};
    if (!partner_id || !question || !Array.isArray(answers) || answers.length === 0) return res.status(400).json({ error: 'invalid_puzzle' });
    const r = await q('INSERT INTO puzzles (partner_id, question, answers, hint_url) VALUES (?, ?, ?, ?)',
      [partner_id, question, JSON.stringify(answers), hint_url || null]);
    res.status(201).json({ id: r.insertId });
  } catch (e) { next(e); }
});

router.patch('/puzzles/:id', async (req, res, next) => {
  try {
    const { active } = req.body || {};
    await q('UPDATE puzzles SET active = ? WHERE id = ?', [active ? 1 : 0, req.params.id]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

router.delete('/puzzles/:id', async (req, res, next) => {
  try {
    await q('DELETE FROM puzzles WHERE id = ?', [req.params.id]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

/* ---- Vagues ---- */
router.get('/waves', async (req, res, next) => {
  try {
    const now = Date.now();
    const rows = await q('SELECT * FROM waves ORDER BY start_at DESC LIMIT 50');
    res.json(rows.map(w => ({ ...w, phase: wavePhase(w, now) })));
  } catch (e) { next(e); }
});

router.post('/waves', async (req, res, next) => {
  try {
    const b = req.body || {};
    const start = Date.parse(b.start_at);
    if (!b.partner_id || Number.isNaN(start)) {
      return res.status(400).json({ error: 'invalid_wave', hint: 'partner_id + start_at (ISO 8601, ex: 2026-10-01T18:00:00Z)' });
    }
    const partner = await one('SELECT id FROM partners WHERE id = ?', [b.partner_id]);
    if (!partner) return res.status(404).json({ error: 'partner_not_found' });

    const durationMs = (b.duration_min || 15) * 60000;
    const r = await q(`INSERT INTO waves
        (partner_id, start_at, end_at, capacity, registration_open_before_ms, registration_close_before_ms,
         qualification_ms, min_human_ms, prizes_count, max_attempts, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [b.partner_id, start, start + durationMs,
       b.capacity || 500,
       (b.registration_open_before_min || 60) * 60000,
       (b.registration_close_before_sec || 60) * 1000,
       (b.qualification_seconds || 300) * 1000,
       (b.min_human_seconds || 20) * 1000,
       b.prizes_count || 10,
       b.max_attempts || 3,
       Date.now()]);
    res.status(201).json({ id: r.insertId, start_at: new Date(start).toISOString() });
  } catch (e) { next(e); }
});

/** Ouvre la porte immédiatement (réservé aux tests). */
router.post('/waves/:id/start-now', async (req, res, next) => {
  try {
    const w = await one('SELECT * FROM waves WHERE id = ?', [req.params.id]);
    if (!w) return res.status(404).json({ error: 'wave_not_found' });
    const now = Date.now();
    await q('UPDATE waves SET start_at = ?, end_at = ? WHERE id = ?',
      [now, now + (Number(w.end_at) - Number(w.start_at)), w.id]);
    res.json({ ok: true, start_at: now });
  } catch (e) { next(e); }
});

/**
 * Tirage des lots parmi les qualifiés.
 * mode=chrono → les N plus rapides. mode=random → N tirés au sort parmi les qualifiés (recommandé).
 */
router.post('/waves/:id/draw', async (req, res, next) => {
  try {
    const w = await one('SELECT * FROM waves WHERE id = ?', [req.params.id]);
    if (!w) return res.status(404).json({ error: 'wave_not_found' });
    if (w.status === 'drawn') return res.status(409).json({ error: 'already_drawn' });

    const phase = wavePhase(w, Date.now());
    if (phase !== 'finished' && !req.body?.force) {
      return res.status(409).json({ error: 'wave_not_finished', phase, hint: 'passer {"force":true} pour forcer en test' });
    }

    const mode = req.body?.mode === 'chrono' ? 'chrono' : 'random';
    let qualified = await q('SELECT id, pseudo, answered_at FROM players WHERE wave_id = ? AND qualified = 1 ORDER BY answered_at ASC', [w.id]);

    if (mode === 'random') {
      // Mélange de Fisher-Yates avec RANDOM() en base pour rester reproductible côté serveur
      qualified = await q('SELECT id, pseudo, answered_at FROM players WHERE wave_id = ? AND qualified = 1 ORDER BY RAND()', [w.id]);
    }
    const winners = qualified.slice(0, Number(w.prizes_count));

    for (const p of winners) await q('UPDATE players SET is_winner = 1 WHERE id = ?', [p.id]);
    await q('UPDATE waves SET status = ?, draw_mode = ?, drawn_at = ? WHERE id = ?', ['drawn', mode, Date.now(), w.id]);

    res.json({
      ok: true, mode, qualified_count: qualified.length,
      winners: winners.map(p => ({ pseudo: p.pseudo, chrono: fmtChrono(Number(p.answered_at) - Number(w.start_at)) }))
    });
  } catch (e) { next(e); }
});

/** Statistiques d'une vague : ce que vous montrerez au partenaire. */
router.get('/waves/:id/stats', async (req, res, next) => {
  try {
    const w = await one('SELECT * FROM waves WHERE id = ?', [req.params.id]);
    if (!w) return res.status(404).json({ error: 'wave_not_found' });
    const start = Number(w.start_at);

    const s = await one(`
      SELECT COUNT(*) AS joined,
             SUM(qualified) AS qualified,
             SUM(CASE WHEN reject_reason = 'too_fast' THEN 1 ELSE 0 END) AS too_fast,
             SUM(CASE WHEN reject_reason = 'no_attempts' THEN 1 ELSE 0 END) AS no_attempts,
             SUM(CASE WHEN answered_at IS NULL THEN 1 ELSE 0 END) AS no_answer,
             SUM(is_winner) AS winners,
             SUM(CASE WHEN claimed_at IS NOT NULL THEN 1 ELSE 0 END) AS claimed,
             AVG(CASE WHEN qualified = 1 THEN answered_at - ? END) AS avg_qualified_ms,
             MIN(CASE WHEN qualified = 1 THEN answered_at - ? END) AS fastest_ms,
             MAX(CASE WHEN qualified = 1 THEN answered_at - ? END) AS slowest_ms,
             COUNT(DISTINCT ip_hash) AS distinct_ips
      FROM players WHERE wave_id = ?`, [start, start, start, w.id]);

    const attempts = (await one('SELECT COUNT(*) AS n FROM attempts a JOIN players p ON p.id = a.player_id WHERE p.wave_id = ?', [w.id])).n;

    res.json({
      wave: { id: w.id, start_at: new Date(start).toISOString(), status: w.status, phase: wavePhase(w, Date.now()) },
      ...s,
      total_attempts: attempts,
      avg_qualified: s.avg_qualified_ms ? fmtChrono(Math.round(s.avg_qualified_ms)) : null,
      fastest: s.fastest_ms ? fmtChrono(s.fastest_ms) : null,
      slowest: s.slowest_ms ? fmtChrono(s.slowest_ms) : null
    });
  } catch (e) { next(e); }
});

router.get('/waves/:id/players', async (req, res, next) => {
  try {
    const w = await one('SELECT * FROM waves WHERE id = ?', [req.params.id]);
    if (!w) return res.status(404).json({ error: 'wave_not_found' });
    const rows = await q('SELECT id, pseudo, player_code, joined_at, attempts, answered_at, qualified, reject_reason, is_winner, claimed_at FROM players WHERE wave_id = ? ORDER BY answered_at ASC', [w.id]);
    res.json(rows.map(p => ({
      ...p,
      qualified: !!p.qualified, is_winner: !!p.is_winner, claimed: !!p.claimed_at,
      chrono: p.answered_at ? fmtChrono(Number(p.answered_at) - Number(w.start_at)) : null
    })));
  } catch (e) { next(e); }
});

module.exports = router;
