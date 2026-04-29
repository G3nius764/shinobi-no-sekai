// src/db/migrate.js — Cria todas as tabelas do sistema
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const pool = require('./pool');

async function migrate() {
  const client = await pool.connect();
  try {
    console.log('[MIGRATE] Iniciando migração...');
    await client.query('BEGIN');

    // ── EXTENSÕES ──────────────────────────────────────────────────────────
    await client.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp";`);

    // ── REGRAS DO DISCORD (sincronizadas da Academia Ninja) ────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS discord_rules (
        id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        channel_id  VARCHAR(30) NOT NULL,
        channel_name VARCHAR(100) NOT NULL,
        category    VARCHAR(100) DEFAULT 'Academia Ninja',
        content     TEXT NOT NULL,
        parsed_data JSONB DEFAULT '{}',
        synced_at   TIMESTAMPTZ DEFAULT NOW(),
        updated_at  TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    // ── VILAGES ────────────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS villages (
        id          SERIAL PRIMARY KEY,
        name        VARCHAR(100) NOT NULL UNIQUE,
        name_jp     VARCHAR(100),
        symbol      VARCHAR(10),
        description TEXT,
        created_at  TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    // ── CLÃS ──────────────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS clans (
        id              SERIAL PRIMARY KEY,
        name            VARCHAR(100) NOT NULL UNIQUE,
        kekkei_genkai   VARCHAR(200),
        description     TEXT,
        village_id      INT REFERENCES villages(id),
        created_at      TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    // ── USUÁRIOS (jogadores) ────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        username        VARCHAR(50) NOT NULL UNIQUE,
        password_hash   VARCHAR(255) NOT NULL,
        discord_id      VARCHAR(30) UNIQUE,
        discord_username VARCHAR(100),
        role            VARCHAR(20) DEFAULT 'player' CHECK (role IN ('player','gm','admin')),
        is_active       BOOLEAN DEFAULT TRUE,
        last_login      TIMESTAMPTZ,
        created_at      TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    // ── PERSONAGENS ───────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS characters (
        id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name            VARCHAR(100) NOT NULL,
        age             INT DEFAULT 12,
        clan_id         INT REFERENCES clans(id),
        village_id      INT REFERENCES villages(id),
        rank            VARCHAR(20) DEFAULT 'Genin'
                          CHECK (rank IN ('Genin','Chunin','Jonin','ANBU','Kage','Missing-nin','Acadêmico')),
        level           INT DEFAULT 1 CHECK (level BETWEEN 1 AND 100),
        xp              INT DEFAULT 0,
        xp_next         INT DEFAULT 1000,
        ryo             INT DEFAULT 500,
        portrait_url    TEXT,

        -- STATUS
        hp_current      INT DEFAULT 100,
        hp_max          INT DEFAULT 100,
        chakra_current  INT DEFAULT 100,
        chakra_max      INT DEFAULT 100,
        stress          INT DEFAULT 0 CHECK (stress BETWEEN 0 AND 100),

        -- ATRIBUTOS (1–5 por padrão, calculados pelas regras)
        -- ATRIBUTOS (conforme regras: total 8, máx 4 por atributo)
        attr_forca       INT DEFAULT 0 CHECK (attr_forca BETWEEN 0 AND 10),
        attr_destreza    INT DEFAULT 0 CHECK (attr_destreza BETWEEN 0 AND 10),
        attr_vitalidade  INT DEFAULT 0 CHECK (attr_vitalidade BETWEEN 0 AND 10),
        attr_inteligencia INT DEFAULT 0 CHECK (attr_inteligencia BETWEEN 0 AND 10),
        attr_espirito    INT DEFAULT 0 CHECK (attr_espirito BETWEEN 0 AND 10),
        -- PERÍCIAS (conforme regras: total 6, máx 3 por perícia)
        skill_ninjutsu    INT DEFAULT 0 CHECK (skill_ninjutsu BETWEEN 0 AND 5),
        skill_taijutsu    INT DEFAULT 0 CHECK (skill_taijutsu BETWEEN 0 AND 5),
        skill_genjutsu    INT DEFAULT 0 CHECK (skill_genjutsu BETWEEN 0 AND 5),
        skill_furtividade INT DEFAULT 0 CHECK (skill_furtividade BETWEEN 0 AND 5),
        skill_conhecimento INT DEFAULT 0 CHECK (skill_conhecimento BETWEEN 0 AND 5),
        skill_percepcao   INT DEFAULT 0 CHECK (skill_percepcao BETWEEN 0 AND 5),
        skill_atletismo   INT DEFAULT 0 CHECK (skill_atletismo BETWEEN 0 AND 5),
        skill_persuasao   INT DEFAULT 0 CHECK (skill_persuasao BETWEEN 0 AND 5),
        -- STATUS DERIVADO
        deslocamento     INT DEFAULT 5,
        iniciativa       INT DEFAULT 0,

        -- PONTOS disponíveis para distribuir
        attr_points_available INT DEFAULT 0,

        -- BACKGROUND
        background      TEXT,
        special_abilities TEXT,

        is_active       BOOLEAN DEFAULT TRUE,
        created_at      TIMESTAMPTZ DEFAULT NOW(),
        updated_at      TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    // ── TÉCNICAS (Jutsus) ─────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS jutsus (
        id              SERIAL PRIMARY KEY,
        name            VARCHAR(150) NOT NULL,
        name_jp         VARCHAR(150),
        rank            VARCHAR(5) CHECK (rank IN ('E','D','C','B','A','S')),
        type            VARCHAR(30) CHECK (type IN ('Ninjutsu','Taijutsu','Genjutsu','Fuinjutsu','Kenjutsu','Senjutsu','Kekkei Genkai','Outro')),
        description     TEXT,
        range_type      VARCHAR(50),
        chakra_cost     INT DEFAULT 0,
        damage          VARCHAR(50),
        requirements    TEXT,
        source_channel  VARCHAR(100),
        is_learnable    BOOLEAN DEFAULT TRUE,
        created_at      TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    // ── JUTSUS DO PERSONAGEM ──────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS character_jutsus (
        id              SERIAL PRIMARY KEY,
        character_id    UUID NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
        jutsu_id        INT NOT NULL REFERENCES jutsus(id),
        learned_at      TIMESTAMPTZ DEFAULT NOW(),
        is_main         BOOLEAN DEFAULT FALSE,
        UNIQUE(character_id, jutsu_id)
      );
    `);

    // ── ITENS DA LOJA ─────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS shop_items (
        id              SERIAL PRIMARY KEY,
        name            VARCHAR(150) NOT NULL,
        description     TEXT,
        category        VARCHAR(30) CHECK (category IN ('weapon','accessory','consumable','scroll')),
        icon            VARCHAR(10) DEFAULT '📦',
        price           INT NOT NULL DEFAULT 0,
        effect          JSONB DEFAULT '{}',
        stock           INT DEFAULT -1,
        is_available    BOOLEAN DEFAULT TRUE,
        source_channel  VARCHAR(100),
        created_at      TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    // ── INVENTÁRIO ────────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS inventory (
        id              SERIAL PRIMARY KEY,
        character_id    UUID NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
        item_id         INT NOT NULL REFERENCES shop_items(id),
        quantity        INT DEFAULT 1,
        acquired_at     TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(character_id, item_id)
      );
    `);

    // ── MISSÕES ───────────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS missions (
        id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        title           VARCHAR(200) NOT NULL,
        description     TEXT,
        type            VARCHAR(20) DEFAULT 'side'
                          CHECK (type IN ('main','side','special','daily')),
        rank            VARCHAR(5) CHECK (rank IN ('E','D','C','B','A','S')),
        reward_ryo      INT DEFAULT 0,
        reward_xp       INT DEFAULT 0,
        reward_items    JSONB DEFAULT '[]',
        reward_rep      INT DEFAULT 0,
        created_by      UUID REFERENCES users(id),
        created_at      TIMESTAMPTZ DEFAULT NOW(),
        expires_at      TIMESTAMPTZ,
        is_active       BOOLEAN DEFAULT TRUE
      );
    `);

    // ── MISSÕES DO PERSONAGEM ─────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS character_missions (
        id              SERIAL PRIMARY KEY,
        character_id    UUID NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
        mission_id      UUID NOT NULL REFERENCES missions(id),
        status          VARCHAR(20) DEFAULT 'active'
                          CHECK (status IN ('active','completed','failed','abandoned')),
        progress        INT DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
        assigned_at     TIMESTAMPTZ DEFAULT NOW(),
        completed_at    TIMESTAMPTZ,
        UNIQUE(character_id, mission_id)
      );
    `);

    // ── TRANSAÇÕES DE RYO ─────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS ryo_transactions (
        id              SERIAL PRIMARY KEY,
        character_id    UUID NOT NULL REFERENCES characters(id),
        amount          INT NOT NULL,
        type            VARCHAR(30),
        description     VARCHAR(255),
        created_at      TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    // ── LOG DE EVENTOS DO BOT ─────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS bot_events (
        id              SERIAL PRIMARY KEY,
        event_type      VARCHAR(50),
        discord_user_id VARCHAR(30),
        character_id    UUID REFERENCES characters(id),
        data            JSONB DEFAULT '{}',
        created_at      TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    // ── ÍNDICES ───────────────────────────────────────────────────────────
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_characters_user ON characters(user_id);
      CREATE INDEX IF NOT EXISTS idx_char_jutsus_char ON character_jutsus(character_id);
      CREATE INDEX IF NOT EXISTS idx_char_missions_char ON character_missions(character_id);
      CREATE INDEX IF NOT EXISTS idx_inventory_char ON inventory(character_id);
      CREATE INDEX IF NOT EXISTS idx_bot_events_date ON bot_events(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_rules_channel ON discord_rules(channel_id);
    `);

    // ── TRIGGER updated_at ────────────────────────────────────────────────
    await client.query(`
      CREATE OR REPLACE FUNCTION set_updated_at()
      RETURNS TRIGGER AS $$
      BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
      $$ LANGUAGE plpgsql;

      DROP TRIGGER IF EXISTS trg_characters_updated ON characters;
      CREATE TRIGGER trg_characters_updated
        BEFORE UPDATE ON characters
        FOR EACH ROW EXECUTE FUNCTION set_updated_at();
    `);

    await client.query('COMMIT');
    console.log('[MIGRATE] ✅ Todas as tabelas criadas com sucesso!');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[MIGRATE] ❌ Erro:', err.message);
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

migrate().catch(console.error);
