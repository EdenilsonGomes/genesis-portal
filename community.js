'use strict';

const crypto = require('node:crypto');
const multer = require('multer');
const sharp = require('sharp');
const { rateLimit } = require('express-rate-limit');
const { z } = require('zod');
const { hashPassword, verifyPassword } = require('./lib/security');
const {
  BRAZIL_STATES,
  BRAZIL_STATE_CODES,
  MAIN_STATE_CODES,
  mainCities,
  loadMunicipalities,
  normalizeStateCode,
} = require('./lib/brazil-locations');

const GROUP_CATEGORIES = [
  'Vagas gerais', 'Limpeza e facilities', 'Portaria e segurança', 'Logística',
  'Atendimento e vendas', 'Construção e manutenção', 'Administrativo', 'Tecnologia',
  'Free lances', 'PCD', 'Trabalho temporário',
  'Networking', 'Dicas de carreira',
];

const GROUP_STATUS_LABELS = {
  pending: 'Em análise', approved: 'Publicado', rejected: 'Correção necessária',
  suspended: 'Suspenso', expired: 'Link expirado',
};
const JOB_STATUS_LABELS = {
  PENDENTE: 'Em análise', EM_REVISAO: 'Em revisão', APROVADA: 'Aprovada',
  REJEITADA: 'Correção necessária', CONVERTIDA: 'Criada no painel', CANCELADA: 'Cancelada',
};

function brazilStateSchema(defaultValue = '') {
  return z.preprocess(
    (value) => String(value || defaultValue).trim().toUpperCase(),
    z.enum(BRAZIL_STATE_CODES, { message: 'Selecione um estado válido.' }),
  );
}

const accountSchema = z.object({
  tipo: z.enum(['RECRUTADOR', 'EMPRESA'], { message: 'Escolha Recrutador ou Empresa.' }),
  nome: z.string().trim().min(3, 'Informe seu nome.').max(160),
  email: z.string().trim().email('Informe um e-mail válido.').max(200),
  whatsapp: z.string().trim().min(10, 'Informe um WhatsApp válido.').max(30),
  empresa_nome: z.string().trim().max(180).optional().default(''),
  cnpj: z.string().trim().max(30).optional().default(''),
  cidade: z.string().trim().max(120).optional().default(''),
  estado: brazilStateSchema('SP'),
  senha: z.string().min(8, 'A senha precisa ter pelo menos 8 caracteres.').max(160),
  confirmar_senha: z.string().max(160),
  consentimento_comercial: z.string().optional().default(''),
  aceite_termos: z.string().optional().default(''),
  website: z.string().optional().default(''),
});
const loginSchema = z.object({
  email: z.string().trim().email('Informe um e-mail válido.').max(200),
  senha: z.string().min(1, 'Informe sua senha.').max(160),
});
const groupSchema = z.object({
  invite_url: z.string().trim().url('Informe um convite válido do WhatsApp.').max(1000),
  name: z.string().trim().min(5, 'Informe um nome mais descritivo.').max(160),
  description: z.string().trim().min(30, 'A descrição precisa ter pelo menos 30 caracteres.').max(3000),
  rules: z.string().trim().max(3000).optional().default(''),
  category: z.enum(GROUP_CATEGORIES, { message: 'Escolha uma categoria válida.' }),
  state: brazilStateSchema(),
  city: z.string().trim().min(2, 'Informe a cidade.').max(120),
  region: z.string().trim().max(120).optional().default(''),
  group_type: z.enum(['emprego', 'networking', 'carreira']).default('emprego'),
  admin_only: z.string().optional().default(''),
  accepts_jobs: z.string().optional().default(''),
  accepts_candidate_messages: z.string().optional().default(''),
  charges_members: z.string().optional().default(''),
  preview_image_url: z.string().trim().max(1800).optional().default(''),
  website: z.string().optional().default(''),
});
const jobSchema = z.object({
  empresa_nome: z.string().trim().min(2, 'Informe a empresa.').max(180),
  titulo: z.string().trim().min(4, 'Informe o título da vaga.').max(180),
  cargo: z.string().trim().min(2, 'Informe o cargo.').max(180),
  descricao: z.string().trim().min(50, 'A descrição precisa ter pelo menos 50 caracteres.').max(6000),
  requisitos: z.string().trim().max(4000).optional().default(''),
  beneficios: z.string().trim().max(4000).optional().default(''),
  cidade: z.string().trim().min(2, 'Informe a cidade.').max(120),
  estado: brazilStateSchema(),
  bairro: z.string().trim().max(120).optional().default(''),
  modalidade: z.enum(['Presencial', 'Híbrido', 'Remoto']).default('Presencial'),
  tipo_contrato: z.string().trim().max(60).optional().default(''),
  escala: z.string().trim().max(120).optional().default(''),
  horario: z.string().trim().max(180).optional().default(''),
  salario: z.string().trim().max(30).optional().default(''),
  quantidade_vagas: z.coerce.number().int().min(1).max(999).default(1),
  whatsapp_contato: z.string().trim().max(30).optional().default(''),
  website: z.string().optional().default(''),
});

