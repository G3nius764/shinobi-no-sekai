// src/db/pool.js — Conexão PostgreSQL (Supabase Pooler)
const { Pool } = require('pg');

const pool = new Pool({
  host:     'aws-1-us-west-2.pooler.supabase.com',
  port:     6543,
  database: 'postgres',
  user:     'postgres.yolqujxuncevfajdxgga',
  password: '03QE4G41%Z5?!m?Pc',
  ssl:      { rejectUnauthorized: false },
  max:      10,
  idleTimeoutMillis:       30000,
  connectionTimeoutMillis: 10000,
});

pool.on('connect', () => {
  console.log('[DB] ✅ Conectado ao Supabase Pooler');
});

pool.on('error', (err) => {
  console.error('[DB] ❌ Erro no pool:', err.message);
});

module.exports = pool;
