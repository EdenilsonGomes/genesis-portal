'use strict';

const crypto = require('node:crypto');
const multer = require('multer');
const sharp = require('sharp');
const { rateLimit } = require('express-rate-limit');
const { z } = require('zod');
const { hashPassword } = require('./lib/security');
const { BRAZIL_STATES, BRAZIL_STATE_CODES } = require('./lib/brazil-locations');

const PORTAL_STATUS = new Set(['RASCUNHO', 'ATIVO', 'SUSPENSO']);
const JOB_STATUSES = new Set(['RASCUNHO', 'ATIVA', 'PAUSADA', 'ENCERRADA']);

function registerCompanyPortalRoutes({ app, pool, config, helpers }) {
  const {
    SITE_URL,
    AUTH_SECRET,
    SESSION_DAYS = 14,
    PORTAL_BRAND_NAME = 'Gênesis Vagas',
    COMMERCIAL_WHATSAPP_NUMBER = '',
  } = config;
  const {
    escapeHtml,
    slugify,
    metaPage,
    portalHeader,
    portalFooter,
    vacancyUrl,
    formatMoney,
    vacancyCard,
    genesisInteractiveDemoSection,
  } = helpers;

  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 6 * 1024 * 1024, files: 2, fields: 30 },
    fileFilter: (_req, file, cb) => {
      const allowed = ['image/jpeg', 'image/png', 'image/webp'].includes(file.mimetype);
      cb(allowed ? null : new Error('Envie imagens JPG, PNG ou WEBP.'), allowed);
    },
  });
  const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 18, standardHeaders: 'draft-8', legacyHeaders: false });
  const writeLimiter = rateLimit({ windowMs: 60 * 60 * 1000, limit: 45, standardHeaders: 'draft-8', legacyHeaders: false });

  const signupSchema = z.object({
    nome: z.string().trim().min(3, 'Informe seu nome.').max(160),
    empresa_nome: z.string().trim().min(2, 'Informe o nome da empresa.').max(180),
    email: z.string().trim().email('Informe um e-mail válido.').max(200),
    whatsapp: z.string().trim().min(10, 'Informe um WhatsApp válido.').max(30),
    senha: z.string().min(8, 'A senha precisa ter pelo menos 8 caracteres.').max(160),
    confirmar_senha: z.string().max(160),
    aceite_termos: z.string().optional().default(''),
    consentimento_comercial: z.string().optional().default(''),
    ref: z.string().trim().max(120).optional().default(''),
    website: z.string().optional().default(''),
  });
  const profileSchema = z.object({
    nome_publico: z.string().trim().min(2, 'Informe o nome público da empresa.').max(180),
    segmento: z.string().trim().min(2, 'Informe o segmento.').max(120),
    resumo: z.string().trim().min(40, 'Conte um pouco mais sobre a empresa.').max(1800),
    cidade: z.string().trim().min(2, 'Informe a cidade.').max(120),
    estado: z.preprocess((v) => String(v || '').trim().toUpperCase(), z.enum(BRAZIL_STATE_CODES, { message: 'Selecione um estado válido.' })),
    site_url: z.string().trim().max(1200).optional().default(''),
    instagram_url: z.string().trim().max(1200).optional().default(''),
    linkedin_url: z.string().trim().max(1200).optional().default(''),
    cnpj: z.string().trim().max(30).optional().default(''),
  });
  const identitySchema = z.object({
    cor_primaria: z.string().trim().regex(/^#[0-9a-fA-F]{6}$/, 'Escolha uma cor válida.'),
  });
  const jobSchema = z.object({
    titulo: z.string().trim().min(4, 'Informe o título da vaga.').max(150),
    cargo: z.string().trim().min(2, 'Informe o cargo.').max(150),
    descricao: z.string().trim().min(50, 'A descrição precisa ter pelo menos 50 caracteres.').max(6000),
    requisitos: z.string().trim().max(4000).optional().default(''),
    beneficios: z.string().trim().max(4000).optional().default(''),
    cidade: z.string().trim().min(2, 'Informe a cidade.').max(100),
    estado: z.preprocess((v) => String(v || '').trim().toUpperCase(), z.enum(BRAZIL_STATE_CODES, { message: 'Selecione um estado válido.' })),
    bairro: z.string().trim().max(100).optional().default(''),
    modalidade: z.enum(['Presencial', 'Híbrido', 'Remoto']).default('Presencial'),
    tipo_contrato: z.string().trim().max(50).optional().default(''),
    escala: z.string().trim().max(100).optional().default(''),
    horario: z.string().trim().max(150).optional().default(''),
    salario: z.string().trim().max(30).optional().default(''),
    quantidade_vagas: z.coerce.number().int().min(1).max(999).default(1),
    aceita_sem_experiencia: z.string().optional().default(''),
    candidatura_tipo: z.enum(['WHATSAPP', 'URL', 'EMAIL']).default('WHATSAPP'),
    candidatura_destino: z.string().trim().min(5, 'Informe onde o candidato deve se candidatar.').max(1200),
  });

  function cookies(req) {
    return String(req.headers.cookie || '').split(';').reduce((out, item) => {
      const i = item.indexOf('=');
      if (i < 0) return out;
      const key = item.slice(0, i).trim();
      const raw = item.slice(i + 1).trim();
      try { out[key] = decodeURIComponent(raw); } catch { out[key] = raw; }
      return out;
    }, {});
  }
  function hmac(value) { return crypto.createHmac('sha256', AUTH_SECRET).update(String(value || '')).digest('hex'); }
  function isSecure(req) {
    return req.secure || String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https' || SITE_URL.startsWith('https://');
  }
  function setCookie(req, res, name, value, { maxAge, httpOnly = true } = {}) {
    const parts = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'SameSite=Lax'];
    if (httpOnly) parts.push('HttpOnly');
    if (isSecure(req)) parts.push('Secure');
    if (Number.isFinite(maxAge)) parts.push(`Max-Age=${Math.max(0, Math.floor(maxAge))}`);
    res.append('Set-Cookie', parts.join('; '));
  }
  function csrf(req, res) {
    let token = String(cookies(req).genesis_portal_csrf || '');
    if (!/^[A-Za-z0-9_-]{30,120}$/.test(token)) {
      token = crypto.randomBytes(30).toString('base64url');
      setCookie(req, res, 'genesis_portal_csrf', token, { maxAge: 30 * 86400, httpOnly: false });
    }
    return token;
  }
  function assertCsrf(req) {
    const left = String(cookies(req).genesis_portal_csrf || '');
    const right = String(req.body?.csrf_token || '');
    if (!left || !right || left.length !== right.length || !crypto.timingSafeEqual(Buffer.from(left), Buffer.from(right))) {
      const error = new Error('O formulário expirou. Atualize a página e tente novamente.');
      error.statusCode = 403;
      throw error;
    }
  }
  async function currentAccount(req) {
    if (req.companyPortalAccount !== undefined) return req.companyPortalAccount;
    const token = cookies(req).genesis_portal_session;
    if (!token || token.length < 30) return (req.companyPortalAccount = null);
    const result = await pool.query(`SELECT c.id,c.tipo,c.nome,c.email,c.whatsapp,c.empresa_nome,c.cnpj,c.cidade,c.estado,c.status,c.lead_status,c.origem_ref,c.created_at FROM portal_sessoes s JOIN portal_contas c ON c.id=s.conta_id WHERE s.token_hash=$1 AND s.expires_at>NOW() AND c.status='ATIVA' LIMIT 1`, [hmac(token)]);
    req.companyPortalAccount = result.rows[0] || null;
    return req.companyPortalAccount;
  }
  async function createSession(req, res, accountId) {
    const token = crypto.randomBytes(36).toString('base64url');
    const seconds = SESSION_DAYS * 86400;
    await pool.query('DELETE FROM portal_sessoes WHERE expires_at<=NOW()');
    await pool.query(`INSERT INTO portal_sessoes(token_hash,conta_id,ip_hash,user_agent,expires_at) VALUES($1,$2,$3,$4,NOW()+($5::INTEGER*INTERVAL '1 second'))`, [hmac(token), accountId, hmac(String(req.ip || '')).slice(0, 128), String(req.headers['user-agent'] || '').slice(0, 1000), seconds]);
    setCookie(req, res, 'genesis_portal_session', token, { maxAge: seconds });
  }
  async function requireCompanyAccount(req, res, next) {
    try {
      const account = await currentAccount(req);
      if (!account) return res.redirect(303, `/entrar?retorno=${encodeURIComponent(req.originalUrl)}`);
      if (!['EMPRESA','RECRUTADOR'].includes(String(account.tipo || '').toUpperCase())) return res.status(403).send(simpleMessagePage(res, 'Portal de carreiras', 'Sua conta não possui permissão para administrar um portal de empresa.', '/minha-conta', 'Voltar para minha conta'));
      return next();
    } catch (error) { return next(error); }
  }
  function checkbox(value) { return ['on', 'true', '1', 'sim'].includes(String(value || '').toLowerCase()); }
  function digits(value) { return String(value || '').replace(/\D+/g, ''); }
  function cleanUrl(value) {
    const raw = String(value || '').trim();
    if (!raw) return '';
    try {
      const url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
      if (!['http:', 'https:'].includes(url.protocol)) return '';
      return url.toString();
    } catch { return ''; }
  }
  function fieldErrors(issues) {
    const out = {};
    for (const issue of issues || []) {
      const key = String(issue.path?.[0] || 'geral');
      if (!out[key]) out[key] = issue.message;
    }
    return out;
  }
  function errorText(errors, key) { return errors[key] ? `<small class="field-error">${escapeHtml(errors[key])}</small>` : ''; }
  function stateOptions(selected = 'SP') {
    return BRAZIL_STATES.map((state) => `<option value="${state.code}" ${state.code === String(selected || '').toUpperCase() ? 'selected' : ''}>${escapeHtml(state.name)}</option>`).join('');
  }
  function companyBrandStyle(portal) {
    const color = /^#[0-9a-f]{6}$/i.test(String(portal?.cor_primaria || '')) ? portal.cor_primaria : '#0EAEA0';
    return `--company-brand:${escapeHtml(color)};--company-brand-soft:${escapeHtml(color)}18;`;
  }
  async function uniqueSlug(name) {
    const base = slugify(name).slice(0, 140) || 'empresa';
    for (let index = 0; index < 40; index += 1) {
      const candidate = index ? `${base}-${index + 1}` : base;
      const exists = await pool.query('SELECT 1 FROM portal_empresas WHERE slug=$1 LIMIT 1', [candidate]);
      if (!exists.rowCount) return candidate;
    }
    return `${base}-${crypto.randomBytes(3).toString('hex')}`;
  }
  async function getPortalByAccount(accountId) {
    const result = await pool.query(`
      SELECT pe.*,e.nome,e.nome_publico,e.descricao_publica,e.logo_url,e.site_url AS empresa_site_url,e.cidade AS empresa_cidade,e.estado AS empresa_estado,e.ativo,e.exibir_no_portal,
        EXISTS(SELECT 1 FROM portal_empresa_imagens i WHERE i.portal_empresa_id=pe.id AND i.tipo='LOGO') AS has_logo,
        EXISTS(SELECT 1 FROM portal_empresa_imagens i WHERE i.portal_empresa_id=pe.id AND i.tipo='CAPA') AS has_cover
      FROM portal_empresas pe
      JOIN empresas e ON e.id=pe.empresa_id
      WHERE pe.owner_account_id=$1
      LIMIT 1
    `, [accountId]);
    return result.rows[0] || null;
  }
  async function requirePortal(req, res) {
    const account = await currentAccount(req);
    const portal = account ? await getPortalByAccount(account.id) : null;
    if (!portal) {
      res.redirect(303, '/meu-portal/onboarding?etapa=1');
      return null;
    }
    return { account, portal };
  }
  async function processImage(file, kind) {
    if (!file?.buffer) return null;
    if (kind === 'LOGO') {
      return sharp(file.buffer).rotate().resize({ width: 720, height: 720, fit: 'inside', withoutEnlargement: true }).webp({ quality: 90 }).toBuffer();
    }
    return sharp(file.buffer).rotate().resize({ width: 1600, height: 560, fit: 'cover', position: 'attention', withoutEnlargement: false }).webp({ quality: 86 }).toBuffer();
  }
  async function saveImage(portalId, kind, buffer) {
    if (!buffer) return;
    await pool.query(`INSERT INTO portal_empresa_imagens(portal_empresa_id,tipo,conteudo,mime_type,updated_at) VALUES($1,$2,$3,'image/webp',NOW()) ON CONFLICT(portal_empresa_id,tipo) DO UPDATE SET conteudo=EXCLUDED.conteudo,mime_type='image/webp',updated_at=NOW()`, [portalId, kind, buffer]);
  }
  function imageUrl(portal, kind) {
    return `${SITE_URL}/media/empresas/${encodeURIComponent(portal.slug)}/${kind.toLowerCase()}.webp?v=${encodeURIComponent(String(portal.updated_at || portal.publicado_em || '1'))}`;
  }
  function simpleMessagePage(res, title, message, href, label) {
    return metaPage({
      title,
      description: message,
      canonical: `${SITE_URL}${href}`,
      image: `${SITE_URL}/assets/vagas-grupos-social.png`,
      bodyClass: 'light-page directory-site company-portal-page',
      nonce: res.locals.cspNonce,
      robots: 'noindex,nofollow',
      siteName: PORTAL_BRAND_NAME,
      titleSuffix: PORTAL_BRAND_NAME,
      favicon: '/assets/vagas-grupos-mark.svg',
      themeColor: '#0B1F2A',
      structuredData: [],
      content: `${portalHeader({ active: '' })}<main id="conteudo" class="company-message-main"><div class="directory-container company-message-card"><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p><a class="btn btn-primary" href="${escapeHtml(href)}">${escapeHtml(label)}</a></div></main>${portalFooter()}`,
    });
  }
  function careerAppHeader(account, portal, token) {
    return `<header class="career-app-header"><div class="directory-container career-app-header-inner"><a class="career-app-brand" href="/meu-portal"><img src="/assets/vagas-grupos-mark.svg" width="40" height="40" alt=""><span><b>Portal da empresa</b><small>${escapeHtml(portal?.nome_publico || account.empresa_nome || account.nome)}</small></span></a><nav><a href="/meu-portal">Visão geral</a><a href="/meu-portal/vagas/nova">Nova vaga</a>${portal?.status === 'ATIVO' ? `<a href="/empresa/${escapeHtml(portal.slug)}" target="_blank" rel="noopener">Ver portal ↗</a>` : ''}</nav><form method="post" action="/sair"><input type="hidden" name="csrf_token" value="${escapeHtml(token)}"><button type="submit" class="career-link-button">Sair</button></form></div></header>`;
  }

  async function landingPage(req, res) {
    const ref = String(req.query.ref || '').trim().slice(0, 120);
    const account = await currentAccount(req);
    const existingPortal = account ? await getPortalByAccount(account.id).catch((error) => { if (error?.code === '42P01') return null; throw error; }) : null;
    const startHref = account ? (existingPortal ? '/meu-portal' : `/meu-portal/onboarding${ref ? `?ref=${encodeURIComponent(ref)}` : ''}`) : `/portal-para-empresas/comecar${ref ? `?ref=${encodeURIComponent(ref)}` : ''}`;
    const startLabel = account ? (existingPortal ? 'Gerenciar meu portal' : 'Criar portal da minha empresa') : 'Criar meu portal grátis';
    const content = `${portalHeader({ active: '' })}<main id="conteudo" class="company-landing">
      <section class="company-lp-hero"><div class="directory-container company-lp-hero-grid"><div class="company-lp-copy"><span class="company-kicker">Portal de carreiras gratuito</span><h1>Seu Trabalhe Conosco, com a <em>marca da sua empresa.</em></h1><p>Centralize suas vagas em uma página profissional, compartilhe um único link e acompanhe o interesse dos candidatos sem precisar criar ou manter um site.</p><div class="company-lp-actions"><a class="btn btn-primary btn-lg" href="${escapeHtml(startHref)}" data-track="CTA_PORTAL_EMPRESA_COMECAR">${escapeHtml(startLabel)}</a><a class="btn btn-ghost btn-lg" href="#exemplo">Ver como fica</a></div><div class="company-lp-trust"><span>✓ Sua logomarca</span><span>✓ Vagas em um só lugar</span><span>✓ Métricas básicas</span><span>✓ Sem cartão</span></div></div><div id="exemplo" class="career-preview-shell" aria-label="Exemplo de portal de carreiras"><div class="career-preview-browser"><span></span><span></span><span></span><b>vagasegrupos.com.br/empresa/sua-empresa</b></div><div class="career-preview-cover"><div class="career-preview-logo">S</div><div><small>TRABALHE CONOSCO</small><h2>Sua Empresa</h2><p>Oportunidades para quem quer crescer junto.</p></div></div><div class="career-preview-body"><div><b>Vagas abertas</b><small>Encontre a oportunidade ideal</small></div><article><span>Auxiliar de Operações</span><small>São Paulo · Presencial</small><b>Ver vaga →</b></article><article><span>Assistente Administrativo</span><small>São Paulo · Híbrido</small><b>Ver vaga →</b></article><footer>Empresa parceira do Vagas & Grupos · Tecnologia Gênesis IA</footer></div></div></div></section>
      <section class="company-value-strip"><div class="directory-container"><article><b>Uma página com a sua marca</b><span>Logo, cor, apresentação e vagas organizadas.</span></article><article><b>Um link para divulgar em todo lugar</b><span>WhatsApp, Instagram, LinkedIn, QR Code e site.</span></article><article><b>Dados para decidir melhor</b><span>Visualizações das vagas e cliques para candidatura.</span></article></div></section>
      ${genesisInteractiveDemoSection()}
      <section class="company-lp-section"><div class="directory-container"><div class="company-section-heading"><span>Feito para reduzir trabalho</span><h2>Você publica a vaga. O portal organiza a experiência.</h2><p>Uma estrutura simples para recrutadores que hoje dependem de imagens, formulários, redes sociais e links espalhados.</p></div><div class="company-benefit-grid"><article><i>01</i><h3>Marca empregadora</h3><p>Apresente sua empresa antes da vaga. O candidato entende quem está contratando e encontra todas as oportunidades no mesmo lugar.</p></article><article><i>02</i><h3>Vagas organizadas</h3><p>Cadastre, edite, duplique e encerre oportunidades sem precisar alterar uma página do seu site.</p></article><article><i>03</i><h3>Distribuição simples</h3><p>Compartilhe o link da empresa ou uma vaga específica em qualquer canal. O Vagas & Grupos continua visível como rede parceira.</p></article><article><i>04</i><h3>Rastreio essencial</h3><p>Acompanhe visualizações e cliques de candidatura para entender se a divulgação está trazendo interesse.</p></article></div></div></section>
      <section class="company-brand-section"><div class="directory-container company-brand-grid"><div><span class="company-kicker dark">Co-branding inteligente</span><h2>A marca é sua. A tecnologia é nossa.</h2><p>Na página de carreiras, sua empresa é protagonista. O Vagas & Grupos aparece como rede parceira e a Gênesis como tecnologia da operação — de forma discreta, sem transformar seu portal em propaganda.</p><ul><li>Logo e cor da empresa em destaque</li><li>Selo “Empresa parceira do Vagas & Grupos”</li><li>Assinatura “Tecnologia Gênesis IA” no rodapé</li></ul></div><div class="brand-balance-card"><div class="brand-main-demo">SUA EMPRESA<strong>Trabalhe conosco</strong></div><div class="brand-support-demo"><span>Parceira do <b>Vagas & Grupos</b></span><span>Tecnologia <b>Gênesis IA</b></span></div></div></div></section>
      <section class="company-lp-section soft"><div class="directory-container"><div class="company-section-heading"><span>Comece em poucos passos</span><h2>Do cadastro à primeira vaga sem enrolação.</h2></div><div class="company-steps"><article><b>1</b><h3>Crie a conta</h3><p>Nome, empresa, e-mail e WhatsApp.</p></article><article><b>2</b><h3>Personalize</h3><p>Adicione logo, cor e uma breve apresentação.</p></article><article><b>3</b><h3>Publique</h3><p>Seu portal fica pronto para receber as primeiras vagas.</p></article></div></div></section>
      <section class="company-genesis-bridge"><div class="directory-container"><div><span>Quando o volume crescer</span><h2>O portal atrai. A Gênesis pode cuidar do trabalho pesado depois.</h2><p>Atendimento pelo WhatsApp, triagem, documentos, agenda e operação humana entram apenas quando fizer sentido para sua empresa.</p></div><a class="btn btn-accent btn-lg" href="/anunciar-vaga" data-track="CTA_PORTAL_EMPRESA_GENESIS">Conhecer a Gênesis</a></div></section>
      <section class="company-final-cta"><div class="directory-container"><div><h2>Crie seu portal de carreiras.</h2><p>Comece com a sua marca e publique a primeira vaga quando estiver pronto.</p></div><a class="btn btn-primary btn-lg" href="${escapeHtml(startHref)}">${escapeHtml(startLabel)}</a></div></section>
    </main>${portalFooter()}`;
    return res.send(metaPage({ title: 'Portal de carreiras gratuito para empresas', description: 'Crie uma página de carreiras com a marca da sua empresa, publique vagas e acompanhe visualizações e cliques.', canonical: `${SITE_URL}/portal-para-empresas`, image: `${SITE_URL}/assets/vagas-grupos-social.png`, bodyClass: 'light-page directory-site company-portal-page', nonce: res.locals.cspNonce, siteName: PORTAL_BRAND_NAME, titleSuffix: PORTAL_BRAND_NAME, favicon: '/assets/vagas-grupos-mark.svg', themeColor: '#0B1F2A', structuredData: [], content }));
  }

  async function signupPage(req, res, { errors = {}, values = {} } = {}) {
    const account = await currentAccount(req);
    if (account) { const portal = await getPortalByAccount(account.id).catch((error) => { if (error?.code === '42P01') return null; throw error; }); return res.redirect(302, portal ? '/meu-portal' : '/meu-portal/onboarding'); }
    const token = csrf(req, res);
    const ref = String(req.query.ref || values.ref || '').trim().slice(0, 120);
    const content = `${portalHeader({ active: '' })}<main id="conteudo" class="career-signup-main"><div class="directory-container career-signup-grid"><section class="career-signup-value"><a href="/portal-para-empresas" class="back-link">← Portal para empresas</a><span class="company-kicker">Seu portal começa aqui</span><h1>Uma página profissional sem precisar montar um site.</h1><p>Depois do cadastro, você configura a identidade da empresa e visualiza o portal antes de publicar.</p><ul><li>Logo e identidade da empresa</li><li>Página pública de carreiras</li><li>Cadastro e gestão de vagas</li><li>Métricas de visualização e candidatura</li></ul><small>Você continua no controle das vagas. A Gênesis aparece apenas como tecnologia por trás da solução.</small></section><section class="career-signup-card"><div><span>PASSO 1 DE 3</span><h2>Crie sua conta gratuita</h2><p>Leva menos de dois minutos.</p></div><form method="post" action="/portal-para-empresas/comecar" class="career-form" novalidate><input type="hidden" name="csrf_token" value="${escapeHtml(token)}"><input type="hidden" name="ref" value="${escapeHtml(ref)}"><input class="honeypot" name="website" tabindex="-1" autocomplete="off"><div class="form-grid two"><label>Seu nome<input name="nome" value="${escapeHtml(values.nome || '')}" autocomplete="name" required>${errorText(errors, 'nome')}</label><label>WhatsApp<input name="whatsapp" value="${escapeHtml(values.whatsapp || '')}" autocomplete="tel" inputmode="tel" required>${errorText(errors, 'whatsapp')}</label></div><label>Empresa<input name="empresa_nome" value="${escapeHtml(values.empresa_nome || '')}" autocomplete="organization" required>${errorText(errors, 'empresa_nome')}</label><label>E-mail profissional<input type="email" name="email" value="${escapeHtml(values.email || '')}" autocomplete="email" required>${errorText(errors, 'email')}</label><div class="form-grid two"><label>Senha<input type="password" name="senha" minlength="8" autocomplete="new-password" required>${errorText(errors, 'senha')}</label><label>Confirmar senha<input type="password" name="confirmar_senha" minlength="8" autocomplete="new-password" required>${errorText(errors, 'confirmar_senha')}</label></div><label class="check-field"><input type="checkbox" name="aceite_termos" ${values.aceite_termos ? 'checked' : ''} required><span>Li e aceito os <a href="/termos" target="_blank" rel="noopener">Termos</a> e a <a href="/privacidade" target="_blank" rel="noopener">Política de privacidade</a>.</span></label>${errorText(errors, 'aceite_termos')}<label class="check-field"><input type="checkbox" name="consentimento_comercial" ${values.consentimento_comercial ? 'checked' : ''}><span>Quero receber novidades e soluções da Gênesis. <small>Opcional.</small></span></label>${errors.geral ? `<div class="form-alert error">${escapeHtml(errors.geral)}</div>` : ''}<button class="btn btn-primary btn-lg btn-block" type="submit">Continuar e personalizar portal</button><p class="form-switch">Já tem uma conta? <a href="/entrar?retorno=%2Fmeu-portal">Entrar</a></p></form></section></div></main>${portalFooter()}`;
    return res.send(metaPage({ title: 'Criar portal de carreiras', description: 'Crie sua conta empresarial e configure um portal de carreiras gratuito.', canonical: `${SITE_URL}/portal-para-empresas/comecar`, image: `${SITE_URL}/assets/vagas-grupos-social.png`, bodyClass: 'light-page directory-site company-portal-page', nonce: res.locals.cspNonce, robots: 'noindex,nofollow', siteName: PORTAL_BRAND_NAME, titleSuffix: PORTAL_BRAND_NAME, favicon: '/assets/vagas-grupos-mark.svg', themeColor: '#0B1F2A', structuredData: [], content }));
  }

  async function onboardingPage(req, res, next, { errors = {}, values = {} } = {}) {
    try {
      const account = await currentAccount(req);
      let portal = await getPortalByAccount(account.id);
      let step = Math.max(1, Math.min(3, Number(req.query.etapa || portal?.onboarding_step || 1)));
      if (!portal && step > 1) step = 1;
      const token = csrf(req, res);
      let main = '';
      if (step === 1) {
        const data = { nome_publico: account.empresa_nome || '', segmento: '', resumo: '', cidade: account.cidade || '', estado: account.estado || 'SP', site_url: '', instagram_url: '', linkedin_url: '', cnpj: account.cnpj || '', ...(portal || {}), ...values };
        main = `<div class="onboarding-head"><span>PASSO 1 DE 3</span><h1>Conte o essencial sobre a empresa</h1><p>Somente o necessário para criar uma página que pareça realmente sua.</p></div><form class="career-form onboarding-form" method="post" action="/meu-portal/onboarding/perfil" novalidate><input type="hidden" name="csrf_token" value="${escapeHtml(token)}"><div class="form-grid two"><label>Nome que aparece no portal<input name="nome_publico" value="${escapeHtml(data.nome_publico || '')}" required>${errorText(errors, 'nome_publico')}</label><label>Segmento<input name="segmento" value="${escapeHtml(data.segmento || '')}" placeholder="Ex.: Facilities, logística, varejo" required>${errorText(errors, 'segmento')}</label></div><label>Sobre a empresa<textarea name="resumo" rows="5" maxlength="1800" placeholder="Conte em poucas linhas quem é a empresa e o tipo de ambiente que o candidato vai encontrar." required>${escapeHtml(data.resumo || '')}</textarea>${errorText(errors, 'resumo')}</label><div class="form-grid three"><label>Estado<select name="estado" required>${stateOptions(data.estado)}</select>${errorText(errors, 'estado')}</label><label>Cidade<input name="cidade" value="${escapeHtml(data.cidade || '')}" required>${errorText(errors, 'cidade')}</label><label>CNPJ <span class="optional">opcional</span><input name="cnpj" value="${escapeHtml(data.cnpj || '')}" inputmode="numeric"></label></div><label>Site <span class="optional">opcional</span><input name="site_url" value="${escapeHtml(data.site_url || data.empresa_site_url || '')}" placeholder="www.suaempresa.com.br"></label><details class="optional-details"><summary>Adicionar redes sociais</summary><div class="form-grid two"><label>Instagram<input name="instagram_url" value="${escapeHtml(data.instagram_url || '')}" placeholder="instagram.com/suaempresa"></label><label>LinkedIn<input name="linkedin_url" value="${escapeHtml(data.linkedin_url || '')}" placeholder="linkedin.com/company/suaempresa"></label></div></details>${errors.geral ? `<div class="form-alert error">${escapeHtml(errors.geral)}</div>` : ''}<div class="onboarding-actions"><a href="/portal-para-empresas" class="btn btn-ghost">Voltar</a><button class="btn btn-primary btn-lg" type="submit">Continuar para identidade</button></div></form>`;
      } else if (step === 2) {
        main = `<div class="onboarding-head"><span>PASSO 2 DE 3</span><h1>Deixe o portal com a cara da empresa</h1><p>Logo + uma cor principal já são suficientes. A capa é opcional.</p></div><form class="career-form onboarding-form" method="post" action="/meu-portal/onboarding/identidade" enctype="multipart/form-data" novalidate><input type="hidden" name="csrf_token" value="${escapeHtml(token)}"><div class="brand-onboarding-grid"><label class="brand-upload-card"><span>Logomarca</span><div class="brand-upload-preview">${portal?.has_logo ? `<img src="${escapeHtml(imageUrl(portal, 'LOGO'))}" alt="Prévia da logo">` : ''}<b>Adicionar logo</b><small>JPG, PNG ou WEBP · até 6 MB</small></div><input type="file" name="logo" accept="image/jpeg,image/png,image/webp"></label><label class="brand-upload-card"><span>Capa <small>opcional</small></span><div class="brand-upload-preview cover">${portal?.has_cover ? `<img src="${escapeHtml(imageUrl(portal, 'CAPA'))}" alt="Prévia da capa">` : ''}<b>Adicionar imagem de capa</b><small>Se não enviar, usamos um fundo profissional com sua cor.</small></div><input type="file" name="capa" accept="image/jpeg,image/png,image/webp"></label></div><label class="color-field">Cor principal da empresa<div><input type="color" name="cor_primaria" value="${escapeHtml(portal?.cor_primaria || '#0EAEA0')}"><span>Usaremos essa cor em botões, destaques e detalhes.</span></div></label>${errors.geral ? `<div class="form-alert error">${escapeHtml(errors.geral)}</div>` : ''}<div class="onboarding-actions"><a href="/meu-portal/onboarding?etapa=1" class="btn btn-ghost">Voltar</a><button class="btn btn-primary btn-lg" type="submit">Visualizar meu portal</button></div></form>`;
      } else {
        const preview = renderCompanyHero(portal, { preview: true });
        main = `<div class="onboarding-head"><span>PASSO 3 DE 3</span><h1>Seu portal está pronto para estrear</h1><p>Revise a identidade. Você poderá editar os dados depois.</p></div><div class="onboarding-preview" style="${companyBrandStyle(portal)}">${preview}<div class="preview-empty-jobs"><span>Vagas abertas</span><h3>Sua primeira oportunidade vai aparecer aqui.</h3><p>Publique o portal agora e cadastre a primeira vaga em seguida.</p></div></div><form method="post" action="/meu-portal/publicar" class="onboarding-actions publish"><input type="hidden" name="csrf_token" value="${escapeHtml(token)}"><a href="/meu-portal/onboarding?etapa=2" class="btn btn-ghost">Ajustar identidade</a><button class="btn btn-primary btn-lg" type="submit">Publicar meu portal</button></form>`;
      }
      const content = `<main id="conteudo" class="onboarding-main"><div class="onboarding-top"><a href="/portal-para-empresas"><img src="/assets/vagas-grupos-mark.svg" width="38" height="38" alt=""><span><b>${escapeHtml(PORTAL_BRAND_NAME)}</b><small>Portal para empresas</small></span></a><span>Configuração do portal</span></div><div class="onboarding-progress"><i class="${step >= 1 ? 'done' : ''}"></i><i class="${step >= 2 ? 'done' : ''}"></i><i class="${step >= 3 ? 'done' : ''}"></i></div><section class="onboarding-card">${main}</section><p class="onboarding-powered">Sua marca em primeiro plano · Tecnologia Gênesis IA</p></main>`;
      return res.send(metaPage({ title: 'Configurar portal da empresa', description: 'Configure a identidade e publique seu portal de carreiras.', canonical: `${SITE_URL}/meu-portal/onboarding`, image: `${SITE_URL}/assets/vagas-grupos-social.png`, bodyClass: 'light-page directory-site company-portal-page onboarding-page', nonce: res.locals.cspNonce, robots: 'noindex,nofollow', siteName: PORTAL_BRAND_NAME, titleSuffix: PORTAL_BRAND_NAME, favicon: '/assets/vagas-grupos-mark.svg', themeColor: portal?.cor_primaria || '#0EAEA0', structuredData: [], content }));
    } catch (error) { return next(error); }
  }

  function renderCompanyHero(portal, { preview = false } = {}) {
    const hasCover = Boolean(portal?.has_cover);
    const logo = portal?.has_logo ? `<img src="${escapeHtml(imageUrl(portal, 'LOGO'))}" alt="Logo ${escapeHtml(portal.nome_publico || portal.nome)}">` : `<span>${escapeHtml(String(portal?.nome_publico || portal?.nome || 'E').trim().slice(0, 1).toUpperCase())}</span>`;
    return `<section class="company-career-hero ${hasCover ? 'has-cover' : ''}" style="${companyBrandStyle(portal)}${hasCover ? `--company-cover:url('${escapeHtml(imageUrl(portal, 'CAPA'))}');` : ''}"><div class="company-career-overlay"></div><div class="directory-container company-career-hero-inner"><div class="company-career-logo">${logo}</div><div class="company-career-intro"><span>TRABALHE CONOSCO</span><h1>${escapeHtml(portal?.nome_publico || portal?.nome || 'Sua empresa')}</h1><p>${escapeHtml(portal?.resumo || portal?.descricao_publica || 'Conheça nossas oportunidades e encontre seu próximo desafio.')}</p><div class="company-career-meta">${portal?.segmento ? `<span>${escapeHtml(portal.segmento)}</span>` : ''}${portal?.cidade || portal?.estado ? `<span>${escapeHtml([portal.cidade || portal.empresa_cidade, portal.estado || portal.empresa_estado].filter(Boolean).join(' · '))}</span>` : ''}<span>Empresa parceira do ${escapeHtml(PORTAL_BRAND_NAME)}</span></div>${!preview ? '<a class="btn company-brand-button" href="#vagas">Ver vagas abertas</a>' : ''}</div></div></section>`;
  }

  async function dashboardPage(req, res, next) {
    try {
      const context = await requirePortal(req, res);
      if (!context) return;
      const { account, portal } = context;
      if (portal.status === 'RASCUNHO') return res.redirect(303, `/meu-portal/onboarding?etapa=${Math.max(1, portal.onboarding_step || 1)}`);
      const token = csrf(req, res);
      const [jobsResult, metricsResult] = await Promise.all([
        pool.query(`SELECT * FROM vagas WHERE empresa_id=$1 AND origem_vaga='PORTAL_PARCEIRO' ORDER BY CASE status WHEN 'ATIVA' THEN 0 WHEN 'RASCUNHO' THEN 1 WHEN 'PAUSADA' THEN 2 ELSE 3 END,created_at DESC`, [portal.empresa_id]),
        pool.query(`SELECT
          COUNT(*) FILTER (WHERE evento='PORTAL_EMPRESA_VIEW')::INTEGER AS portal_views,
          COUNT(*) FILTER (WHERE vaga_id IS NOT NULL AND evento='VISUALIZACAO_VAGA')::INTEGER AS job_views,
          COUNT(*) FILTER (WHERE vaga_id IS NOT NULL AND evento LIKE 'CTA_%CANDIDATURA')::INTEGER AS apply_clicks,
          COUNT(*) FILTER (WHERE created_at>=NOW()-INTERVAL '7 days' AND (evento='PORTAL_EMPRESA_VIEW' OR vaga_id IS NOT NULL))::INTEGER AS activity_7d
        FROM portal_eventos pe
        WHERE pe.empresa_id=$1 OR pe.vaga_id IN (SELECT id FROM vagas WHERE empresa_id=$1)`, [portal.empresa_id]),
      ]);
      const m = metricsResult.rows[0] || {};
      const activeJobs = jobsResult.rows.filter((job) => job.status === 'ATIVA').length;
      const content = `${careerAppHeader(account, portal, token)}<main id="conteudo" class="career-dashboard-main"><div class="directory-container career-dashboard-head"><div><span class="company-kicker dark">Portal ativo</span><h1>Seu portal de carreiras</h1><p>O que importa agora: vagas no ar, pessoas chegando e próxima ação.</p></div><div class="career-dashboard-head-actions"><a class="btn btn-ghost" href="/empresa/${escapeHtml(portal.slug)}" target="_blank" rel="noopener">Abrir portal ↗</a><a class="btn btn-primary" href="/meu-portal/vagas/nova">+ Nova vaga</a></div></div><section class="directory-container career-kpis"><article><span>Vagas ativas</span><strong>${activeJobs}</strong><small>${jobsResult.rowCount} cadastradas no total</small></article><article><span>Visualizações do portal</span><strong>${Number(m.portal_views || 0).toLocaleString('pt-BR')}</strong><small>Pessoas que abriram a página da empresa</small></article><article><span>Visualizações das vagas</span><strong>${Number(m.job_views || 0).toLocaleString('pt-BR')}</strong><small>Detalhes de oportunidades acessados</small></article><article><span>Cliques para candidatura</span><strong>${Number(m.apply_clicks || 0).toLocaleString('pt-BR')}</strong><small>Intenção de candidatura registrada</small></article></section><section class="directory-container career-dashboard-grid"><article class="career-panel main"><div class="career-panel-heading"><div><h2>Suas vagas</h2><p>Cadastre uma vez e mantenha o portal sempre atualizado.</p></div><a href="/meu-portal/vagas/nova">+ Nova vaga</a></div>${jobsResult.rowCount ? `<div class="career-job-list">${jobsResult.rows.map((job) => `<article><div><span class="career-status ${String(job.status).toLowerCase()}">${escapeHtml(job.status === 'ATIVA' ? 'Ativa' : job.status === 'ENCERRADA' ? 'Encerrada' : job.status)}</span><h3>${escapeHtml(job.titulo)}</h3><p>${escapeHtml([job.bairro, job.cidade, job.estado].filter(Boolean).join(' · '))}${job.salario ? ` · ${escapeHtml(formatMoney(job.salario))}` : ''}</p></div><div class="career-job-actions">${job.status === 'ATIVA' ? `<a href="${escapeHtml(vacancyUrl(job))}" target="_blank" rel="noopener">Ver vaga</a>` : ''}<a href="/meu-portal/vagas/${job.id}/editar">Editar</a><form method="post" action="/meu-portal/vagas/${job.id}/duplicar"><input type="hidden" name="csrf_token" value="${escapeHtml(token)}"><button type="submit">Duplicar</button></form>${job.status === 'ATIVA' ? `<form method="post" action="/meu-portal/vagas/${job.id}/encerrar"><input type="hidden" name="csrf_token" value="${escapeHtml(token)}"><button type="submit" class="danger">Encerrar</button></form>` : ''}</div></article>`).join('')}</div>` : `<div class="career-empty"><div>＋</div><h3>Publique sua primeira vaga</h3><p>Seu portal já está pronto. Falta apenas uma oportunidade para começar a divulgar.</p><a class="btn btn-primary" href="/meu-portal/vagas/nova">Criar primeira vaga</a></div>`}</article><aside class="career-panel side"><div class="career-share-card"><span>Compartilhe seu portal</span><code>${escapeHtml(`${SITE_URL}/empresa/${portal.slug}`)}</code><button class="btn btn-ghost btn-block" type="button" data-copy-text="${escapeHtml(`${SITE_URL}/empresa/${portal.slug}`)}">Copiar link</button></div><div class="career-next-card"><span>Últimos 7 dias</span><strong>${Number(m.activity_7d || 0).toLocaleString('pt-BR')}</strong><p>interações registradas entre portal e vagas.</p></div>${Number(m.apply_clicks || 0) >= 20 ? `<div class="career-genesis-nudge"><span>Recebendo candidatos?</span><h3>Deixe a Gênesis cuidar da triagem.</h3><p>Automatize WhatsApp, documentos e agendamento sem trocar seu portal.</p><a href="/anunciar-vaga">Conhecer a Gênesis →</a></div>` : ''}</aside></section></main>`;
      return res.send(metaPage({ title: 'Meu portal de carreiras', description: 'Gerencie a página de carreiras e as vagas da sua empresa.', canonical: `${SITE_URL}/meu-portal`, image: `${SITE_URL}/assets/vagas-grupos-social.png`, bodyClass: 'light-page directory-site company-portal-page career-dashboard-page', nonce: res.locals.cspNonce, robots: 'noindex,nofollow', siteName: PORTAL_BRAND_NAME, titleSuffix: PORTAL_BRAND_NAME, favicon: '/assets/vagas-grupos-mark.svg', themeColor: portal.cor_primaria || '#0EAEA0', structuredData: [], content }));
    } catch (error) { return next(error); }
  }

  function jobForm(portal, token, data = {}, errors = {}, editing = false) {
    const action = editing ? `/meu-portal/vagas/${data.id}/editar` : '/meu-portal/vagas/nova';
    const salaryValue = data.salario ? String(data.salario).replace('.', ',') : '';
    const candidateType = data.candidatura_tipo || (data.canal_candidatura === 'EMAIL' ? 'EMAIL' : data.candidatura_url && !String(data.candidatura_url).includes('wa.me') ? 'URL' : 'WHATSAPP');
    const candidateDest = data.candidatura_destino || (candidateType === 'EMAIL' ? data.candidatura_email : candidateType === 'URL' ? data.candidatura_url : String(data.candidatura_url || '').match(/wa\.me\/(\d+)/)?.[1] || '');
    return `<form class="career-form career-job-form" method="post" action="${action}" novalidate><input type="hidden" name="csrf_token" value="${escapeHtml(token)}"><section class="career-form-section"><div><span>1</span><h2>Sobre a oportunidade</h2><p>Comece pelo que o candidato precisa entender.</p></div><div class="form-grid two"><label>Título da vaga<input name="titulo" value="${escapeHtml(data.titulo || '')}" placeholder="Ex.: Auxiliar de Limpeza" required>${errorText(errors, 'titulo')}</label><label>Cargo<input name="cargo" value="${escapeHtml(data.cargo || '')}" placeholder="Ex.: Auxiliar de Serviços Gerais" required>${errorText(errors, 'cargo')}</label></div><label>Descrição<textarea name="descricao" rows="7" maxlength="6000" placeholder="Explique as principais atividades e o contexto da oportunidade." required>${escapeHtml(data.descricao || '')}</textarea>${errorText(errors, 'descricao')}</label><div class="form-grid two"><label>Requisitos <span class="optional">opcional</span><textarea name="requisitos" rows="4">${escapeHtml(data.requisitos || data.requisitos_obrigatorios || '')}</textarea></label><label>Benefícios <span class="optional">opcional</span><textarea name="beneficios" rows="4">${escapeHtml(data.beneficios || '')}</textarea></label></div></section><section class="career-form-section"><div><span>2</span><h2>Local e condições</h2><p>Informação clara reduz candidaturas fora do perfil.</p></div><div class="form-grid three"><label>Estado<select name="estado" required>${stateOptions(data.estado || portal.estado || portal.empresa_estado || 'SP')}</select>${errorText(errors, 'estado')}</label><label>Cidade<input name="cidade" value="${escapeHtml(data.cidade || portal.cidade || portal.empresa_cidade || '')}" required>${errorText(errors, 'cidade')}</label><label>Bairro <span class="optional">opcional</span><input name="bairro" value="${escapeHtml(data.bairro || '')}"></label></div><div class="form-grid three"><label>Modalidade<select name="modalidade"><option ${data.modalidade !== 'Híbrido' && data.modalidade !== 'Remoto' ? 'selected' : ''}>Presencial</option><option ${data.modalidade === 'Híbrido' ? 'selected' : ''}>Híbrido</option><option ${data.modalidade === 'Remoto' ? 'selected' : ''}>Remoto</option></select></label><label>Contrato<input name="tipo_contrato" value="${escapeHtml(data.tipo_contrato || '')}" placeholder="CLT, temporário..."></label><label>Quantidade<input type="number" name="quantidade_vagas" min="1" max="999" value="${escapeHtml(data.quantidade_vagas || 1)}"></label></div><div class="form-grid three"><label>Escala <span class="optional">opcional</span><input name="escala" value="${escapeHtml(data.escala || '')}" placeholder="6x1, 12x36..."></label><label>Horário <span class="optional">opcional</span><input name="horario" value="${escapeHtml(data.horario || '')}"></label><label>Salário <span class="optional">opcional</span><input name="salario" inputmode="decimal" value="${escapeHtml(salaryValue)}" placeholder="1837,40"></label></div><label class="check-field compact"><input type="checkbox" name="aceita_sem_experiencia" ${data.aceita_sem_experiencia ? 'checked' : ''}><span>A vaga aceita candidatos sem experiência.</span></label></section><section class="career-form-section"><div><span>3</span><h2>Como o candidato se inscreve?</h2><p>Escolha um único destino. O botão da vaga levará a pessoa para lá.</p></div><div class="candidate-channel-picker"><label><input type="radio" name="candidatura_tipo" value="WHATSAPP" ${candidateType === 'WHATSAPP' ? 'checked' : ''}><span><b>WhatsApp da empresa</b><small>Ideal para vagas operacionais e alto volume.</small></span></label><label><input type="radio" name="candidatura_tipo" value="URL" ${candidateType === 'URL' ? 'checked' : ''}><span><b>Link externo</b><small>Formulário, ATS ou página já existente.</small></span></label><label><input type="radio" name="candidatura_tipo" value="EMAIL" ${candidateType === 'EMAIL' ? 'checked' : ''}><span><b>E-mail</b><small>Receba a candidatura na caixa do RH.</small></span></label></div><label>Destino da candidatura<input name="candidatura_destino" value="${escapeHtml(candidateDest)}" placeholder="WhatsApp, e-mail ou URL" required>${errorText(errors, 'candidatura_destino')}</label></section>${errors.geral ? `<div class="form-alert error">${escapeHtml(errors.geral)}</div>` : ''}<div class="career-form-footer"><a class="btn btn-ghost" href="/meu-portal">Cancelar</a><button class="btn btn-primary btn-lg" type="submit">${editing ? 'Salvar alterações' : 'Publicar vaga'}</button></div></form>`;
  }

  async function jobFormPage(req, res, next, { data = {}, errors = {}, editing = false } = {}) {
    try {
      const context = await requirePortal(req, res);
      if (!context) return;
      const { account, portal } = context;
      const token = csrf(req, res);
      const content = `${careerAppHeader(account, portal, token)}<main id="conteudo" class="career-job-page"><div class="directory-container career-job-page-head"><a href="/meu-portal">← Voltar ao portal</a><span class="company-kicker dark">${editing ? 'Editar vaga' : 'Nova vaga'}</span><h1>${editing ? 'Atualize a oportunidade' : 'Publique uma oportunidade'}</h1><p>Três blocos curtos. Mostramos somente o que o candidato realmente precisa.</p></div><div class="directory-container career-job-layout">${jobForm(portal, token, data, errors, editing)}<aside><div class="career-tip-card"><span>Boa vaga, menos ruído</span><h3>Seja direto.</h3><ul><li>Título reconhecível</li><li>Local e horário claros</li><li>Salário quando possível</li><li>Benefícios objetivos</li></ul></div><div class="career-tip-card subtle"><span>Depois de publicar</span><p>A vaga entra automaticamente na página da empresa e na busca geral do Vagas & Grupos.</p></div></aside></div></main>`;
      return res.send(metaPage({ title: editing ? 'Editar vaga' : 'Nova vaga', description: 'Cadastre uma oportunidade no portal de carreiras da empresa.', canonical: `${SITE_URL}${req.path}`, image: `${SITE_URL}/assets/vagas-grupos-social.png`, bodyClass: 'light-page directory-site company-portal-page career-dashboard-page', nonce: res.locals.cspNonce, robots: 'noindex,nofollow', siteName: PORTAL_BRAND_NAME, titleSuffix: PORTAL_BRAND_NAME, favicon: '/assets/vagas-grupos-mark.svg', themeColor: portal.cor_primaria || '#0EAEA0', structuredData: [], content }));
    } catch (error) { return next(error); }
  }

  function normalizeJobInput(parsed) {
    const salary = parsed.salario ? Number(String(parsed.salario).replace(/\./g, '').replace(',', '.')) : null;
    if (salary !== null && (!Number.isFinite(salary) || salary < 0)) return { error: 'Informe um salário válido.' };
    let channel = 'URL_EXTERNA';
    let url = null;
    let email = null;
    if (parsed.candidatura_tipo === 'WHATSAPP') {
      const number = digits(parsed.candidatura_destino);
      if (number.length < 10 || number.length > 15) return { error: 'Informe um WhatsApp válido com DDD.' };
      const message = `Olá! Quero me candidatar à vaga ${parsed.titulo} divulgada no Vagas & Grupos.`;
      url = `https://wa.me/${number}?text=${encodeURIComponent(message)}`;
    } else if (parsed.candidatura_tipo === 'EMAIL') {
      if (!z.string().email().safeParse(parsed.candidatura_destino).success) return { error: 'Informe um e-mail válido para candidatura.' };
      channel = 'EMAIL';
      email = parsed.candidatura_destino;
    } else {
      url = cleanUrl(parsed.candidatura_destino);
      if (!url) return { error: 'Informe uma URL válida para candidatura.' };
    }
    return { salary, channel, url, email };
  }

  async function publicCompanyPage(req, res, next) {
    try {
      const result = await pool.query(`SELECT pe.*,e.nome,e.nome_publico,e.descricao_publica,e.site_url AS empresa_site_url,e.cidade AS empresa_cidade,e.estado AS empresa_estado,EXISTS(SELECT 1 FROM portal_empresa_imagens i WHERE i.portal_empresa_id=pe.id AND i.tipo='LOGO') AS has_logo,EXISTS(SELECT 1 FROM portal_empresa_imagens i WHERE i.portal_empresa_id=pe.id AND i.tipo='CAPA') AS has_cover FROM portal_empresas pe JOIN empresas e ON e.id=pe.empresa_id WHERE pe.slug=$1 AND pe.status='ATIVO' AND e.ativo IS TRUE AND e.exibir_no_portal IS TRUE LIMIT 1`, [String(req.params.slug || '')]);
      if (!result.rowCount) return next();
      const portal = result.rows[0];
      const jobs = await pool.query(`SELECT v.*,COALESCE(e.nome_publico,e.nome) AS empresa_nome,e.logo_url AS empresa_logo_url FROM vagas v JOIN empresas e ON e.id=v.empresa_id WHERE v.empresa_id=$1 AND v.status='ATIVA' AND COALESCE(v.publicar_portal,TRUE) IS TRUE AND (v.data_encerramento IS NULL OR v.data_encerramento>=CURRENT_DATE) ORDER BY COALESCE(v.portal_publicado_em,v.created_at) DESC`, [portal.empresa_id]);
      void pool.query(`INSERT INTO portal_eventos(empresa_id,evento,pagina,origem,metadata,ip_hash,user_agent) VALUES($1,'PORTAL_EMPRESA_VIEW',$2,$3,$4::JSONB,$5,$6)`, [portal.empresa_id, req.path, String(req.get('referer') || '').slice(0, 1000), JSON.stringify({ slug: portal.slug }), hmac(String(req.ip || '')).slice(0, 128), String(req.headers['user-agent'] || '').slice(0, 1000)]).catch(() => {});
      const jobCards = jobs.rowCount ? jobs.rows.map((job) => vacancyCard(job)).join('') : `<div class="company-no-jobs"><h3>Nenhuma vaga aberta no momento</h3><p>Acompanhe esta página. Novas oportunidades podem ser publicadas em breve.</p><a href="/vagas">Explorar outras vagas</a></div>`;
      const socialLinks = [portal.empresa_site_url ? `<a href="${escapeHtml(portal.empresa_site_url)}" target="_blank" rel="noopener">Site</a>` : '', portal.instagram_url ? `<a href="${escapeHtml(portal.instagram_url)}" target="_blank" rel="noopener">Instagram</a>` : '', portal.linkedin_url ? `<a href="${escapeHtml(portal.linkedin_url)}" target="_blank" rel="noopener">LinkedIn</a>` : ''].filter(Boolean).join('');
      const organization = { '@context': 'https://schema.org', '@type': 'Organization', name: portal.nome_publico || portal.nome, url: `${SITE_URL}/empresa/${portal.slug}`, description: portal.resumo || portal.descricao_publica || undefined, logo: portal.has_logo ? imageUrl(portal, 'LOGO') : undefined };
      const content = `${portalHeader({ active: 'empresas' })}<main id="conteudo" class="company-public-page" style="${companyBrandStyle(portal)}">${renderCompanyHero(portal)}<section id="vagas" class="company-jobs-section"><div class="directory-container"><div class="company-jobs-head"><div><span>${jobs.rowCount} ${jobs.rowCount === 1 ? 'vaga aberta' : 'vagas abertas'}</span><h2>Oportunidades na ${escapeHtml(portal.nome_publico || portal.nome)}</h2></div>${socialLinks ? `<nav>${socialLinks}</nav>` : ''}</div><div class="company-job-list">${jobCards}</div></div></section><section class="company-partner-band"><div class="directory-container"><div><span>Empresa parceira do ${escapeHtml(PORTAL_BRAND_NAME)}</span><p>Esta página de carreiras é mantida pela própria empresa. A tecnologia do portal é fornecida pela Gênesis IA.</p></div><a href="/portal-para-empresas" class="btn btn-ghost">Quero um portal para minha empresa</a></div></section></main>${portalFooter()}`;
      return res.send(metaPage({ title: `Trabalhe conosco na ${portal.nome_publico || portal.nome}`, description: String(portal.resumo || portal.descricao_publica || `Veja as vagas abertas na ${portal.nome_publico || portal.nome}.`).slice(0, 300), canonical: `${SITE_URL}/empresa/${portal.slug}`, image: portal.has_cover ? imageUrl(portal, 'CAPA') : portal.has_logo ? imageUrl(portal, 'LOGO') : `${SITE_URL}/assets/vagas-grupos-social.png`, bodyClass: 'light-page directory-site company-portal-page', nonce: res.locals.cspNonce, siteName: portal.nome_publico || portal.nome, titleSuffix: PORTAL_BRAND_NAME, favicon: '/assets/vagas-grupos-mark.svg', themeColor: portal.cor_primaria || '#0EAEA0', structuredData: [organization], content }));
    } catch (error) { return next(error); }
  }

  async function companiesDirectory(req, res, next) {
    try {
      const q = String(req.query.q || '').trim().slice(0, 100);
      const values = [];
      let filter = `pe.status='ATIVO' AND e.ativo IS TRUE AND e.exibir_no_portal IS TRUE`;
      if (q) { values.push(`%${q}%`); filter += ` AND (COALESCE(e.nome_publico,e.nome) ILIKE $1 OR pe.segmento ILIKE $1 OR pe.cidade ILIKE $1)`; }
      const result = await pool.query(`SELECT pe.*,e.nome,e.nome_publico,e.cidade AS empresa_cidade,e.estado AS empresa_estado,EXISTS(SELECT 1 FROM portal_empresa_imagens i WHERE i.portal_empresa_id=pe.id AND i.tipo='LOGO') AS has_logo,(SELECT COUNT(*) FROM vagas v WHERE v.empresa_id=pe.empresa_id AND v.status='ATIVA' AND COALESCE(v.publicar_portal,TRUE) IS TRUE AND (v.data_encerramento IS NULL OR v.data_encerramento>=CURRENT_DATE))::INTEGER AS vagas_ativas FROM portal_empresas pe JOIN empresas e ON e.id=pe.empresa_id WHERE ${filter} ORDER BY vagas_ativas DESC,COALESCE(e.nome_publico,e.nome) ASC LIMIT 120`, values);
      const cards = result.rowCount ? result.rows.map((portal) => `<a class="partner-company-card" href="/empresa/${escapeHtml(portal.slug)}" style="${companyBrandStyle(portal)}"><div class="partner-company-logo">${portal.has_logo ? `<img src="${escapeHtml(imageUrl(portal, 'LOGO'))}" alt="Logo ${escapeHtml(portal.nome_publico || portal.nome)}">` : `<span>${escapeHtml(String(portal.nome_publico || portal.nome).slice(0, 1).toUpperCase())}</span>`}</div><div><span>Empresa parceira</span><h3>${escapeHtml(portal.nome_publico || portal.nome)}</h3><p>${escapeHtml([portal.segmento, portal.cidade || portal.empresa_cidade, portal.estado || portal.empresa_estado].filter(Boolean).join(' · '))}</p><b>${portal.vagas_ativas} ${portal.vagas_ativas === 1 ? 'vaga aberta' : 'vagas abertas'} →</b></div></a>`).join('') : `<div class="company-no-jobs"><h3>Nenhuma empresa encontrada</h3><p>Tente buscar por outro nome, segmento ou cidade.</p></div>`;
      const content = `${portalHeader({ active: 'empresas' })}<main id="conteudo" class="companies-directory-main"><section class="companies-directory-hero"><div class="directory-container"><span class="company-kicker dark">Empresas parceiras</span><h1>Conheça empresas que estão contratando.</h1><p>Explore páginas de carreiras, descubra oportunidades e acompanhe as empresas que publicam no Vagas & Grupos.</p><form action="/empresas" method="get"><input type="search" name="q" value="${escapeHtml(q)}" placeholder="Empresa, segmento ou cidade"><button class="btn btn-primary" type="submit">Buscar</button></form></div></section><section class="directory-container companies-grid-section"><div class="companies-results-head"><span>${result.rowCount} ${result.rowCount === 1 ? 'empresa encontrada' : 'empresas encontradas'}</span><a href="/portal-para-empresas">Criar portal da minha empresa →</a></div><div class="partner-company-grid">${cards}</div></section></main>${portalFooter()}`;
      return res.send(metaPage({ title: 'Empresas que estão contratando', description: 'Conheça empresas parceiras, visite páginas de carreiras e encontre vagas abertas.', canonical: `${SITE_URL}/empresas${q ? `?q=${encodeURIComponent(q)}` : ''}`, image: `${SITE_URL}/assets/vagas-grupos-social.png`, bodyClass: 'light-page directory-site company-portal-page', nonce: res.locals.cspNonce, robots: q ? 'noindex,follow' : 'index,follow,max-image-preview:large', siteName: PORTAL_BRAND_NAME, titleSuffix: PORTAL_BRAND_NAME, favicon: '/assets/vagas-grupos-mark.svg', themeColor: '#0B1F2A', structuredData: [], content }));
    } catch (error) { return next(error); }
  }

  app.get('/portal-para-empresas', async (req,res,next)=>{ try { return await landingPage(req,res); } catch(error) { return next(error); } });
  app.get('/portal-para-empresas/comecar', (req, res, next) => signupPage(req, res).catch(next));
  app.post('/portal-para-empresas/comecar', authLimiter, async (req, res, next) => {
    try {
      assertCsrf(req);
      const parsed = signupSchema.safeParse(req.body);
      if (!parsed.success) { res.status(400); return signupPage(req, res, { errors: fieldErrors(parsed.error.issues), values: req.body }); }
      if (parsed.data.website) return res.redirect(303, '/portal-para-empresas');
      if (parsed.data.senha !== parsed.data.confirmar_senha) { res.status(400); return signupPage(req, res, { errors: { confirmar_senha: 'As senhas não conferem.' }, values: req.body }); }
      if (!checkbox(parsed.data.aceite_termos)) { res.status(400); return signupPage(req, res, { errors: { aceite_termos: 'Você precisa aceitar os termos para continuar.' }, values: req.body }); }
      const passwordHash = await hashPassword(parsed.data.senha);
      let inserted;
      try {
        inserted = await pool.query(`INSERT INTO portal_contas(tipo,nome,email,senha_hash,whatsapp,empresa_nome,status,lead_status,consentimento_comercial,aceite_termos_em,origem,origem_ref) VALUES('EMPRESA',$1,LOWER($2),$3,$4,$5,'ATIVA','NOVO',$6,NOW(),'PORTAL_CARREIRAS',NULLIF($7,'')) RETURNING id`, [parsed.data.nome, parsed.data.email, passwordHash, digits(parsed.data.whatsapp), parsed.data.empresa_nome, checkbox(parsed.data.consentimento_comercial), parsed.data.ref]);
      } catch (error) {
        if (error.code === '23505') { res.status(409); return signupPage(req, res, { errors: { email: 'Já existe uma conta com este e-mail. Entre na conta existente.' }, values: req.body }); }
        throw error;
      }
      await createSession(req, res, inserted.rows[0].id);
      return res.redirect(303, '/meu-portal/onboarding?etapa=1');
    } catch (error) { return next(error); }
  });

  app.get('/meu-portal/onboarding', requireCompanyAccount, onboardingPage);
  app.post('/meu-portal/onboarding/perfil', requireCompanyAccount, writeLimiter, async (req, res, next) => {
    try {
      assertCsrf(req);
      const account = await currentAccount(req);
      const parsed = profileSchema.safeParse(req.body);
      if (!parsed.success) { res.status(400); req.query.etapa = '1'; return onboardingPage(req, res, next, { errors: fieldErrors(parsed.error.issues), values: req.body }); }
      const siteUrl = cleanUrl(parsed.data.site_url);
      const instagramUrl = cleanUrl(parsed.data.instagram_url);
      const linkedinUrl = cleanUrl(parsed.data.linkedin_url);
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        let portal = await client.query('SELECT * FROM portal_empresas WHERE owner_account_id=$1 LIMIT 1 FOR UPDATE', [account.id]);
        let empresaId;
        if (!portal.rowCount) {
          const company = await client.query(`INSERT INTO empresas(nome,nome_publico,descricao_publica,site_url,cidade,estado,ativo,exibir_no_portal) VALUES($1,$1,$2,NULLIF($3,''),$4,$5,TRUE,TRUE) RETURNING id`, [parsed.data.nome_publico, parsed.data.resumo, siteUrl, parsed.data.cidade, parsed.data.estado]);
          empresaId = company.rows[0].id;
          const slug = await uniqueSlug(parsed.data.nome_publico);
          portal = await client.query(`INSERT INTO portal_empresas(empresa_id,owner_account_id,slug,nome_publico,segmento,resumo,cidade,estado,site_url,instagram_url,linkedin_url,status,onboarding_step,origem_ref) VALUES($1,$2,$3,$4,$5,$6,$7,$8,NULLIF($9,''),NULLIF($10,''),NULLIF($11,''),'RASCUNHO',2,NULLIF($12,'')) RETURNING *`, [empresaId, account.id, slug, parsed.data.nome_publico, parsed.data.segmento, parsed.data.resumo, parsed.data.cidade, parsed.data.estado, siteUrl, instagramUrl, linkedinUrl, account.origem_ref || '']);
        } else {
          empresaId = portal.rows[0].empresa_id;
          await client.query(`UPDATE empresas SET nome_publico=$1,descricao_publica=$2,site_url=NULLIF($3,''),cidade=$4,estado=$5,updated_at=NOW() WHERE id=$6`, [parsed.data.nome_publico, parsed.data.resumo, siteUrl, parsed.data.cidade, parsed.data.estado, empresaId]);
          portal = await client.query(`UPDATE portal_empresas SET nome_publico=$1,segmento=$2,resumo=$3,cidade=$4,estado=$5,site_url=NULLIF($6,''),instagram_url=NULLIF($7,''),linkedin_url=NULLIF($8,''),onboarding_step=GREATEST(onboarding_step,2),updated_at=NOW() WHERE owner_account_id=$9 RETURNING *`, [parsed.data.nome_publico, parsed.data.segmento, parsed.data.resumo, parsed.data.cidade, parsed.data.estado, siteUrl, instagramUrl, linkedinUrl, account.id]);
        }
        await client.query(`UPDATE portal_contas SET empresa_nome=$1,cnpj=NULLIF($2,''),cidade=$3,estado=$4,updated_at=NOW() WHERE id=$5`, [parsed.data.nome_publico, parsed.data.cnpj, parsed.data.cidade, parsed.data.estado, account.id]);
        await client.query('COMMIT');
      } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
      return res.redirect(303, '/meu-portal/onboarding?etapa=2');
    } catch (error) { return next(error); }
  });

  app.post('/meu-portal/onboarding/identidade', requireCompanyAccount, writeLimiter, upload.fields([{ name: 'logo', maxCount: 1 }, { name: 'capa', maxCount: 1 }]), async (req, res, next) => {
    try {
      assertCsrf(req);
      const account = await currentAccount(req);
      const portal = await getPortalByAccount(account.id);
      if (!portal) return res.redirect(303, '/meu-portal/onboarding?etapa=1');
      const parsed = identitySchema.safeParse(req.body);
      if (!parsed.success) { res.status(400); req.query.etapa = '2'; return onboardingPage(req, res, next, { errors: fieldErrors(parsed.error.issues), values: req.body }); }
      const logo = await processImage(req.files?.logo?.[0], 'LOGO');
      const cover = await processImage(req.files?.capa?.[0], 'CAPA');
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('UPDATE portal_empresas SET cor_primaria=$1,onboarding_step=GREATEST(onboarding_step,3),updated_at=NOW() WHERE id=$2', [parsed.data.cor_primaria, portal.id]);
        if (logo) await client.query(`INSERT INTO portal_empresa_imagens(portal_empresa_id,tipo,conteudo,mime_type,updated_at) VALUES($1,'LOGO',$2,'image/webp',NOW()) ON CONFLICT(portal_empresa_id,tipo) DO UPDATE SET conteudo=EXCLUDED.conteudo,mime_type='image/webp',updated_at=NOW()`, [portal.id, logo]);
        if (cover) await client.query(`INSERT INTO portal_empresa_imagens(portal_empresa_id,tipo,conteudo,mime_type,updated_at) VALUES($1,'CAPA',$2,'image/webp',NOW()) ON CONFLICT(portal_empresa_id,tipo) DO UPDATE SET conteudo=EXCLUDED.conteudo,mime_type='image/webp',updated_at=NOW()`, [portal.id, cover]);
        if (logo) await client.query('UPDATE empresas SET logo_url=$1,updated_at=NOW() WHERE id=$2', [`${SITE_URL}/media/empresas/${portal.slug}/logo.webp`, portal.empresa_id]);
        await client.query('COMMIT');
      } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
      return res.redirect(303, '/meu-portal/onboarding?etapa=3');
    } catch (error) { return next(error); }
  });

  app.post('/meu-portal/publicar', requireCompanyAccount, writeLimiter, async (req, res, next) => {
    try {
      assertCsrf(req);
      const account = await currentAccount(req);
      const portal = await getPortalByAccount(account.id);
      if (!portal) return res.redirect(303, '/meu-portal/onboarding?etapa=1');
      await pool.query(`UPDATE portal_empresas SET status='ATIVO',onboarding_step=3,publicado_em=COALESCE(publicado_em,NOW()),updated_at=NOW() WHERE id=$1`, [portal.id]);
      await pool.query(`UPDATE portal_contas SET lead_status=CASE WHEN lead_status='NOVO' THEN 'QUALIFICADO' ELSE lead_status END,updated_at=NOW() WHERE id=$1`, [account.id]);
      return res.redirect(303, '/meu-portal?bemvindo=1');
    } catch (error) { return next(error); }
  });

  app.get('/meu-portal', requireCompanyAccount, dashboardPage);
  app.get('/meu-portal/vagas/nova', requireCompanyAccount, (req, res, next) => jobFormPage(req, res, next));
  app.post('/meu-portal/vagas/nova', requireCompanyAccount, writeLimiter, async (req, res, next) => {
    try {
      assertCsrf(req);
      const context = await requirePortal(req, res);
      if (!context) return;
      const parsed = jobSchema.safeParse(req.body);
      if (!parsed.success) { res.status(400); return jobFormPage(req, res, next, { data: req.body, errors: fieldErrors(parsed.error.issues) }); }
      const normalized = normalizeJobInput(parsed.data);
      if (normalized.error) { res.status(400); return jobFormPage(req, res, next, { data: req.body, errors: { candidatura_destino: normalized.error } }); }
      const code = `WEB-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(2).toString('hex').toUpperCase()}`;
      await pool.query(`INSERT INTO vagas(empresa_id,codigo,titulo,cargo,descricao,cidade,estado,bairro,tipo_contrato,modalidade,escala,horario,salario,beneficios,experiencia_minima_meses,aceita_sem_experiencia,requisitos_obrigatorios,quantidade_vagas,status,data_inicio,publicar_portal,destaque_portal,atendimento_chatbot,canal_candidatura,candidatura_url,candidatura_email,portal_publicado_em,origem_vaga,idade_minima,exigir_experiencia_compativel,experiencia_revisao_minima_meses,chatbot_estatico_ativo) VALUES($1,$2,$3,$4,$5,$6,$7,NULLIF($8,''),NULLIF($9,''),$10,NULLIF($11,''),NULLIF($12,''),$13,NULLIF($14,''),0,$15,NULLIF($16,''),$17,'ATIVA',CURRENT_DATE,TRUE,FALSE,FALSE,$18,$19,$20,NOW(),'PORTAL_PARCEIRO',18,FALSE,0,FALSE)`, [context.portal.empresa_id, code, parsed.data.titulo, parsed.data.cargo, parsed.data.descricao, parsed.data.cidade, parsed.data.estado, parsed.data.bairro, parsed.data.tipo_contrato, parsed.data.modalidade, parsed.data.escala, parsed.data.horario, normalized.salary, parsed.data.beneficios, checkbox(parsed.data.aceita_sem_experiencia), parsed.data.requisitos, parsed.data.quantidade_vagas, normalized.channel, normalized.url, normalized.email]);
      return res.redirect(303, '/meu-portal');
    } catch (error) { return next(error); }
  });

  app.get('/meu-portal/vagas/:id/editar', requireCompanyAccount, async (req, res, next) => {
    try {
      const context = await requirePortal(req, res);
      if (!context) return;
      const result = await pool.query(`SELECT * FROM vagas WHERE id=$1 AND empresa_id=$2 AND origem_vaga='PORTAL_PARCEIRO' LIMIT 1`, [Number(req.params.id), context.portal.empresa_id]);
      if (!result.rowCount) return res.redirect(303, '/meu-portal');
      return jobFormPage(req, res, next, { data: result.rows[0], editing: true });
    } catch (error) { return next(error); }
  });
  app.post('/meu-portal/vagas/:id/editar', requireCompanyAccount, writeLimiter, async (req, res, next) => {
    try {
      assertCsrf(req);
      const context = await requirePortal(req, res);
      if (!context) return;
      const parsed = jobSchema.safeParse(req.body);
      if (!parsed.success) { res.status(400); return jobFormPage(req, res, next, { data: { ...req.body, id: req.params.id }, errors: fieldErrors(parsed.error.issues), editing: true }); }
      const normalized = normalizeJobInput(parsed.data);
      if (normalized.error) { res.status(400); return jobFormPage(req, res, next, { data: { ...req.body, id: req.params.id }, errors: { candidatura_destino: normalized.error }, editing: true }); }
      const result = await pool.query(`UPDATE vagas SET titulo=$1,cargo=$2,descricao=$3,cidade=$4,estado=$5,bairro=NULLIF($6,''),tipo_contrato=NULLIF($7,''),modalidade=$8,escala=NULLIF($9,''),horario=NULLIF($10,''),salario=$11,beneficios=NULLIF($12,''),aceita_sem_experiencia=$13,requisitos_obrigatorios=NULLIF($14,''),quantidade_vagas=$15,canal_candidatura=$16,candidatura_url=$17,candidatura_email=$18,status=CASE WHEN status='RASCUNHO' THEN 'ATIVA' ELSE status END,data_inicio=COALESCE(data_inicio,CURRENT_DATE),portal_publicado_em=COALESCE(portal_publicado_em,NOW()),updated_at=NOW() WHERE id=$19 AND empresa_id=$20 AND origem_vaga='PORTAL_PARCEIRO' RETURNING id`, [parsed.data.titulo, parsed.data.cargo, parsed.data.descricao, parsed.data.cidade, parsed.data.estado, parsed.data.bairro, parsed.data.tipo_contrato, parsed.data.modalidade, parsed.data.escala, parsed.data.horario, normalized.salary, parsed.data.beneficios, checkbox(parsed.data.aceita_sem_experiencia), parsed.data.requisitos, parsed.data.quantidade_vagas, normalized.channel, normalized.url, normalized.email, Number(req.params.id), context.portal.empresa_id]);
      if (!result.rowCount) return res.redirect(303, '/meu-portal');
      return res.redirect(303, '/meu-portal');
    } catch (error) { return next(error); }
  });
  app.post('/meu-portal/vagas/:id/encerrar', requireCompanyAccount, writeLimiter, async (req, res, next) => {
    try {
      assertCsrf(req);
      const context = await requirePortal(req, res);
      if (!context) return;
      await pool.query(`UPDATE vagas SET status='ENCERRADA',data_encerramento=CURRENT_DATE,updated_at=NOW() WHERE id=$1 AND empresa_id=$2 AND origem_vaga='PORTAL_PARCEIRO'`, [Number(req.params.id), context.portal.empresa_id]);
      return res.redirect(303, '/meu-portal');
    } catch (error) { return next(error); }
  });
  app.post('/meu-portal/vagas/:id/duplicar', requireCompanyAccount, writeLimiter, async (req, res, next) => {
    try {
      assertCsrf(req);
      const context = await requirePortal(req, res);
      if (!context) return;
      const original = await pool.query(`SELECT * FROM vagas WHERE id=$1 AND empresa_id=$2 AND origem_vaga='PORTAL_PARCEIRO' LIMIT 1`, [Number(req.params.id), context.portal.empresa_id]);
      if (!original.rowCount) return res.redirect(303, '/meu-portal');
      const o = original.rows[0];
      const code = `WEB-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(2).toString('hex').toUpperCase()}`;
      const inserted = await pool.query(`INSERT INTO vagas(empresa_id,codigo,titulo,cargo,descricao,cidade,estado,bairro,tipo_contrato,modalidade,escala,horario,salario,beneficios,experiencia_minima_meses,aceita_sem_experiencia,requisitos_obrigatorios,quantidade_vagas,status,data_inicio,publicar_portal,destaque_portal,atendimento_chatbot,canal_candidatura,candidatura_url,candidatura_email,origem_vaga,idade_minima,exigir_experiencia_compativel,experiencia_revisao_minima_meses,chatbot_estatico_ativo) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,0,$15,$16,$17,'RASCUNHO',NULL,TRUE,FALSE,FALSE,$18,$19,$20,'PORTAL_PARCEIRO',18,FALSE,0,FALSE) RETURNING id`, [o.empresa_id, code, `${o.titulo} — cópia`.slice(0, 150), o.cargo, o.descricao, o.cidade, o.estado, o.bairro, o.tipo_contrato, o.modalidade, o.escala, o.horario, o.salario, o.beneficios, o.aceita_sem_experiencia, o.requisitos_obrigatorios, o.quantidade_vagas, o.canal_candidatura, o.candidatura_url, o.candidatura_email]);
      return res.redirect(303, `/meu-portal/vagas/${inserted.rows[0].id}/editar`);
    } catch (error) { return next(error); }
  });

  app.get('/empresas', companiesDirectory);
  app.get('/empresa/:slug', publicCompanyPage);
  app.get('/media/empresas/:slug/:tipo.webp', async (req, res, next) => {
    try {
      const kind = String(req.params.tipo || '').toUpperCase();
      if (!['LOGO', 'CAPA'].includes(kind)) return next();
      const result = await pool.query(`SELECT i.conteudo,i.mime_type,i.updated_at FROM portal_empresa_imagens i JOIN portal_empresas pe ON pe.id=i.portal_empresa_id WHERE pe.slug=$1 AND i.tipo=$2 LIMIT 1`, [String(req.params.slug || ''), kind]);
      if (!result.rowCount) return next();
      res.setHeader('Content-Type', result.rows[0].mime_type || 'image/webp');
      res.setHeader('Cache-Control', 'public, max-age=86400, stale-while-revalidate=604800');
      res.setHeader('ETag', `"company-${req.params.slug}-${kind}-${new Date(result.rows[0].updated_at).getTime()}"`);
      return res.send(result.rows[0].conteudo);
    } catch (error) { return next(error); }
  });

  return {
    async sitemapCompanies() {
      return (await pool.query(`SELECT slug,updated_at,publicado_em FROM portal_empresas WHERE status='ATIVO' ORDER BY updated_at DESC`)).rows;
    },
  };
}

module.exports = { registerCompanyPortalRoutes, PORTAL_STATUS, JOB_STATUSES };
