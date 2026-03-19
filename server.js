require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const http = require('http');

const app = express();
const PORT = process.env.PORT || 4000;

// IP del laptop in negozio — aggiorna con IP hotspot quando in negozio
const TUNNEL_URL = process.env.TUNNEL_URL || 'https://tile-hiv-petition-weighted.trycloudflare.com';

app.use(cors());
app.use(express.json({ limit: '50mb' }));

// Connessione PostgreSQL
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Test connessione
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
const path = require('path');

app.get('/app', (req, res) => {
  res.sendFile(path.join(__dirname, 'mobile.html'));
});

// ============================================================
// PROXY → laptop locale (Whisper + Ollama + visual search)
// ============================================================

// Helper: proxy una richiesta al laptop locale
function proxyToLaptop(path, req, res) {
  const payload = JSON.stringify(req.body);
  const options = {
    hostname: LAPTOP_IP,
    port: LAPTOP_PORT,
    path: path,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload)
    },
    timeout: 60000
  };

  const proxyReq = http.request(options, (proxyRes) => {
    // Passa gli header del laptop al client (incluso SSE se streaming)
    res.setHeader('Access-Control-Allow-Origin', '*');
    Object.keys(proxyRes.headers).forEach(key => {
      res.setHeader(key, proxyRes.headers[key]);
    });
    res.status(proxyRes.statusCode);
    // Pipe diretto — funziona sia per JSON che per SSE streaming
    proxyRes.pipe(res);
  });

  proxyReq.on('error', () => {
    res.status(503).json({
      ok: false,
      error: 'Laptop negozio non raggiungibile. Assicurati di essere connesso alla rete del negozio.'
    });
  });

  proxyReq.on('timeout', () => {
    proxyReq.destroy();
    res.status(504).json({ ok: false, error: 'Timeout connessione laptop.' });
  });

  proxyReq.write(payload);
  proxyReq.end();
}

// Proxy voice transcription (Whisper)
app.post('/api/voice', (req, res) => proxyToLaptop('/api/voice', req, res));

// Proxy voice answer (Ollama) — streaming SSE
app.post('/api/voice-answer', (req, res) => proxyToLaptop('/api/voice-answer', req, res));

// Proxy visual search (CLIP)
app.post('/api/search', (req, res) => proxyToLaptop('/api/search', req, res));

// Proxy avatar response (Ollama) — streaming SSE
app.post('/api/avatar-response', (req, res) => proxyToLaptop('/api/avatar-response', req, res));

// ============================================================
// SINCRONIZZAZIONE — riceve dati da pannello admin locale
// ============================================================
app.post('/api/sync', async (req, res) => {
  const { prodotti, giacenze } = req.body;

  if (!prodotti || !Array.isArray(prodotti)) {
    return res.status(400).json({ ok: false, error: 'Dati prodotti mancanti' });
  }

  const client = await pool.connect();
  let prodotti_nuovi = 0;
  let prodotti_tot = 0;
  let giacenze_tot = 0;

  try {
    await client.query('BEGIN');

    for (const p of prodotti) {
      const result = await client.query(`
        INSERT INTO prodotti (id, codice_fd, descrizione, categoria, sottocategoria, prezzo, dimensioni, novita, sincronizzato_il)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
        ON CONFLICT (id) DO UPDATE SET
          codice_fd        = EXCLUDED.codice_fd,
          descrizione      = EXCLUDED.descrizione,
          categoria        = EXCLUDED.categoria,
          sottocategoria   = EXCLUDED.sottocategoria,
          prezzo           = EXCLUDED.prezzo,
          dimensioni       = EXCLUDED.dimensioni,
          novita           = EXCLUDED.novita,
          sincronizzato_il = NOW()
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
          ON CONFLICT (prodotto_id, negozio_id) DO UPDATE SET
            giacenza = EXCLUDED.giacenza,
            aggiornato_il = NOW()
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
  } finally {
    client.release();
  }
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
    if (cerca) {
      where += ` AND (p.descrizione ILIKE $${i} OR p.codice_fd ILIKE $${i})`;
      params.push(`%${cerca}%`); i++;
    }

    const rows = await pool.query(`
      SELECT p.id, p.codice_fd, p.descrizione, p.categoria,
        p.sottocategoria, p.prezzo, p.dimensioni, p.novita, p.foto_url,
        json_object_agg(g.negozio_id, g.giacenza) AS giacenze
      FROM prodotti p
      JOIN giacenze g ON g.prodotto_id = p.id
      ${where}
      GROUP BY p.id, p.codice_fd, p.descrizione, p.categoria,
        p.sottocategoria, p.prezzo, p.dimensioni, p.novita, p.foto_url
      ORDER BY CAST(NULLIF(regexp_replace(p.codice_fd, '[^0-9]', '', 'g'), '') AS INTEGER) NULLS LAST
      LIMIT $${i} OFFSET $${i+1}
    `, [...params, parseInt(limit), parseInt(offset)]);

    const count = await pool.query(`
      SELECT COUNT(DISTINCT p.id) AS n
      FROM prodotti p JOIN giacenze g ON g.prodotto_id = p.id ${where}
    `, params);

    res.json({ ok: true, data: rows.rows, total: parseInt(count.rows[0].n) });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.get('/api/prodotti/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const row = await pool.query(`
      SELECT p.*, json_object_agg(g.negozio_id, g.giacenza) AS giacenze
      FROM prodotti p JOIN giacenze g ON g.prodotto_id = p.id
      WHERE p.id = $1 GROUP BY p.id
    `, [id]);
    if (!row.rows.length) return res.status(404).json({ ok: false, error: 'Non trovato' });
    res.json({ ok: true, data: row.rows[0] });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// ============================================================
// FAQ
// ============================================================
app.get('/api/faq', async (req, res) => {
  try {
    const rows = await pool.query(`
      SELECT id, domanda, risposta, categoria FROM faq
      WHERE attiva = true ORDER BY ordine, id
    `);
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
  console.log('');
});
