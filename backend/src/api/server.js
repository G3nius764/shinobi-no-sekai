// src/api/server.js — API REST para o Portal do Jogador
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });

const express = require('express');
const cors    = require('cors');
const helmet  = require('helmet');
const morgan  = require('morgan');
const rateLimit = require('express-rate-limit');
const jwt     = require('jsonwebtoken');
const bcrypt  = require('bcryptjs');
const pool    = require('../db/pool');

const app = express();

// ── Middlewares ────────────────────────────────────────────────────────────
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({
  origin: function(origin, callback) {
    // Permite localhost, netlify.app, onrender.com e PORTAL_URL
    if (!origin) return callback(null, true);
    if (origin.includes('localhost') || origin.includes('127.0.0.1')) return callback(null, true);
    if (origin.endsWith('.netlify.app')) return callback(null, true);
    if (origin.endsWith('.onrender.com')) return callback(null, true);
    if (origin.endsWith('.railway.app')) return callback(null, true);
    if (process.env.PORTAL_URL && origin === process.env.PORTAL_URL) return callback(null, true);
    callback(null, true); // Liberar tudo por enquanto
  },
  credentials: true,
}));
app.use(express.json({ limit: '10mb' }));
app.use(morgan('dev'));

const limiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 100 });
app.use('/api/', limiter);

// ── Auth Middleware ────────────────────────────────────────────────────────
function auth(req, res, next) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Token não fornecido' });
  }
  try {
    req.user = jwt.verify(header.split(' ')[1], process.env.JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Token inválido ou expirado' });
  }
}

function gmOnly(req, res, next) {
  if (!['gm','admin'].includes(req.user.role)) {
    return res.status(403).json({ error: 'Acesso restrito a GMs' });
  }
  next();
}

// ── Helper: buscar personagem do usuário autenticado ──────────────────────
async function getCharOf(userId) {
  const { rows } = await pool.query(`
    SELECT c.*, cl.name AS clan_name, v.name AS village_name
    FROM characters c
    LEFT JOIN clans cl ON c.clan_id = cl.id
    LEFT JOIN villages v ON c.village_id = v.id
    WHERE c.user_id = $1 AND c.is_active = TRUE
    LIMIT 1
  `, [userId]);
  return rows[0] || null;
}

// ══════════════════════════════════════════════════════════════════════════
//  AUTH
// ══════════════════════════════════════════════════════════════════════════

// POST /api/auth/login
app.post('/api/auth/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Campos obrigatórios' });

  try {
    const { rows } = await pool.query(
      `SELECT * FROM users WHERE username = $1 AND is_active = TRUE`, [username]
    );
    const user = rows[0];
    if (!user || !await bcrypt.compare(password, user.password_hash)) {
      return res.status(401).json({ error: 'Credenciais inválidas' });
    }

    await pool.query(`UPDATE users SET last_login = NOW() WHERE id = $1`, [user.id]);

    const token = jwt.sign(
      { id: user.id, username: user.username, role: user.role, discordId: user.discord_id },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
    );

    const char = await getCharOf(user.id);
    res.json({ token, user: { id: user.id, username: user.username, role: user.role }, character: char });
  } catch (err) {
    console.error('[API/login]', err);
    res.status(500).json({ error: 'Erro interno' });
  }
});

// POST /api/auth/change-password
app.post('/api/auth/change-password', auth, async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword || newPassword.length < 6) {
    return res.status(400).json({ error: 'Senha deve ter ao menos 6 caracteres' });
  }
  const { rows } = await pool.query(`SELECT password_hash FROM users WHERE id = $1`, [req.user.id]);
  if (!rows[0] || !await bcrypt.compare(currentPassword, rows[0].password_hash)) {
    return res.status(401).json({ error: 'Senha atual incorreta' });
  }
  const hash = await bcrypt.hash(newPassword, 10);
  await pool.query(`UPDATE users SET password_hash = $1 WHERE id = $2`, [hash, req.user.id]);
  res.json({ message: 'Senha alterada com sucesso!' });
});

// ══════════════════════════════════════════════════════════════════════════
//  PERSONAGEM
// ══════════════════════════════════════════════════════════════════════════

