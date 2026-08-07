'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');

const connectionString = process.env.DATABASE_URL;
const pool = new Pool(connectionString ? { connectionString, ssl: String(process.env.DB_SSL || 'false').toLowerCase() === 'true' ? { rejectUnauthorized: false } : false } : {
  host: process.env.PGHOST,
  port: Number(process.env.PGPORT || 5432),
  database: process.env.PGDATABASE,
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
  ssl: String(process.env.DB_SSL || 'false').toLowerCase() === 'true' ? { rejectUnauthorized: false } : false,
});

(async () => {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'sql', '17_GENESIS_PORTAL_EMPRESAS_MVP.sql'), 'utf8');
  try {
    await pool.query(sql);
    console.log('Migration Portal de Empresas MVP aplicada com sucesso.');
  } finally {
    await pool.end();
  }
})().catch((error) => {
  console.error('Falha na migration Portal de Empresas MVP:', error);
  process.exit(1);
});
