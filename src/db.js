require('dotenv').config();
const mysql = require('mysql2/promise');

/**
 * Accès MySQL. Hostinger fournit ces valeurs dans hpanel → Bases de données.
 * Variables attendues : DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, DB_NAME.
 */
const DB_HOST = process.env.DB_HOST || 'localhost';
const DB_PORT = parseInt(process.env.DB_PORT || '3306', 10);
const DB_USER = process.env.DB_USER;
const DB_PASSWORD = process.env.DB_PASSWORD;
const DB_NAME = process.env.DB_NAME;

let pool = null;

function getPool() {
  if (pool) return pool;
  if (!DB_USER || !DB_PASSWORD || !DB_NAME) {
    throw new Error('db_not_configured: renseignez DB_USER, DB_PASSWORD et DB_NAME');
  }
  pool = mysql.createPool({
    host: DB_HOST,
    port: DB_PORT,
    user: DB_USER,
    password: DB_PASSWORD,
    database: DB_NAME,
    waitForConnections: true,
    connectionLimit: 5,
    queueLimit: 0,
    charset: 'utf8mb4',
    // Les colonnes BIGINT (horodatages en millisecondes) doivent revenir en Number, pas en String.
    supportBigNumbers: true,
    bigNumberStrings: false,
    dateStrings: true
  });
  return pool;
}

async function q(sql, params = []) {
  const [rows] = await getPool().execute(sql, params);
  return rows;
}
async function one(sql, params = []) {
  const rows = await q(sql, params);
  return rows[0] || null;
}

/** Schéma. Exécuté au démarrage : les CREATE TABLE IF NOT EXISTS sont sans effet si tout existe déjà. */
async function migrate() {
  const statements = [
    `CREATE TABLE IF NOT EXISTS partners (
      id INT AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(120) NOT NULL,
      shop_url VARCHAR(500) NOT NULL,
      created_at BIGINT NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

    `CREATE TABLE IF NOT EXISTS waves (
      id INT AUTO_INCREMENT PRIMARY KEY,
      partner_id INT NOT NULL,
      start_at BIGINT NOT NULL,
      end_at BIGINT NOT NULL,
      capacity INT NOT NULL DEFAULT 500,
      registration_open_before_ms BIGINT NOT NULL DEFAULT 3600000,
      registration_close_before_ms BIGINT NOT NULL DEFAULT 60000,
      qualification_ms BIGINT NOT NULL DEFAULT 300000,
      min_human_ms BIGINT NOT NULL DEFAULT 20000,
      prizes_count INT NOT NULL DEFAULT 10,
      max_attempts INT NOT NULL DEFAULT 3,
      status VARCHAR(16) NOT NULL DEFAULT 'scheduled',
      draw_mode VARCHAR(16) NULL,
      drawn_at BIGINT NULL,
      created_at BIGINT NOT NULL,
      INDEX idx_waves_start (start_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

    `CREATE TABLE IF NOT EXISTS puzzles (
      id INT AUTO_INCREMENT PRIMARY KEY,
      partner_id INT NOT NULL,
      question VARCHAR(500) NOT NULL,
      answers TEXT NOT NULL,
      hint_url VARCHAR(500) NULL,
      active TINYINT NOT NULL DEFAULT 1,
      INDEX idx_puzzles_partner (partner_id, active)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

    `CREATE TABLE IF NOT EXISTS players (
      id INT AUTO_INCREMENT PRIMARY KEY,
      wave_id INT NOT NULL,
      pseudo VARCHAR(20) NOT NULL,
      player_code VARCHAR(8) NOT NULL,
      token VARCHAR(64) NOT NULL,
      ip_hash VARCHAR(64) NULL,
      joined_at BIGINT NOT NULL,
      puzzle_ids TEXT NOT NULL,
      attempts INT NOT NULL DEFAULT 0,
      answered_at BIGINT NULL,
      qualified TINYINT NOT NULL DEFAULT 0,
      reject_reason VARCHAR(16) NULL,
      is_winner TINYINT NOT NULL DEFAULT 0,
      claim_phone VARCHAR(20) NULL,
      claim_code VARCHAR(8) NULL,
      claim_expires_at BIGINT NULL,
      claimed_at BIGINT NULL,
      UNIQUE KEY uniq_token (token),
      UNIQUE KEY uniq_pseudo (wave_id, pseudo),
      UNIQUE KEY uniq_code (wave_id, player_code),
      INDEX idx_players_rank (wave_id, qualified, answered_at),
      INDEX idx_players_ip (wave_id, ip_hash)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

    `CREATE TABLE IF NOT EXISTS attempts (
      id INT AUTO_INCREMENT PRIMARY KEY,
      player_id INT NOT NULL,
      received_at BIGINT NOT NULL,
      elapsed_ms BIGINT NOT NULL,
      result VARCHAR(16) NOT NULL,
      INDEX idx_attempts_player (player_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
  ];
  for (const s of statements) await getPool().query(s);
}

/** Jeu de démonstration : 1 partenaire, 6 énigmes, 1 vague dont le départ est dans 5 minutes. */
async function seedIfEmpty() {
  const row = await one('SELECT COUNT(*) AS n FROM partners');
  if (row && row.n > 0) return;

  const now = Date.now();
  const p = await q('INSERT INTO partners (name, shop_url, created_at) VALUES (?, ?, ?)',
    ['Boutique de démonstration', 'https://example.com', now]);
  const pid = p.insertId;

  const puzzles = [
    ['De quelle couleur est le logo affiché en haut de la boutique ?', ['vert', 'verte', 'green']],
    ['Combien de produits sont affichés sur la page d\'accueil ?', ['6', 'six']],
    ['Quel mot est écrit sur le bandeau promotionnel ?', ['bienvenue']],
    ['Quel est le prix du produit mis en avant (en euros, sans centimes) ?', ['29', '29 euros', '29€']],
    ['Quelle ville apparaît dans le pied de page de la boutique ?', ['paris']],
    ['(25 × 4) − 15 = ?', ['85']]
  ];
  for (const [question, answers] of puzzles) {
    await q('INSERT INTO puzzles (partner_id, question, answers, hint_url) VALUES (?, ?, ?, NULL)',
      [pid, question, JSON.stringify(answers)]);
  }

  const start = now + 5 * 60000;
  await q(`INSERT INTO waves (partner_id, start_at, end_at, capacity, registration_open_before_ms, prizes_count, created_at)
           VALUES (?, ?, ?, 500, ?, 10, ?)`,
    [pid, start, start + 15 * 60000, 60 * 60000, now]);

  console.log(`[seed] Partenaire + 6 énigmes + 1 vague de test (départ ${new Date(start).toLocaleTimeString('fr-FR')}).`);
}

module.exports = { q, one, getPool, migrate, seedIfEmpty };
