'use strict';

(function () {
  const page = document.documentElement;

  const root = document.documentElement;
  const themeButtons = document.querySelectorAll('[data-theme-toggle]');
  function syncThemeButtons() {
    const dark = root.dataset.theme === 'dark';
    themeButtons.forEach((button) => {
      const icon = button.querySelector('span');
      if (icon) icon.textContent = dark ? '☀' : '☾';
      button.setAttribute('aria-label', dark ? 'Ativar modo claro' : 'Ativar modo escuro');
      button.title = dark ? 'Ativar modo claro' : 'Ativar modo escuro';
    });
  }
  themeButtons.forEach((button) => button.addEventListener('click', () => {
    const next = root.dataset.theme === 'dark' ? 'light' : 'dark';
    root.dataset.theme = next;
    root.style.colorScheme = next;
    localStorage.setItem('genesis_theme', next);
    syncThemeButtons();
  }));
  syncThemeButtons();

  const menuButton = document.querySelector('[data-menu-toggle]');
  const menuBackdrop = document.querySelector('[data-menu-backdrop]');
  function setMenu(open) {
    document.body.classList.toggle('menu-open', open);
    menuButton?.setAttribute('aria-expanded', String(open));
    if (menuButton) menuButton.textContent = open ? '×' : '☰';
  }
  menuButton?.addEventListener('click', () => setMenu(!document.body.classList.contains('menu-open')));
  menuBackdrop?.addEventListener('click', () => setMenu(false));
  document.querySelectorAll('[data-mobile-menu] a').forEach((link) => link.addEventListener('click', () => setMenu(false)));
  document.addEventListener('keydown', (event) => { if (event.key === 'Escape') setMenu(false); });

  const currentPath = location.pathname.replace(/\/$/, '') || '/';
  document.querySelectorAll('[data-nav-path]').forEach((link) => {
    const path = link.dataset.navPath;
    const active = path === '/' ? currentPath === '/' : currentPath === path || currentPath.startsWith(`${path}/`);
    link.classList.toggle('active', active);
  });

  const vacancyId = page.dataset.vacancyId || null;
  const sessionKey = 'genesis_portal_session';
  let sessionId = localStorage.getItem(sessionKey);
  if (!sessionId) {
    sessionId = (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`);
    localStorage.setItem(sessionKey, sessionId);
  }

  const params = new URLSearchParams(location.search);
  const attribution = {
    source: params.get('utm_source') || params.get('src') || document.referrer || 'direto',
    medium: params.get('utm_medium') || '',
    campaign: params.get('utm_campaign') || '',
  };

  function track(eventType, metadata = {}) {
    const payload = JSON.stringify({
      vaga_id: vacancyId ? Number(vacancyId) : null,
      evento: eventType,
      sessao_id: sessionId,
      pagina: location.pathname,
      ...attribution,
      metadata,
    });

    try {
      if (navigator.sendBeacon) {
        navigator.sendBeacon('/api/public/eventos', new Blob([payload], { type: 'application/json' }));
        return;
      }
      fetch('/api/public/eventos', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: payload,
        keepalive: true,
      }).catch(() => {});
    } catch {}
  }

  track(vacancyId ? 'VISUALIZACAO_VAGA' : 'VISUALIZACAO_PAGINA');

  document.addEventListener('click', (event) => {
    const target = event.target.closest('[data-track]');
    if (!target) return;
    track(target.dataset.track, {
      label: target.dataset.trackLabel || target.textContent.trim().slice(0, 100),
      destino: target.getAttribute('href') || '',
    });
  });

  const searchForm = document.querySelector('[data-search-form]');
  if (searchForm) {
    searchForm.addEventListener('submit', () => track('BUSCA_VAGAS'));
  }
})();
