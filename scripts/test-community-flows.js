'use strict';

const assert = require('node:assert/strict');
const express = require('express');
const { registerCommunityRoutes } = require('../community');

function result(rows = []) { return { rows, rowCount: rows.length }; }

class FakePool {
  constructor() {
    this.account = null;
    this.sessions = new Set();
    this.groups = [];
    this.jobs = [];
  }

  async query(sql, values = []) {
    const text = String(sql).replace(/\s+/g, ' ').trim();
    if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(text)) return result();
    if (text.startsWith('SELECT 1 FROM portal_contas')) return result(this.account ? [{}] : []);
    if (text.startsWith('INSERT INTO portal_contas')) {
      this.account = {
        id: 1,
        tipo: values[0],
        nome: values[1],
        email: values[2],
        whatsapp: values[4],
        empresa_nome: values[5] || null,
        cnpj: values[6] || null,
        cidade: values[7] || null,
        estado: values[8] || 'SP',
        status: 'ATIVA',
        lead_status: 'NOVO',
        created_at: new Date(),
      };
      return result([this.account]);
    }
    if (text.startsWith('DELETE FROM portal_sessoes')) return result();
    if (text.startsWith('INSERT INTO portal_sessoes')) {
      this.sessions.add(values[0]);
      return result();
    }
    if (text.includes('FROM portal_sessoes s JOIN portal_contas c')) return result(this.account && this.sessions.size ? [this.account] : []);
    if (text.startsWith('UPDATE portal_sessoes') || text.startsWith('UPDATE portal_contas SET ultimo_login_at')) return result();
    if (text.includes('FROM gg_groups g LEFT JOIN LATERAL') && text.includes('owner_account_id=$1')) return result(this.groups.map((group) => ({ ...group, view_count: 0, click_count: 0 })));
    if (text.startsWith('SELECT * FROM portal_vagas_submissoes WHERE conta_id')) return result(this.jobs);
    if (text.startsWith('SELECT 1 FROM gg_groups WHERE invite_code_hash')) {
      const [hash] = values;
      return result(this.groups.some((group) => group.invite_code_hash === hash) ? [{}] : []);
    }
    if (text.startsWith('SELECT 1 FROM gg_groups WHERE slug=')) return result();
    if (text.startsWith('INSERT INTO gg_groups')) {
      const group = {
        id: this.groups.length + 1,
        name: values[0],
        slug: values[1],
        description: values[2],
        rules: values[3] || null,
        invite_url: values[4],
        category: values[5],
        state: values[6],
        city: values[7],
        region: values[8] || null,
        group_type: values[9],
        admin_only: values[10],
        accepts_jobs: values[11],
        accepts_candidate_messages: values[12],
        charges_members: values[13],
        owner_account_id: values[17],
        status: 'pending',
        invite_code_hash: values[18],
        created_at: new Date(),
      };
      this.groups.push(group);
      return result([group]);
    }
    if (text.startsWith('INSERT INTO portal_vagas_submissoes')) {
      const job = {
        id: this.jobs.length + 1,
        conta_id: values[0],
        empresa_nome: values[1],
        titulo: values[2],
        cargo: values[3],
        descricao: values[4],
        requisitos: values[5] || null,
        beneficios: values[6] || null,
        cidade: values[7],
        estado: values[8],
        status: 'PENDENTE',
        created_at: new Date(),
      };
      this.jobs.push(job);
      return result([job]);
    }
    throw new Error(`Consulta não simulada no teste: ${text.slice(0, 180)}`);
  }

  async connect() {
    return { query: this.query.bind(this), release() {} };
  }
}

function escapeHtml(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}

function slugify(value) {
  return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 90);
}

function cookieHeader(jar) { return [...jar.entries()].map(([key, value]) => `${key}=${value}`).join('; '); }
function collectCookies(response, jar) {
  const headers = typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : [response.headers.get('set-cookie')].filter(Boolean);
  headers.forEach((header) => {
    const pair = header.split(';', 1)[0];
    const index = pair.indexOf('=');
    if (index > 0) jar.set(pair.slice(0, index), pair.slice(index + 1));
  });
}
function csrfFrom(html) {
  const match = html.match(/name="csrf_token" value="([^"]+)"/);
  assert(match, 'O formulário precisa expor um token CSRF.');
  return match[1];
}

