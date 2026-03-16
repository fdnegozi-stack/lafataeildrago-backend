require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 4000;

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
// SINCRONIZZAZIONE — riceve dati da pannello admin locale
// ============================================================

// Sincronizza prodotti e giacenze da dragon.fdb
app.post('/api/sync', async (req, res) => {
  const { prodotti, giacenze, negozi_ids } = req.body;

  if (!prodotti || !Array.isArray(prodotti)) {
    return res.status(400).json({ ok: false, error: 'Dati prodotti mancanti' });
  }

  const client = await pool.connect();
  let prodotti_nuovi = 0;
  let prodotti_tot = 0;
  let giacenze_tot = 0;

  try {
    await client.query('BEGIN');

    // Upsert prodotti
    for (const p of prodotti) {
      const result = await client.query(`
        INSERT INTO prodotti (id, codice_fd, descrizione, categoria, sottocategoria, prezzo, dimensioni, novita, sincronizzato_il)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
        ON CONFLICT (id) DO UPDATE SET
          codice_fd       = EXCLUDED.codice_fd,
          descrizione     = EXCLUDED.descrizione,
          categoria       = EXCLUDED.categoria,
          sottocategoria  = EXCLUDED.sottocategoria,
          prezzo          = EXCLUDED.prezzo,
          dimensioni      = EXCLUDED.dimensioni,
          novita          = EXCLUDED.novita,
          sincronizzato_il = NOW()
        RETURNING (xmax = 0) AS inserted
      `, [p.ID, p.Codice_FD, p.Descrizione, p.Categoria, p.Sottocategoria,
          p.Prezzo_Vendita, p.Dimensioni, p['Novità'] === 1 || p.Novita === 1]);

      prodotti_tot++;
      if (result.rows[0]?.inserted) prodotti_nuovi++;
    }

    // Upsert giacenze
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

    // Log sincronizzazione
    await client.query(`
      INSERT INTO sincronizzazioni (tipo, prodotti_tot, prodotti_nuovi, giacenze_tot, esito)
      VALUES ('tutto', $1, $2, $3, 'ok')
    `, [prodotti_tot, prodotti_nuovi, giacenze_tot]);

    await client.query('COMMIT');

    res.json({
      ok: true,
      prodotti_tot,
      prodotti_nuovi,
      giacenze_tot,
      message: `Sincronizzati ${prodotti_tot} prodotti (${prodotti_nuovi} nuovi) e ${giacenze_tot} giacenze.`
    });

  } catch (err) {
    await client.query('ROLLBACK');
    await pool.query(`
      INSERT INTO sincronizzazioni (tipo, esito, dettagli)
      VALUES ('tutto', 'errore', $1)
    `, [err.message]);
    res.status(500).json({ ok: false, error: err.message });
  } finally {
    client.release();
  }
});

// ============================================================
// PRODOTTI — API per app clienti
// ============================================================

// Lista prodotti disponibili
app.get('/api/prodotti', async (req, res) => {
  try {
    const { cerca, categoria, sottocategoria, negozio_id, limit = 50, offset = 0 } = req.query;
    let where = `WHERE g.giacenza > 0`;
    const params = [];
    let i = 1;

    if (negozio_id) { where += ` AND g.negozio_id = $${i++}`; params.push(negozio_id); }
    if (categoria)  { where += ` AND p.categoria = $${i++}`; params.push(categoria); }
    if (sottocategoria) { where += ` AND p.sottocategoria = $${i++}`; params.push(sottocategoria); }
    if (cerca) {
      where += ` AND (p.descrizione ILIKE $${i} OR p.codice_fd ILIKE $${i})`;
      params.push(`%${cerca}%`); i++;
    }

    const rows = await pool.query(`
      SELECT DISTINCT p.id, p.codice_fd, p.descrizione, p.categoria,
        p.sottocategoria, p.prezzo, p.dimensioni, p.novita, p.foto_url,
        json_object_agg(g.negozio_id, g.giacenza) AS giacenze
      FROM prodotti p
      JOIN giacenze g ON g.prodotto_id = p.id
      ${where}
      GROUP BY p.id
      ORDER BY CAST(p.codice_fd AS INTEGER)
      LIMIT $${i} OFFSET $${i+1}
    `, [...params, parseInt(limit), parseInt(offset)]);

    const count = await pool.query(`
      SELECT COUNT(DISTINCT p.id) AS n
      FROM prodotti p JOIN giacenze g ON g.prodotto_id = p.id ${where}
    `, params);

    res.json({ ok: true, data: rows.rows, total: parseInt(count.rows[0].n) });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// Singolo prodotto per ID
app.get('/api/prodotti/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const row = await pool.query(`
      SELECT p.*,
        json_object_agg(g.negozio_id, g.giacenza) AS giacenze
      FROM prodotti p
      JOIN giacenze g ON g.prodotto_id = p.id
      WHERE p.id = $1
      GROUP BY p.id
    `, [id]);

    if (!row.rows.length) return res.status(404).json({ ok: false, error: 'Non trovato' });

    // Contenuti extra
    const extra = await pool.query(`
      SELECT titolo, contenuto FROM contenuti_extra
      WHERE tipo = 'prodotto' AND riferimento = $1
    `, [id]);

    // Prodotti correlati
    const correlati = await pool.query(`
      SELECT p.id, p.codice_fd, p.descrizione, p.foto_url, pc.tipo
      FROM prodotti_correlati pc
      JOIN prodotti p ON p.id = pc.correlato_id
      WHERE pc.prodotto_id = $1
    `, [id]);

    res.json({
      ok: true,
      data: {
        ...row.rows[0],
        contenuti_extra: extra.rows,
        correlati: correlati.rows
      }
    });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// ============================================================
// TESTO AVATAR — per lingua
// ============================================================
app.get('/api/avatar/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { lingua = 'it' } = req.query;

    const testo = await pool.query(`
      SELECT testo FROM testi_avatar
      WHERE prodotto_id = $1 AND lingua = $2
    `, [id, lingua]);

    if (testo.rows.length) {
      return res.json({ ok: true, testo: testo.rows[0].testo, cached: true });
    }

    // Non trovato — il client dovrà generarlo
    res.json({ ok: true, testo: null, cached: false });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// Salva testo avatar generato
app.post('/api/avatar/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { lingua, testo } = req.body;
    await pool.query(`
      INSERT INTO testi_avatar (prodotto_id, lingua, testo)
      VALUES ($1, $2, $3)
      ON CONFLICT (prodotto_id, lingua) DO UPDATE SET testo = EXCLUDED.testo, generato_il = NOW()
    `, [id, lingua, testo]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// ============================================================
// FAQ
// ============================================================
app.get('/api/faq', async (req, res) => {
  try {
    const { categoria } = req.query;
    const rows = await pool.query(`
      SELECT id, domanda, risposta, categoria FROM faq
      WHERE attiva = true AND ($1::text IS NULL OR categoria = $1 OR categoria IS NULL)
      ORDER BY ordine, id
    `, [categoria || null]);
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
  console.log('');
});
