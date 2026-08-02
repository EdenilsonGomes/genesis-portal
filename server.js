'use strict';

const crypto = require('node:crypto');
const path = require('node:path');
const express = require('express');
const helmet = require('helmet');
const { rateLimit } = require('express-rate-limit');
const { Pool } = require('pg');
const QRCode = require('qrcode');
const { z } = require('zod');

const PORT = Number(process.env.PORT || 3000);
const DATABASE_URL = process.env.DATABASE_URL;
const PGHOST = process.env.PGHOST;
const PGPORT = Number(process.env.PGPORT || 5432);
const PGDATABASE = process.env.PGDATABASE;
const PGUSER = process.env.PGUSER;
const PGPASSWORD = process.env.PGPASSWORD;
const DB_SSL = String(process.env.DB_SSL || 'false').toLowerCase() === 'true';

const SITE_URL = normalizeBaseUrl(process.env.SITE_URL || 'http://localhost:3000');
const PANEL_URL = normalizeBaseUrl(process.env.PANEL_URL || '');
const BRAND_NAME = String(process.env.BRAND_NAME || 'Genesis IA').trim();
const ORGANIZATION_LEGAL_NAME = String(process.env.ORGANIZATION_LEGAL_NAME || BRAND_NAME).trim();
const ORGANIZATION_LOGO_URL = String(
  process.env.ORGANIZATION_LOGO_URL || `${SITE_URL}/assets/genesis-mark.svg`,
).trim();
const ORGANIZATION_CITY = String(process.env.ORGANIZATION_CITY || 'São Paulo').trim();
const ORGANIZATION_STATE = String(process.env.ORGANIZATION_STATE || 'SP').trim().toUpperCase();
const ORGANIZATION_COUNTRY = String(process.env.ORGANIZATION_COUNTRY || 'BR').trim().toUpperCase();
const DEFAULT_STATE = String(process.env.DEFAULT_STATE || 'SP').trim().toUpperCase();
const CANDIDATE_WHATSAPP_NUMBER = digits(process.env.CANDIDATE_WHATSAPP_NUMBER || '5511913022278');
const COMMERCIAL_WHATSAPP_NUMBER = digits(process.env.COMMERCIAL_WHATSAPP_NUMBER || CANDIDATE_WHATSAPP_NUMBER);
const WHATSAPP_GROUP_URL = String(process.env.WHATSAPP_GROUP_URL || '').trim();
const PORTAL_ANALYTICS_SECRET = String(
  process.env.PORTAL_ANALYTICS_SECRET || crypto.randomBytes(32).toString('hex'),
).trim();

const WAHA_BASE_URL = normalizeBaseUrl(process.env.WAHA_BASE_URL || '');
const WAHA_API_KEY = String(process.env.WAHA_API_KEY || '').trim();
const WAHA_SESSION = String(process.env.WAHA_SESSION || 'whats_junior').trim();
const WAHA_GROUP_ID = String(process.env.WAHA_GROUP_ID || '').trim();
const LEAD_EMPRESA_WEBHOOK_URL = String(process.env.LEAD_EMPRESA_WEBHOOK_URL || '').trim();
const LEAD_EMPRESA_WEBHOOK_TOKEN = String(process.env.LEAD_EMPRESA_WEBHOOK_TOKEN || '').trim();

if (!DATABASE_URL && (!PGHOST || !PGDATABASE || !PGUSER || !PGPASSWORD)) {
  console.error('ERRO: configure DATABASE_URL ou PGHOST, PGDATABASE, PGUSER e PGPASSWORD.');
  process.exit(1);
}

const pool = new Pool({
  ...(DATABASE_URL
    ? { connectionString: DATABASE_URL }
    : {
        host: PGHOST,
        port: PGPORT,
        database: PGDATABASE,
        user: PGUSER,
        password: PGPASSWORD,
      }),
  ssl: DB_SSL ? { rejectUnauthorized: false } : false,
  max: 8,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
});

pool.on('error', (error) => console.error('Erro inesperado no PostgreSQL:', error));

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');

app.use((req, res, next) => {
  res.locals.cspNonce = crypto.randomBytes(16).toString('base64');
  next();
});

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", (req, res) => `'nonce-${res.locals.cspNonce}'`],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:', 'https:'],
      connectSrc: ["'self'"],
      fontSrc: ["'self'"],
      objectSrc: ["'none'"],
      frameAncestors: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
    },
  },
  crossOriginResourcePolicy: { policy: 'cross-origin' },
}));

app.use(rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 650,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  skip: (req) => ['/health', '/robots.txt', '/sitemap.xml'].includes(req.path),
}));

const companyLeadLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 8,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: 'Muitas tentativas. Aguarde alguns minutos e tente novamente.',
});

app.use(express.json({ limit: '256kb' }));
app.use(express.urlencoded({ extended: false, limit: '256kb' }));
app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: process.env.NODE_ENV === 'production' ? '1d' : 0,
  etag: true,
}));

function normalizeBaseUrl(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

function digits(value) {
  return String(value || '').replace(/\D+/g, '');
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function jsonForHtml(value) {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026');
}

function slugify(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 90) || 'vaga';
}

function vacancySlug(vacancy) {
  return `${vacancy.id}-${slugify(`${vacancy.titulo || vacancy.cargo}-${vacancy.bairro || vacancy.cidade || ''}`)}`;
}

function vacancyUrl(vacancy) {
  return `${SITE_URL}/vagas/${vacancySlug(vacancy)}`;
}

function formatMoney(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return '';
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(number);
}


function structuredBenefits(vacancy = {}) {
  const items = [
    Number(vacancy.vale_refeicao_valor) > 0 ? { label: 'Vale-refeição', value: Number(vacancy.vale_refeicao_valor), includeInTotal: true } : null,
    Number(vacancy.vale_alimentacao_valor) > 0 ? { label: 'Vale-alimentação', value: Number(vacancy.vale_alimentacao_valor), includeInTotal: true } : null,
    Number(vacancy.premio_assiduidade_valor) > 0 ? { label: 'Prêmio de assiduidade', value: Number(vacancy.premio_assiduidade_valor), includeInTotal: true } : null,
    Number(vacancy.outros_beneficios_valor) > 0 ? { label: 'Outros benefícios com valor', value: Number(vacancy.outros_beneficios_valor), includeInTotal: true } : null,
  ].filter(Boolean);
  if (String(vacancy.vale_transporte_descricao || '').trim()) {
    items.push({ label: 'Vale-transporte', description: String(vacancy.vale_transporte_descricao).trim(), includeInTotal: false });
  }
  return items;
}

function approximateMonthlyGains(vacancy = {}) {
  const salary = Number(vacancy.salario) || 0;
  const structured = structuredBenefits(vacancy).filter((item) => item.includeInTotal).reduce((sum, item) => sum + Number(item.value || 0), 0);
  const unhealthy = vacancy.possui_insalubridade === true || String(vacancy.possui_insalubridade).toLowerCase() === 'true';
  const percentage = Number(vacancy.percentual_insalubridade);
  const unhealthyValue = unhealthy && salary > 0 && Number.isFinite(percentage) ? salary * (percentage / 100) : 0;
  return {
    total: salary + structured + unhealthyValue,
    unhealthyValue,
    salary,
    structured,
  };
}

function formatDate(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    day: '2-digit',
    month: 'long',
    year: 'numeric',
  }).format(date);
}

