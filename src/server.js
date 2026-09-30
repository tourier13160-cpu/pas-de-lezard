const express = require('express');
const path = require('path');
const { migrate, seedIfEmpty } = require('./db');

const app = express();
app.set('trust proxy', process.env.TRUST_PROXY === '1');
app.disable('x-powered-by');
app.use(express.json({ limit: '10kb' }));
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cache-Control', req.path.startsWith('/api') ? 'no-store' : 'public, max-age=300');
  next();
});

app.use('/api/admin', require('./routes/admin'));
app.use('/api', require('./routes/public'));
app.use(express.static(path.join(__dirname, '..', 'public')));

app.use('/api', (req, res) => res.status(404).json({ error: 'not_found' }));
app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'bad_json' });
  console.error(err);
  res.status(500).json({ error: 'server_error' });
});

const PORT = process.env.PORT || 3000;

(async () => {
  try {
    await migrate();
    await seedIfEmpty();
    app.listen(PORT, () => {
      console.log(`Pas-de-Lézard → port ${PORT} (DEV_MODE=${process.env.DEV_MODE === '1' ? 'on' : 'off'}, MySQL ${process.env.DB_NAME})`);
    });
  } catch (e) {
    console.error('[fatal] démarrage impossible :', e.message);
    console.error('→ Vérifiez DB_HOST, DB_USER, DB_PASSWORD et DB_NAME dans les variables d\'environnement.');
    process.exit(1);
  }
})();
