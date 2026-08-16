'use strict';

const base = String(process.env.SITE_URL || process.argv[2] || '').replace(/\/+$/, '');
if (!/^https?:\/\//.test(base)) {
  console.error('Configure SITE_URL ou informe a URL como argumento.');
  process.exit(1);
}
const checks = [
  ['/health', 200, '"status":"ok"'],
  ['/', 200, 'Gênesis'],
  ['/vagas', 200, 'vagas'],
  ['/grupos', 200, 'grupos'],
  ['/cadastro', 200, 'Criar conta'],
  ['/robots.txt', 200, 'Sitemap:'],
  ['/sitemap.xml', 200, '<sitemapindex'],
  ['/privacidade', 200, 'Política de privacidade'],
  ['/termos', 200, 'Termos de uso'],
  ['/exclusao-de-dados', 200, 'Exclusão de dados do usuário'],
];

async function main() {
  let failed = false;
  for (const [path, status, text] of checks) {
    try {
      const response = await fetch(`${base}${path}`, { redirect: 'follow', signal: AbortSignal.timeout(12_000) });
      const body = await response.text();
      const ok = response.status === status && body.toLowerCase().includes(text.toLowerCase());
      console.log(`${ok ? 'OK' : 'FALHA'} ${response.status} ${path}`);
      if (!ok) failed = true;
    } catch (error) {
      failed = true;
      console.log(`FALHA ${path}: ${error.message}`);
    }
  }
  if (failed) process.exitCode = 1;
}
main();

