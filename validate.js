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
['server.js','public/portal.js','public/theme-init.js'].forEach(checkSyntax);
const server = read('server.js');
['data-theme-toggle','data-menu-toggle','portal-bottom-nav','JobPosting','sitemap.xml','ageRequirementText','idade_maxima','Faixa etária'].forEach((token) => assert(server.includes(token), `Recurso obrigatório ausente: ${token}`));
const css = read('public/portal.css');
['html[data-theme="dark"]','portal-bottom-nav','mobile-menu','sticky-mobile-cta'].forEach((token) => assert(css.includes(token), `CSS incompleto: ${token}`));
const migration = read('sql/12_GENESIS_IA_V9_1_EXPORT_FILTROS_IDADE_MAXIMA.sql');
['idade_maxima','data_nascimento_origem','vagas_faixa_etaria_valida'].forEach((token) => assert(migration.includes(token), `Migração V9.1 incompleta: ${token}`));
console.log('Validação do portal V9.1 concluída com sucesso.');