async function main() {
  const pool = new FakePool();
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json({ limit: '256kb' }));
  app.use(express.urlencoded({ extended: false, limit: '256kb' }));
  registerCommunityRoutes({
    app,
    pool,
    config: {
      SITE_URL: 'http://127.0.0.1', PANEL_URL: '', AUTH_SECRET: 't'.repeat(64),
      SESSION_DAYS: 14, PUBLICATIONS_WEBHOOK_URL: '', PUBLICATIONS_WEBHOOK_TOKEN: '',
      PORTAL_BRAND_NAME: 'Vagas & Grupos', PORTAL_BRAND_TAGLINE: 'Emprego, carreira e networking',
    },
    helpers: {
      escapeHtml,
      slugify,
      truncate: (value, size) => String(value || '').slice(0, size),
      metaPage: ({ content }) => `<!doctype html><html><body>${content}</body></html>`,
      header: () => '',
      footer: () => '',
      portalHeader: () => '',
      portalFooter: () => '',
      organizationSchema: () => ({}),
      portalOrganizationSchema: () => ({}),
      vacancyUrl: (vacancy) => `/vagas/${vacancy.id}`,
      listVacancies: async () => ({ vacancies: [], total: 0 }),
      formatMoney: (value) => String(value),
    },
  });
  app.use((error, _req, res, _next) => res.status(500).send(error.stack || error.message));

  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const jar = new Map();
  const request = async (path, options = {}) => {
    const response = await fetch(`${base}${path}`, {
      redirect: 'manual',
      ...options,
      headers: { ...(options.headers || {}), ...(jar.size ? { Cookie: cookieHeader(jar) } : {}) },
    });
    collectCookies(response, jar);
    return response;
  };

  try {
    let response = await request('/cadastro');
    assert.equal(response.status, 200);
    let csrf = csrfFrom(await response.text());
    response = await request('/cadastro', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        csrf_token: csrf, website: '', tipo: 'RECRUTADOR', nome: 'Pessoa de Teste',
        email: 'teste@example.com', whatsapp: '11999999999', empresa_nome: '', cnpj: '',
        cidade: 'São Paulo', estado: 'SP', senha: 'senha-segura', confirmar_senha: 'senha-segura',
        aceite_termos: 'on', consentimento_comercial: '',
      }),
    });
    assert.equal(response.status, 303);
    assert.equal(decodeURIComponent(response.headers.get('location')), '/minha-conta?ok=Conta criada com sucesso. Agora você pode publicar.');

    response = await request('/minha-conta/grupos/novo');
    assert.equal(response.status, 200);
    let html = await response.text();
    assert.match(html, /Free lances/);
    assert.doesNotMatch(html, /Primeiro emprego|Estágio e jovem aprendiz/);
    csrf = csrfFrom(html);

    const group = new FormData();
    Object.entries({
      csrf_token: csrf, website: '', preview_image_url: '',
      invite_url: 'https://chat.whatsapp.com/AbcdEfghij12345',
      name: 'Free lances em São Paulo',
      description: 'Grupo para divulgação de trabalhos autônomos e oportunidades de free lance em São Paulo.',
      rules: 'Não publicar golpes.', category: 'Free lances', state: 'SP', city: 'São Paulo',
      region: 'Zona Sul', group_type: 'emprego', admin_only: 'on', accepts_jobs: 'on',
    }).forEach(([key, value]) => group.append(key, value));
    response = await request('/minha-conta/grupos/novo', { method: 'POST', body: group });
    assert.equal(response.status, 303);
    assert.equal(pool.groups.length, 1);
    assert.equal(pool.groups[0].category, 'Free lances');

    response = await request('/minha-conta/vagas/nova');
    assert.equal(response.status, 200);
    csrf = csrfFrom(await response.text());
    response = await request('/minha-conta/vagas/nova', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        csrf_token: csrf, website: '', empresa_nome: 'Empresa Teste', titulo: 'Auxiliar de limpeza',
        cargo: 'Auxiliar de limpeza', descricao: 'O profissional será responsável pela limpeza e organização dos ambientes da empresa durante o expediente.',
        requisitos: 'Experiência desejável.', beneficios: 'Vale-transporte; Vale-refeição; Seguro de vida',
        cidade: 'São Paulo', estado: 'SP', bairro: 'Mooca', modalidade: 'Presencial',
        tipo_contrato: 'CLT', escala: '6x1', horario: '08:00 às 16:20', salario: '1837,40',
        quantidade_vagas: '2', whatsapp_contato: '11999999999',
      }),
    });
    assert.equal(response.status, 303);
    assert.equal(pool.jobs.length, 1);
    assert.match(pool.jobs[0].beneficios, /Vale-transporte/);

    response = await request('/minha-conta/grupos/novo');
    csrf = csrfFrom(await response.text());
    const invalidUpload = new FormData();
    invalidUpload.append('csrf_token', csrf);
    invalidUpload.append('image', new Blob(['arquivo inválido'], { type: 'text/plain' }), 'grupo.txt');
    response = await request('/minha-conta/grupos/novo', { method: 'POST', body: invalidUpload });
    assert.equal(response.status, 400);
    assert.match(await response.text(), /Envie uma imagem JPG, PNG ou WEBP/);

    console.log('Fluxos de conta, grupo, vaga e upload validados com sucesso.');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