function isoDate(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

function splitList(value) {
  if (Array.isArray(value)) return value.map(String).map((item) => item.trim()).filter(Boolean);
  return String(value || '')
    .split(/\r?\n|;|\|/)
    .map((item) => item.replace(/^[-•]\s*/, '').trim())
    .filter(Boolean);
}

function truncate(value, max) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trim()}…`;
}

function locationText(vacancy) {
  return [vacancy.bairro, vacancy.cidade, vacancy.estado].filter(Boolean).join(' · ') || 'Local a confirmar';
}

function themeForVacancy(vacancy) {
  const text = `${vacancy.titulo || ''} ${vacancy.cargo || ''}`
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
  const map = [
    ['limpeza', ['limpeza', 'faxina', 'servicos gerais', 'higienizacao', 'copeira']],
    ['seguranca', ['porteiro', 'portaria', 'vigilante', 'seguranca', 'controlador de acesso']],
    ['logistica', ['logistica', 'estoque', 'almoxarifado', 'carga', 'motorista', 'expedicao']],
    ['manutencao', ['manutencao', 'eletricista', 'encanador', 'tecnico', 'predial']],
    ['administrativo', ['administrativo', 'recepcao', 'recepcionista', 'assistente', 'auxiliar administrativo']],
    ['rh', ['recrutamento', 'recursos humanos', 'departamento pessoal', 'rh']],
    ['alimentacao', ['cozinha', 'cozinheiro', 'alimentacao', 'nutricao', 'restaurante']],
    ['tecnologia', ['tecnologia', 'desenvolvedor', 'suporte', 'ti', 'sistemas']],
    ['saude', ['saude', 'enfermagem', 'cuidador', 'clinica']],
  ];
  for (const [theme, terms] of map) {
    if (terms.some((term) => text.includes(term))) return theme;
  }
  return 'generico';
}

function imageForVacancy(vacancy) {
  if (vacancy.imagem_capa_url) return vacancy.imagem_capa_url;
  return `${SITE_URL}/assets/jobs/${themeForVacancy(vacancy)}.jpg`;
}

function employmentType(value) {
  const text = String(value || '').toLowerCase();
  if (text.includes('tempor')) return 'TEMPORARY';
  if (text.includes('estágio') || text.includes('estagio')) return 'INTERN';
  if (text.includes('autôn') || text.includes('auton') || text.includes('pj')) return 'CONTRACTOR';
  if (text.includes('parcial') || text.includes('part')) return 'PART_TIME';
  if (text.includes('diária') || text.includes('diaria')) return 'PER_DIEM';
  return 'FULL_TIME';
}

function candidateApplication(vacancy) {
  const channel = String(vacancy.canal_candidatura || 'WHATSAPP_GENESIS').toUpperCase();
  if (channel === 'URL_EXTERNA' && vacancy.candidatura_url) {
    return { url: vacancy.candidatura_url, label: 'Candidatar-se no site da empresa', type: 'external' };
  }
  if (channel === 'EMAIL' && vacancy.candidatura_email) {
    const subject = encodeURIComponent(`Candidatura — ${vacancy.titulo} — ${vacancy.codigo}`);
    return {
      url: `mailto:${vacancy.candidatura_email}?subject=${subject}`,
      label: 'Enviar candidatura por e-mail',
      type: 'email',
    };
  }
  const number = digits(vacancy.whatsapp_candidatura || CANDIDATE_WHATSAPP_NUMBER);
  const message = [
    'Olá! Vi esta oportunidade no Portal Genesis IA e quero me candidatar:',
    '',
    `${vacancy.titulo}`,
    `${locationText(vacancy)}`,
    `Código da vaga: ${vacancy.codigo}`,
    `Link: ${vacancyUrl(vacancy)}`,
  ].join('\n');
  return {
    url: `https://wa.me/${number}?text=${encodeURIComponent(message)}`,
    label: 'Quero me candidatar pelo WhatsApp',
    type: 'whatsapp',
  };
}

async function notifyCompanyLead(lead) {
  if (!LEAD_EMPRESA_WEBHOOK_URL) return;
  try {
    await fetch(LEAD_EMPRESA_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: LEAD_EMPRESA_WEBHOOK_TOKEN, ...lead }),
      signal: AbortSignal.timeout(8_000),
    });
  } catch (error) {
    console.error('Falha ao notificar novo lead de empresa:', error.message);
  }
}

function commercialWhatsAppUrl() {
  const message = encodeURIComponent('Olá! Quero anunciar vagas e conhecer as soluções da Genesis IA.');
  return `https://wa.me/${COMMERCIAL_WHATSAPP_NUMBER}?text=${message}`;
}

