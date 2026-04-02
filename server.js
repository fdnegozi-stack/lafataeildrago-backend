require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const http = require('http');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 4000;

const TUNNEL_URL = process.env.TUNNEL_URL || 'https://tile-hiv-petition-weighted.trycloudflare.com';

app.use(cors());
app.use(express.json({ limit: '50mb' }));

// ── File statici offline (video e audio per PWA senza server) ─────
// Carica forest.mp3 e sfondo_vuoto.mp4 dalla root del repository
// URL: /static/forest.mp3  e  /static/sfondo_vuoto.mp4
app.use('/static', express.static(path.join(__dirname), {
  setHeaders: (res, filePath) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    if (filePath.endsWith('.mp4')) res.setHeader('Content-Type', 'video/mp4');
    if (filePath.endsWith('.mp3')) res.setHeader('Content-Type', 'audio/mpeg');
  }
}));

// Connessione PostgreSQL
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

pool.query('SELECT NOW()', (err, res) => {
  if (err) console.error('✗ Errore connessione PostgreSQL:', err.message);
  else console.log('✓ PostgreSQL connesso:', res.rows[0].now);
});

// ============================================================
// HEALTH CHECK
// ============================================================
app.get('/health', (req, res) => {
  res.json({ ok: true, timestamp: new Date().toISOString() });
});

// ============================================================
// PWA — serve la pagina mobile ai clienti
// ============================================================
app.get('/app', (req, res) => {
  res.sendFile(path.join(__dirname, 'mobile.html'));
});

// ============================================================
// PROXY → laptop locale (Whisper + Ollama + visual search)
// ============================================================
function proxyToLaptop(path, req, res) {
  const https = require('https');
  const payload = JSON.stringify(req.body);
  const url = new URL(TUNNEL_URL);
  const options = {
    hostname: url.hostname,
    port: 443,
    path: path,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload)
    },
    timeout: 60000
  };

  const proxyReq = https.request(options, (proxyRes) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    Object.keys(proxyRes.headers).forEach(key => {
      res.setHeader(key, proxyRes.headers[key]);
    });
    res.status(proxyRes.statusCode);
    proxyRes.pipe(res);
  });

  proxyReq.on('error', () => {
    res.status(503).json({
      ok: false,
      error: 'Laptop negozio non raggiungibile. Assicurati che il tunnel Cloudflare sia attivo.'
    });
  });

  proxyReq.on('timeout', () => {
    proxyReq.destroy();
    res.status(504).json({ ok: false, error: 'Timeout connessione laptop.' });
  });

  proxyReq.write(payload);
  proxyReq.end();
}

app.post('/api/voice', (req, res) => proxyToLaptop('/api/voice', req, res));
app.post('/api/voice-answer', (req, res) => proxyToLaptop('/api/voice-answer', req, res));
app.post('/api/search', (req, res) => proxyToLaptop('/api/search', req, res));
app.post('/api/avatar-response', (req, res) => proxyToLaptop('/api/avatar-response', req, res));

// ============================================================
// SINCRONIZZAZIONE
// ============================================================
app.post('/api/sync', async (req, res) => {
  const { prodotti, giacenze } = req.body;
  if (!prodotti || !Array.isArray(prodotti)) {
    return res.status(400).json({ ok: false, error: 'Dati prodotti mancanti' });
  }
  const client = await pool.connect();
  let prodotti_nuovi = 0, prodotti_tot = 0, giacenze_tot = 0;
  try {
    await client.query('BEGIN');
    for (const p of prodotti) {
      const result = await client.query(`
        INSERT INTO prodotti (id, codice_fd, descrizione, categoria, sottocategoria, prezzo, dimensioni, novita, sincronizzato_il)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
        ON CONFLICT (id) DO UPDATE SET
          codice_fd=$2, descrizione=$3, categoria=$4, sottocategoria=$5,
          prezzo=$6, dimensioni=$7, novita=$8, sincronizzato_il=NOW()
        RETURNING (xmax = 0) AS inserted
      `, [p.ID, p.Codice_FD, p.Descrizione, p.Categoria, p.Sottocategoria,
          p.Prezzo_Vendita, p.Dimensioni, p['Novità'] === 1 || p.Novita === 1]);
      prodotti_tot++;
      if (result.rows[0]?.inserted) prodotti_nuovi++;
    }
    if (giacenze && Array.isArray(giacenze)) {
      for (const g of giacenze) {
        await client.query(`
          INSERT INTO giacenze (prodotto_id, negozio_id, giacenza, aggiornato_il)
          VALUES ($1, $2, $3, NOW())
          ON CONFLICT (prodotto_id, negozio_id) DO UPDATE SET giacenza=$3, aggiornato_il=NOW()
        `, [g.prodotto_id, g.negozio_id, g.giacenza]);
        giacenze_tot++;
      }
    }
    await client.query(`
      INSERT INTO sincronizzazioni (tipo, prodotti_tot, prodotti_nuovi, giacenze_tot, esito)
      VALUES ('tutto', $1, $2, $3, 'ok')
    `, [prodotti_tot, prodotti_nuovi, giacenze_tot]);
    await client.query('COMMIT');
    res.json({ ok: true, prodotti_tot, prodotti_nuovi, giacenze_tot });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ ok: false, error: err.message });
  } finally { client.release(); }
});