function registerCommunityRoutes({ app, pool, config, helpers }) {
  const { SITE_URL, PANEL_URL, AUTH_SECRET, SESSION_DAYS, PUBLICATIONS_WEBHOOK_URL, PUBLICATIONS_WEBHOOK_TOKEN, PORTAL_BRAND_NAME = 'Vagas & Grupos', PORTAL_BRAND_TAGLINE = 'Emprego, carreira e networking', APP_VERSION = '13.0.0', LOCATION_FETCH = globalThis.fetch } = config;
  const { escapeHtml, slugify, truncate, metaPage, header, footer, portalHeader, portalFooter, organizationSchema, portalOrganizationSchema, vacancyUrl, listVacancies, formatMoney } = helpers;

  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 4 * 1024 * 1024, files: 1, fields: 40 },
    fileFilter: (_req, file, cb) => {
      const allowed = ['image/jpeg', 'image/png', 'image/webp'].includes(file.mimetype);
      cb(allowed ? null : new Error('Envie uma imagem JPG, PNG ou WEBP.'), allowed);
    },
  });
  function parseGroupImage(req, _res, next) {
    upload.single('image')(req, _res, (error) => {
      req.groupUploadError = error || null;
      next();
    });
  }
  const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 18, standardHeaders: 'draft-8', legacyHeaders: false });
  const publicationLimiter = rateLimit({ windowMs: 60 * 60 * 1000, limit: 24, standardHeaders: 'draft-8', legacyHeaders: false });
  const previewLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: 'draft-8', legacyHeaders: false });

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
  function hmac(value) { return crypto.createHmac('sha256', AUTH_SECRET).update(String(value || '')).digest('hex'); }
  function ipHash(req) { return hmac(String(req.headers['x-forwarded-for'] || req.ip || '').split(',')[0].trim()); }
  function visitorHash(req, daily = false) {
    return hmac(`${ipHash(req)}|${String(req.headers['user-agent'] || '')}|${daily ? new Date().toISOString().slice(0, 10) : 'all'}`).slice(0, 80);
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
    if (req.portalAccount !== undefined) return req.portalAccount;
    const token = cookies(req).genesis_portal_session;
    if (!token || token.length < 30) return (req.portalAccount = null);
    const result = await pool.query(`SELECT c.id,c.tipo,c.nome,c.email,c.whatsapp,c.empresa_nome,c.cnpj,c.cidade,c.estado,c.status,c.lead_status,c.created_at FROM portal_sessoes s JOIN portal_contas c ON c.id=s.conta_id WHERE s.token_hash=$1 AND s.expires_at>NOW() AND c.status='ATIVA' LIMIT 1`, [hmac(token)]);
    req.portalAccount = result.rows[0] || null;
    if (req.portalAccount) void pool.query("UPDATE portal_sessoes SET last_seen_at=NOW() WHERE token_hash=$1 AND last_seen_at < NOW()-INTERVAL '15 minutes'", [hmac(token)]).catch(() => {});
    return req.portalAccount;
  }
  async function createSession(req, res, accountId) {
    const token = crypto.randomBytes(36).toString('base64url');
    const seconds = SESSION_DAYS * 86400;
    await pool.query('DELETE FROM portal_sessoes WHERE expires_at<=NOW()');
    await pool.query(`INSERT INTO portal_sessoes(token_hash,conta_id,ip_hash,user_agent,expires_at) VALUES($1,$2,$3,$4,NOW()+($5::INTEGER*INTERVAL '1 second'))`, [hmac(token), accountId, ipHash(req), String(req.headers['user-agent'] || '').slice(0, 1000), seconds]);
    setCookie(req, res, 'genesis_portal_session', token, { maxAge: seconds });
  }
  async function destroySession(req, res) {
    const token = cookies(req).genesis_portal_session;
    if (token) await pool.query('DELETE FROM portal_sessoes WHERE token_hash=$1', [hmac(token)]).catch(() => {});
    setCookie(req, res, 'genesis_portal_session', '', { maxAge: 0 });
  }
  async function requireAccount(req, res, next) {
    try {
      if (!await currentAccount(req)) return res.redirect(303, `/entrar?retorno=${encodeURIComponent(req.originalUrl)}`);
      return next();
    } catch (error) { return next(error); }
  }
  function checkbox(value) { return ['on', 'true', '1', 'sim', 'yes'].includes(String(value || '').toLowerCase()); }
  function phone(value) { return String(value || '').replace(/\D+/g, '').slice(0, 20); }
  function cleanRedirect(value) { const path = String(value || ''); return path.startsWith('/') && !path.startsWith('//') ? path : '/minha-conta'; }
  function fieldErrors(issues) { return issues.reduce((out, issue) => { const key = issue.path?.[0] || 'geral'; if (!out[key]) out[key] = issue.message; return out; }, {}); }
  function fieldError(errors, key) { return errors?.[key] ? `<small class="field-error">${escapeHtml(errors[key])}</small>` : ''; }
  function flash(req) {
    if (req.query.ok) return `<div class="form-alert success" role="status">${escapeHtml(String(req.query.ok))}</div>`;
    if (req.query.erro) return `<div class="form-alert error" role="alert">${escapeHtml(String(req.query.erro))}</div>`;
    return '';
  }
  function stateOptions(selected = '', { allowBlank = false } = {}) {
    const active = normalizeStateCode(selected);
    const popular = MAIN_STATE_CODES.map((code) => BRAZIL_STATES.find((state) => state.code === code)).filter(Boolean);
    const remaining = BRAZIL_STATES.filter((state) => !MAIN_STATE_CODES.includes(state.code));
    const options = (states) => states.map((state) => `<option value="${state.code}" ${state.code === active ? 'selected' : ''}>${escapeHtml(state.name)}</option>`).join('');
    return `${allowBlank ? '<option value="">Todos os estados</option>' : '<option value="">Selecione o estado</option>'}<optgroup label="Estados mais procurados">${options(popular)}</optgroup><optgroup label="Demais estados">${options(remaining)}</optgroup>`;
  }
  function initialCityOptions(state, selected = '', { allowBlank = false } = {}) {
    const active = String(selected || '').trim();
    const featured = mainCities(state);
    const featuredKeys = new Set(featured.map((city) => city.toLocaleLowerCase('pt-BR')));
    const options = featured.map((city) => `<option value="${escapeHtml(city)}" ${city.toLocaleLowerCase('pt-BR') === active.toLocaleLowerCase('pt-BR') ? 'selected' : ''}>${escapeHtml(city)}</option>`).join('');
    const preserved = active && !featuredKeys.has(active.toLocaleLowerCase('pt-BR')) ? `<option value="${escapeHtml(active)}" selected>${escapeHtml(active)}</option>` : '';
    return `<option value="">${allowBlank ? 'Todas as cidades' : 'Selecione a cidade'}</option>${preserved ? `<optgroup label="Cidade informada">${preserved}</optgroup>` : ''}${options ? `<optgroup label="Principais cidades">${options}</optgroup>` : ''}`;
  }
  function locationSelects({ stateName = 'estado', cityName = 'cidade', state = 'SP', city = '', required = true, allowBlank = false, stateError = '', cityError = '' } = {}) {
    const safeState = normalizeStateCode(state);
    const requirement = required ? ' required' : '';
    return `<div class="form-grid two location-picker-grid" data-location-picker><label>Estado<select name="${escapeHtml(stateName)}" autocomplete="address-level1" data-location-state${requirement}>${stateOptions(safeState, { allowBlank })}</select>${stateError}</label><label>Cidade<select name="${escapeHtml(cityName)}" autocomplete="address-level2" data-location-city data-selected-city="${escapeHtml(city)}"${requirement}>${initialCityOptions(safeState, city, { allowBlank })}</select><small class="location-help" data-location-status aria-live="polite">Selecione o estado para carregar todas as cidades.</small>${cityError}</label></div>`;
  }
  function inviteCode(value) {
    try {
      const url = new URL(String(value || '').trim());
      if (!['chat.whatsapp.com', 'www.chat.whatsapp.com'].includes(url.hostname.toLowerCase())) return null;
      const code = url.pathname.split('/').filter(Boolean)[0] || '';
      return /^[A-Za-z0-9_-]{10,120}$/.test(code) ? code : null;
    } catch { return null; }
  }
  function inviteHash(value) { const code = inviteCode(value); return code ? crypto.createHash('sha256').update(code).digest('hex') : null; }
  function statusPill(status, labels) {
    const s = String(status || '');
    const l = s.toLowerCase();
    const tone = ['approved', 'aprovada', 'convertida'].includes(l) ? 'success' : ['rejected', 'rejeitada', 'suspended', 'cancelada'].includes(l) ? 'danger' : l === 'expired' ? 'warning' : 'neutral';
    return `<span class="status-pill ${tone}">${escapeHtml(labels[s] || labels[s.toUpperCase()] || s)}</span>`;
  }
  function pageHeader(account, active = 'grupos', compactSearch = true) { return portalHeader({ account, active, compactSearch }); }
  async function notify(event, data) {
    if (!PUBLICATIONS_WEBHOOK_URL) return;
    try {
      await fetch(PUBLICATIONS_WEBHOOK_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: PUBLICATIONS_WEBHOOK_TOKEN, event, source: 'vagas-e-grupos', data }), signal: AbortSignal.timeout(8000) });
    } catch (error) { console.error(`Falha ao notificar ${event}:`, error.message); }
  }
  function groupImageUrl(group) {
    if (group.has_image) return `${SITE_URL}/media/grupos/${group.id}.webp?v=${encodeURIComponent(String(group.image_updated_at || group.updated_at || '1'))}`;
    return group.image_url || `${SITE_URL}/assets/vagas-grupos-mark.svg`;
  }
  function authPage(req, res, { title, subtitle, content, mode = 'login' }) {
    return metaPage({
      title,
      description: subtitle,
      canonical: `${SITE_URL}${req.path}`,
      image: `${SITE_URL}/assets/vagas-grupos-social.png`,
      bodyClass: `light-page directory-site directory-auth-page ${mode === 'register' ? 'is-register' : 'is-login'}`,
      robots: 'noindex,nofollow',
      nonce: res.locals.cspNonce,
      siteName: PORTAL_BRAND_NAME,
      titleSuffix: PORTAL_BRAND_NAME,
      favicon: '/assets/vagas-grupos-mark.svg',
      themeColor: '#19ad5b',
      structuredData: [],
      content: `${pageHeader(null, '', false)}<main id="conteudo" class="directory-auth-main"><div class="directory-auth-shell"><section class="directory-auth-intro"><a class="auth-brand" href="/grupos"><img src="/assets/vagas-grupos-mark.svg" width="58" height="58" alt=""><span><b>${escapeHtml(PORTAL_BRAND_NAME)}</b><small>${escapeHtml(PORTAL_BRAND_TAGLINE)}</small></span></a><span class="auth-kicker">Área de publicadores</span><h1>${escapeHtml(title)}</h1><p>${escapeHtml(subtitle)}</p><div class="auth-trust"><span>✓ Publicação gratuita</span><span>✓ Moderação humana</span><span>✓ Métricas básicas</span></div></section><section class="directory-auth-card">${content}</section></div></main>${portalFooter()}`,
    });
  }

  function registrationPage(req, res, { errors = {}, values = {} } = {}) {
    const token = csrf(req, res);
    const content = `${flash(req)}<div class="auth-card-heading"><h2>Comece agora</h2><p>Leva menos de dois minutos.</p></div>
      <form method="post" action="/cadastro" class="stack-form" novalidate>
        <input type="hidden" name="csrf_token" value="${escapeHtml(token)}"><input class="honeypot" name="website" tabindex="-1" autocomplete="off">
        <fieldset class="account-type-picker"><legend>Como você atua?</legend>
          <label><input type="radio" name="tipo" value="RECRUTADOR" ${values.tipo !== 'EMPRESA' ? 'checked' : ''}><span><b>Recrutador</b><small>RH, consultoria, autônomo ou administrador de grupos.</small></span></label>
          <label><input type="radio" name="tipo" value="EMPRESA" ${values.tipo === 'EMPRESA' ? 'checked' : ''}><span><b>Empresa</b><small>Organização contratante com equipe ou responsável de RH.</small></span></label>
        </fieldset>${fieldError(errors, 'tipo')}
        <div class="form-grid two"><label>Nome completo<input name="nome" value="${escapeHtml(values.nome || '')}" autocomplete="name" required>${fieldError(errors, 'nome')}</label><label>WhatsApp<input name="whatsapp" value="${escapeHtml(values.whatsapp || '')}" autocomplete="tel" inputmode="tel" required>${fieldError(errors, 'whatsapp')}</label></div>
        <label>E-mail profissional<input type="email" name="email" value="${escapeHtml(values.email || '')}" autocomplete="email" required>${fieldError(errors, 'email')}</label>
        <div class="form-grid two"><label>Empresa ou consultoria<input name="empresa_nome" value="${escapeHtml(values.empresa_nome || '')}" autocomplete="organization">${fieldError(errors, 'empresa_nome')}</label><label>CNPJ <span class="optional">opcional</span><input name="cnpj" value="${escapeHtml(values.cnpj || '')}" inputmode="numeric"></label></div>
        ${locationSelects({ state: values.estado || 'SP', city: values.cidade || '', required: false, stateError: fieldError(errors, 'estado'), cityError: fieldError(errors, 'cidade') })}
        <div class="form-grid two"><label>Senha<input type="password" name="senha" minlength="8" autocomplete="new-password" required>${fieldError(errors, 'senha')}</label><label>Confirmar senha<input type="password" name="confirmar_senha" minlength="8" autocomplete="new-password" required>${fieldError(errors, 'confirmar_senha')}</label></div>
        <label class="check-field"><input type="checkbox" name="aceite_termos" required ${values.aceite_termos ? 'checked' : ''}><span>Li e aceito os <a href="/termos" target="_blank" rel="noopener">Termos de uso</a> e a <a href="/privacidade" target="_blank" rel="noopener">Política de privacidade</a>.</span></label>${fieldError(errors, 'aceite_termos')}
        <label class="check-field"><input type="checkbox" name="consentimento_comercial" ${values.consentimento_comercial ? 'checked' : ''}><span>Autorizo contato da Gênesis sobre recrutamento e divulgação. <small>Opcional.</small></span></label>
        ${errors.geral ? `<div class="form-alert error">${escapeHtml(errors.geral)}</div>` : ''}
        <button class="btn btn-primary btn-block btn-lg" type="submit">Criar minha conta</button><p class="form-switch">Já possui conta? <a href="/entrar">Entrar</a></p>
      </form>`;
    return authPage(req, res, { title: 'Crie sua conta gratuita', subtitle: 'Cadastre grupos, envie vagas e acompanhe o status das suas publicações em um só lugar.', content, mode: 'register' });
  }

  function loginPage(req, res, { errors = {}, values = {} } = {}) {
    const token = csrf(req, res);
    const retorno = cleanRedirect(req.query.retorno || values.retorno || '/minha-conta');
    const content = `${flash(req)}<div class="auth-card-heading"><h2>Acessar conta</h2><p>Use o e-mail e a senha cadastrados.</p></div>
      <form method="post" action="/entrar" class="stack-form" novalidate><input type="hidden" name="csrf_token" value="${escapeHtml(token)}"><input type="hidden" name="retorno" value="${escapeHtml(retorno)}">
        <label>E-mail<input type="email" name="email" value="${escapeHtml(values.email || '')}" autocomplete="email" required>${fieldError(errors, 'email')}</label>
        <label>Senha<input type="password" name="senha" autocomplete="current-password" required>${fieldError(errors, 'senha')}</label>
        ${errors.geral ? `<div class="form-alert error">${escapeHtml(errors.geral)}</div>` : ''}
        <button class="btn btn-primary btn-block btn-lg" type="submit">Entrar</button><p class="form-switch">Ainda não possui conta? <a href="/cadastro">Criar conta gratuita</a></p>
      </form>${PANEL_URL ? `<div class="operational-login"><span>Já é cliente da Gênesis?</span><a href="${escapeHtml(PANEL_URL)}/login">Acessar painel operacional →</a></div>` : ''}`;
    return authPage(req, res, { title: 'Entre na sua conta', subtitle: 'Acesse seus grupos, vagas enviadas e métricas de desempenho.', content, mode: 'login' });
  }

  function groupCard(group, compact = false) {
    const location = [group.region, group.city, group.state].filter(Boolean).join(' · ');
    return `<article class="group-card${group.featured ? ' featured' : ''}"><a class="group-card-image" href="/grupo/${escapeHtml(group.slug)}" aria-label="Ver grupo ${escapeHtml(group.name)}"><img src="${escapeHtml(groupImageUrl(group))}" alt="Foto do grupo ${escapeHtml(group.name)}" width="360" height="220" loading="lazy">${group.featured ? '<span class="group-featured">Destaque</span>' : ''}${group.verified ? '<span class="group-image-verified" title="Link verificado">✓</span>' : ''}</a><div class="group-card-body"><div class="group-card-tags"><a href="/grupos/categoria/${slugify(group.category)}">${escapeHtml(group.category)}</a></div><h3><a href="/grupo/${escapeHtml(group.slug)}">${escapeHtml(group.name)}</a></h3><p class="group-location"><span aria-hidden="true">⌖</span> ${escapeHtml(location || 'Brasil')}</p><p class="group-description">${escapeHtml(truncate(group.description, compact ? 95 : 130))}</p><div class="group-card-stats"><span><b>${Number(group.click_count || 0).toLocaleString('pt-BR')}</b> acessos</span>${group.admin_only ? '<span>Somente admins</span>' : '<span>Comunidade aberta</span>'}</div><a class="group-card-button" href="/grupo/${escapeHtml(group.slug)}">Ver grupo</a></div></article>`;
  }

  async function listGroups({ q = '', category = '', state = '', city = '', page = 1, pageSize = 18 }) {
    const clauses = ["g.status='approved'"];
    const values = [];
    const add = (value) => { values.push(value); return `$${values.length}`; };
    if (q) { const p = add(`%${q}%`); clauses.push(`(g.name ILIKE ${p} OR g.description ILIKE ${p} OR g.city ILIKE ${p} OR COALESCE(g.region,'') ILIKE ${p})`); }
    if (category) clauses.push(`g.category=${add(category)}`);
    if (state) clauses.push(`UPPER(g.state)=UPPER(${add(state)})`);
    if (city) clauses.push(`LOWER(g.city)=LOWER(${add(city)})`);
    values.push(pageSize, (page - 1) * pageSize);
    const result = await pool.query(`SELECT g.*,(img.grupo_id IS NOT NULL) has_image,img.updated_at image_updated_at,COALESCE(v.c,0)::INTEGER view_count,COALESCE(k.c,0)::INTEGER click_count,COUNT(*) OVER()::INTEGER total_count FROM gg_groups g LEFT JOIN portal_grupo_imagens img ON img.grupo_id=g.id LEFT JOIN LATERAL(SELECT COUNT(*) c FROM gg_group_views x WHERE x.group_id=g.id)v ON TRUE LEFT JOIN LATERAL(SELECT COUNT(*) c FROM gg_group_clicks x WHERE x.group_id=g.id)k ON TRUE WHERE ${clauses.join(' AND ')} ORDER BY g.featured DESC,g.verified DESC,g.last_verified_at DESC NULLS LAST,g.created_at DESC LIMIT $${values.length - 1} OFFSET $${values.length}`, values);
    return { groups: result.rows, total: result.rows[0]?.total_count || 0 };
  }

  function collectionSchema(groups, canonical, title) {
    return { '@context': 'https://schema.org', '@type': 'CollectionPage', name: title, url: canonical, mainEntity: { '@type': 'ItemList', itemListElement: groups.slice(0, 30).map((group, index) => ({ '@type': 'ListItem', position: index + 1, url: `${SITE_URL}/grupo/${group.slug}`, name: group.name })) } };
  }

  async function directoryPage(req, res, next, fixed = {}) {
    try {
      const q = String(req.query.q || '').trim().slice(0, 120);
      const category = fixed.category || String(req.query.categoria || '').trim().slice(0, 80);
      const state = fixed.state || String(req.query.uf || '').trim().slice(0, 2);
      const city = fixed.city || String(req.query.cidade || '').trim().slice(0, 120);
      const page = Math.max(1, Number.parseInt(req.query.pagina, 10) || 1);
      const data = await listGroups({ q, category, state, city, page });
      const pages = Math.max(1, Math.ceil(data.total / 18));
      const account = await currentAccount(req);
      const canonicalPath = fixed.canonicalPath || '/grupos';
      const canonical = `${SITE_URL}${canonicalPath}${page > 1 ? `?pagina=${page}` : ''}`;
      const title = fixed.title || (category ? `Grupos de ${category}` : city ? `Grupos de emprego em ${city}` : 'Grupos de emprego, carreira e networking');
      const description = fixed.description || `Encontre grupos de emprego, networking e dicas de carreira${city ? ` em ${city}` : ''}. Links revisados e vagas relacionadas.`;
      const pagination = Array.from({ length: Math.min(pages, 7) }, (_, i) => i + 1).map((n) => { const params = new URLSearchParams(req.query); params.set('pagina', String(n)); return n === page ? `<span class="active">${n}</span>` : `<a href="${escapeHtml(req.path)}?${escapeHtml(params.toString())}">${n}</a>`; }).join('');
      // Buscas livres e filtros via query string não devem competir no Google com
      // as páginas canônicas de categoria e localização. Na V12 esta declaração
      // foi removida por engano, causando ReferenceError em /grupos.
      const searchPage = Boolean(
        q ||
        (!fixed.category && req.query.categoria) ||
        (!fixed.city && req.query.cidade) ||
        (!fixed.state && req.query.uf)
      );
      const content = `${pageHeader(account, 'grupos')}<main id="conteudo" class="groups-directory directory-main"><section class="directory-hero"><div class="directory-container"><div class="directory-hero-copy"><nav class="directory-breadcrumb"><a href="/">Gênesis</a><span>›</span><b>Grupos</b></nav><h1>${escapeHtml(title)}</h1><p>${escapeHtml(description)}</p></div><form class="directory-search" action="/grupos" method="get"><label class="directory-search-main"><span>Buscar grupos</span><input name="q" value="${escapeHtml(q)}" placeholder="Ex.: vagas zona sul, limpeza, primeiro emprego"></label><label><span>Categoria</span><select name="categoria"><option value="">Todas as categorias</option>${GROUP_CATEGORIES.map((item) => `<option ${item === category ? 'selected' : ''}>${escapeHtml(item)}</option>`).join('')}</select></label><label><span>Cidade</span><input name="cidade" value="${escapeHtml(city)}" placeholder="São Paulo"></label><button class="directory-search-button" type="submit">Buscar</button></form><div class="category-scroller"><a class="${!category ? 'active' : ''}" href="/grupos">Todos</a>${GROUP_CATEGORIES.slice(0, 11).map((item) => `<a class="${item === category ? 'active' : ''}" href="/grupos/categoria/${slugify(item)}">${escapeHtml(item)}</a>`).join('')}</div></div></section><section class="directory-container directory-results"><div class="directory-results-toolbar"><div><h2>${data.total.toLocaleString('pt-BR')} grupo${data.total === 1 ? '' : 's'} encontrado${data.total === 1 ? '' : 's'}</h2><p>Links revisados antes da publicação.</p></div><div class="directory-toolbar-actions"><a href="/vagas">Ver vagas</a><a class="directory-outline-button" href="${account ? '/minha-conta/grupos/novo' : '/cadastro'}">+ Cadastrar grupo</a></div></div>${data.groups.length ? `<div class="group-grid">${data.groups.map((group) => groupCard(group)).join('')}</div>${pages > 1 ? `<nav class="pagination">${pagination}</nav>` : ''}` : `<div class="empty-state"><h3>Nenhum grupo encontrado</h3><p>Tente outra busca ou seja o primeiro a cadastrar uma comunidade nessa categoria.</p><a class="directory-primary-button" href="${account ? '/minha-conta/grupos/novo' : '/cadastro'}">Cadastrar grupo</a></div>`}</section><section class="directory-container directory-publisher-strip"><div><span>Para recrutadores e administradores</span><h2>Divulgue seu grupo gratuitamente</h2><p>Crie uma conta, envie o convite e acompanhe acessos após a aprovação.</p></div><a class="directory-primary-button" href="${account ? '/minha-conta/grupos/novo' : '/cadastro'}">Cadastrar meu grupo</a></section><section class="directory-container directory-business-cta"><div><span>Precisa contratar melhor?</span><h2>A Gênesis organiza candidatos, triagem e entrevistas.</h2><p>O portal ajuda na divulgação. A Gênesis cuida do processo seletivo.</p></div><a class="directory-business-button" href="/anunciar-vaga">Conhecer a Gênesis</a></section></main>${portalFooter()}`;
      return res.send(metaPage({ title, description, canonical, image: `${SITE_URL}/assets/vagas-grupos-social.png`, bodyClass: 'light-page directory-site', nonce: res.locals.cspNonce, robots: searchPage ? 'noindex,follow,max-image-preview:large' : 'index,follow,max-image-preview:large', siteName: PORTAL_BRAND_NAME, titleSuffix: PORTAL_BRAND_NAME, favicon: '/assets/vagas-grupos-mark.svg', themeColor: '#19ad5b', structuredData: [portalOrganizationSchema(), collectionSchema(data.groups, canonical, title)], content }));
    } catch (error) { return next(error); }
  }

  async function loadGroup(slug) {
    const result = await pool.query(`SELECT g.*,(img.grupo_id IS NOT NULL)has_image,img.updated_at image_updated_at,COALESCE(v.c,0)::INTEGER view_count,COALESCE(k.c,0)::INTEGER click_count,pc.nome publisher_name,pc.empresa_nome publisher_company FROM gg_groups g LEFT JOIN portal_grupo_imagens img ON img.grupo_id=g.id LEFT JOIN portal_contas pc ON pc.id=g.owner_account_id LEFT JOIN LATERAL(SELECT COUNT(*) c FROM gg_group_views x WHERE x.group_id=g.id)v ON TRUE LEFT JOIN LATERAL(SELECT COUNT(*) c FROM gg_group_clicks x WHERE x.group_id=g.id)k ON TRUE WHERE g.slug=$1 AND g.status='approved' LIMIT 1`, [slug]);
    return result.rows[0] || null;
  }
  async function relatedGroups(group) {
    const result = await pool.query(`SELECT g.*,(img.grupo_id IS NOT NULL)has_image,img.updated_at image_updated_at,COALESCE(k.c,0)::INTEGER click_count FROM gg_groups g LEFT JOIN portal_grupo_imagens img ON img.grupo_id=g.id LEFT JOIN LATERAL(SELECT COUNT(*) c FROM gg_group_clicks x WHERE x.group_id=g.id)k ON TRUE WHERE g.status='approved' AND g.id<>$1 AND (LOWER(g.city)=LOWER($2) OR g.category=$3) ORDER BY (LOWER(g.city)=LOWER($2)) DESC,(g.category=$3) DESC,g.featured DESC,g.created_at DESC LIMIT 4`, [group.id, group.city, group.category]);
    return result.rows;
  }

  async function groupDetailPage(req, res, next) {
    try {
      const group = await loadGroup(String(req.params.slug || '').slice(0, 190));
      if (!group) return next();
      const account = await currentAccount(req);
      await pool.query('INSERT INTO gg_group_views(group_id,visitor_day_hash,source) VALUES($1,$2,$3) ON CONFLICT DO NOTHING', [group.id, visitorHash(req, true), String(req.get('referer') || '').slice(0, 240)]).catch(() => {});
      const [related, jobs] = await Promise.all([
        relatedGroups(group),
        listVacancies({ query: '', city: group.city, modality: '', page: 1, pageSize: 4 }).catch(() => ({ vacancies: [] })),
      ]);
      const location = [group.region, group.city, group.state].filter(Boolean).join(' · ');
      const canonical = `${SITE_URL}/grupo/${group.slug}`;
      const title = group.seo_title || `${group.name} — grupo de emprego em ${group.city}`;
      const description = group.seo_description || truncate(`${group.description} Veja regras, vagas relacionadas e o convite atualizado.`, 300);
      const token = csrf(req, res);
      const schema = { '@context': 'https://schema.org', '@type': 'WebPage', name: group.name, description, url: canonical, primaryImageOfPage: groupImageUrl(group), about: { '@type': 'Thing', name: group.category }, breadcrumb: { '@type': 'BreadcrumbList', itemListElement: [{ '@type': 'ListItem', position: 1, name: 'Início', item: SITE_URL }, { '@type': 'ListItem', position: 2, name: 'Grupos', item: `${SITE_URL}/grupos` }, { '@type': 'ListItem', position: 3, name: group.name, item: canonical }] } };
      const content = `${pageHeader(account, 'grupos')}<main id="conteudo" class="group-detail-page directory-main"><section class="group-detail-hero"><div class="container"><nav class="breadcrumbs"><a href="/">Início</a><span>›</span><a href="/grupos">Grupos</a><span>›</span><span>${escapeHtml(group.category)}</span></nav><div class="group-detail-head"><img src="${escapeHtml(groupImageUrl(group))}" alt="Foto do grupo ${escapeHtml(group.name)}" width="220" height="220"><div><div class="group-card-tags"><span>${escapeHtml(group.category)}</span>${group.verified ? '<span class="verified-chip">✓ Link verificado</span>' : ''}${group.official ? '<span class="official-chip">Grupo oficial</span>' : ''}</div><h1>${escapeHtml(group.name)}</h1><p>⌖ ${escapeHtml(location)}</p><div class="group-detail-stats"><span><b>${Number(group.view_count || 0).toLocaleString('pt-BR')}</b> visualizações</span><span><b>${Number(group.click_count || 0).toLocaleString('pt-BR')}</b> acessos</span></div></div></div></div></section><section class="container group-detail-layout"><article class="group-detail-content"><section class="content-card"><h2>Sobre este grupo</h2><p class="long-copy">${escapeHtml(group.description)}</p></section>${group.rules ? `<section class="content-card"><h2>Regras da comunidade</h2><p class="long-copy pre-line">${escapeHtml(group.rules)}</p></section>` : ''}<section class="content-card trust-notice"><h2>Participe com segurança</h2><ul><li>O portal não cobra candidatos para acessar grupos ou vagas.</li><li>Não envie senhas, códigos ou pagamentos para desconhecidos.</li><li>Use a denúncia se o conteúdo não corresponder à página.</li></ul></section></article><aside class="group-action-card"><span class="group-action-kicker">Convite externo</span><h2>Entrar no grupo</h2><p>Você será direcionado ao WhatsApp. Confira o nome da comunidade antes de participar.</p>${group.invite_url ? `<a class="btn btn-primary btn-lg btn-block" href="/r/grupo/${group.id}" rel="nofollow" data-track="CTA_ENTRAR_GRUPO">Abrir no WhatsApp</a>` : '<button class="btn btn-ghost btn-block" disabled>Convite indisponível</button>'}<div class="group-safety-meta"><span>${group.admin_only ? '✓ Somente administradores publicam' : '• Participantes podem conversar'}</span><span>${group.accepts_jobs ? '✓ Aceita divulgação de vagas' : '• Divulgação não confirmada'}</span></div><button class="text-button" type="button" data-report-toggle>Denunciar este grupo</button><form class="report-form" method="post" action="/grupo/${escapeHtml(group.slug)}/denunciar"><input type="hidden" name="csrf_token" value="${escapeHtml(token)}"><label>Motivo<select name="reason" required><option value="link_expirado">Link expirado</option><option value="grupo_diferente">Grupo diferente da descrição</option><option value="vaga_falsa">Vaga falsa ou golpe</option><option value="cobranca">Cobrança de candidato</option><option value="spam">Spam ou conteúdo impróprio</option><option value="outro">Outro</option></select></label><label>Detalhes<textarea name="details" rows="4" maxlength="1200"></textarea></label><label>Contato <span class="optional">opcional</span><input name="contact" maxlength="180"></label><button class="btn btn-dark btn-block" type="submit">Enviar denúncia</button></form></aside></section>${jobs.vacancies?.length ? `<section class="container related-section"><div class="results-head"><div><h2>Vagas abertas em ${escapeHtml(group.city)}</h2><span>Oportunidades relacionadas à região</span></div><a href="/vagas?cidade=${encodeURIComponent(group.city)}">Ver todas →</a></div><div class="related-job-grid">${jobs.vacancies.map((job) => `<a class="related-job-card" href="${escapeHtml(vacancyUrl(job))}"><span>${escapeHtml(job.empresa_nome || 'Empresa contratante')}</span><h3>${escapeHtml(job.titulo)}</h3><p>${escapeHtml([job.bairro, job.cidade, job.estado].filter(Boolean).join(' · '))}</p>${job.salario ? `<b>${escapeHtml(formatMoney(job.salario))}</b>` : '<b>Consulte detalhes</b>'}</a>`).join('')}</div></section>` : ''}${related.length ? `<section class="container related-section"><div class="results-head"><div><h2>Outros grupos relacionados</h2><span>Comunidades da mesma região ou categoria</span></div><a href="/grupos">Explorar diretório →</a></div><div class="group-grid compact">${related.map((item) => groupCard(item, true)).join('')}</div></section>` : ''}</main>${portalFooter()}`;
      return res.send(metaPage({ title, description, canonical, image: groupImageUrl(group), bodyClass: 'light-page directory-site', nonce: res.locals.cspNonce, siteName: PORTAL_BRAND_NAME, titleSuffix: PORTAL_BRAND_NAME, favicon: '/assets/vagas-grupos-mark.svg', themeColor: '#19ad5b', structuredData: [portalOrganizationSchema(), schema], content }));
    } catch (error) { return next(error); }
  }

  async function accountDashboard(req, res, next) {
    try {
      const account = await currentAccount(req);
      const [groups, jobs] = await Promise.all([
        pool.query(`SELECT g.*,COALESCE(v.c,0)::INTEGER view_count,COALESCE(k.c,0)::INTEGER click_count FROM gg_groups g LEFT JOIN LATERAL(SELECT COUNT(*) c FROM gg_group_views x WHERE x.group_id=g.id)v ON TRUE LEFT JOIN LATERAL(SELECT COUNT(*) c FROM gg_group_clicks x WHERE x.group_id=g.id)k ON TRUE WHERE g.owner_account_id=$1 ORDER BY g.created_at DESC`, [account.id]),
        pool.query('SELECT * FROM portal_vagas_submissoes WHERE conta_id=$1 ORDER BY created_at DESC', [account.id]),
      ]);
      const token = csrf(req, res);
      const content = `${pageHeader(account)}<main id="conteudo" class="account-main"><section class="account-hero"><div class="container account-hero-row"><div><span class="eyebrow">${account.tipo === 'EMPRESA' ? 'Empresa' : 'Recrutador'}</span><h1>Olá, ${escapeHtml(account.nome.split(' ')[0])}</h1><p>Gerencie seus grupos e vagas enviados ao Vagas & Grupos.</p></div><form method="post" action="/sair"><input type="hidden" name="csrf_token" value="${escapeHtml(token)}"><button class="btn btn-ghost" type="submit">Sair</button></form></div></section><section class="container account-content">${flash(req)}<div class="account-kpis"><article><span>Grupos</span><b>${groups.rowCount}</b><small>${groups.rows.filter((item) => item.status === 'approved').length} publicados</small></article><article><span>Vagas enviadas</span><b>${jobs.rowCount}</b><small>${jobs.rows.filter((item) => item.status === 'CONVERTIDA').length} no painel</small></article><article><span>Acessos aos grupos</span><b>${groups.rows.reduce((sum, item) => sum + Number(item.click_count || 0), 0).toLocaleString('pt-BR')}</b><small>cliques rastreados</small></article></div><div class="account-actions"><a class="btn btn-primary" href="/minha-conta/grupos/novo">+ Cadastrar grupo</a><a class="btn btn-dark" href="/minha-conta/vagas/nova">+ Enviar vaga</a><a class="btn btn-ghost" href="/anunciar-vaga">Quero automatizar o recrutamento</a></div><section class="account-section"><div class="section-title-row"><div><h2>Meus grupos</h2><p>Acompanhe análise, correções e desempenho.</p></div></div>${groups.rows.length ? `<div class="management-list">${groups.rows.map((group) => `<article><div><div class="management-title"><h3>${escapeHtml(group.name)}</h3>${statusPill(group.status, GROUP_STATUS_LABELS)}</div><p>${escapeHtml([group.region, group.city, group.state].filter(Boolean).join(' · '))}</p>${group.rejection_reason ? `<div class="moderation-feedback"><b>Motivo da revisão:</b> ${escapeHtml(group.rejection_reason)}</div>` : ''}</div><div class="management-metrics"><span><b>${Number(group.view_count || 0).toLocaleString('pt-BR')}</b> visualizações</span><span><b>${Number(group.click_count || 0).toLocaleString('pt-BR')}</b> acessos</span><a href="/minha-conta/grupos/${group.id}/editar">Editar</a>${group.status === 'approved' ? `<a href="/grupo/${escapeHtml(group.slug)}">Ver página</a>` : ''}</div></article>`).join('')}</div>` : '<div class="empty-state"><h3>Nenhum grupo cadastrado</h3><p>Cadastre uma comunidade de emprego, networking ou carreira.</p></div>'}</section><section class="account-section"><div class="section-title-row"><div><h2>Vagas enviadas</h2><p>A aprovação cria um rascunho no painel oficial.</p></div></div>${jobs.rows.length ? `<div class="management-list">${jobs.rows.map((job) => `<article><div><div class="management-title"><h3>${escapeHtml(job.titulo)}</h3>${statusPill(job.status, JOB_STATUS_LABELS)}</div><p>${escapeHtml(job.empresa_nome)} · ${escapeHtml([job.bairro, job.cidade, job.estado].filter(Boolean).join(' · '))}</p>${job.rejection_reason ? `<div class="moderation-feedback"><b>Motivo da revisão:</b> ${escapeHtml(job.rejection_reason)}</div>` : ''}</div><div class="management-metrics"><span>${new Date(job.created_at).toLocaleDateString('pt-BR')}</span>${job.vaga_id ? `<a href="/vagas/${job.vaga_id}">Ver no portal</a>` : ''}</div></article>`).join('')}</div>` : '<div class="empty-state"><h3>Nenhuma vaga enviada</h3><p>Envie uma oportunidade para análise da equipe.</p></div>'}</section></section></main>${portalFooter()}`;
      return res.send(metaPage({ title: 'Minha conta', description: 'Gerencie seus grupos e vagas no Vagas & Grupos.', canonical: `${SITE_URL}/minha-conta`, image: `${SITE_URL}/assets/vagas-grupos-social.png`, bodyClass: 'light-page directory-site', nonce: res.locals.cspNonce, robots: 'noindex,nofollow', siteName: PORTAL_BRAND_NAME, titleSuffix: PORTAL_BRAND_NAME, favicon: '/assets/vagas-grupos-mark.svg', themeColor: '#19ad5b', structuredData: [], content }));
    } catch (error) { return next(error); }
  }

  async function groupFormPage(req, res, next, { group = null, errors = {}, values = {} } = {}) {
    try {
      const account = await currentAccount(req);
      const data = { ...(group || {}), ...values };
      const token = csrf(req, res);
      const action = group ? `/minha-conta/grupos/${group.id}/editar` : '/minha-conta/grupos/novo';
      const title = group ? 'Editar grupo' : 'Cadastrar grupo';
      const existingImageUrl = group ? `/media/grupos/${group.id}.webp?v=${Date.now()}` : '/assets/vagas-grupos-mark.svg';
      const content = `${pageHeader(account)}<main id="conteudo" class="form-page"><section class="form-page-head"><div class="container"><a href="/minha-conta">← Minha conta</a><span class="eyebrow">Publicação moderada</span><h1>${title}</h1><p>Cole o convite para tentar preencher nome, descrição e foto. Revise tudo antes de enviar.</p></div></section><section class="container form-page-layout">${flash(req)}<form method="post" action="${action}" enctype="multipart/form-data" class="publication-form" data-group-form novalidate><input type="hidden" name="csrf_token" value="${escapeHtml(token)}"><input type="hidden" name="preview_image_url" value="${escapeHtml(data.preview_image_url || '')}" data-preview-image-url><input class="honeypot" name="website" tabindex="-1" autocomplete="off"><section class="form-panel"><div class="form-panel-title"><span>1</span><div><h2>Convite do WhatsApp</h2><p>Usamos o link para direcionar interessados e verificar dados públicos.</p></div></div><div class="invite-fetch-row"><label>Link do convite<input type="url" name="invite_url" value="${escapeHtml(data.invite_url || '')}" placeholder="https://chat.whatsapp.com/..." required data-invite-input>${fieldError(errors, 'invite_url')}</label><button class="btn btn-dark" type="button" data-fetch-group>Buscar dados</button></div><div class="fetch-feedback" data-fetch-feedback></div></section><section class="form-panel"><div class="form-panel-title"><span>2</span><div><h2>Apresentação</h2><p>Textos claros ajudam o grupo a aparecer no Google.</p></div></div><label>Nome do grupo<input name="name" value="${escapeHtml(data.name || '')}" maxlength="160" required data-group-name>${fieldError(errors, 'name')}</label><label>Descrição<textarea name="description" rows="6" maxlength="3000" required data-group-description>${escapeHtml(data.description || '')}</textarea>${fieldError(errors, 'description')}</label><label>Regras <span class="optional">opcional</span><textarea name="rules" rows="5" maxlength="3000">${escapeHtml(data.rules || '')}</textarea></label><div class="image-upload-field"><img class="image-preview" data-image-preview src="${escapeHtml(existingImageUrl)}" alt="Prévia da foto do grupo"><label>Foto do grupo <span class="optional">JPG, PNG ou WEBP até 4 MB</span><input type="file" name="image" accept="image/jpeg,image/png,image/webp" data-image-input></label></div></section><section class="form-panel"><div class="form-panel-title"><span>3</span><div><h2>Categoria e localização</h2><p>Esses dados conectam a comunidade às vagas certas.</p></div></div><div class="form-grid two"><label>Categoria<select name="category" required><option value="">Selecione</option>${GROUP_CATEGORIES.map((item) => `<option ${item === data.category ? 'selected' : ''}>${escapeHtml(item)}</option>`).join('')}</select>${fieldError(errors, 'category')}</label><label>Tipo<select name="group_type"><option value="emprego" ${!['networking', 'carreira'].includes(data.group_type) ? 'selected' : ''}>Emprego</option><option value="networking" ${data.group_type === 'networking' ? 'selected' : ''}>Networking</option><option value="carreira" ${data.group_type === 'carreira' ? 'selected' : ''}>Dicas de carreira</option></select></label></div><div class="form-grid three"><label>UF<input name="state" maxlength="2" value="${escapeHtml(data.state || account.estado || 'SP')}" required>${fieldError(errors, 'state')}</label><label>Cidade<input name="city" value="${escapeHtml(data.city || account.cidade || '')}" required>${fieldError(errors, 'city')}</label><label>Região ou bairro<input name="region" value="${escapeHtml(data.region || '')}"></label></div><div class="check-grid"><label><input type="checkbox" name="admin_only" ${data.admin_only ? 'checked' : ''}><span>Somente administradores publicam</span></label><label><input type="checkbox" name="accepts_jobs" ${data.accepts_jobs ? 'checked' : ''}><span>Aceita divulgação de vagas</span></label><label><input type="checkbox" name="accepts_candidate_messages" ${data.accepts_candidate_messages ? 'checked' : ''}><span>Candidatos podem chamar o responsável</span></label><label><input type="checkbox" name="charges_members" ${data.charges_members ? 'checked' : ''}><span>Existe cobrança para participar</span></label></div></section>${errors.geral ? `<div class="form-alert error">${escapeHtml(errors.geral)}</div>` : ''}<div class="publication-submit"><div><b>Todos os grupos passam por revisão.</b><span>Conteúdo suspeito, cobrança de candidatos ou links incompatíveis serão rejeitados.</span></div><button class="btn btn-primary btn-lg" type="submit">${group ? 'Salvar e reenviar' : 'Enviar para análise'}</button></div></form><aside class="form-help"><h3>Como ser aprovado</h3><ul><li>Use uma descrição verdadeira e específica.</li><li>Informe cidade e categoria corretamente.</li><li>Não cobre candidatos.</li><li>Mantenha o convite ativo.</li></ul><a href="/grupos">Ver grupos publicados</a></aside></section></main>${portalFooter()}`;
      return res.send(metaPage({ title, description: 'Cadastre gratuitamente um grupo de emprego, carreira ou networking.', canonical: `${SITE_URL}${req.path}`, image: `${SITE_URL}/assets/vagas-grupos-social.png`, bodyClass: 'light-page directory-site', nonce: res.locals.cspNonce, robots: 'noindex,nofollow', siteName: PORTAL_BRAND_NAME, titleSuffix: PORTAL_BRAND_NAME, favicon: '/assets/vagas-grupos-mark.svg', themeColor: '#19ad5b', structuredData: [], content }));
    } catch (error) { return next(error); }
  }

  async function jobFormPage(req, res, next, { errors = {}, values = {} } = {}) {
    try {
      const account = await currentAccount(req);
      const token = csrf(req, res);
      const data = { empresa_nome: account.empresa_nome || '', whatsapp_contato: account.whatsapp || '', cidade: account.cidade || '', estado: account.estado || 'SP', ...values };
      const content = `${pageHeader(account)}<main id="conteudo" class="form-page"><section class="form-page-head"><div class="container"><a href="/minha-conta">← Minha conta</a><span class="eyebrow">Vaga gratuita</span><h1>Enviar vaga para o portal</h1><p>A oportunidade será revisada antes de ser criada no painel oficial.</p></div></section><section class="container form-page-layout">${flash(req)}<form method="post" action="/minha-conta/vagas/nova" class="publication-form" novalidate><input type="hidden" name="csrf_token" value="${escapeHtml(token)}"><input class="honeypot" name="website" tabindex="-1" autocomplete="off"><section class="form-panel"><div class="form-panel-title"><span>1</span><div><h2>Empresa e oportunidade</h2><p>Use um título objetivo e evite abreviações excessivas.</p></div></div><div class="form-grid two"><label>Empresa<input name="empresa_nome" value="${escapeHtml(data.empresa_nome || '')}" required>${fieldError(errors, 'empresa_nome')}</label><label>Título da vaga<input name="titulo" value="${escapeHtml(data.titulo || '')}" required>${fieldError(errors, 'titulo')}</label></div><label>Cargo<input name="cargo" value="${escapeHtml(data.cargo || '')}" required>${fieldError(errors, 'cargo')}</label><label>Descrição completa<textarea name="descricao" rows="8" maxlength="6000" required>${escapeHtml(data.descricao || '')}</textarea>${fieldError(errors, 'descricao')}</label><div class="form-grid two"><label>Requisitos<textarea name="requisitos" rows="5">${escapeHtml(data.requisitos || '')}</textarea></label><label>Benefícios<textarea name="beneficios" rows="5">${escapeHtml(data.beneficios || '')}</textarea></label></div></section><section class="form-panel"><div class="form-panel-title"><span>2</span><div><h2>Local e condições</h2><p>Informações completas aumentam a qualidade das candidaturas.</p></div></div><div class="form-grid three"><label>UF<input name="estado" maxlength="2" value="${escapeHtml(data.estado || 'SP')}" required>${fieldError(errors, 'estado')}</label><label>Cidade<input name="cidade" value="${escapeHtml(data.cidade || '')}" required>${fieldError(errors, 'cidade')}</label><label>Bairro<input name="bairro" value="${escapeHtml(data.bairro || '')}"></label></div><div class="form-grid three"><label>Modalidade<select name="modalidade"><option ${!['Híbrido', 'Remoto'].includes(data.modalidade) ? 'selected' : ''}>Presencial</option><option ${data.modalidade === 'Híbrido' ? 'selected' : ''}>Híbrido</option><option ${data.modalidade === 'Remoto' ? 'selected' : ''}>Remoto</option></select></label><label>Contrato<input name="tipo_contrato" value="${escapeHtml(data.tipo_contrato || '')}" placeholder="CLT, temporário..."></label><label>Quantidade<input name="quantidade_vagas" type="number" min="1" max="999" value="${escapeHtml(data.quantidade_vagas || 1)}"></label></div><div class="form-grid two"><label>Escala<input name="escala" value="${escapeHtml(data.escala || '')}" placeholder="6x1, 12x36..."></label><label>Horário<input name="horario" value="${escapeHtml(data.horario || '')}"></label></div><div class="form-grid two"><label>Salário mensal <span class="optional">opcional</span><input name="salario" inputmode="decimal" value="${escapeHtml(data.salario || '')}" placeholder="1837,40"></label><label>WhatsApp de contato<input name="whatsapp_contato" value="${escapeHtml(data.whatsapp_contato || '')}" inputmode="tel"></label></div></section>${errors.geral ? `<div class="form-alert error">${escapeHtml(errors.geral)}</div>` : ''}<div class="publication-submit"><div><b>Aprovação não é automática.</b><span>A equipe verifica a empresa e as informações antes da publicação.</span></div><button class="btn btn-primary btn-lg" type="submit">Enviar vaga para análise</button></div></form><aside class="form-help"><h3>Precisa contratar em escala?</h3><p>A Gênesis pode divulgar, atender candidatos, realizar triagem, organizar documentos e agendar entrevistas.</p><a class="btn btn-accent btn-block" href="/anunciar-vaga">Conhecer a solução</a></aside></section></main>${portalFooter()}`;
      return res.send(metaPage({ title: 'Enviar vaga', description: 'Envie uma vaga para análise e publicação no Vagas & Grupos.', canonical: `${SITE_URL}/minha-conta/vagas/nova`, image: `${SITE_URL}/assets/vagas-grupos-social.png`, bodyClass: 'light-page directory-site', nonce: res.locals.cspNonce, robots: 'noindex,nofollow', siteName: PORTAL_BRAND_NAME, titleSuffix: PORTAL_BRAND_NAME, favicon: '/assets/vagas-grupos-mark.svg', themeColor: '#19ad5b', structuredData: [], content }));
    } catch (error) { return next(error); }
  }

  function trustedWhatsAppMediaUrl(value) {
    try {
      const url = new URL(String(value || ''));
      const host = url.hostname.toLowerCase();
      const allowed = host.endsWith('.whatsapp.net') || host.endsWith('.fbcdn.net') || ['pps.whatsapp.net', 'mmg.whatsapp.net'].includes(host);
      return url.protocol === 'https:' && allowed ? url : null;
    } catch { return null; }
  }
  async function fetchTrustedMedia(value) {
    let url = trustedWhatsAppMediaUrl(value);
    if (!url) return null;
    for (let redirect = 0; redirect <= 3; redirect += 1) {
      const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(7000) });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location');
        url = trustedWhatsAppMediaUrl(location ? new URL(location, url).href : '');
        if (!url) return null;
        continue;
      }
      return response;
    }
    return null;
  }
  async function limitedResponseBuffer(response, maximumBytes) {
    const declared = Number(response.headers.get('content-length') || 0);
    if (declared > maximumBytes) return null;
    const chunks = [];
    let total = 0;
    for await (const chunk of response.body || []) {
      total += chunk.length;
      if (total > maximumBytes) {
        await response.body?.cancel().catch(() => {});
        return null;
      }
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks, total);
  }
  async function processImage(file, remoteUrl) {
    let buffer = file?.buffer || null;
    let origin = file ? 'UPLOAD' : 'WHATSAPP';
    if (!buffer && remoteUrl) {
      try {
        const response = await fetchTrustedMedia(remoteUrl);
        const contentType = String(response?.headers.get('content-type') || '').toLowerCase();
        if (!response?.ok || !/^image\/(jpeg|png|webp)(?:;|$)/.test(contentType)) return null;
        buffer = await limitedResponseBuffer(response, 5 * 1024 * 1024);
      } catch { return null; }
    }
    if (!buffer) return null;
    try {
      const result = await sharp(buffer).rotate().resize(640, 640, { fit: 'cover', position: 'attention' }).webp({ quality: 82, effort: 4 }).toBuffer({ resolveWithObject: true });
      return { buffer: result.data, width: result.info.width, height: result.info.height, size: result.info.size, origin };
    } catch {
      const error = new Error('Não foi possível processar a imagem. Envie outro arquivo.');
      error.statusCode = 400;
      throw error;
    }
  }
  async function saveImage(client, groupId, image) {
    if (!image) return;
    await client.query(`INSERT INTO portal_grupo_imagens(grupo_id,conteudo,mime_type,largura,altura,tamanho_bytes,origem) VALUES($1,$2,'image/webp',$3,$4,$5,$6) ON CONFLICT(grupo_id) DO UPDATE SET conteudo=EXCLUDED.conteudo,mime_type=EXCLUDED.mime_type,largura=EXCLUDED.largura,altura=EXCLUDED.altura,tamanho_bytes=EXCLUDED.tamanho_bytes,origem=EXCLUDED.origem,updated_at=NOW()`, [groupId, image.buffer, image.width, image.height, image.size, image.origin]);
  }
  function groupDatabaseErrors(error) {
    if (!['23514', '23502'].includes(String(error?.code || ''))) return null;
    const constraint = String(error?.constraint || '').toLowerCase();
    const column = String(error?.column || '').toLowerCase();
    console.error('[GROUP_DATABASE_REJECTION]', { code: error.code, constraint: error.constraint || null, column: error.column || null });
    if (constraint.includes('category')) return { category: 'A categoria selecionada ainda não está habilitada no banco. A estrutura do portal precisa ser atualizada para a versão atual.' };
    if (constraint.includes('group_type')) return { group_type: 'Selecione um tipo de grupo válido.' };
    const fields = {
      name: ['name', 'Informe o nome do grupo.'],
      description: ['description', 'Informe a descrição do grupo.'],
      invite_url: ['invite_url', 'Informe o convite do WhatsApp.'],
      category: ['category', 'Selecione a categoria.'],
      state: ['state', 'Selecione o estado.'],
      city: ['city', 'Selecione a cidade.'],
    };
    if (fields[column]) return { [fields[column][0]]: fields[column][1] };
    return { geral: 'Uma regra antiga do banco bloqueou o cadastro. Atualize a estrutura do portal e tente novamente.' };
  }
  async function fetchInviteMetadata(value) {
    const code = inviteCode(value);
    if (!code) throw new Error('Use um link no formato https://chat.whatsapp.com/...');
    const inviteUrl = `https://chat.whatsapp.com/${code}`;
    const response = await fetch(inviteUrl, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; GenesisPortal/1.0)' }, redirect: 'follow', signal: AbortSignal.timeout(8000) });
    if (!response.ok) throw new Error('O WhatsApp não retornou os dados públicos deste convite.');
    const body = await limitedResponseBuffer(response, 800_000);
    if (!body) throw new Error('A resposta pública do WhatsApp excedeu o limite permitido.');
    const html = body.toString('utf8');
    const meta = (key) => {
      const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      for (const regex of [new RegExp(`<meta[^>]+(?:property|name)=["']${escaped}["'][^>]+content=["']([^"']*)["']`, 'i'), new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+(?:property|name)=["']${escaped}["']`, 'i')]) {
        const match = html.match(regex);
        if (match?.[1]) return match[1].replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"').trim();
      }
      return '';
    };
    return { name: meta('og:title').replace(/\s*\|\s*WhatsApp\s*$/i, '').trim(), description: meta('og:description'), image_url: meta('og:image'), invite_url: inviteUrl };
  }

  app.get('/health/communities', async (_req, res) => {
    const requiredTables = [
      'portal_contas', 'portal_sessoes', 'gg_groups', 'gg_group_views',
      'gg_group_clicks', 'gg_group_reports', 'portal_grupo_imagens',
      'portal_vagas_submissoes', 'portal_vaga_grupos',
    ];
    try {
      const result = await pool.query(
        `SELECT tablename FROM pg_catalog.pg_tables WHERE schemaname = current_schema() AND tablename = ANY($1::text[])`,
        [requiredTables]
      );
      const found = new Set(result.rows.map((row) => row.tablename));
      const missing = requiredTables.filter((table) => !found.has(table));
      let categoryCompatible = false;
      let unsupportedRequiredColumns = [];
      if (!missing.includes('gg_groups')) {
        const checks = await pool.query(`SELECT pg_get_constraintdef(oid) definition FROM pg_constraint WHERE conrelid='gg_groups'::regclass AND contype='c' AND POSITION('category' IN LOWER(pg_get_constraintdef(oid)))>0`);
        categoryCompatible = checks.rows.every((item) => String(item.definition || '').includes('Free lances'));
        const requiredColumns = await pool.query(`SELECT column_name FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='gg_groups' AND is_nullable='NO' AND column_default IS NULL AND is_identity='NO'`);
        const supplied = new Set(['name', 'slug', 'description', 'rules', 'invite_url', 'category', 'state', 'city', 'region', 'group_type', 'admin_only', 'accepts_jobs', 'accepts_candidate_messages', 'charges_members', 'owner_name', 'owner_email', 'owner_phone', 'owner_account_id', 'status', 'invite_code_hash', 'submitted_at']);
        unsupportedRequiredColumns = requiredColumns.rows.map((item) => item.column_name).filter((column) => !supplied.has(column));
      }
      const incomplete = missing.length > 0 || !categoryCompatible || unsupportedRequiredColumns.length > 0;
      return res.status(incomplete ? 503 : 200).json({
        status: incomplete ? 'incomplete' : 'ok',
        module: 'vagas-grupos',
        database: incomplete ? 'migration_required' : 'ok',
        missing_tables: missing,
        checks: {
          category_free_lances: categoryCompatible ? 'ok' : 'migration_required',
          legacy_required_columns: unsupportedRequiredColumns.length ? 'incompatible' : 'ok',
        },
        incompatible_columns: unsupportedRequiredColumns,
        version: APP_VERSION,
      });
    } catch (error) {
      console.error('[HEALTH_COMMUNITIES]', error);
      return res.status(503).json({ status: 'error', module: 'vagas-grupos', database: 'unavailable', version: APP_VERSION });
    }
  });

  app.get('/cadastro', async (req, res, next) => { try { if (await currentAccount(req)) return res.redirect(302, '/minha-conta'); return res.send(registrationPage(req, res)); } catch (error) { return next(error); } });
  app.post('/cadastro', authLimiter, async (req, res, next) => {
    try {
      assertCsrf(req);
      const parsed = accountSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).send(registrationPage(req, res, { errors: fieldErrors(parsed.error.issues), values: req.body }));
      if (parsed.data.website) return res.redirect(303, '/cadastro');
      if (!checkbox(parsed.data.aceite_termos)) return res.status(400).send(registrationPage(req, res, { errors: { aceite_termos: 'Você precisa aceitar os termos para criar a conta.' }, values: req.body }));
      if (parsed.data.tipo === 'EMPRESA' && parsed.data.empresa_nome.trim().length < 2) return res.status(400).send(registrationPage(req, res, { errors: { empresa_nome: 'Informe o nome da empresa.' }, values: req.body }));
      if (parsed.data.senha !== parsed.data.confirmar_senha) return res.status(400).send(registrationPage(req, res, { errors: { confirmar_senha: 'As senhas não conferem.' }, values: req.body }));
      const email = parsed.data.email.toLowerCase();
      if ((await pool.query('SELECT 1 FROM portal_contas WHERE LOWER(email)=LOWER($1) LIMIT 1', [email])).rowCount) return res.status(409).send(registrationPage(req, res, { errors: { email: 'Este e-mail já possui uma conta.' }, values: req.body }));
      const passwordHash = await hashPassword(parsed.data.senha);
      const result = await pool.query(`INSERT INTO portal_contas(tipo,nome,email,senha_hash,whatsapp,empresa_nome,cnpj,cidade,estado,consentimento_comercial,aceite_termos_em) VALUES($1,$2,$3,$4,$5,NULLIF($6,''),NULLIF($7,''),NULLIF($8,''),NULLIF(UPPER($9),''),$10,NOW()) RETURNING id,tipo,nome,email,whatsapp,empresa_nome,cidade,estado,created_at`, [parsed.data.tipo, parsed.data.nome, email, passwordHash, phone(parsed.data.whatsapp), parsed.data.empresa_nome, parsed.data.cnpj, parsed.data.cidade, parsed.data.estado, checkbox(parsed.data.consentimento_comercial)]);
      await createSession(req, res, result.rows[0].id);
      void notify('account.created', result.rows[0]);
      return res.redirect(303, '/minha-conta?ok=Conta criada com sucesso. Agora você pode publicar.');
    } catch (error) {
      if (error?.code === '23505') return res.status(409).send(registrationPage(req, res, { errors: { email: 'Este e-mail já possui uma conta.' }, values: req.body || {} }));
      return next(error);
    }
  });
  app.get('/entrar', async (req, res, next) => { try { if (await currentAccount(req)) return res.redirect(302, '/minha-conta'); return res.send(loginPage(req, res)); } catch (error) { return next(error); } });
  app.post('/entrar', authLimiter, async (req, res, next) => {
    try {
      assertCsrf(req);
      const parsed = loginSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).send(loginPage(req, res, { errors: fieldErrors(parsed.error.issues), values: req.body }));
      const result = await pool.query('SELECT * FROM portal_contas WHERE LOWER(email)=LOWER($1) LIMIT 1', [parsed.data.email]);
      const account = result.rows[0];
      if (!account || account.status !== 'ATIVA' || !await verifyPassword(parsed.data.senha, account.senha_hash)) return res.status(401).send(loginPage(req, res, { errors: { geral: 'E-mail ou senha incorretos.' }, values: req.body }));
      await createSession(req, res, account.id);
      await pool.query('UPDATE portal_contas SET ultimo_login_at=NOW() WHERE id=$1', [account.id]);
      return res.redirect(303, cleanRedirect(req.body.retorno));
    } catch (error) { return next(error); }
  });
  app.post('/sair', requireAccount, async (req, res, next) => { try { assertCsrf(req); await destroySession(req, res); return res.redirect(303, '/'); } catch (error) { return next(error); } });
  app.get('/minha-conta', requireAccount, accountDashboard);
  app.get('/minha-conta/grupos/novo', requireAccount, (req, res, next) => groupFormPage(req, res, next));

  app.post('/minha-conta/grupos/novo', requireAccount, publicationLimiter, parseGroupImage, async (req, res, next) => {
    try {
      if (req.groupUploadError) {
        res.status(400);
        return groupFormPage(req, res, next, { errors: { geral: req.groupUploadError.message || 'Não foi possível receber a imagem.' }, values: req.body || {} });
      }
      assertCsrf(req);
      const account = await currentAccount(req);
      const parsed = groupSchema.safeParse(req.body);
      if (!parsed.success) { res.status(400); return groupFormPage(req, res, next, { errors: fieldErrors(parsed.error.issues), values: req.body }); }
      if (parsed.data.website) return res.redirect(303, '/minha-conta');
      const code = inviteCode(parsed.data.invite_url);
      const hash = inviteHash(parsed.data.invite_url);
      if (!hash || !code) { res.status(400); return groupFormPage(req, res, next, { errors: { invite_url: 'Use um convite válido de chat.whatsapp.com.' }, values: req.body }); }
      if ((await pool.query("SELECT 1 FROM gg_groups WHERE invite_code_hash=$1 OR POSITION($2 IN COALESCE(invite_url,''))>0 LIMIT 1", [hash, code])).rowCount) { res.status(409); return groupFormPage(req, res, next, { errors: { invite_url: 'Este convite já está cadastrado.' }, values: req.body }); }
      const image = await processImage(req.file, parsed.data.preview_image_url);
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const base = slugify(`${parsed.data.name}-${parsed.data.city}`);
        let slug = base; let suffix = 2;
        while ((await client.query('SELECT 1 FROM gg_groups WHERE slug=$1 LIMIT 1', [slug])).rowCount) slug = `${base.slice(0, 175)}-${suffix++}`;
        const result = await client.query(`INSERT INTO gg_groups(name,slug,description,rules,invite_url,category,state,city,region,group_type,admin_only,accepts_jobs,accepts_candidate_messages,charges_members,owner_name,owner_email,owner_phone,owner_account_id,status,invite_code_hash,submitted_at) VALUES($1,$2,$3,NULLIF($4,''),$5,$6,UPPER($7),$8,NULLIF($9,''),$10,$11,$12,$13,$14,$15,$16,$17,$18,'pending',$19,NOW()) RETURNING *`, [parsed.data.name, slug, parsed.data.description, parsed.data.rules, parsed.data.invite_url, parsed.data.category, parsed.data.state, parsed.data.city, parsed.data.region, parsed.data.group_type, checkbox(parsed.data.admin_only), checkbox(parsed.data.accepts_jobs), checkbox(parsed.data.accepts_candidate_messages), checkbox(parsed.data.charges_members), account.nome, account.email, account.whatsapp, account.id, hash]);
        await saveImage(client, result.rows[0].id, image);
        await client.query('COMMIT');
        void notify('group.submitted', { ...result.rows[0], publisher: account });
        return res.redirect(303, '/minha-conta?ok=Grupo enviado para análise.');
      } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    } catch (error) {
      if (error instanceof multer.MulterError || error.statusCode === 400) { res.status(400); return groupFormPage(req, res, next, { errors: { geral: error.message }, values: req.body || {} }); }
      if (error?.code === '23505') { res.status(409); return groupFormPage(req, res, next, { errors: { invite_url: 'Este convite já está cadastrado.' }, values: req.body || {} }); }
      const databaseErrors = groupDatabaseErrors(error);
      if (databaseErrors) { res.status(400); return groupFormPage(req, res, next, { errors: databaseErrors, values: req.body || {} }); }
      return next(error);
    }
  });

  app.get('/minha-conta/grupos/:id/editar', requireAccount, async (req, res, next) => {
    try {
      const account = await currentAccount(req);
      const result = await pool.query('SELECT * FROM gg_groups WHERE id=$1 AND owner_account_id=$2 LIMIT 1', [Number(req.params.id), account.id]);
      if (!result.rowCount) return res.status(404).send('Grupo não encontrado.');
      return groupFormPage(req, res, next, { group: result.rows[0] });
    } catch (error) { return next(error); }
  });

  app.post('/minha-conta/grupos/:id/editar', requireAccount, publicationLimiter, parseGroupImage, async (req, res, next) => {
    let currentGroup = null;
    try {
      assertCsrf(req);
      const account = await currentAccount(req);
      const current = await pool.query('SELECT * FROM gg_groups WHERE id=$1 AND owner_account_id=$2 LIMIT 1', [Number(req.params.id), account.id]);
      if (!current.rowCount) return res.status(404).send('Grupo não encontrado.');
      [currentGroup] = current.rows;
      if (req.groupUploadError) {
        res.status(400);
        return groupFormPage(req, res, next, { group: current.rows[0], errors: { geral: req.groupUploadError.message || 'Não foi possível receber a imagem.' }, values: req.body || {} });
      }
      const parsed = groupSchema.safeParse(req.body);
      if (!parsed.success) { res.status(400); return groupFormPage(req, res, next, { group: current.rows[0], errors: fieldErrors(parsed.error.issues), values: req.body }); }
      const code = inviteCode(parsed.data.invite_url);
      const hash = inviteHash(parsed.data.invite_url);
      if (!hash || !code) { res.status(400); return groupFormPage(req, res, next, { group: current.rows[0], errors: { invite_url: 'Use um convite válido de chat.whatsapp.com.' }, values: req.body }); }
      if ((await pool.query("SELECT 1 FROM gg_groups WHERE id<>$2 AND (invite_code_hash=$1 OR POSITION($3 IN COALESCE(invite_url,''))>0) LIMIT 1", [hash, current.rows[0].id, code])).rowCount) { res.status(409); return groupFormPage(req, res, next, { group: current.rows[0], errors: { invite_url: 'Este convite já pertence a outro cadastro.' }, values: req.body }); }
      const image = await processImage(req.file, parsed.data.preview_image_url);
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await client.query(`UPDATE gg_groups SET name=$1,description=$2,rules=NULLIF($3,''),invite_url=$4,category=$5,state=UPPER($6),city=$7,region=NULLIF($8,''),group_type=$9,admin_only=$10,accepts_jobs=$11,accepts_candidate_messages=$12,charges_members=$13,status='pending',rejection_reason=NULL,invite_code_hash=$14,submitted_at=NOW(),verified=FALSE WHERE id=$15 AND owner_account_id=$16 RETURNING *`, [parsed.data.name, parsed.data.description, parsed.data.rules, parsed.data.invite_url, parsed.data.category, parsed.data.state, parsed.data.city, parsed.data.region, parsed.data.group_type, checkbox(parsed.data.admin_only), checkbox(parsed.data.accepts_jobs), checkbox(parsed.data.accepts_candidate_messages), checkbox(parsed.data.charges_members), hash, current.rows[0].id, account.id]);
        await saveImage(client, current.rows[0].id, image);
        await client.query('COMMIT');
        void notify('group.resubmitted', { ...result.rows[0], publisher: account });
        return res.redirect(303, '/minha-conta?ok=Grupo atualizado e reenviado para análise.');
      } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    } catch (error) {
      const databaseErrors = groupDatabaseErrors(error);
      if (databaseErrors && currentGroup) {
        res.status(400);
        return groupFormPage(req, res, next, { group: currentGroup, errors: databaseErrors, values: req.body || {} });
      }
      return next(error);
    }
  });

  app.get('/minha-conta/vagas/nova', requireAccount, (req, res, next) => jobFormPage(req, res, next));
  app.post('/minha-conta/vagas/nova', requireAccount, publicationLimiter, async (req, res, next) => {
    try {
      assertCsrf(req);
      const account = await currentAccount(req);
      const parsed = jobSchema.safeParse(req.body);
      if (!parsed.success) { res.status(400); return jobFormPage(req, res, next, { errors: fieldErrors(parsed.error.issues), values: req.body }); }
      if (parsed.data.website) return res.redirect(303, '/minha-conta');
      const salary = parsed.data.salario ? Number(String(parsed.data.salario).replace(/\./g, '').replace(',', '.')) : null;
      if (salary !== null && (!Number.isFinite(salary) || salary < 0)) { res.status(400); return jobFormPage(req, res, next, { errors: { salario: 'Informe um salário válido.' }, values: req.body }); }
      const result = await pool.query(`INSERT INTO portal_vagas_submissoes(conta_id,empresa_nome,titulo,cargo,descricao,requisitos,beneficios,cidade,estado,bairro,modalidade,tipo_contrato,escala,horario,salario,quantidade_vagas,whatsapp_contato) VALUES($1,$2,$3,$4,$5,NULLIF($6,''),NULLIF($7,''),$8,UPPER($9),NULLIF($10,''),$11,NULLIF($12,''),NULLIF($13,''),NULLIF($14,''),$15,$16,NULLIF($17,'')) RETURNING *`, [account.id, parsed.data.empresa_nome, parsed.data.titulo, parsed.data.cargo, parsed.data.descricao, parsed.data.requisitos, parsed.data.beneficios, parsed.data.cidade, parsed.data.estado, parsed.data.bairro, parsed.data.modalidade, parsed.data.tipo_contrato, parsed.data.escala, parsed.data.horario, salary, parsed.data.quantidade_vagas, phone(parsed.data.whatsapp_contato)]);
      void notify('job.submitted', { ...result.rows[0], publisher: account });
      return res.redirect(303, '/minha-conta?ok=Vaga enviada para análise.');
    } catch (error) {
      if (error?.code === '23514' || error?.code === '23502') {
        console.error('[JOB_DATABASE_REJECTION]', { code: error.code, constraint: error.constraint || null, column: error.column || null });
        res.status(400);
        return jobFormPage(req, res, next, { errors: { geral: 'Não foi possível validar a vaga no banco. Confira os campos e execute a migração da versão atual se o erro continuar.' }, values: req.body || {} });
      }
      return next(error);
    }
  });

  app.post('/api/public/grupos/previsualizar', previewLimiter, async (req, res) => {
    try { return res.json({ sucesso: true, grupo: await fetchInviteMetadata(String(req.body?.invite_url || '')) }); }
    catch (error) { return res.status(400).json({ sucesso: false, erro: error.message || 'Não foi possível buscar os dados.' }); }
  });
  app.get('/api/public/localidades/estados/:uf/municipios', async (req, res) => {
    try {
      const location = await loadMunicipalities(req.params.uf, LOCATION_FETCH);
      res.setHeader('Cache-Control', location.complete ? 'public, max-age=86400, stale-while-revalidate=604800' : 'public, max-age=300');
      return res.json({
        sucesso: true,
        estado: location.state,
        nome_estado: location.stateName,
        completo: location.complete,
        fonte: location.source,
        principais: location.featured,
        municipios: location.cities,
      });
    } catch (error) {
      return res.status(error.statusCode || 400).json({ sucesso: false, erro: error.message || 'Estado inválido.' });
    }
  });
  app.get('/media/grupos/:id.webp', async (req, res, next) => {
    try {
      const result = await pool.query('SELECT conteudo,mime_type,updated_at FROM portal_grupo_imagens WHERE grupo_id=$1 LIMIT 1', [Number(req.params.id)]);
      if (!result.rowCount) return res.redirect(302, '/assets/genesis-mark.svg');
      res.setHeader('Content-Type', result.rows[0].mime_type || 'image/webp');
      res.setHeader('Cache-Control', 'public, max-age=86400, stale-while-revalidate=604800');
      res.setHeader('ETag', `"g-${req.params.id}-${new Date(result.rows[0].updated_at).getTime()}"`);
      return res.send(result.rows[0].conteudo);
    } catch (error) { return next(error); }
  });

  app.get('/grupos', (req, res, next) => directoryPage(req, res, next));
  app.get('/grupos/categoria/:slug', (req, res, next) => {
    const category = GROUP_CATEGORIES.find((item) => slugify(item) === req.params.slug);
    if (!category) return next();
    return directoryPage(req, res, next, { category, canonicalPath: `/grupos/categoria/${req.params.slug}`, title: `Grupos de ${category}`, description: `Encontre grupos de ${category.toLowerCase()} revisados pela Gênesis, com links atualizados, localização e vagas relacionadas.` });
  });
  app.get('/grupos/local/:state/:city', (req, res, next) => {
    const city = String(req.params.city || '').split('-').map((item) => item ? item[0].toUpperCase() + item.slice(1) : '').join(' ');
    const state = String(req.params.state || '').toUpperCase();
    return directoryPage(req, res, next, { state, city, canonicalPath: `/grupos/local/${state.toLowerCase()}/${req.params.city}`, title: `Grupos de emprego em ${city} — ${state}`, description: `Grupos de emprego, carreira e networking em ${city}, ${state}, com páginas revisadas e oportunidades relacionadas.` });
  });
  app.get('/grupo/:slug', groupDetailPage);

  app.get('/r/grupo/:id', async (req, res, next) => {
    try {
      const result = await pool.query("SELECT id,invite_url FROM gg_groups WHERE id=$1 AND status='approved' LIMIT 1", [Number(req.params.id)]);
      if (!result.rowCount || !result.rows[0].invite_url) return res.redirect(302, '/grupos?erro=Convite indisponível');
      await pool.query('INSERT INTO gg_group_clicks(group_id,visitor_hash,source,job_id,sessao_id,utm_source,utm_medium,utm_campaign) VALUES($1,$2,$3,$4,$5,$6,$7,$8)', [result.rows[0].id, visitorHash(req), String(req.get('referer') || '').slice(0, 240), Number(req.query.vaga_id) || null, String(req.query.sessao_id || '').slice(0, 120), String(req.query.utm_source || '').slice(0, 160), String(req.query.utm_medium || '').slice(0, 160), String(req.query.utm_campaign || '').slice(0, 200)]).catch(() => {});
      return res.redirect(302, result.rows[0].invite_url);
    } catch (error) { return next(error); }
  });

  app.post('/grupo/:slug/denunciar', publicationLimiter, async (req, res, next) => {
    try {
      assertCsrf(req);
      const result = await pool.query("SELECT id FROM gg_groups WHERE slug=$1 AND status='approved' LIMIT 1", [String(req.params.slug || '')]);
      if (!result.rowCount) return res.redirect(303, '/grupos');
      await pool.query("INSERT INTO gg_group_reports(group_id,reason,details,contact) VALUES($1,$2,NULLIF($3,''),NULLIF($4,''))", [result.rows[0].id, String(req.body.reason || 'outro').slice(0, 100), String(req.body.details || '').slice(0, 1200), String(req.body.contact || '').slice(0, 180)]);
      void notify('group.reported', { group_id: result.rows[0].id, reason: req.body.reason, details: req.body.details, contact: req.body.contact });
      return res.redirect(303, `/grupo/${encodeURIComponent(req.params.slug)}?ok=Denúncia enviada para revisão.`);
    } catch (error) { return next(error); }
  });

  app.get('/api/public/grupos', async (req, res, next) => {
    try {
      const data = await listGroups({ q: String(req.query.q || '').slice(0, 120), category: String(req.query.categoria || '').slice(0, 80), state: String(req.query.uf || '').slice(0, 2), city: String(req.query.cidade || '').slice(0, 120), page: Math.max(1, Number(req.query.pagina) || 1), pageSize: Math.min(50, Math.max(1, Number(req.query.limite) || 20)) });
      return res.json({ sucesso: true, total: data.total, grupos: data.groups.map((g) => ({ id: g.id, nome: g.name, slug: g.slug, descricao: g.description, categoria: g.category, cidade: g.city, estado: g.state, regiao: g.region, verificado: g.verified, destaque: g.featured, visualizacoes: g.view_count, acessos: g.click_count, imagem: groupImageUrl(g), url: `${SITE_URL}/grupo/${g.slug}` })) });
    } catch (error) { return next(error); }
  });

  return {
    GROUP_CATEGORIES,
    listGroups,
    groupCard,
    async sitemapGroups() { return (await pool.query("SELECT slug,updated_at,featured FROM gg_groups WHERE status='approved' ORDER BY updated_at DESC")).rows; },
    async sitemapCategoryPages() { return (await pool.query("SELECT category,state,city,COUNT(*)::INTEGER total,MAX(updated_at) lastmod FROM gg_groups WHERE status='approved' GROUP BY category,state,city")).rows; },
  };
}

module.exports = { registerCommunityRoutes, GROUP_CATEGORIES };
