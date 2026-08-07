'use strict';
const { Pool } = require('pg');
const connectionString = process.env.DATABASE_URL;
const ssl = String(process.env.DB_SSL || 'false').toLowerCase() === 'true' ? { rejectUnauthorized: false } : false;
const pool = new Pool(connectionString ? { connectionString, ssl } : { host: process.env.PGHOST, port: Number(process.env.PGPORT || 5432), database: process.env.PGDATABASE, user: process.env.PGUSER, password: process.env.PGPASSWORD, ssl });
(async () => {
  try {
    const result = await pool.query(`SELECT
      TO_REGCLASS('public.portal_empresas') IS NOT NULL AS portal_empresas,
      TO_REGCLASS('public.portal_empresa_imagens') IS NOT NULL AS portal_empresa_imagens,
      EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='portal_eventos' AND column_name='empresa_id') AS eventos_empresa,
      EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='portal_contas' AND column_name='origem_ref') AS contas_ref`);
    const state = result.rows[0];
    if (!Object.values(state).every(Boolean)) throw new Error(`Estrutura incompleta: ${JSON.stringify(state)}`);
    console.log('Preflight Portal de Empresas MVP aprovado:', state);
  } finally { await pool.end(); }
})().catch((error) => { console.error(error); process.exit(1); });
