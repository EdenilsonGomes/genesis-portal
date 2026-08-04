'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
function assert(condition, message) { if (!condition) throw new Error(message); }
function read(file) { return fs.readFileSync(path.join(root, file), 'utf8'); }
function checkSyntax(file) {
  const result = spawnSync(process.execPath, ['--check', path.join(root, file)], { encoding: 'utf8' });
  assert(result.status === 0, `${file}: ${result.stderr || result.stdout}`);
}
['server.js','community.js','lib/brazil-locations.js','public/portal.js','public/theme-init.js','scripts/test-community-flows.js'].forEach(checkSyntax);
const server = read('server.js');
['data-theme-toggle','data-menu-toggle','portal-bottom-nav','JobPosting','sitemap.xml'].forEach((token) => assert(server.includes(token), `Recurso obrigatório ausente: ${token}`));
['13.0.0','upgradeLocationMarkup','grupo-oficial','recrutamento conversacional'].forEach((token) => assert(server.includes(token), `Recurso V13 ausente: ${token}`));
const css = read('public/portal.css');
['html[data-theme="dark"]','portal-bottom-nav','mobile-menu','sticky-mobile-cta'].forEach((token) => assert(css.includes(token), `CSS incompleto: ${token}`));
['publication-form input','form-panel-title > span','benefit-options','@media (max-width: 620px)'].forEach((token) => assert(css.includes(token), `CSS de formulários incompleto: ${token}`));
['sistema visual V13','location-picker-pair','prefers-reduced-motion'].forEach((token) => assert(css.includes(token), `CSS V13 incompleto: ${token}`));
const community = read('community.js');
['Free lances','parseGroupImage','GROUP_DATABASE_REJECTION','api/public/localidades'].forEach((token) => assert(community.includes(token), `Comunidades incompletas: ${token}`));
['Primeiro emprego','Estágio e jovem aprendiz'].forEach((token) => assert(!community.includes(token), `Categoria removida ainda presente: ${token}`));
const portalJs = read('public/portal.js');
['benefitOptions','syncBenefits','publication-form'].forEach((token) => assert(portalJs.includes(token), `Interação de formulário incompleta: ${token}`));
['brazilStates','loadCities','data-location-state','lista completa do IBGE'].forEach((token) => assert(portalJs.includes(token), `Localização guiada incompleta: ${token}`));
const migration = read('sql/07_GENESIS_IA_PORTAL_PUBLICO_VAGAS_SEO_LEADS.sql');
['portal_leads_empresas','portal_eventos','publicar_portal'].forEach((token) => assert(migration.includes(token), `Migração incompleta: ${token}`));
const communitiesMigration = read('sql/16_GENESIS_PORTAL_COMUNIDADES_CONTAS_PUBLICACOES.sql');
['gg_groups_category_check', 'Free lances', "DROP CONSTRAINT %I"].forEach((token) => assert(communitiesMigration.includes(token), `Compatibilidade de categorias incompleta: ${token}`));
[
  'public/assets/genesis-brand.svg', 'public/assets/vagas-grupos-brand.svg',
  'public/assets/genesis-social.png', 'public/assets/vagas-grupos-social.png', 'public/assets/og-default.png',
  'BRAND_GUIDE.md',
].forEach((file) => assert(fs.existsSync(path.join(root, file)), `Ativo de marca ausente: ${file}`));
console.log('Validação do portal concluída com sucesso.');
