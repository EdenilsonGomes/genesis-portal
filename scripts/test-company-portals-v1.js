'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
function assert(condition, message) { if (!condition) throw new Error(message); }
function syntax(file) {
  const r = spawnSync(process.execPath, ['--check', path.join(root, file)], { encoding: 'utf8' });
  assert(r.status === 0, `${file}: ${r.stderr || r.stdout}`);
}

['server.js','company-portals.js','community.js','public/portal.js','scripts/migrate-company-portals-v1.js','scripts/preflight-company-portals-v1.js'].forEach(syntax);

const server = read('server.js');
const moduleText = read('company-portals.js');
const css = read('public/portal.css');
const js = read('public/portal.js');
const migration = read('sql/17_GENESIS_PORTAL_EMPRESAS_MVP.sql');
const pkg = JSON.parse(read('package.json'));

assert(pkg.version === '13.1.0', 'Versão do portal precisa ser 13.1.0.');
assert(server.includes('registerCompanyPortalRoutes'), 'Módulo de portais de empresas não foi registrado.');
[
  "/portal-para-empresas",
  "/portal-para-empresas/comecar",
  "/meu-portal/onboarding",
  "/meu-portal/vagas/nova",
  "/empresas",
  "/empresa/:slug",
  "/sitemap-empresas.xml",
].forEach((token) => assert(server.includes(token) || moduleText.includes(token), `Rota obrigatória ausente: ${token}`));

[
  'Seu Trabalhe Conosco, com a <em>marca da sua empresa.</em>',
  'A marca é sua. A tecnologia é nossa.',
  'Criar meu portal grátis',
  'Empresa parceira do',
  'Tecnologia Gênesis IA',
].forEach((token) => assert(moduleText.includes(token), `Mensagem/CTA do MVP ausente: ${token}`));

assert(moduleText.includes("INSERT INTO vagas("), 'Vagas parceiras não usam a tabela oficial vagas.');
assert(moduleText.includes("origem_vaga='PORTAL_PARCEIRO'") || moduleText.includes("'PORTAL_PARCEIRO'"), 'Origem PORTAL_PARCEIRO ausente.');
assert(moduleText.includes('atendimento_chatbot') && moduleText.includes('FALSE'), 'Vaga parceira precisa nascer fora do chatbot por padrão.');
assert(moduleText.includes("status=CASE WHEN status='RASCUNHO' THEN 'ATIVA'"), 'Cópia em rascunho não é ativada ao salvar.');
assert(moduleText.includes('wa.me/${number}?text='), 'Candidatura via WhatsApp não possui mensagem contextual.');

['portal_empresas','portal_empresa_imagens','portal_eventos','owner_account_id','origem_ref'].forEach((token) => assert(migration.includes(token), `Migração 17 incompleta: ${token}`));
['DROP TABLE','DROP SCHEMA','DROP DATABASE','TRUNCATE'].forEach((token) => assert(!migration.toUpperCase().includes(token), `Migração destrutiva detectada: ${token}`));
assert(!/CREATE\s+TABLE\s+(IF\s+NOT\s+EXISTS\s+)?(portal_)?vagas\b/i.test(migration), 'MVP criou tabela duplicada de vagas.');

['company-landing','career-signup-grid','onboarding-card','career-dashboard-grid','partner-company-grid','company-public-page'].forEach((token) => assert(css.includes(token), `CSS do MVP ausente: ${token}`));
['@media(max-width:760px)','@media(max-width:540px)'].forEach((token) => assert(css.replace(/\s/g,'').includes(token), `Breakpoint responsivo ausente: ${token}`));
['data-copy-text','brand-upload-card','candidatura_tipo'].forEach((token) => assert(js.includes(token) || moduleText.includes(token), `Interação do MVP ausente: ${token}`));

console.log('MVP Portal de Empresas V1: estrutura, UX básica, responsividade e isolamento validados.');
