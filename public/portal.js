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


  const groupFetchButton = document.querySelector('[data-fetch-group]');
  if (groupFetchButton) {
    const inviteInput = document.querySelector('[data-invite-input]');
    const nameInput = document.querySelector('[data-group-name]');
    const descriptionInput = document.querySelector('[data-group-description]');
    const previewUrlInput = document.querySelector('[data-preview-image-url]');
    const imagePreview = document.querySelector('[data-image-preview]');
    const feedback = document.querySelector('[data-fetch-feedback]');
    groupFetchButton.addEventListener('click', async () => {
      const inviteUrl = inviteInput?.value.trim();
      if (!inviteUrl) { if (feedback) feedback.textContent = 'Cole primeiro o convite do grupo.'; inviteInput?.focus(); return; }
      groupFetchButton.disabled = true;
      if (feedback) feedback.textContent = 'Buscando informações públicas do convite…';
      try {
        const response = await fetch('/api/public/grupos/previsualizar', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ invite_url: inviteUrl }) });
        const body = await response.json();
        if (!response.ok || !body.sucesso) throw new Error(body.erro || 'Não foi possível buscar os dados.');
        const group = body.grupo || {};
        if (group.name && nameInput && !nameInput.value.trim()) nameInput.value = group.name;
        if (group.description && descriptionInput && !descriptionInput.value.trim()) descriptionInput.value = group.description;
        if (group.image_url && previewUrlInput) {
          previewUrlInput.value = group.image_url;
          if (imagePreview) imagePreview.src = group.image_url;
        }
        if (feedback) feedback.textContent = 'Dados encontrados. Revise tudo antes de enviar.';
      } catch (error) {
        if (feedback) feedback.textContent = `${error.message} Você pode preencher manualmente e enviar uma imagem.`;
      } finally { groupFetchButton.disabled = false; }
    });
  }

  const imageInput = document.querySelector('[data-image-input]');
  if (imageInput) {
    imageInput.addEventListener('change', () => {
      const file = imageInput.files?.[0];
      const preview = document.querySelector('[data-image-preview]');
      if (!file || !preview) return;
      if (file.size > 4 * 1024 * 1024) { imageInput.value = ''; alert('A imagem deve ter no máximo 4 MB.'); return; }
      const url = URL.createObjectURL(file);
      preview.src = url;
      preview.onload = () => URL.revokeObjectURL(url);
    });
  }

  const benefitsTextarea = document.querySelector('textarea[name="beneficios"]');
  if (benefitsTextarea) {
    const benefitOptions = [
      'Vale-transporte', 'Vale-refeição', 'Vale-alimentação', 'Cesta básica',
      'Assistência médica', 'Assistência odontológica', 'Seguro de vida',
      'Prêmio de assiduidade', 'Comissão', 'Participação nos lucros',
    ];
    const normalize = (value) => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase();
    const originalParts = benefitsTextarea.value.split(/[;\n|]+/).map((item) => item.trim()).filter(Boolean);
    const selected = new Set(benefitOptions.filter((option) => originalParts.some((item) => normalize(item) === normalize(option))));
    const customParts = originalParts.filter((item) => !benefitOptions.some((option) => normalize(item) === normalize(option)));
    const originalLabel = benefitsTextarea.closest('label');
    const form = benefitsTextarea.closest('form');
    const hidden = document.createElement('input');
    hidden.type = 'hidden';
    hidden.name = 'beneficios';
    benefitsTextarea.name = 'beneficios_detalhes';
    benefitsTextarea.value = customParts.join('\n');
    benefitsTextarea.placeholder = 'Ex.: Gympass, auxílio-creche ou detalhes sobre os valores';
    originalLabel?.parentElement?.classList.add('job-description-grid');
    if (originalLabel?.firstChild?.nodeType === Node.TEXT_NODE) originalLabel.firstChild.textContent = 'Outros benefícios e detalhes ';
    benefitsTextarea.insertAdjacentElement('afterend', hidden);

    const picker = document.createElement('fieldset');
    picker.className = 'benefit-picker';
    const legend = document.createElement('legend');
    legend.textContent = 'Benefícios';
    const hint = document.createElement('p');
    hint.textContent = 'Toque para selecionar todos os benefícios oferecidos.';
    const options = document.createElement('div');
    options.className = 'benefit-options';
    picker.append(legend, hint, options);

    benefitOptions.forEach((option) => {
      const label = document.createElement('label');
      const checkbox = document.createElement('input');
      const text = document.createElement('span');
      checkbox.type = 'checkbox';
      checkbox.value = option;
      checkbox.checked = selected.has(option);
      text.textContent = option;
      label.append(checkbox, text);
      options.append(label);
    });

    originalLabel?.parentNode?.insertBefore(picker, originalLabel);
    const syncBenefits = () => {
      const checked = [...options.querySelectorAll('input:checked')].map((input) => input.value);
      hidden.value = [...checked, benefitsTextarea.value.trim()].filter(Boolean).join('; ');
    };
    options.addEventListener('change', syncBenefits);
    benefitsTextarea.addEventListener('input', syncBenefits);
    form?.addEventListener('submit', syncBenefits);
    syncBenefits();
  }

  document.querySelectorAll('.publication-form').forEach((form) => {
    const minimums = [
      ['input[name="name"]', 5],
      ['textarea[name="description"]', 30],
      ['input[name="empresa_nome"]', 2],
      ['input[name="titulo"]', 4],
      ['input[name="cargo"]', 2],
      ['textarea[name="descricao"]', 50],
    ];
    minimums.forEach(([selector, length]) => {
      const field = form.querySelector(selector);
      if (field) field.minLength = length;
    });
    form.addEventListener('submit', (event) => {
      if (!form.checkValidity()) {
        event.preventDefault();
        form.reportValidity();
        form.querySelector(':invalid')?.focus();
        return;
      }
      const submit = form.querySelector('button[type="submit"]');
      if (submit) {
        submit.disabled = true;
        submit.setAttribute('aria-busy', 'true');
        submit.textContent = 'Enviando…';
      }
    });
  });

  document.querySelectorAll('[data-report-toggle]').forEach((button) => {
    button.addEventListener('click', () => {
      const form = document.querySelector('.report-form');
      if (!form) return;
      form.classList.toggle('active');
      button.setAttribute('aria-expanded', String(form.classList.contains('active')));
      if (form.classList.contains('active')) form.querySelector('select,textarea,input')?.focus();
    });
  });

  const groupSearch = document.querySelector('.directory-search');
  if (groupSearch) {
    const groupQuery = groupSearch.querySelector('input[name="q"]');
    if (groupQuery) groupQuery.placeholder = 'Ex.: vagas zona sul, limpeza, free lances';
    groupSearch.addEventListener('submit', () => track('BUSCA_GRUPOS'));
  }
})();
