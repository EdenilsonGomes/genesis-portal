'use strict';

const { Pool } = require('pg');
const DATABASE_URL = process.env.DATABASE_URL;
const requiredEnv = ['SITE_URL', 'PORTAL_AUTH_SECRET'];
const missing = requiredEnv.filter((name) => !String(process.env[name] || '').trim());
if (missing.length) {
  console.error(`Variáveis recomendadas ausentes: ${missing.join(', ')}`);
  process.exit(1);
}
if (String(process.env.PORTAL_AUTH_SECRET).length < 32) {
  console.error('PORTAL_AUTH_SECRET deve ter pelo menos 32 caracteres.');
  process.exit(1);
}
const config = DATABASE_URL ? { connectionString: DATABASE_URL } : {
  host: process.env.PGHOST,
  port: Number(process.env.PGPORT || 5432),
  database: process.env.PGDATABASE,
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
};
const pool = new Pool({ ...config, ssl: String(process.env.DB_SSL || 'false').toLowerCase() === 'true' ? { rejectUnauthorized: false } : false, max: 1 });

async function main() {
  const result = await pool.query(`SELECT
    to_regclass('public.vagas') AS vagas,
    to_regclass('public.empresas') AS empresas,
    to_regclass('public.app_usuarios') AS app_usuarios,
    to_regclass('public.portal_contas') AS portal_contas,
    to_regclass('public.gg_groups') AS gg_groups,
    to_regclass('public.portal_vagas_submissoes') AS portal_vagas_submissoes`);
  const row = result.rows[0];
  const absent = Object.entries(row).filter(([, value]) => !value).map(([key]) => key);
  if (absent.length) throw new Error(`Estruturas ausentes: ${absent.join(', ')}`);
  const columns = await pool.query(`SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='vagas'`);
  const names = new Set(columns.rows.map((item) => item.column_name));
  for (const name of ['id', 'titulo', 'status']) if (!names.has(name)) throw new Error(`Coluna obrigatória ausente em vagas: ${name}`);
  const requiredColumns = {
    portal_contas: ['id', 'email', 'senha_hash', 'status'],
    portal_sessoes: ['token_hash', 'conta_id', 'expires_at'],
    gg_groups: ['id', 'name', 'slug', 'description', 'invite_url', 'category', 'state', 'city', 'owner_account_id', 'invite_code_hash', 'submitted_at'],
    portal_grupo_imagens: ['grupo_id', 'conteudo', 'mime_type'],
    portal_vagas_submissoes: ['id', 'conta_id', 'empresa_nome', 'titulo', 'descricao', 'beneficios', 'status'],
  };
  const portalColumns = await pool.query(
    `SELECT table_name,column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=ANY($1::text[])`,
    [Object.keys(requiredColumns)],
  );
  const available = new Map();
  for (const item of portalColumns.rows) {
    if (!available.has(item.table_name)) available.set(item.table_name, new Set());
    available.get(item.table_name).add(item.column_name);
  }
  for (const [table, required] of Object.entries(requiredColumns)) {
    const missingColumns = required.filter((name) => !available.get(table)?.has(name));
    if (missingColumns.length) throw new Error(`Colunas ausentes em ${table}: ${missingColumns.join(', ')}`);
  }
  const groupConstraints = await pool.query(`
    SELECT conname, pg_get_constraintdef(oid) AS definition
    FROM pg_constraint
    WHERE conrelid='public.gg_groups'::regclass
      AND contype='c'
      AND POSITION('category' IN LOWER(pg_get_constraintdef(oid))) > 0
  `);
  const incompatibleCategoryChecks = groupConstraints.rows.filter((item) => !String(item.definition || '').includes('Free lances'));
  if (incompatibleCategoryChecks.length) {
    throw new Error(`Restrição antiga de categoria em gg_groups: ${incompatibleCategoryChecks.map((item) => item.conname).join(', ')}. Execute npm run migrate:communities.`);
  }
  const requiredLegacyColumns = await pool.query(`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema='public'
      AND table_name='gg_groups'
      AND is_nullable='NO'
      AND column_default IS NULL
      AND is_identity='NO'
  `);
  const suppliedOnInsert = new Set([
    'name', 'slug', 'description', 'rules', 'invite_url', 'category', 'state', 'city', 'region',
    'group_type', 'admin_only', 'accepts_jobs', 'accepts_candidate_messages', 'charges_members',
    'owner_name', 'owner_email', 'owner_phone', 'owner_account_id', 'status', 'invite_code_hash', 'submitted_at',
  ]);
  const unsupportedRequired = requiredLegacyColumns.rows.map((item) => item.column_name).filter((name) => !suppliedOnInsert.has(name));
  if (unsupportedRequired.length) throw new Error(`Colunas legadas obrigatórias bloqueiam novos grupos: ${unsupportedRequired.join(', ')}`);
  console.log('Pré-checagem concluída.', { siteUrl: process.env.SITE_URL, tables: row, dbPoolMax: process.env.DB_POOL_MAX || '10' });
}
main().catch((error) => { console.error('Pré-checagem falhou:', error.message); process.exitCode = 1; }).finally(() => pool.end());