// GET /api/character
app.get('/api/character', auth, async (req, res) => {
  const char = await getCharOf(req.user.id);
  if (!char) return res.status(404).json({ error: 'Personagem não encontrado' });
  res.json(char);
});

// PATCH /api/character — Atualizar campos da ficha
app.patch('/api/character', auth, async (req, res) => {
  const char = await getCharOf(req.user.id);
  if (!char) return res.status(404).json({ error: 'Personagem não encontrado' });

  const allowed = [
    'name','age','background','special_abilities','portrait_url',
    'hp_current','chakra_current','stress',
    'attr_forca','attr_velocidade','attr_resistencia','attr_selos',
    'attr_ninjutsu','attr_genjutsu','attr_taijutsu','attr_inteligencia'
  ];

  const updates = {};
  allowed.forEach(k => { if (req.body[k] !== undefined) updates[k] = req.body[k]; });

  if (!Object.keys(updates).length) return res.status(400).json({ error: 'Nada para atualizar' });

  // Validações de status
  if (updates.hp_current !== undefined) updates.hp_current = Math.min(updates.hp_current, char.hp_max);
  if (updates.chakra_current !== undefined) updates.chakra_current = Math.min(updates.chakra_current, char.chakra_max);
  if (updates.stress !== undefined) updates.stress = Math.min(100, Math.max(0, updates.stress));

  // Validações de atributos (1-10, requer pontos disponíveis)
  const attrKeys = Object.keys(updates).filter(k => k.startsWith('attr_'));
  if (attrKeys.length > 0) {
    let totalCost = 0;
    attrKeys.forEach(k => {
      const oldVal = char[k] || 1;
      const newVal = Math.min(10, Math.max(1, parseInt(updates[k])));
      updates[k] = newVal;
      if (newVal > oldVal) totalCost += (newVal - oldVal);
    });
    if (totalCost > char.attr_points_available) {
      return res.status(400).json({
        error: `Pontos insuficientes! Você tem ${char.attr_points_available} pontos disponíveis.`
      });
    }
    if (totalCost > 0) updates.attr_points_available = char.attr_points_available - totalCost;
  }

  const keys = Object.keys(updates);
  const vals = Object.values(updates);
  const set  = keys.map((k, i) => `${k} = $${i + 1}`).join(', ');

  await pool.query(
    `UPDATE characters SET ${set} WHERE id = $${keys.length + 1}`,
    [...vals, char.id]
  );

  const updated = await getCharOf(req.user.id);
  res.json(updated);
});

// ══════════════════════════════════════════════════════════════════════════
//  MISSÕES
// ══════════════════════════════════════════════════════════════════════════

// GET /api/missions
app.get('/api/missions', auth, async (req, res) => {
  const char = await getCharOf(req.user.id);
  if (!char) return res.status(404).json({ error: 'Personagem não encontrado' });

  const { rows } = await pool.query(`
    SELECT cm.id AS cm_id, cm.status, cm.progress, cm.assigned_at, cm.completed_at,
           m.id, m.title, m.description, m.type, m.rank,
           m.reward_ryo, m.reward_xp, m.reward_items, m.reward_rep
    FROM character_missions cm
    JOIN missions m ON cm.mission_id = m.id
    WHERE cm.character_id = $1
    ORDER BY cm.assigned_at DESC
  `, [char.id]);

  res.json(rows);
});

// PATCH /api/missions/:id/progress — Jogador pode atualizar progresso
app.patch('/api/missions/:id/progress', auth, async (req, res) => {
  const { progress } = req.body;
  if (progress === undefined || progress < 0 || progress > 100) {
    return res.status(400).json({ error: 'Progresso deve ser entre 0 e 100' });
  }
  const char = await getCharOf(req.user.id);
  await pool.query(
    `UPDATE character_missions SET progress = $1 WHERE id = $2 AND character_id = $3 AND status = 'active'`,
    [progress, req.params.id, char.id]
  );
  res.json({ message: 'Progresso atualizado' });
});

// ══════════════════════════════════════════════════════════════════════════
//  LOJA
// ══════════════════════════════════════════════════════════════════════════