// ============================================================
// PRODOTTI
// ============================================================
app.get('/api/prodotti', async (req, res) => {
  try {
    const { cerca, categoria, sottocategoria, negozio_id, limit = 50, offset = 0 } = req.query;
    let where = `WHERE g.giacenza > 0`;
    const params = [];
    let i = 1;
    if (negozio_id)     { where += ` AND g.negozio_id = $${i++}`; params.push(negozio_id); }
    if (categoria)      { where += ` AND p.categoria = $${i++}`; params.push(categoria); }
    if (sottocategoria) { where += ` AND p.sottocategoria = $${i++}`; params.push(sottocategoria); }
    if (cerca) { where += ` AND (p.descrizione ILIKE $${i} OR p.codice_fd ILIKE $${i})`; params.push(`%${cerca}%`); i++; }
    const rows = await pool.query(`
      SELECT p.id, p.codice_fd, p.descrizione, p.categoria,
        p.sottocategoria, p.prezzo, p.dimensioni, p.novita, p.foto_url,
        json_object_agg(g.negozio_id, g.giacenza) AS giacenze
      FROM prodotti p JOIN giacenze g ON g.prodotto_id = p.id
      ${where}
      GROUP BY p.id, p.codice_fd, p.descrizione, p.categoria,
        p.sottocategoria, p.prezzo, p.dimensioni, p.novita, p.foto_url
      ORDER BY CAST(NULLIF(regexp_replace(p.codice_fd, '[^0-9]', '', 'g'), '') AS INTEGER) NULLS LAST
      LIMIT $${i} OFFSET $${i+1}
    `, [...params, parseInt(limit), parseInt(offset)]);
    const count = await pool.query(`
      SELECT COUNT(DISTINCT p.id) AS n FROM prodotti p JOIN giacenze g ON g.prodotto_id = p.id ${where}
    `, params);
    res.json({ ok: true, data: rows.rows, total: parseInt(count.rows[0].n) });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.get('/api/prodotti/:id', async (req, res) => {
  try {
    const row = await pool.query(`
      SELECT p.*, json_object_agg(g.negozio_id, g.giacenza) AS giacenze
      FROM prodotti p JOIN giacenze g ON g.prodotto_id = p.id
      WHERE p.id = $1 GROUP BY p.id
    `, [req.params.id]);
    if (!row.rows.length) return res.status(404).json({ ok: false, error: 'Non trovato' });
    res.json({ ok: true, data: row.rows[0] });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// ============================================================
// FAQ
// ============================================================
app.get('/api/faq', async (req, res) => {
  try {
    const rows = await pool.query(`SELECT id, domanda, risposta, categoria FROM faq WHERE attiva = true ORDER BY ordine, id`);
    res.json({ ok: true, data: rows.rows });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// ============================================================
// NEGOZI
// ============================================================
app.get('/api/negozi', async (req, res) => {
  try {
    const rows = await pool.query(`SELECT * FROM negozi WHERE attivo = true ORDER BY id`);
    res.json({ ok: true, data: rows.rows });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.listen(PORT, () => {
  console.log('');
  console.log('  La Fata e il Drago — Backend API');
  console.log(`  Porta: ${PORT}`);
  console.log(`  Tunnel URL: ${process.env.TUNNEL_URL || 'non configurato'}`);
  console.log(`  Static: /static/forest.mp3 e /static/sfondo_vuoto.mp4`);
  console.log('');
});
