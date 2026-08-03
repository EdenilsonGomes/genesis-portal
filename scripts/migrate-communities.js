'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');

const DATABASE_URL = process.env.DATABASE_URL;
const config = DATABASE_URL
  ? { connectionString: DATABASE_URL }
  : {
      host: process.env.PGHOST,
      port: Number(process.env.PGPORT || 5432),
      database: process.env.PGDATABASE,
      user: process.env.PGUSER,
      password: process.env.PGPASSWORD,
    };

if (!DATABASE_URL && (!config.host || !config.database || !config.user || !config.password)) {
  console.error('Configure DATABASE_URL ou PGHOST, PGDATABASE, PGUSER e PGPASSWORD.');
  process.exit(1);
}

const pool = new Pool({
  ...config,
  ssl: String(process.env.DB_SSL || 'false').toLowerCase() === 'true'
    ? { rejectUnauthorized: false }
    : false,
  max: 1,
  connectionTimeoutMillis: 10_000,
});

async function main() {
  const file = path.join(__dirname, '..', 'sql', '16_GENESIS_PORTAL_COMUNIDADES_CONTAS_PUBLICACOES.sql');
  const sql = fs.readFileSync(file, 'utf8');
  console.log(`Aplicando ${path.basename(file)} em ${DATABASE_URL ? 'DATABASE_URL' : config.database}...`);
  await pool.query(sql);
  const result = await pool.query(`SELECT
    to_regclass('public.portal_contas') AS portal_contas,
    to_regclass('public.gg_groups') AS gg_groups,
    to_regclass('public.portal_vagas_submissoes') AS portal_vagas_submissoes`);
  console.log('Migração concluída.', result.rows[0]);
}

main()
  .catch((error) => {
    console.error('Falha na migração:', error);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