function absoluteUrl(pathname) {
  if (/^https?:\/\//i.test(String(pathname || ''))) return pathname;
  return `${SITE_URL}${String(pathname || '').startsWith('/') ? '' : '/'}${pathname || ''}`;
}

function currentUrl(req) {
  return `${SITE_URL}${req.originalUrl.split('#')[0]}`;
}

function metaPage({ title, description, canonical, image, bodyClass = '', content, nonce, structuredData = [], robots = 'index,follow,max-image-preview:large', vacancyId = '' }) {
  const fullTitle = title.includes(BRAND_NAME) ? title : `${title} | ${BRAND_NAME}`;
  const schemas = structuredData.map((schema) => (
    `<script nonce="${escapeHtml(nonce)}" type="application/ld+json">${jsonForHtml(schema)}</script>`
  )).join('\n');

  return `<!doctype html>
<html lang="pt-BR" data-page="public" data-vacancy-id="${escapeHtml(vacancyId)}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(fullTitle)}</title>
  <meta name="description" content="${escapeHtml(description)}">
  <meta name="robots" content="${escapeHtml(robots)}">
  <link rel="canonical" href="${escapeHtml(canonical)}">
  <meta property="og:locale" content="pt_BR">
  <meta property="og:type" content="website">
  <meta property="og:site_name" content="${escapeHtml(BRAND_NAME)}">
  <meta property="og:title" content="${escapeHtml(fullTitle)}">
  <meta property="og:description" content="${escapeHtml(description)}">
  <meta property="og:url" content="${escapeHtml(canonical)}">
  <meta property="og:image" content="${escapeHtml(image)}">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${escapeHtml(fullTitle)}">
  <meta name="twitter:description" content="${escapeHtml(description)}">
  <meta name="twitter:image" content="${escapeHtml(image)}">
  <link rel="icon" href="/assets/genesis-mark.svg" type="image/svg+xml">
  <meta name="theme-color" content="#073642">
  <script src="/theme-init.js?v=1000"></script>
  <link rel="stylesheet" href="/portal.css?v=1000">
  ${schemas}
</head>
<body class="${escapeHtml(bodyClass)}">
  <a class="skip-link" href="#conteudo">Ir para o conteúdo</a>
  ${content}
  <script src="/portal.js?v=1000" defer></script>
</body>
</html>`;
}

function header({ light = false } = {}) {
  const loginUrl = PANEL_URL ? `${PANEL_URL}/login` : '/login';
  return `<header class="site-header">
    <div class="container header-inner">
      <a class="brand" href="/" aria-label="Página inicial da ${escapeHtml(BRAND_NAME)}">
        <img src="/assets/genesis-mark.svg" alt="" width="42" height="42">
        <span>${escapeHtml(BRAND_NAME)}<small>Recruiting OS · Nova Fase</small></span>
      </a>
      <nav class="nav" aria-label="Navegação principal">
        <a href="/#solucoes">Soluções</a>
        <a href="/vagas">Portal de vagas</a>
        <a href="/anunciar-vaga">Anunciar vaga</a>
      </nav>
      <div class="header-actions">
        <button class="header-icon theme-toggle" type="button" data-theme-toggle aria-label="Ativar modo escuro" title="Alternar tema"><span aria-hidden="true">☾</span></button>
        <a class="btn btn-ghost header-vacancies" href="/vagas" data-track="CTA_HEADER_VAGAS">Ver vagas</a>
        <a class="btn btn-primary header-login" href="${escapeHtml(loginUrl)}" data-track="CTA_HEADER_LOGIN">Entrar</a>
        <button class="header-icon menu-toggle" type="button" data-menu-toggle aria-label="Abrir menu" aria-expanded="false">☰</button>
      </div>
    </div>
    <div class="mobile-menu" data-mobile-menu>
      <nav class="container" aria-label="Navegação móvel">
        <a href="/">Início</a><a href="/vagas">Encontrar vagas</a><a href="/grupo">Grupo de vagas</a><a href="/anunciar-vaga">Anunciar vaga</a><a href="${escapeHtml(loginUrl)}">Acessar painel</a>
      </nav>
    </div>
  </header><button class="menu-backdrop" data-menu-backdrop type="button" aria-label="Fechar menu"></button>`;
}

function footer() {
  const year = new Date().getFullYear();
  return `<footer class="site-footer">
    <div class="container footer-grid">
      <div>
        <a class="brand" href="/">
          <img src="/assets/genesis-mark.svg" alt="" width="42" height="42">
          <span>${escapeHtml(BRAND_NAME)}<small>Recruiting OS · Nova Fase</small></span>
        </a>
        <p class="footer-copy">Tecnologia para atrair, qualificar e conduzir candidatos até a entrevista, sem perder o contato humano.</p>
      </div>
      <div class="footer-col">
        <h4>Candidatos</h4>
        <a href="/vagas">Encontrar vagas</a>
        <a href="/grupo" data-track="CTA_FOOTER_GRUPO">Grupo de vagas</a>
      </div>
      <div class="footer-col">
        <h4>Empresas</h4>
        <a href="/anunciar-vaga">Anunciar uma vaga</a>
        <a href="${escapeHtml(commercialWhatsAppUrl())}" target="_blank" rel="noopener" data-track="CTA_FOOTER_COMERCIAL">Falar com especialista</a>
      </div>
    </div>
    <div class="container footer-bottom">© ${year} ${escapeHtml(BRAND_NAME)}. Todos os direitos reservados.</div>
  </footer>
  <nav class="portal-bottom-nav" aria-label="Navegação rápida">
    <a href="/" data-nav-path="/"><span>⌂</span><b>Início</b></a>
    <a href="/vagas" data-nav-path="/vagas"><span>▣</span><b>Vagas</b></a>
    <a href="/grupo"><span>◉</span><b>Grupo</b></a>
    <a href="/anunciar-vaga" data-nav-path="/anunciar-vaga"><span>＋</span><b>Empresas</b></a>
    <a href="/painel"><span>♙</span><b>Painel</b></a>
  </nav>`;
}

function organizationSchema() {
  return {
    '@context': 'https://schema.org',
    '@type': 'Organization',
    name: ORGANIZATION_LEGAL_NAME,
    url: SITE_URL,
    logo: ORGANIZATION_LOGO_URL,
    address: {
      '@type': 'PostalAddress',
      addressLocality: ORGANIZATION_CITY,
      addressRegion: ORGANIZATION_STATE,
      addressCountry: ORGANIZATION_COUNTRY,
    },
  };
}

function landingPage(req, res) {
  const loginUrl = PANEL_URL ? `${PANEL_URL}/login` : '/login';
  const content = `${header()}
  <main id="conteudo">
    <section class="hero">
      <div class="container hero-grid">
        <div>
          <span class="eyebrow">Recrutamento que não deixa oportunidades escapar</span>
          <h1>Transforme vagas em <span>candidatos prontos.</span></h1>
          <p class="hero-copy">A Genesis IA conecta divulgação, WhatsApp, triagem, documentos, agenda e gestão em um fluxo único — para empresas contratarem com mais velocidade e candidatos encontrarem oportunidades reais.</p>
          <div class="hero-actions">
            <a class="btn btn-accent btn-lg" href="/vagas" data-track="CTA_HERO_VAGAS">Encontrar uma vaga</a>
            <a class="btn btn-primary btn-lg" href="/anunciar-vaga" data-track="CTA_HERO_EMPRESA">Quero contratar melhor</a>
            <a class="btn btn-ghost btn-lg" href="${escapeHtml(loginUrl)}" data-track="CTA_HERO_LOGIN">Acessar painel</a>
          </div>
          <p class="hero-note">Contato direto pelo WhatsApp · Vagas atualizadas · Processo guiado</p>
        </div>
        <div class="product-orbit" aria-label="Representação visual da plataforma Genesis IA">
          <div class="orbit-glow"></div>
          <div class="product-card product-main">
            <div class="window-bar"><i></i><i></i><i></i></div>
            <div class="metric-strip">
              <div class="metric-box"><strong>42</strong><span>Candidatos no funil</span></div>
              <div class="metric-box"><strong>8</strong><span>Entrevistas</span></div>
              <div class="metric-box"><strong>12</strong><span>Vagas ativas</span></div>
            </div>
            <div class="pipeline">
              <div class="pipeline-row"><span>Novos</span><div class="pipeline-bar"><i style="width:92%"></i></div><b>18</b></div>
              <div class="pipeline-row"><span>Triagem</span><div class="pipeline-bar"><i style="width:74%"></i></div><b>14</b></div>
              <div class="pipeline-row"><span>Entrevista</span><div class="pipeline-bar"><i style="width:48%"></i></div><b>8</b></div>
              <div class="pipeline-row"><span>Admissão</span><div class="pipeline-bar"><i style="width:24%"></i></div><b>4</b></div>
            </div>
          </div>
          <div class="product-card product-mini">
            <div class="job-mini-card"><b>Auxiliar de Limpeza</b><span>Mooca · 6x1 · Início imediato</span></div>
            <div class="job-mini-card"><b>Porteiro</b><span>Santo Amaro · Noturno</span></div>
          </div>
        </div>
      </div>
    </section>

    <div class="container trust-bar">
      <div class="trust-inner">
        <div class="trust-item"><strong>Portal conectado</strong><span>Vaga ativa no painel aparece automaticamente para o candidato.</span></div>
        <div class="trust-item"><strong>WhatsApp no centro</strong><span>CTA direto, QR Code no computador e atendimento guiado.</span></div>
        <div class="trust-item"><strong>Triagem inteligente</strong><span>Experiência, documentos e agenda no mesmo processo.</span></div>
        <div class="trust-item"><strong>Etapas rastreáveis</strong><span>Origem, cliques, pendências e evolução do candidato.</span></div>
      </div>
    </div>

    <section id="solucoes" class="section">
      <div class="container">
        <div class="section-head">
          <h2>Uma operação de recrutamento com cara de produto.</h2>
          <p>Da publicação da vaga até a admissão, cada etapa foi desenhada para reduzir abandono, retrabalho e tempo de resposta.</p>
        </div>
        <div class="feature-grid">
          <article class="feature-card accent"><div class="feature-icon">↗</div><h3>Aquisição de candidatos</h3><p>Páginas públicas, Google Vagas, WhatsApp, QR Code, grupos e campanhas com links rastreáveis.</p></article>
          <article class="feature-card"><div class="feature-icon">◎</div><h3>Triagem no WhatsApp</h3><p>A Evelyn se apresenta como inteligência artificial e conduz a candidatura por etapas claras, opções numeradas e validações previsíveis.</p></article>
          <article class="feature-card"><div class="feature-icon">▣</div><h3>Documentos e CTPS</h3><p>Recebimento, análise e visibilidade dos documentos dentro do perfil do candidato.</p></article>
          <article class="feature-card"><div class="feature-icon">◷</div><h3>Agenda conectada</h3><p>Horários disponíveis, Google Meet, confirmação e reagendamento sem confusão no painel.</p></article>
          <article class="feature-card"><div class="feature-icon">◇</div><h3>Banco de talentos vivo</h3><p>Quem não avança pode continuar no grupo e voltar ao funil em uma vaga mais compatível.</p></article>
          <article class="feature-card"><div class="feature-icon">⌁</div><h3>Observabilidade real</h3><p>Indicadores, erros, mensagens, etapas e desempenho por vaga para o administrador acompanhar.</p></article>
        </div>
      </div>
    </section>

    <section class="section section-dark">
      <div class="container split-panel">
        <article class="candidate-panel">
          <span class="panel-kicker">Para candidatos</span>
          <h3>Um caminho guiado. Menos abandono.</h3>
          <p>O candidato encontra a vaga, entende salário, escala, horário e benefícios, e inicia a candidatura no canal que já usa todos os dias.</p>
          <ul class="check-list"><li>Vagas atualizadas e páginas completas</li><li>WhatsApp clicável no celular e computador</li><li>QR Code para continuar no telefone</li><li>Grupo com novas oportunidades</li></ul>
          <a class="btn btn-accent btn-lg" href="/vagas" data-track="CTA_CANDIDATO_VAGAS">Ver oportunidades</a>
        </article>
        <article class="company-panel">
          <span class="panel-kicker">Para empresas</span>
          <h3>Não é só anunciar. É gerar candidatos.</h3>
          <p>Empresas interessadas deixam os dados e entram no funil comercial da Genesis IA. A vaga não é publicada automaticamente e não é oferecida pelo chatbot até ser aprovada e configurada pela equipe.</p>
          <ul class="check-list"><li>Divulgação profissional da oportunidade</li><li>Captação e qualificação de candidatos</li><li>Painel com funil e entrevistas</li><li>Automação adaptada à operação</li></ul>
          <a class="btn btn-primary btn-lg" href="/anunciar-vaga" data-track="CTA_EMPRESA_FORM">Quero anunciar vagas</a>
        </article>
      </div>
    </section>

    <section class="section">
      <div class="container">
        <div class="section-head">
          <h2>Do clique ao processo seletivo sem perder o lead.</h2>
          <p>CTAs persistentes, vagas relacionadas, grupo e mensagens pré-preenchidas mantêm o candidato dentro de uma jornada simples.</p>
        </div>
        <div class="feature-grid">
          <article class="feature-card"><div class="feature-icon">1</div><h3>Descoberta</h3><p>Google, redes sociais, grupos, QR Code e portal próprio levam o candidato para a página correta.</p></article>
          <article class="feature-card"><div class="feature-icon">2</div><h3>Conversão</h3><p>Uma página objetiva mostra os dados da vaga e abre o WhatsApp com título e código já preenchidos.</p></article>
          <article class="feature-card"><div class="feature-icon">3</div><h3>Continuidade</h3><p>A Evelyn conduz a triagem e o recrutador acompanha o progresso no painel.</p></article>
        </div>
      </div>
    </section>

    <section class="cta-band">
      <div class="container cta-shell">
        <div><h2>Encontre pessoas. Contrate melhor.</h2><p>Comece por uma vaga ou conheça a operação completa da Genesis IA.</p></div>
        <div class="hero-actions"><a class="btn btn-accent btn-lg" href="/vagas" data-track="CTA_FINAL_VAGAS">Ver vagas</a><a class="btn btn-dark btn-lg" href="/anunciar-vaga" data-track="CTA_FINAL_EMPRESA">Falar sobre contratação</a></div>
      </div>
    </section>
  </main>
  ${footer()}`;

  return res.send(metaPage({
    title: `${BRAND_NAME} — recrutamento, vagas e triagem inteligente`,
    description: 'Portal de vagas e plataforma de recrutamento com WhatsApp, triagem, documentos, entrevistas e gestão do funil.',
    canonical: SITE_URL,
    image: `${SITE_URL}/assets/og-default.svg`,
    content,
    nonce: res.locals.cspNonce,
    structuredData: [organizationSchema(), {
      '@context': 'https://schema.org',
      '@type': 'WebSite',
      name: BRAND_NAME,
      url: SITE_URL,
      potentialAction: {
        '@type': 'SearchAction',
        target: `${SITE_URL}/vagas?q={search_term_string}`,
        'query-input': 'required name=search_term_string',
      },
    }],
  }));
}

const vacancySelect = `
  SELECT
    v.*,
    COALESCE(e.nome_publico, e.nome) AS empresa_nome,
    e.nome AS empresa_razao,
    e.descricao_publica AS empresa_descricao,
    e.logo_url AS empresa_logo_url,
    e.site_url AS empresa_site_url
  FROM vagas v
  JOIN empresas e ON e.id = v.empresa_id
`;

function activePortalWhere(alias = 'v') {
  return `
    ${alias}.status = 'ATIVA'
    AND COALESCE(${alias}.publicar_portal, TRUE) IS TRUE
    AND (data_encerramento IS NULL OR data_encerramento >= CURRENT_DATE)
  `;
}

async function listVacancies({ query = '', city = '', modality = '', page = 1, pageSize = 12 }) {
  const clauses = [activePortalWhere('v'), 'e.ativo IS TRUE', 'COALESCE(e.exibir_no_portal, TRUE) IS TRUE'];
  const values = [];

  if (query) {
    values.push(`%${query}%`);
    clauses.push(`(
      v.titulo ILIKE $${values.length}
      OR v.cargo ILIKE $${values.length}
      OR v.bairro ILIKE $${values.length}
      OR v.cidade ILIKE $${values.length}
      OR COALESCE(e.nome_publico, e.nome) ILIKE $${values.length}
    )`);
  }
  if (city) {
    values.push(city);
    clauses.push(`LOWER(v.cidade) = LOWER($${values.length})`);
  }
  if (modality) {
    values.push(modality);
    clauses.push(`LOWER(v.modalidade) = LOWER($${values.length})`);
  }

  const where = clauses.join('\n AND ');
  const offset = (page - 1) * pageSize;
  const countQuery = `SELECT COUNT(*)::INTEGER AS total FROM vagas v JOIN empresas e ON e.id = v.empresa_id WHERE ${where}`;
  const [countResult, rowsResult, citiesResult] = await Promise.all([
    pool.query(countQuery, values),
    pool.query(`${vacancySelect} WHERE ${where}
      ORDER BY v.destaque_portal DESC, COALESCE(v.portal_publicado_em, v.created_at) DESC, v.id DESC
      LIMIT ${pageSize} OFFSET ${offset}`, values),
    pool.query(`
      SELECT DISTINCT v.cidade
      FROM vagas v
      JOIN empresas e ON e.id = v.empresa_id
      WHERE ${activePortalWhere('v')}
        AND e.ativo IS TRUE
        AND NULLIF(BTRIM(v.cidade), '') IS NOT NULL
      ORDER BY v.cidade ASC
    `),
  ]);

  return {
    total: countResult.rows[0]?.total || 0,
    vacancies: rowsResult.rows,
    cities: citiesResult.rows.map((row) => row.cidade),
  };
}

function vacancyCard(vacancy) {
  const salary = formatMoney(vacancy.salario);
  const gains = approximateMonthlyGains(vacancy);
  const gainsText = gains.total > 0 ? formatMoney(gains.total) : '';
  return `<a class="job-card" href="/vagas/${escapeHtml(vacancySlug(vacancy))}" data-track="ABRIR_VAGA" data-track-label="${escapeHtml(vacancy.titulo)}">
    <div class="job-card-image">
      <img src="${escapeHtml(imageForVacancy(vacancy))}" alt="" loading="lazy" width="270" height="220">
      ${vacancy.destaque_portal ? '<span class="job-badge">Destaque</span>' : ''}
    </div>
    <div>
      <h3>${escapeHtml(vacancy.titulo || vacancy.cargo)}</h3>
      <p class="job-company">${escapeHtml(vacancy.empresa_nome)}</p>
      <div class="job-meta">
        <span class="meta-chip">📍 ${escapeHtml(locationText(vacancy))}</span>
        ${vacancy.modalidade ? `<span class="meta-chip">◉ ${escapeHtml(vacancy.modalidade)}</span>` : ''}
        ${vacancy.escala ? `<span class="meta-chip">◷ ${escapeHtml(vacancy.escala)}</span>` : ''}
        ${vacancy.aceita_sem_experiencia ? '<span class="meta-chip">Sem experiência</span>' : ''}
      </div>
    </div>
    <div class="job-card-action">
      <strong>${salary || 'Salário a combinar'}</strong>
      ${gainsText && gains.total > gains.salary ? `<small>Ganhos aprox. ${escapeHtml(gainsText)}</small>` : ''}
      <span>Ver oportunidade →</span>
    </div>
  </a>`;
}

async function vacanciesPage(req, res, next) {
  try {
    const query = String(req.query.q || '').trim().slice(0, 120);
    const city = String(req.query.cidade || '').trim().slice(0, 120);
    const modality = String(req.query.modalidade || '').trim().slice(0, 50);
    const page = Math.max(1, Number.parseInt(req.query.pagina, 10) || 1);
    const pageSize = 12;
    const result = await listVacancies({ query, city, modality, page, pageSize });
    const totalPages = Math.max(1, Math.ceil(result.total / pageSize));
    const safePage = Math.min(page, totalPages);

    if (safePage !== page && result.total > 0) {
      const redirect = new URL(`${SITE_URL}/vagas`);
      for (const [key, value] of Object.entries(req.query)) redirect.searchParams.set(key, String(value));
      redirect.searchParams.set('pagina', String(safePage));
      return res.redirect(302, `${redirect.pathname}${redirect.search}`);
    }

    const queryBase = new URLSearchParams();
    if (query) queryBase.set('q', query);
    if (city) queryBase.set('cidade', city);
    if (modality) queryBase.set('modalidade', modality);

    let pagination = '';
    if (totalPages > 1) {
      const pages = [];
      for (let number = 1; number <= totalPages; number += 1) {
        if (number > 1 && number < totalPages && Math.abs(number - safePage) > 2) continue;
        const params = new URLSearchParams(queryBase);
        params.set('pagina', String(number));
        pages.push(number === safePage
          ? `<span class="active">${number}</span>`
          : `<a href="/vagas?${params.toString()}">${number}</a>`);
      }
      pagination = `<nav class="pagination" aria-label="Paginação">${pages.join('')}</nav>`;
    }

    const cards = result.vacancies.length
      ? result.vacancies.map(vacancyCard).join('')
      : `<div class="empty-state"><h3>Nenhuma vaga encontrada</h3><p>Tente remover algum filtro ou acompanhe as próximas oportunidades no grupo.</p><a class="btn btn-primary" href="/grupo" data-track="CTA_SEM_RESULTADO_GRUPO">Entrar no grupo de vagas</a></div>`;

    const content = `${header({ light: true })}
      <main id="conteudo">
        <section class="portal-hero">
          <div class="container">
            <span class="eyebrow">Oportunidades atualizadas</span>
            <h1>Seu próximo trabalho pode começar aqui.</h1>
            <p>Pesquise por cargo ou local, veja todos os detalhes e inicie a candidatura pelo WhatsApp sem preencher cadastros intermináveis.</p>
            <form class="search-shell" action="/vagas" method="get" data-search-form>
              <input type="search" name="q" value="${escapeHtml(query)}" placeholder="Cargo, bairro ou empresa" aria-label="Pesquisar vagas">
              <select name="cidade" aria-label="Filtrar por cidade">
                <option value="">Todas as cidades</option>
                ${result.cities.map((item) => `<option value="${escapeHtml(item)}" ${item.toLowerCase() === city.toLowerCase() ? 'selected' : ''}>${escapeHtml(item)}</option>`).join('')}
              </select>
              <button class="btn btn-accent" type="submit">Buscar vagas</button>
            </form>
          </div>
        </section>
        <section class="portal-main">
          <div class="container portal-layout">
            <div>
              <div class="results-head"><h2>${result.total} ${result.total === 1 ? 'oportunidade encontrada' : 'oportunidades encontradas'}</h2><span>Vagas ativas no painel Genesis IA</span></div>
              <div class="job-list">${cards}</div>
              ${pagination}
            </div>
            <aside class="portal-sidebar">
              <article class="sidebar-card primary"><h3>Receba novas vagas</h3><p>Entre no grupo e acompanhe oportunidades assim que forem divulgadas.</p><a class="btn btn-accent btn-block" href="/grupo" data-track="CTA_LISTA_GRUPO">Entrar no grupo</a></article>
              <article class="sidebar-card"><h3>Sua empresa está contratando?</h3><p>Conte sobre a necessidade. A equipe avalia a vaga e apresenta as soluções da Genesis IA.</p><a class="btn btn-primary btn-block" href="/anunciar-vaga" data-track="CTA_LISTA_EMPRESA">Anunciar uma vaga</a></article>
            </aside>
          </div>
        </section>
      </main>
      ${footer()}`;

    return res.send(metaPage({
      title: query ? `Vagas para ${query}` : 'Portal de vagas',
      description: 'Encontre vagas abertas, confira salário, horário, benefícios e fale diretamente pelo WhatsApp para iniciar sua candidatura.',
      canonical: `${SITE_URL}/vagas`,
      image: `${SITE_URL}/assets/og-default.svg`,
      bodyClass: 'light-page',
      robots: (query || city || modality || safePage > 1) ? 'noindex,follow' : 'index,follow,max-image-preview:large',
      content,
      nonce: res.locals.cspNonce,
      structuredData: [organizationSchema(), {
        '@context': 'https://schema.org',
        '@type': 'CollectionPage',
        name: 'Portal de vagas Genesis IA',
        url: `${SITE_URL}/vagas`,
      }],
    }));
  } catch (error) {
    next(error);
  }
}

async function findVacancyById(id) {
  const result = await pool.query(`${vacancySelect}
    WHERE v.id = $1
      AND COALESCE(v.publicar_portal, TRUE) IS TRUE
      AND e.ativo IS TRUE
      AND COALESCE(e.exibir_no_portal, TRUE) IS TRUE
    LIMIT 1`, [id]);
  return result.rows[0] || null;
}

async function relatedVacancies(vacancy) {
  const result = await pool.query(`${vacancySelect}
    WHERE ${activePortalWhere('v')}
      AND e.ativo IS TRUE
      AND v.id <> $1
    ORDER BY
      CASE WHEN LOWER(v.cargo) = LOWER($2) THEN 0 ELSE 1 END,
      CASE WHEN LOWER(COALESCE(v.cidade, '')) = LOWER(COALESCE($3, '')) THEN 0 ELSE 1 END,
      CASE WHEN v.empresa_id = $4 THEN 0 ELSE 1 END,
      v.updated_at DESC
    LIMIT 4`, [vacancy.id, vacancy.cargo || vacancy.titulo, vacancy.cidade, vacancy.empresa_id]);
  return result.rows;
}

function jobDescriptionHtml(vacancy) {
  const parts = [];
  parts.push(`<p>${escapeHtml(vacancy.descricao || `Oportunidade para ${vacancy.titulo || vacancy.cargo}.`)}</p>`);
  if (vacancy.horario) parts.push(`<p><strong>Horário:</strong> ${escapeHtml(vacancy.horario)}</p>`);
  if (vacancy.escala) parts.push(`<p><strong>Escala:</strong> ${escapeHtml(vacancy.escala)}</p>`);
  const requirements = splitList(vacancy.requisitos_obrigatorios);
  if (requirements.length) parts.push(`<p><strong>Requisitos:</strong> ${escapeHtml(requirements.join('; '))}</p>`);
  const benefits = splitList(vacancy.beneficios);
  const structured = structuredBenefits(vacancy);
  const gains = approximateMonthlyGains(vacancy);
  if (benefits.length) parts.push(`<p><strong>Benefícios:</strong> ${escapeHtml(benefits.join('; '))}</p>`);
  if (structured.length) parts.push(`<p><strong>Benefícios com valores:</strong> ${structured.map((item) => item.value ? `${item.label}: ${formatMoney(item.value)}` : `${item.label}: ${item.description}`).map(escapeHtml).join('; ')}</p>`);
  if (gains.total > 0) parts.push(`<p><strong>Ganhos mensais aproximados:</strong> ${escapeHtml(formatMoney(gains.total))}, sem incluir vale-transporte.</p>`);
  if (vacancy.possui_insalubridade) {
    parts.push(`<p><strong>Insalubridade:</strong> adicional de ${escapeHtml(vacancy.percentual_insalubridade || '')}%${vacancy.observacao_insalubridade ? ` — ${escapeHtml(vacancy.observacao_insalubridade)}` : ''}.</p>`);
  }
  return parts.join('');
}

function jobPostingSchema(vacancy, application) {
  const schema = {
    '@context': 'https://schema.org',
    '@type': 'JobPosting',
    title: vacancy.titulo || vacancy.cargo,
    description: jobDescriptionHtml(vacancy),
    identifier: {
      '@type': 'PropertyValue',
      name: vacancy.empresa_nome,
      value: vacancy.codigo,
    },
    datePosted: isoDate(vacancy.portal_publicado_em || vacancy.created_at),
    employmentType: employmentType(vacancy.tipo_contrato),
    hiringOrganization: {
      '@type': 'Organization',
      name: vacancy.empresa_nome,
      sameAs: vacancy.empresa_site_url || undefined,
      logo: vacancy.empresa_logo_url || ORGANIZATION_LOGO_URL,
    },
    jobLocation: {
      '@type': 'Place',
      address: {
        '@type': 'PostalAddress',
        streetAddress: vacancy.endereco_referencia || undefined,
        addressLocality: vacancy.cidade || undefined,
        addressRegion: vacancy.estado || DEFAULT_STATE,
        addressCountry: 'BR',
      },
    },
    directApply: ['whatsapp', 'external', 'email'].includes(application.type),
    totalJobOpenings: Number(vacancy.quantidade_vagas || 1),
    url: vacancyUrl(vacancy),
  };

  if (vacancy.data_encerramento) {
    schema.validThrough = `${vacancy.data_encerramento}T23:59:59-03:00`;
  }
  if (vacancy.salario !== null && vacancy.salario !== undefined && Number.isFinite(Number(vacancy.salario))) {
    schema.baseSalary = {
      '@type': 'MonetaryAmount',
      currency: 'BRL',
      value: {
        '@type': 'QuantitativeValue',
        value: Number(vacancy.salario),
        unitText: 'MONTH',
      },
    };
  }
  if (String(vacancy.modalidade || '').toLowerCase().includes('remot')) {
    schema.jobLocationType = 'TELECOMMUTE';
  }
  if (Number(vacancy.experiencia_minima_meses) > 0) {
    schema.experienceRequirements = {
      '@type': 'OccupationalExperienceRequirements',
      monthsOfExperience: Number(vacancy.experiencia_minima_meses),
    };
  }
  return schema;
}

function listBlock(items, fallback = 'Informados durante o processo seletivo.') {
  if (!items.length) return `<p>${escapeHtml(fallback)}</p>`;
  return `<ul class="text-list">${items.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>`;
}

async function vacancyDetailPage(req, res, next) {
  try {
    const id = Number.parseInt(String(req.params.slug || '').split('-', 1)[0], 10);
    if (!Number.isInteger(id) || id <= 0) return res.status(404).send(notFoundPage(res));
    const vacancy = await findVacancyById(id);
    if (!vacancy) return res.status(404).send(notFoundPage(res));

    const canonicalPath = `/vagas/${vacancySlug(vacancy)}`;
    if (req.path !== canonicalPath) return res.redirect(301, canonicalPath);

    const expired = vacancy.status !== 'ATIVA'
      || (vacancy.data_encerramento && new Date(`${vacancy.data_encerramento}T23:59:59-03:00`).getTime() < Date.now());
    if (expired) return res.status(410).send(expiredPage(vacancy, res));

    const [related, groupUrl] = await Promise.all([
      relatedVacancies(vacancy),
      getGroupInviteUrl().catch(() => WHATSAPP_GROUP_URL),
    ]);
    const application = candidateApplication(vacancy);
    const qrDataUrl = await QRCode.toDataURL(application.url, {
      width: 360,
      margin: 1,
      errorCorrectionLevel: 'M',
    });
    const salary = formatMoney(vacancy.salario);
    const gains = approximateMonthlyGains(vacancy);
    const gainsText = gains.total > 0 ? formatMoney(gains.total) : '';
    const structured = structuredBenefits(vacancy);
    const benefits = splitList(vacancy.beneficios);
    const required = splitList(vacancy.requisitos_obrigatorios);
    const desired = splitList(vacancy.requisitos_desejaveis);
    const contentImage = imageForVacancy(vacancy);
    const description = vacancy.seo_descricao
      || truncate(`${vacancy.titulo} em ${locationText(vacancy)}. ${vacancy.descricao || ''} ${salary ? `Salário ${salary}.` : ''}`, 158);
    const title = vacancy.seo_titulo || `${vacancy.titulo} em ${vacancy.bairro || vacancy.cidade || vacancy.estado}`;

    const relatedHtml = related.length
      ? related.map((item) => `<a class="related-card" href="/vagas/${escapeHtml(vacancySlug(item))}" data-track="VAGA_RELACIONADA"><h3>${escapeHtml(item.titulo)}</h3><p>${escapeHtml(locationText(item))} · ${escapeHtml(item.empresa_nome)}</p><span>Ver vaga →</span></a>`).join('')
      : '<p>Novas oportunidades serão exibidas aqui assim que forem publicadas.</p>';

    const groupButton = groupUrl
      ? `<a class="btn btn-ghost btn-block" href="/grupo" data-track="CTA_VAGA_GRUPO">Entrar no grupo de vagas</a>`
      : '';

    const content = `${header({ light: true })}
      <main id="conteudo">
        <section class="job-detail-hero">
          <div class="container">
            <nav class="breadcrumbs" aria-label="Breadcrumb"><a href="/">Início</a><span>›</span><a href="/vagas">Vagas</a><span>›</span><span>${escapeHtml(vacancy.titulo)}</span></nav>
            <div class="job-title-grid">
              <div><span class="eyebrow">Vaga aberta · Código ${escapeHtml(vacancy.codigo)}</span><h1>${escapeHtml(vacancy.titulo)}</h1><p>${escapeHtml(vacancy.empresa_nome)} · ${escapeHtml(locationText(vacancy))}</p></div>
              <a class="btn btn-accent btn-lg" href="${escapeHtml(application.url)}" target="${application.type === 'whatsapp' || application.type === 'external' ? '_blank' : '_self'}" rel="noopener" data-track="CTA_HERO_CANDIDATURA">${escapeHtml(application.label)}</a>
            </div>
          </div>
        </section>
        <section class="job-detail-main">
          <div class="container job-detail-layout">
            <div class="job-content">
              <article class="content-card">
                <h2>Resumo da oportunidade</h2>
                <div class="detail-grid">
                  <div class="detail-item"><span>Empresa</span><strong>${escapeHtml(vacancy.empresa_nome)}</strong></div>
                  <div class="detail-item"><span>Local</span><strong>${escapeHtml(locationText(vacancy))}</strong></div>
                  <div class="detail-item"><span>Salário</span><strong>${escapeHtml(salary || 'A combinar')}</strong></div>
                  <div class="detail-item gains-highlight"><span>Ganhos aproximados</span><strong>${escapeHtml(gainsText || 'A confirmar')}</strong><small>VT não incluído</small></div>
                  <div class="detail-item"><span>Contrato</span><strong>${escapeHtml(vacancy.tipo_contrato || 'A confirmar')}</strong></div>
                  <div class="detail-item"><span>Escala</span><strong>${escapeHtml(vacancy.escala || 'A confirmar')}</strong></div>
                  <div class="detail-item"><span>Horário</span><strong>${escapeHtml(vacancy.horario || 'A confirmar')}</strong></div>
                  <div class="detail-item"><span>Modalidade</span><strong>${escapeHtml(vacancy.modalidade || 'Presencial')}</strong></div>
                  <div class="detail-item"><span>Quantidade</span><strong>${escapeHtml(vacancy.quantidade_vagas || 1)} ${Number(vacancy.quantidade_vagas || 1) === 1 ? 'vaga' : 'vagas'}</strong></div>
                </div>
              </article>

              <article class="content-card"><h2>Sobre a vaga</h2><p>${escapeHtml(vacancy.descricao || 'Os detalhes completos serão apresentados durante o processo seletivo.')}</p></article>
              <article class="content-card"><h2>Benefícios</h2>${structured.length ? `<div class="benefit-value-grid">${structured.map((item) => `<div><span>${escapeHtml(item.label)}</span><strong>${escapeHtml(item.value ? formatMoney(item.value) : item.description)}</strong>${item.includeInTotal ? '<small>Incluído nos ganhos aproximados</small>' : '<small>Não incluído no cálculo</small>'}</div>`).join('')}</div>` : ''}${listBlock(benefits)}${vacancy.beneficios_observacao ? `<p class="benefits-note">${escapeHtml(vacancy.beneficios_observacao)}</p>` : ''}</article>
              ${gainsText ? `<article class="content-card gains-card"><span>Estimativa mensal</span><h2>${escapeHtml(gainsText)}</h2><p>Salário + benefícios mensais com valor + adicional de insalubridade aproximado. O vale-transporte não entra no cálculo.</p></article>` : ''}
              <article class="content-card"><h2>Requisitos obrigatórios</h2>${listBlock(required, vacancy.aceita_sem_experiencia ? 'Esta vaga aceita candidatos sem experiência.' : 'Os requisitos serão confirmados durante o processo seletivo.')}</article>
              ${desired.length ? `<article class="content-card"><h2>Diferenciais</h2>${listBlock(desired)}</article>` : ''}
              ${vacancy.possui_insalubridade ? `<article class="content-card insalubrity-card"><h2>Adicional de insalubridade</h2><p><strong>${escapeHtml(vacancy.percentual_insalubridade || '')}% adicional</strong>${gains.unhealthyValue > 0 ? ` — aproximadamente ${escapeHtml(formatMoney(gains.unhealthyValue))}` : ''}${vacancy.observacao_insalubridade ? ` — ${escapeHtml(vacancy.observacao_insalubridade)}` : ''}.</p></article>` : ''}
              ${vacancy.empresa_descricao ? `<article class="content-card"><h2>Sobre a empresa contratante</h2><p>${escapeHtml(vacancy.empresa_descricao)}</p></article>` : ''}
              <article class="content-card"><h2>Outras vagas relacionadas</h2><div class="related-grid">${relatedHtml}</div></article>
            </div>

            <aside class="apply-card">
              <h2>Comece sua candidatura</h2>
              <p>Abra o WhatsApp com a vaga já identificada. No computador, escaneie o QR Code para continuar no celular.</p>
              <a class="btn btn-accent btn-block btn-lg" href="${escapeHtml(application.url)}" target="${application.type === 'whatsapp' || application.type === 'external' ? '_blank' : '_self'}" rel="noopener" data-track="CTA_LATERAL_CANDIDATURA">${escapeHtml(application.label)}</a>
              ${application.type === 'whatsapp' ? `<div class="apply-separator">ou use o celular</div><div class="qr-shell"><img src="${escapeHtml(qrDataUrl)}" alt="QR Code para abrir a candidatura no WhatsApp" width="176" height="176"><strong>Aponte a câmera do celular</strong></div>` : ''}
              ${groupButton}
              <p class="apply-safe">A candidatura é gratuita. Nunca faça pagamentos para participar de processos seletivos.</p>
            </aside>
          </div>
        </section>
        <div class="sticky-mobile-cta">
          <a class="btn btn-accent" href="${escapeHtml(application.url)}" target="${application.type === 'whatsapp' || application.type === 'external' ? '_blank' : '_self'}" rel="noopener" data-track="CTA_MOBILE_CANDIDATURA">Candidatar-se</a>
          ${groupUrl ? '<a class="btn btn-ghost" href="/grupo" data-track="CTA_MOBILE_GRUPO">Grupo</a>' : ''}
        </div>
      </main>
      ${footer()}`;

    return res.send(metaPage({
      title,
      description,
      vacancyId: vacancy.id,
      canonical: vacancyUrl(vacancy),
      image: contentImage,
      bodyClass: 'light-page job-detail-page',
      content,
      nonce: res.locals.cspNonce,
      structuredData: [
        organizationSchema(),
        jobPostingSchema(vacancy, application),
        {
          '@context': 'https://schema.org',
          '@type': 'BreadcrumbList',
          itemListElement: [
            { '@type': 'ListItem', position: 1, name: 'Início', item: SITE_URL },
            { '@type': 'ListItem', position: 2, name: 'Vagas', item: `${SITE_URL}/vagas` },
            { '@type': 'ListItem', position: 3, name: vacancy.titulo, item: vacancyUrl(vacancy) },
          ],
        },
      ],
    }));
  } catch (error) {
    next(error);
  }
}

const companyLeadSchema = z.object({
  empresa_nome: z.string().trim().min(2).max(180),
  cnpj: z.string().trim().max(30).optional().default(''),
  contato_nome: z.string().trim().min(2).max(160),
  email: z.string().trim().email().max(200),
  whatsapp: z.string().trim().min(8).max(40),
  cidade: z.string().trim().max(120).optional().default(''),
  estado: z.string().trim().max(2).optional().default(DEFAULT_STATE),
  quantidade_vagas: z.coerce.number().int().min(1).max(10000).optional().default(1),
  cargos_interesse: z.string().trim().min(2).max(2000),
  mensagem: z.string().trim().max(4000).optional().default(''),
  website: z.string().trim().max(200).optional().default(''),
  utm_source: z.string().trim().max(160).optional().default(''),
  utm_medium: z.string().trim().max(160).optional().default(''),
  utm_campaign: z.string().trim().max(200).optional().default(''),
});

function companyLeadPage(req, res, { errors = [], values = {} } = {}) {
  const sent = req.query.enviado === '1';
  const errorHtml = errors.length
    ? `<div class="success-box" style="border-color:#f4aaaa;background:#fff1f1;color:#9f2424"><strong>Revise os campos:</strong><br>${errors.map(escapeHtml).join('<br>')}</div>`
    : '';
  const content = `${header({ light: true })}
    <main id="conteudo">
      <section class="lead-hero">
        <div class="container lead-hero-grid">
          <div><span class="eyebrow">Empresas que precisam contratar</span><h1>Sua vaga merece mais do que uma publicação.</h1><p>Conte sobre a necessidade. A Genesis IA avalia o cenário e mostra como atrair, qualificar e organizar candidatos com tecnologia e atendimento.</p></div>
          <div class="lead-scorecard"><strong>1 formulário</strong><span>para iniciar uma conversa comercial, sem publicar automaticamente a vaga e sem enviá-la ao chatbot antes da aprovação.</span></div>
        </div>
      </section>
      <section class="lead-main">
        <div class="container lead-layout">
          <aside class="lead-benefits"><h2>O que sua empresa pode receber</h2><ul class="check-list"><li>Página profissional para a vaga</li><li>Captação via WhatsApp e QR Code</li><li>Triagem automatizada</li><li>Banco de talentos e grupo de vagas</li><li>Painel com candidatos e entrevistas</li><li>Divulgação e acompanhamento do funil</li></ul><a class="btn btn-accent btn-block" href="${escapeHtml(commercialWhatsAppUrl())}" target="_blank" rel="noopener" data-track="CTA_FORM_COMERCIAL">Falar agora pelo WhatsApp</a></aside>
          <form class="lead-form" method="post" action="/api/public/empresas/interesse" data-track-form="empresa">
            ${sent ? '<div class="success-box"><strong>Recebemos seu interesse.</strong><br>A equipe da Genesis IA poderá entrar em contato para entender a necessidade.</div>' : ''}
            ${errorHtml}
            <h2>Conte sobre sua contratação</h2>
            <p style="color:#64748b;line-height:1.65">Esses dados entram no funil comercial. Nenhuma vaga é publicada automaticamente.</p>
            <div class="form-grid">
              <div class="field"><label for="empresa_nome">Empresa *</label><input id="empresa_nome" name="empresa_nome" required maxlength="180" value="${escapeHtml(values.empresa_nome || '')}"></div>
              <div class="field"><label for="cnpj">CNPJ</label><input id="cnpj" name="cnpj" maxlength="30" value="${escapeHtml(values.cnpj || '')}"></div>
              <div class="field"><label for="contato_nome">Seu nome *</label><input id="contato_nome" name="contato_nome" required maxlength="160" value="${escapeHtml(values.contato_nome || '')}"></div>
              <div class="field"><label for="whatsapp">WhatsApp *</label><input id="whatsapp" name="whatsapp" required maxlength="40" inputmode="tel" value="${escapeHtml(values.whatsapp || '')}"></div>
              <div class="field"><label for="email">E-mail corporativo *</label><input id="email" name="email" required type="email" maxlength="200" value="${escapeHtml(values.email || '')}"></div>
              <div class="field"><label for="quantidade_vagas">Quantidade aproximada</label><input id="quantidade_vagas" name="quantidade_vagas" type="number" min="1" max="10000" value="${escapeHtml(values.quantidade_vagas || '1')}"></div>
              <div class="field"><label for="cidade">Cidade</label><input id="cidade" name="cidade" maxlength="120" value="${escapeHtml(values.cidade || '')}"></div>
              <div class="field"><label for="estado">Estado</label><input id="estado" name="estado" maxlength="2" value="${escapeHtml(values.estado || DEFAULT_STATE)}"></div>
              <div class="field full"><label for="cargos_interesse">Quais cargos precisa contratar? *</label><textarea id="cargos_interesse" name="cargos_interesse" required maxlength="2000" placeholder="Ex.: auxiliares de limpeza, porteiros e encarregados">${escapeHtml(values.cargos_interesse || '')}</textarea></div>
              <div class="field full"><label for="mensagem">Contexto da operação</label><textarea id="mensagem" name="mensagem" maxlength="4000" placeholder="Prazo, região, volume, dificuldades atuais...">${escapeHtml(values.mensagem || '')}</textarea></div>
              <div class="honeypot" aria-hidden="true"><label for="website">Site</label><input id="website" name="website" tabindex="-1" autocomplete="off"></div>
              <input type="hidden" name="utm_source" value="${escapeHtml(req.query.utm_source || values.utm_source || '')}">
              <input type="hidden" name="utm_medium" value="${escapeHtml(req.query.utm_medium || values.utm_medium || '')}">
              <input type="hidden" name="utm_campaign" value="${escapeHtml(req.query.utm_campaign || values.utm_campaign || '')}">
              <div class="field full"><button class="btn btn-primary btn-lg btn-block" type="submit" data-track="ENVIAR_LEAD_EMPRESA">Solicitar contato da Genesis IA</button><p class="form-note">Ao enviar, você autoriza o contato da equipe sobre recrutamento e divulgação de vagas.</p></div>
            </div>
          </form>
        </div>
      </section>
    </main>
    ${footer()}`;

  return metaPage({
    title: 'Anuncie vagas e atraia candidatos',
    description: 'Cadastre o interesse da sua empresa em divulgar vagas e conhecer soluções de captação, triagem e gestão de candidatos.',
    canonical: `${SITE_URL}/anunciar-vaga`,
    image: `${SITE_URL}/assets/og-default.svg`,
    bodyClass: 'light-page',
    content,
    nonce: res.locals.cspNonce,
    structuredData: [organizationSchema()],
  });
}

let groupCache = { url: '', expiresAt: 0 };
async function getGroupInviteUrl() {
  if (groupCache.url && groupCache.expiresAt > Date.now()) return groupCache.url;
  let url = WHATSAPP_GROUP_URL;
  if (WAHA_BASE_URL && WAHA_GROUP_ID && WAHA_SESSION) {
    const endpoint = `${WAHA_BASE_URL}/api/${encodeURIComponent(WAHA_SESSION)}/groups/${encodeURIComponent(WAHA_GROUP_ID)}/invite-code`;
    const response = await fetch(endpoint, {
      headers: {
        Accept: 'application/json',
        ...(WAHA_API_KEY ? { 'X-Api-Key': WAHA_API_KEY } : {}),
      },
      signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) throw new Error(`WAHA retornou HTTP ${response.status} ao consultar o convite.`);
    const body = await response.json().catch(() => ({}));
    const code = typeof body === 'string'
      ? body
      : body.inviteCode || body.invite_code || body.code || body.data?.inviteCode || body.data?.code;
    if (code) url = `https://chat.whatsapp.com/${String(code).replace(/^.*chat\.whatsapp\.com\//, '')}`;
  }
  groupCache = { url, expiresAt: Date.now() + 10 * 60 * 1000 };
  return url;
}

function expiredPage(vacancy, res) {
  const content = `${header({ light: true })}<main id="conteudo" class="container"><section class="expired-box"><span class="eyebrow">Oportunidade encerrada</span><h1>Esta vaga não está mais disponível.</h1><p>A vaga ${escapeHtml(vacancy.titulo)} foi encerrada, mas há outras oportunidades que podem combinar com seu perfil.</p><div class="hero-actions" style="justify-content:center"><a class="btn btn-primary btn-lg" href="/vagas">Ver vagas abertas</a><a class="btn btn-ghost btn-lg" href="/grupo">Entrar no grupo</a></div></section></main>${footer()}`;
  return metaPage({
    title: 'Vaga encerrada',
    description: 'Esta vaga foi encerrada. Consulte as oportunidades abertas no Portal Genesis IA.',
    canonical: vacancyUrl(vacancy),
    image: `${SITE_URL}/assets/og-default.svg`,
    bodyClass: 'light-page',
    content,
    nonce: res.locals.cspNonce,
    structuredData: [organizationSchema()],
  });
}

function notFoundPage(res) {
  const content = `${header({ light: true })}<main id="conteudo" class="container"><section class="expired-box"><span class="eyebrow">Página não encontrada</span><h1>Esta oportunidade não foi localizada.</h1><p>Ela pode ter sido removida ou o endereço pode estar incorreto.</p><a class="btn btn-primary btn-lg" href="/vagas">Ver vagas abertas</a></section></main>${footer()}`;
  return metaPage({
    title: 'Página não encontrada',
    description: 'Consulte as vagas abertas no Portal Genesis IA.',
    canonical: `${SITE_URL}/404`,
    image: `${SITE_URL}/assets/og-default.svg`,
    bodyClass: 'light-page',
    content,
    nonce: res.locals.cspNonce,
    structuredData: [organizationSchema()],
  });
}

function hashIp(req) {
  const ip = String(req.ip || req.headers['x-forwarded-for'] || '');
  return crypto.createHmac('sha256', PORTAL_ANALYTICS_SECRET).update(ip).digest('hex');
}

app.get('/health/live', (_req, res) => {
  res.json({ status: 'ok', portal: 'genesis-ia-nova-fase-v1' });
});

app.get('/health', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok', portal: 'genesis-ia-nova-fase-v1', banco: 'disponível' });
  } catch (error) {
    console.error('Health check do PostgreSQL:', error);
    res.status(503).json({
      status: 'erro',
      portal: 'genesis-ia-nova-fase-v1',
      banco: 'indisponível',
      codigo: String(error?.code || ''),
    });
  }
});

