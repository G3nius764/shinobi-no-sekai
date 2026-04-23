// src/db/pool.js — Conexão PostgreSQL (Supabase)
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const { Pool } = require('pg');

const connectionString = process.env.DATABASE_URL ||
  'postgresql://postgres:03QE4G41%25Z5%3F!m%3FPc@db.yolqujxuncevfajdxgga.supabase.co:5432/postgres';

const pool = new Pool({
  connectionString,
  ssl: { rejectUnauthorized: false }, // Obrigatório no Supabase
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

pool.on('connect', () => {
  console.log('[DB] ✅ Conectado ao Supabase PostgreSQL');
});

pool.on('error', (err) => {
  console.error('[DB] ❌ Erro no pool:', err.message);
});

module.exports = pool;