// GET /api/shop
app.get('/api/shop', auth, async (req, res) => {
  const { category } = req.query;
  let query = `SELECT * FROM shop_items WHERE is_available = TRUE`;
  const params = [];
  if (category && category !== 'all') {
    params.push(category);
    query += ` AND category = $${params.length}`;
  }
  query += ` ORDER BY category, price`;
  const { rows } = await pool.query(query, params);
  res.json(rows);
});

// POST /api/shop/buy
app.post('/api/shop/buy', auth, async (req, res) => {
  const { item_id, quantity = 1 } = req.body;
  if (!item_id || quantity < 1) return res.status(400).json({ error: 'Dados inválidos' });

  const char = await getCharOf(req.user.id);
  if (!char) return res.status(404).json({ error: 'Personagem não encontrado' });

  const { rows: itemRows } = await pool.query(
    `SELECT * FROM shop_items WHERE id = $1 AND is_available = TRUE`, [item_id]
  );
  if (!itemRows.length) return res.status(404).json({ error: 'Item não disponível' });

  const item  = itemRows[0];
  const total = item.price * quantity;

  if (char.ryo < total) {
    return res.status(400).json({ error: 'Saldo insuficiente', needed: total, available: char.ryo });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query(`UPDATE characters SET ryo = ryo - $1 WHERE id = $2`, [total, char.id]);

    await client.query(`
      INSERT INTO inventory (character_id, item_id, quantity)
      VALUES ($1, $2, $3)
      ON CONFLICT (character_id, item_id)
      DO UPDATE SET quantity = inventory.quantity + EXCLUDED.quantity
    `, [char.id, item_id, quantity]);

    await client.query(
      `INSERT INTO ryo_transactions (character_id, amount, type, description) VALUES ($1,$2,'purchase',$3)`,
      [char.id, -total, `Compra: ${item.name} ×${quantity}`]
    );

    await client.query('COMMIT');

    const { rows: updChar } = await client.query(
      `SELECT ryo FROM characters WHERE id = $1`, [char.id]
    );
    res.json({ message: `✅ ${item.name} ×${quantity} comprado!`, newRyo: updChar[0].ryo });

  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// ══════════════════════════════════════════════════════════════════════════
//  JUTSUS
// ══════════════════════════════════════════════════════════════════════════

// GET /api/jutsus — todos os jutsus do sistema
app.get('/api/jutsus', auth, async (req, res) => {
  const { rows } = await pool.query(`SELECT * FROM jutsus ORDER BY rank, name`);
  res.json(rows);
});

// GET /api/character/jutsus — jutsus do personagem
app.get('/api/character/jutsus', auth, async (req, res) => {
  const char = await getCharOf(req.user.id);
  if (!char) return res.status(404).json({ error: 'Personagem não encontrado' });

  const { rows } = await pool.query(`
    SELECT j.*, cj.is_main, cj.learned_at
    FROM character_jutsus cj JOIN jutsus j ON cj.jutsu_id = j.id
    WHERE cj.character_id = $1
    ORDER BY j.rank, j.name
  `, [char.id]);

  res.json(rows);
});

// POST /api/character/jutsus/:jutsu_id/toggle-main
app.post('/api/character/jutsus/:jutsu_id/toggle-main', auth, async (req, res) => {
  const char = await getCharOf(req.user.id);
  await pool.query(
    `UPDATE character_jutsus SET is_main = NOT is_main WHERE character_id = $1 AND jutsu_id = $2`,
    [char.id, req.params.jutsu_id]
  );
  res.json({ message: 'Atualizado!' });
});

// ══════════════════════════════════════════════════════════════════════════
//  REGRAS (Academia Ninja)
// ══════════════════════════════════════════════════════════════════════════

// GET /api/rules — todas as regras sincronizadas
app.get('/api/rules', auth, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT channel_id, channel_name, category, parsed_data, synced_at FROM discord_rules ORDER BY channel_name`
  );
  res.json(rows);
});

// GET /api/rules/:channelName
app.get('/api/rules/:channelName', auth, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT * FROM discord_rules WHERE channel_name ILIKE $1 LIMIT 1`,
    [req.params.channelName]
  );
  if (!rows.length) return res.status(404).json({ error: 'Canal não encontrado' });
  res.json(rows[0]);
});

// ══════════════════════════════════════════════════════════════════════════
//  GM — Rotas exclusivas
// ══════════════════════════════════════════════════════════════════════════

// GET /api/gm/players — listar todos os jogadores
app.get('/api/gm/players', auth, gmOnly, async (req, res) => {
  const { rows } = await pool.query(`
    SELECT u.id, u.username, u.discord_username, u.role, u.last_login,
           c.name AS char_name, c.rank, c.level, c.xp, c.ryo
    FROM users u LEFT JOIN characters c ON c.user_id = u.id AND c.is_active = TRUE
    ORDER BY u.created_at DESC
  `);
  res.json(rows);
});

// POST /api/gm/jutsu/grant — conceder jutsu a personagem
app.post('/api/gm/jutsu/grant', auth, gmOnly, async (req, res) => {
  const { character_id, jutsu_id } = req.body;
  await pool.query(`
    INSERT INTO character_jutsus (character_id, jutsu_id)
    VALUES ($1, $2) ON CONFLICT DO NOTHING
  `, [character_id, jutsu_id]);
  res.json({ message: 'Jutsu concedido!' });
});

// ══════════════════════════════════════════════════════════════════════════
//  MISC
// ══════════════════════════════════════════════════════════════════════════

// GET /api/villages
app.get('/api/villages', async (req, res) => {
  const { rows } = await pool.query(`SELECT * FROM villages ORDER BY name`);
  res.json(rows);
});

// GET /api/clans
app.get('/api/clans', async (req, res) => {
  const { rows } = await pool.query(`SELECT * FROM clans ORDER BY name`);
  res.json(rows);
});

// GET /api/health
app.get('/api/health', async (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ── Start ──────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
function startServer() {
  app.listen(PORT, () => {
    console.log(`\n🌐 [API] Servidor rodando em http://localhost:${PORT}`);
  });
}

module.exports = { app, startServer };

// ══════════════════════════════════════════════════════════════════════════
//  GM — Endpoints adicionais (Portal do Mestre)
// ══════════════════════════════════════════════════════════════════════════

// GET /api/gm/all-missions — todas as missões com info do personagem
app.get('/api/gm/all-missions', auth, gmOnly, async (req, res) => {
  const { rows } = await pool.query(`
    SELECT cm.id AS cm_id, cm.status, cm.progress, cm.assigned_at,
           m.id, m.title, m.description, m.type, m.rank,
           m.reward_ryo, m.reward_xp,
           c.name AS char_name, c.id AS char_id
    FROM character_missions cm
    JOIN missions m ON cm.mission_id = m.id
    JOIN characters c ON cm.character_id = c.id
    ORDER BY cm.assigned_at DESC
  `);
  res.json(rows);
});

// GET /api/gm/char/:userId — personagem por user_id
app.get('/api/gm/char/:userId', auth, gmOnly, async (req, res) => {
  const { rows } = await pool.query(`
    SELECT c.*, cl.name AS clan_name, v.name AS village_name
    FROM characters c
    LEFT JOIN clans cl ON c.clan_id = cl.id
    LEFT JOIN villages v ON c.village_id = v.id
    WHERE c.user_id = $1 AND c.is_active = TRUE LIMIT 1
  `, [req.params.userId]);
  if (!rows.length) return res.status(404).json({ error: 'Personagem não encontrado' });
  res.json(rows[0]);
});

// PATCH /api/gm/char/:userId — editar qualquer campo
app.patch('/api/gm/char/:userId', auth, gmOnly, async (req, res) => {
  const allowed = ['hp_current','hp_max','chakra_current','chakra_max','stress','ryo','xp','level','rank','background',
                   'attr_forca','attr_destreza','attr_vitalidade','attr_inteligencia','attr_espirito',
                   'skill_ninjutsu','skill_taijutsu','skill_genjutsu','skill_furtividade','skill_conhecimento','skill_percepcao','skill_atletismo','skill_persuasao',
                   'name','age'];
  const updates = {};
  allowed.forEach(k => { if (req.body[k] !== undefined) updates[k] = req.body[k]; });
  if (!Object.keys(updates).length) return res.status(400).json({ error: 'Nada para atualizar' });
  const keys = Object.keys(updates);
  const vals = Object.values(updates);
  const set = keys.map((k, i) => `${k} = $${i+1}`).join(', ');
  await pool.query(
    `UPDATE characters SET ${set} WHERE user_id = $${keys.length+1}`,
    [...vals, req.params.userId]
  );
  res.json({ message: 'Ficha atualizada' });
});

// POST /api/gm/xp — conceder XP
app.post('/api/gm/xp', auth, gmOnly, async (req, res) => {
  const { user_id, amount, reason } = req.body;
  const { rows } = await pool.query(`SELECT id, xp, level, xp_next FROM characters WHERE user_id = $1`, [user_id]);
  if (!rows.length) return res.status(404).json({ error: 'Personagem não encontrado' });
  const c = rows[0];
  let xp = c.xp + amount, level = c.level, xpNext = c.xp_next || c.level * 1000;
  while (xp >= xpNext && level < 100) { xp -= xpNext; level++; xpNext = level * 1000; }
  await pool.query(`UPDATE characters SET xp=$1, level=$2, xp_next=$3 WHERE id=$4`, [xp, level, xpNext, c.id]);
  await pool.query(`INSERT INTO bot_events (event_type, character_id, data) VALUES ('xp_grant',$1,$2)`, [c.id, JSON.stringify({amount,reason})]);
  res.json({ message: `+${amount} XP`, newLevel: level, levelUp: level > c.level });
});

// POST /api/gm/ryo — transferir Ryo
app.post('/api/gm/ryo', auth, gmOnly, async (req, res) => {
  const { user_id, amount, reason } = req.body;
  const { rows } = await pool.query(`SELECT id, ryo FROM characters WHERE user_id = $1`, [user_id]);
  if (!rows.length) return res.status(404).json({ error: 'Personagem não encontrado' });
  const newRyo = Math.max(0, rows[0].ryo + amount);
  await pool.query(`UPDATE characters SET ryo=$1 WHERE id=$2`, [newRyo, rows[0].id]);
  await pool.query(`INSERT INTO ryo_transactions (character_id,amount,type,description) VALUES ($1,$2,'gm',$3)`, [rows[0].id, amount, reason||'GM transfer']);
  res.json({ message: 'Ryo atualizado', newRyo });
});

// POST /api/gm/rank — alterar rank
app.post('/api/gm/rank', auth, gmOnly, async (req, res) => {
  const { user_id, rank } = req.body;
  await pool.query(`UPDATE characters SET rank=$1 WHERE user_id=$2`, [rank, user_id]);
  res.json({ message: 'Rank atualizado' });
});

// POST /api/gm/mission — criar missão
app.post('/api/gm/mission', auth, gmOnly, async (req, res) => {
  const { user_id, title, description, type, rank, reward_ryo, reward_xp } = req.body;
  const { rows: charRows } = await pool.query(`SELECT id FROM characters WHERE user_id=$1`, [user_id]);
  if (!charRows.length) return res.status(404).json({ error: 'Personagem não encontrado' });
  const { rows: mRows } = await pool.query(
    `INSERT INTO missions (title,description,type,rank,reward_ryo,reward_xp,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [title,description,type||'side',rank||'D',reward_ryo||0,reward_xp||0,req.user.id]
  );
  await pool.query(`INSERT INTO character_missions (character_id,mission_id) VALUES ($1,$2)`, [charRows[0].id, mRows[0].id]);
  res.json({ message: 'Missão criada', id: mRows[0].id });
});

// POST /api/gm/mission/complete — completar missão
app.post('/api/gm/mission/complete', auth, gmOnly, async (req, res) => {
  const { cm_id } = req.body;
  const { rows } = await pool.query(`SELECT cm.*,m.reward_ryo,m.reward_xp,m.title FROM character_missions cm JOIN missions m ON cm.mission_id=m.id WHERE cm.id=$1`, [cm_id]);
  if (!rows.length) return res.status(404).json({ error: 'Missão não encontrada' });
  const cm = rows[0];
  await pool.query(`UPDATE character_missions SET status='completed',progress=100,completed_at=NOW() WHERE id=$1`, [cm_id]);
  await pool.query(`UPDATE characters SET ryo=ryo+$1,xp=xp+$2 WHERE id=$3`, [cm.reward_ryo||0, cm.reward_xp||0, cm.character_id]);
  res.json({ message: 'Missão completada!' });
});

// DELETE /api/gm/mission/:id
app.delete('/api/gm/mission/:id', auth, gmOnly, async (req, res) => {
  await pool.query(`DELETE FROM character_missions WHERE mission_id=$1`, [req.params.id]);
  await pool.query(`DELETE FROM missions WHERE id=$1`, [req.params.id]);
  res.json({ message: 'Removida' });
});

// POST /api/gm/jutsu/grant (extended with user_id lookup)
app.post('/api/gm/jutsu/grant', auth, gmOnly, async (req, res) => {
  const { user_id, character_id, jutsu_id } = req.body;
  let charId = character_id;
  if (user_id && !charId) {
    const { rows } = await pool.query(`SELECT id FROM characters WHERE user_id=$1`, [user_id]);
    if (!rows.length) return res.status(404).json({ error: 'Personagem não encontrado' });
    charId = rows[0].id;
  }
  await pool.query(`INSERT INTO character_jutsus (character_id,jutsu_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [charId, jutsu_id]);
  res.json({ message: 'Jutsu concedido!' });
});

// POST /api/gm/shop/item
app.post('/api/gm/shop/item', auth, gmOnly, async (req, res) => {
  const { name, icon, category, price, description } = req.body;
  const { rows } = await pool.query(`INSERT INTO shop_items (name,icon,category,price,description) VALUES ($1,$2,$3,$4,$5) RETURNING id`, [name,icon||'📦',category||'consumable',price||0,description||'']);
  res.json({ message: 'Item adicionado', id: rows[0].id });
});

// PATCH /api/gm/shop/item/:id
app.patch('/api/gm/shop/item/:id', auth, gmOnly, async (req, res) => {
  const { is_available, price, name } = req.body;
  const updates = []; const vals = [];
  if (is_available !== undefined) { vals.push(is_available); updates.push(`is_available=$${vals.length}`); }
  if (price !== undefined) { vals.push(price); updates.push(`price=$${vals.length}`); }
  if (name !== undefined) { vals.push(name); updates.push(`name=$${vals.length}`); }
  if (!updates.length) return res.status(400).json({ error: 'Nada a atualizar' });
  vals.push(req.params.id);
  await pool.query(`UPDATE shop_items SET ${updates.join(',')} WHERE id=$${vals.length}`, vals);
  res.json({ message: 'Atualizado' });
});

// DELETE /api/gm/shop/item/:id
app.delete('/api/gm/shop/item/:id', auth, gmOnly, async (req, res) => {
  await pool.query(`DELETE FROM shop_items WHERE id=$1`, [req.params.id]);
  res.json({ message: 'Removido' });
});

// POST /api/gm/sync — trigger sync (requires bot client)
app.post('/api/gm/sync', auth, gmOnly, async (req, res) => {
  try {
    const discordClient = require('../bot/client');
    const { syncAcademiaNinja } = require('../sync/syncRules');
    await syncAcademiaNinja(discordClient);
    res.json({ message: 'Sincronização concluída!' });
  } catch (err) {
    res.status(500).json({ error: 'Bot não disponível: ' + err.message });
  }
});

// POST /api/gm/reset-password
app.post('/api/gm/reset-password', auth, gmOnly, async (req, res) => {
  const { user_id } = req.body;
  const { rows } = await pool.query(`SELECT discord_id, username FROM users WHERE id=$1`, [user_id]);
  if (!rows.length) return res.status(404).json({ error: 'Usuário não encontrado' });
  const rawPass = `ninja_${(rows[0].discord_id||'0000').slice(-4)}`;
  const hash = await require('bcryptjs').hash(rawPass, 10);
  await pool.query(`UPDATE users SET password_hash=$1 WHERE id=$2`, [hash, user_id]);
  res.json({ message: 'Senha resetada', newPassword: rawPass });
});

// GET /api/gm/export — exportar todos os dados
app.get('/api/gm/export', auth, gmOnly, async (req, res) => {
  const [users, chars, missions, jutsus, items] = await Promise.all([
    pool.query('SELECT id,username,discord_username,role,created_at FROM users'),
    pool.query('SELECT * FROM characters WHERE is_active=TRUE'),
    pool.query('SELECT m.*,cm.character_id,cm.status,cm.progress FROM missions m LEFT JOIN character_missions cm ON m.id=cm.mission_id'),
    pool.query('SELECT * FROM jutsus'),
    pool.query('SELECT * FROM shop_items'),
  ]);
  res.json({
    exportedAt: new Date().toISOString(),
    users: users.rows,
    characters: chars.rows,
    missions: missions.rows,
    jutsus: jutsus.rows,
    items: items.rows,
  });
});

// GET /api/gm/logs — últimos 100 eventos
app.get('/api/gm/logs', auth, gmOnly, async (req, res) => {
  const { rows } = await pool.query(`SELECT * FROM bot_events ORDER BY created_at DESC LIMIT 100`);
  res.json(rows);
});

// POST /api/character/create — criação pelo portal
app.post('/api/character/create', auth, async (req, res) => {
  const existing = await pool.query(`SELECT id FROM characters WHERE user_id=$1`, [req.user.id]);
  if (existing.rows.length) return res.status(400).json({ error: 'Personagem já existe' });

  const {
    name, age, clan, village, background,
    attr_forca, attr_destreza, attr_vitalidade, attr_inteligencia, attr_espirito,
    skill_ninjutsu, skill_taijutsu, skill_genjutsu, skill_furtividade,
    skill_conhecimento, skill_percepcao, skill_atletismo, skill_persuasao,
    hp_max, hp_current, chakra_max, chakra_current, deslocamento, iniciativa
  } = req.body;

  if (!name) return res.status(400).json({ error: 'Nome obrigatório' });

  // Validar pontos de atributo (máx 8, máx 4 por attr)
  const attrTotal = (attr_forca||0)+(attr_destreza||0)+(attr_vitalidade||0)+(attr_inteligencia||0)+(attr_espirito||0);
  if (attrTotal > 8) return res.status(400).json({ error: 'Máximo 8 pontos de atributo' });
  const attrVals = [attr_forca||0, attr_destreza||0, attr_vitalidade||0, attr_inteligencia||0, attr_espirito||0];
  if (attrVals.some(v => v > 4)) return res.status(400).json({ error: 'Máximo 4 pontos por atributo' });

  // Validar perícias (máx 6, máx 3 por perícia)
  const skillTotal = (skill_ninjutsu||0)+(skill_taijutsu||0)+(skill_genjutsu||0)+(skill_furtividade||0)+(skill_conhecimento||0)+(skill_percepcao||0)+(skill_atletismo||0)+(skill_persuasao||0);
  if (skillTotal > 6) return res.status(400).json({ error: 'Máximo 6 pontos de perícia' });
  const skillVals = [skill_ninjutsu||0, skill_taijutsu||0, skill_genjutsu||0, skill_furtividade||0, skill_conhecimento||0, skill_percepcao||0, skill_atletismo||0, skill_persuasao||0];
  if (skillVals.some(v => v > 3)) return res.status(400).json({ error: 'Máximo 3 pontos por perícia' });

  const { rows } = await pool.query(`
    INSERT INTO characters (
      user_id, name, age, background, rank, level, xp, xp_next, ryo,
      attr_forca, attr_destreza, attr_vitalidade, attr_inteligencia, attr_espirito,
      skill_ninjutsu, skill_taijutsu, skill_genjutsu, skill_furtividade,
      skill_conhecimento, skill_percepcao, skill_atletismo, skill_persuasao,
      hp_max, hp_current, chakra_max, chakra_current, stress, deslocamento, iniciativa
    ) VALUES ($1,$2,$3,$4,'Acadêmico',1,0,1000,500,
      $5,$6,$7,$8,$9,
      $10,$11,$12,$13,$14,$15,$16,$17,
      $18,$19,$20,$21,0,$22,$23)
    RETURNING *
  `, [req.user.id, name, age||12, background||'',
      attr_forca||0, attr_destreza||0, attr_vitalidade||0, attr_inteligencia||0, attr_espirito||0,
      skill_ninjutsu||0, skill_taijutsu||0, skill_genjutsu||0, skill_furtividade||0,
      skill_conhecimento||0, skill_percepcao||0, skill_atletismo||0, skill_persuasao||0,
      hp_max||20, hp_current||hp_max||20, chakra_max||10, chakra_current||chakra_max||10,
      deslocamento||5, iniciativa||0
  ]);
  res.status(201).json(rows[0]);
});