app.get('/', landingPage);
app.get('/vagas', vacanciesPage);
app.get('/vagas/:slug', vacancyDetailPage);
app.get('/anunciar-vaga', (req, res) => res.send(companyLeadPage(req, res)));

app.get('/login', (_req, res) => {
  if (!PANEL_URL) return res.redirect(302, '/');
  return res.redirect(302, `${PANEL_URL}/login`);
});
app.get('/painel', (_req, res) => {
  if (!PANEL_URL) return res.redirect(302, '/');
  return res.redirect(302, `${PANEL_URL}/login`);
});

app.get('/grupo', async (_req, res) => {
  try {
    const url = await getGroupInviteUrl();
    if (!url) return res.redirect(302, '/vagas');
    return res.redirect(302, url);
  } catch (error) {
    console.error('Falha ao obter convite do grupo:', error);
    if (WHATSAPP_GROUP_URL) return res.redirect(302, WHATSAPP_GROUP_URL);
    return res.redirect(302, '/vagas');
  }
});

app.post('/api/public/empresas/interesse', companyLeadLimiter, async (req, res, next) => {
  try {
    const parsed = companyLeadSchema.safeParse(req.body);
    if (!parsed.success) {
      const errors = parsed.error.issues.map((issue) => issue.message);
      return res.status(400).send(companyLeadPage(req, res, { errors, values: req.body }));
    }
    if (parsed.data.website) return res.redirect(303, '/anunciar-vaga?enviado=1');

    const inserted = await pool.query(`
      INSERT INTO portal_leads_empresas (
        empresa_nome, cnpj, contato_nome, email, whatsapp, cidade, estado,
        quantidade_vagas, cargos_interesse, mensagem, origem,
        utm_source, utm_medium, utm_campaign, created_at, updated_at
      ) VALUES (
        $1, NULLIF($2, ''), $3, $4, $5, NULLIF($6, ''), NULLIF(UPPER($7), ''),
        $8, $9, NULLIF($10, ''), 'PORTAL_EMPRESAS',
        NULLIF($11, ''), NULLIF($12, ''), NULLIF($13, ''), NOW(), NOW()
      )
      RETURNING id, empresa_nome, contato_nome, email, whatsapp, cidade, estado, quantidade_vagas, cargos_interesse, mensagem, created_at
    `, [
      parsed.data.empresa_nome,
      parsed.data.cnpj,
      parsed.data.contato_nome,
      parsed.data.email.toLowerCase(),
      parsed.data.whatsapp,
      parsed.data.cidade,
      parsed.data.estado,
      parsed.data.quantidade_vagas,
      parsed.data.cargos_interesse,
      parsed.data.mensagem,
      parsed.data.utm_source,
      parsed.data.utm_medium,
      parsed.data.utm_campaign,
    ]);

    void notifyCompanyLead(inserted.rows[0]);
    return res.redirect(303, '/anunciar-vaga?enviado=1');
  } catch (error) {
    next(error);
  }
});

