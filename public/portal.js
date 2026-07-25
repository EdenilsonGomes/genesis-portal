'use strict';

(function () {
  const page = document.documentElement;
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
