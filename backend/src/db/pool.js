// src/db/pool.js — Conexão PostgreSQL (Supabase)
const { Pool } = require('pg');

const pool = new Pool({
  host:     'db.yolqujxuncevfajdxgga.supabase.co',
  port:     5432,
  database: 'postgres',
  user:     'postgres',
  password: '03QE4G41%Z5?!m?Pc',
  ssl:      { rejectUnauthorized: false },
  max:      10,
  idleTimeoutMillis:    30000,
  connectionTimeoutMillis: 10000,
  // Forçar IPv4
  family:   4,
});

pool.on('connect', () => {
  console.log('[DB] ✅ Conectado ao Supabase PostgreSQL');
});

pool.on('error', (err) => {
  console.error('[DB] ❌ Erro no pool:', err.message);
});

module.exports = pool;