app.post('/api/public/eventos', async (req, res) => {
  try {
    const event = String(req.body?.evento || '').trim().slice(0, 60);
    if (!event) return res.status(204).end();
    const vacancyId = Number(req.body?.vaga_id);
    await pool.query(`
      INSERT INTO portal_eventos (
        vaga_id, evento, sessao_id, pagina, origem, meio, campanha,
        metadata, ip_hash, user_agent, created_at
      ) VALUES (
        $1, $2, NULLIF($3, ''), NULLIF($4, ''), NULLIF($5, ''),
        NULLIF($6, ''), NULLIF($7, ''), $8::JSONB, $9, $10, NOW()
      )
    `, [
      Number.isInteger(vacancyId) && vacancyId > 0 ? vacancyId : null,
      event,
      String(req.body?.sessao_id || '').slice(0, 120),
      String(req.body?.pagina || '').slice(0, 1000),
      String(req.body?.source || req.body?.origem || '').slice(0, 1000),
      String(req.body?.medium || req.body?.meio || '').slice(0, 160),
      String(req.body?.campaign || req.body?.campanha || '').slice(0, 200),
      JSON.stringify(req.body?.metadata && typeof req.body.metadata === 'object' ? req.body.metadata : {}),
      hashIp(req),
      String(req.headers['user-agent'] || '').slice(0, 1000),
    ]);
    return res.status(204).end();
  } catch (error) {
    console.error('Falha ao registrar evento público:', error.message);
    return res.status(204).end();
  }
});

