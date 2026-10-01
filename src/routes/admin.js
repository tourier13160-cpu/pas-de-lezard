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

/* ============ PARTENAIRES ============ */

router.get('/partners', async (req, res, next) => {
  try {
    const rows = await q(`
      SELECT p.*,
             (SELECT COUNT(*) FROM puzzles z WHERE z.partner_id = p.id AND z.active = 1) AS puzzles_active,
             (SELECT COUNT(*) FROM puzzles z WHERE z.partner_id = p.id) AS puzzles_total,
             (SELECT COUNT(*) FROM waves w WHERE w.partner_id = p.id) AS waves_count
      FROM partners p ORDER BY p.id`);
    res.json(rows);
  } catch (e) { next(e); }
});

router.post('/partners', async (req, res, next) => {
  try {
    const { name, shop_url } = req.body || {};
    if (!name || !/^https?:\/\//.test(shop_url || '')) {
      return res.status(400).json({ error: 'invalid_partner', hint: 'name + shop_url (commençant par http:// ou https://)' });
    }
    const r = await q('INSERT INTO partners (name, shop_url, created_at) VALUES (?, ?, ?)', [String(name).trim(), String(shop_url).trim(), Date.now()]);
    res.status(201).json({ id: r.insertId, name, shop_url });
  } catch (e) { next(e); }
});

router.patch('/partners/:id', async (req, res, next) => {
  try {
    const { name, shop_url } = req.body || {};
    const p = await one('SELECT * FROM partners WHERE id = ?', [req.params.id]);
    if (!p) return res.status(404).json({ error: 'partner_not_found' });
    if (shop_url !== undefined && !/^https?:\/\//.test(shop_url)) {
      return res.status(400).json({ error: 'invalid_url', hint: "l'adresse doit commencer par http:// ou https://" });
    }
    await q('UPDATE partners SET name = ?, shop_url = ? WHERE id = ?', [
      name !== undefined ? String(name).trim() : p.name,
      shop_url !== undefined ? String(shop_url).trim() : p.shop_url,
      p.id]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

router.delete('/partners/:id', async (req, res, next) => {
  try {
    const used = await one('SELECT COUNT(*) AS n FROM waves WHERE partner_id = ?', [req.params.id]);
    if (used.n > 0) return res.status(409).json({ error: 'partner_in_use', waves: used.n, hint: "Ce partenaire est utilisé par une vague. Supprime d'abord la vague." });
    await q('DELETE FROM puzzles WHERE partner_id = ?', [req.params.id]);
    await q('DELETE FROM partners WHERE id = ?', [req.params.id]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

/* ============ ÉNIGMES ============ */

router.get('/partners/:id/puzzles', async (req, res, next) => {
  try {
    const rows = await q('SELECT * FROM puzzles WHERE partner_id = ? ORDER BY id', [req.params.id]);
    res.json(rows.map(p => ({ ...p, answers: JSON.parse(p.answers), active: !!p.active })));
  } catch (e) { next(e); }
});

router.post('/puzzles', async (req, res, next) => {
  try {
    const { partner_id, question, answers, hint_url } = req.body || {};
    if (!partner_id || !question || !Array.isArray(answers) || answers.length === 0) {
      return res.status(400).json({ error: 'invalid_puzzle', hint: 'partner_id + question + answers (liste)' });
    }
    const r = await q('INSERT INTO puzzles (partner_id, question, answers, hint_url) VALUES (?, ?, ?, ?)',
      [partner_id, String(question).trim(), JSON.stringify(answers.map(a => String(a).trim())), hint_url || null]);
    res.status(201).json({ id: r.insertId });
  } catch (e) { next(e); }
});

router.patch('/puzzles/:id', async (req, res, next) => {
  try {
    const { question, answers, hint_url, active } = req.body || {};
    const p = await one('SELECT * FROM puzzles WHERE id = ?', [req.params.id]);
    if (!p) return res.status(404).json({ error: 'puzzle_not_found' });
    await q('UPDATE puzzles SET question = ?, answers = ?, hint_url = ?, active = ? WHERE id = ?', [
      question !== undefined ? String(question).trim() : p.question,
      answers !== undefined ? JSON.stringify(answers.map(a => String(a).trim())) : p.answers,
      hint_url !== undefined ? hint_url : p.hint_url,
      active !== undefined ? (active ? 1 : 0) : p.active,
      p.id]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

router.delete('/puzzles/:id', async (req, res, next) => {
  try {
    await q('DELETE FROM puzzles WHERE id = ?', [req.params.id]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

/* ============ VAGUES ============ */

router.get('/waves', async (req, res, next) => {
  try {
    const now = Date.now();
    const rows = await q(`SELECT w.*, p.name AS partner_name, p.shop_url AS partner_url
                          FROM waves w LEFT JOIN partners p ON p.id = w.partner_id
                          ORDER BY w.start_at DESC LIMIT 50`);
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
    const partner = await one('SELECT id, name FROM partners WHERE id = ?', [b.partner_id]);
    if (!partner) return res.status(404).json({ error: 'partner_not_found' });

    // Garde-fou : une vague a besoin d'au moins 2 énigmes actives chez son partenaire
    const pz = await one('SELECT COUNT(*) AS n FROM puzzles WHERE partner_id = ? AND active = 1', [b.partner_id]);
    if (pz.n < 2) {
      return res.status(400).json({ error: 'not_enough_puzzles', count: pz.n,
        hint: `Le partenaire « ${partner.name} » n'a que ${pz.n} énigme(s) active(s). Il en faut au moins 2.` });
    }

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
    res.status(201).json({ id: r.insertId, start_at: new Date(start).toISOString(), partner: partner.name });
  } catch (e) { next(e); }
});

router.delete('/waves/:id', async (req, res, next) => {
  try {
    const w = await one('SELECT * FROM waves WHERE id = ?', [req.params.id]);
    if (!w) return res.status(404).json({ error: 'wave_not_found' });
    await q('DELETE FROM attempts WHERE player_id IN (SELECT id FROM players WHERE wave_id = ?)', [w.id]);
    await q('DELETE FROM players WHERE wave_id = ?', [w.id]);
    await q('DELETE FROM waves WHERE id = ?', [w.id]);
    res.json({ ok: true });
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

/** Tirage des lots parmi les qualifiés. */
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
    const qualified = mode === 'chrono'
      ? await q('SELECT id, pseudo, answered_at FROM players WHERE wave_id = ? AND qualified = 1 ORDER BY answered_at ASC', [w.id])
      : await q('SELECT id, pseudo, answered_at FROM players WHERE wave_id = ? AND qualified = 1 ORDER BY RAND()', [w.id]);
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
    const w = await one('SELECT w.*, p.name AS partner_name, p.shop_url AS partner_url FROM waves w LEFT JOIN partners p ON p.id = w.partner_id WHERE w.id = ?', [req.params.id]);
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
      wave: { id: w.id, start_at: new Date(start).toISOString(), status: w.status, phase: wavePhase(w, Date.now()),
              partner_name: w.partner_name, partner_url: w.partner_url },
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