app.get('/api/public/vagas', async (req, res, next) => {
  try {
    const result = await listVacancies({
      query: String(req.query.q || '').trim().slice(0, 120),
      city: String(req.query.cidade || '').trim().slice(0, 120),
      modality: String(req.query.modalidade || '').trim().slice(0, 50),
      page: Math.max(1, Number.parseInt(req.query.pagina, 10) || 1),
      pageSize: Math.min(50, Math.max(1, Number.parseInt(req.query.limite, 10) || 20)),
    });
    return res.json({
      sucesso: true,
      total: result.total,
      vagas: result.vacancies.map((vacancy) => ({
        id: vacancy.id,
        codigo: vacancy.codigo,
        titulo: vacancy.titulo,
        empresa: vacancy.empresa_nome,
        cidade: vacancy.cidade,
        estado: vacancy.estado,
        bairro: vacancy.bairro,
        salario: vacancy.salario,
        ganhos_aproximados: approximateMonthlyGains(vacancy).total,
        vale_refeicao_valor: vacancy.vale_refeicao_valor,
        vale_alimentacao_valor: vacancy.vale_alimentacao_valor,
        premio_assiduidade_valor: vacancy.premio_assiduidade_valor,
        outros_beneficios_valor: vacancy.outros_beneficios_valor,
        vale_transporte_descricao: vacancy.vale_transporte_descricao,
        escala: vacancy.escala,
        horario: vacancy.horario,
        modalidade: vacancy.modalidade,
        url: vacancyUrl(vacancy),
      })),
    });
  } catch (error) {
    next(error);
  }
});

app.get('/robots.txt', (_req, res) => {
  res.type('text/plain').send(`User-agent: *\nAllow: /\nDisallow: /api/\nSitemap: ${SITE_URL}/sitemap.xml\n`);
});

app.get('/sitemap.xml', async (_req, res, next) => {
  try {
    const result = await pool.query(`${vacancySelect}
      WHERE ${activePortalWhere('v')}
        AND e.ativo IS TRUE
        AND COALESCE(e.exibir_no_portal, TRUE) IS TRUE
      ORDER BY v.updated_at DESC`);
    const staticPages = [
      { loc: SITE_URL, lastmod: new Date().toISOString(), priority: '1.0' },
      { loc: `${SITE_URL}/vagas`, lastmod: new Date().toISOString(), priority: '0.9' },
      { loc: `${SITE_URL}/anunciar-vaga`, lastmod: new Date().toISOString(), priority: '0.7' },
    ];
    const entries = [
      ...staticPages,
      ...result.rows.map((vacancy) => ({
        loc: vacancyUrl(vacancy),
        lastmod: isoDate(vacancy.updated_at || vacancy.portal_publicado_em || vacancy.created_at),
        priority: vacancy.destaque_portal ? '0.9' : '0.8',
      })),
    ];
    const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${entries.map((entry) => `  <url><loc>${escapeHtml(entry.loc)}</loc><lastmod>${escapeHtml(entry.lastmod)}</lastmod><changefreq>daily</changefreq><priority>${entry.priority}</priority></url>`).join('\n')}\n</urlset>`;
    res.type('application/xml').send(xml);
  } catch (error) {
    next(error);
  }
});

app.use((_req, res) => res.status(404).send(notFoundPage(res)));

app.use((error, _req, res, _next) => {
  console.error(error);
  const code = String(error?.code || '');
  if (['42P01', '42703'].includes(code)) {
    return res.status(500).send(`<!doctype html><meta charset="utf-8"><title>Migração necessária</title><style>body{font-family:system-ui;padding:40px;max-width:760px;margin:auto}code{background:#eee;padding:3px 7px;border-radius:6px}</style><h1>Estrutura do portal incompleta</h1><p>Execute o arquivo <code>07_GENESIS_IA_PORTAL_PUBLICO_VAGAS_SEO_LEADS.sql</code> no PostgreSQL e faça o redeploy.</p>`);
  }
  return res.status(500).send(`<!doctype html><meta charset="utf-8"><title>Erro interno</title><style>body{font-family:system-ui;padding:40px;max-width:760px;margin:auto}</style><h1>Não foi possível carregar esta página</h1><p>Consulte os logs do serviço no EasyPanel.</p>`);
});

let httpServer;

function start() {
  httpServer = app.listen(PORT, '0.0.0.0', () => {
    console.log(`Portal público Genesis IA — Nova Fase V1 iniciado em 0.0.0.0:${PORT}.`);
    console.log('[CONFIGURAÇÃO]', {
      nodeEnv: process.env.NODE_ENV || 'development',
      siteUrl: SITE_URL,
      pgHost: DATABASE_URL ? 'DATABASE_URL configurada' : PGHOST,
      pgPort: DATABASE_URL ? undefined : PGPORT,
      pgDatabase: DATABASE_URL ? undefined : PGDATABASE,
      pgUser: DATABASE_URL ? undefined : PGUSER,
      wahaConfigurado: Boolean(WAHA_BASE_URL && WAHA_GROUP_ID),
    });

    pool.query('SELECT 1')
      .then(() => console.log('PostgreSQL conectado com sucesso.'))
      .catch((error) => {
        console.error('Portal iniciado, mas o PostgreSQL ainda não está acessível:', {
          message: error?.message,
          code: error?.code,
          host: PGHOST,
          port: PGPORT,
          database: PGDATABASE,
        });
      });
  });

  httpServer.on('error', (error) => {
    console.error('Falha ao iniciar o servidor HTTP:', error);
    process.exit(1);
  });
}

async function shutdown(signal) {
  console.log(`${signal} recebido. Encerrando portal...`);
  if (httpServer) {
    await new Promise((resolve) => httpServer.close(resolve));
  }
  await pool.end();
  process.exit(0);
}

process.on('uncaughtException', (error) => {
  console.error('Exceção não tratada:', error);
});

process.on('unhandledRejection', (error) => {
  console.error('Promise rejeitada sem tratamento:', error);
});

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

start();
