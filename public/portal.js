'use strict';

(function () {
  const page = document.documentElement;

  const root = document.documentElement;
  const themeButtons = document.querySelectorAll('[data-theme-toggle]');
  function syncThemeButtons() {
    const dark = root.dataset.theme === 'dark';
    themeButtons.forEach((button) => {
      button.setAttribute('aria-checked', String(dark));
      button.setAttribute('aria-label', dark ? 'Ativar modo claro' : 'Ativar modo escuro');
      button.title = dark ? 'Ativar modo claro' : 'Ativar modo escuro';
    });
  }
  themeButtons.forEach((button) => button.addEventListener('click', () => {
    const next = root.dataset.theme === 'dark' ? 'light' : 'dark';
    root.dataset.theme = next;
    root.style.colorScheme = next;
    try { localStorage.setItem('genesis_theme', next); } catch {}
    syncThemeButtons();
  }));
  syncThemeButtons();

  document.addEventListener('error', (event) => {
    const image = event.target;
    if (!(image instanceof HTMLImageElement) || !image.dataset.imageFallback || image.dataset.fallbackApplied) return;
    image.dataset.fallbackApplied = 'true';
    image.src = image.dataset.imageFallback;
  }, true);

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
  let sessionId = '';
  try { sessionId = localStorage.getItem(sessionKey) || ''; } catch {}
  if (!sessionId) {
    sessionId = (globalThis.crypto?.randomUUID ? globalThis.crypto.randomUUID() : `${Date.now()}-${Math.random()}`);
    try { localStorage.setItem(sessionKey, sessionId); } catch {}
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
        if (navigator.sendBeacon('/api/public/eventos', new Blob([payload], { type: 'application/json' }))) return;
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

  const brazilStates = [
    ['SP', 'São Paulo'], ['RJ', 'Rio de Janeiro'], ['MG', 'Minas Gerais'], ['PR', 'Paraná'],
    ['RS', 'Rio Grande do Sul'], ['SC', 'Santa Catarina'], ['BA', 'Bahia'], ['PE', 'Pernambuco'],
    ['GO', 'Goiás'], ['DF', 'Distrito Federal'], ['CE', 'Ceará'], ['ES', 'Espírito Santo'],
    ['AC', 'Acre'], ['AL', 'Alagoas'], ['AP', 'Amapá'], ['AM', 'Amazonas'],
    ['MA', 'Maranhão'], ['MT', 'Mato Grosso'], ['MS', 'Mato Grosso do Sul'], ['PA', 'Pará'],
    ['PB', 'Paraíba'], ['PI', 'Piauí'], ['RN', 'Rio Grande do Norte'], ['RO', 'Rondônia'],
    ['RR', 'Roraima'], ['SE', 'Sergipe'], ['TO', 'Tocantins'],
  ];
  const popularStateCodes = new Set(brazilStates.slice(0, 12).map(([code]) => code));
  const normalizeLocation = (value) => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase();

  function appendStateOptions(select, selected, filterMode = false) {
    const active = String(selected || '').toUpperCase();
    select.replaceChildren();
    const blank = document.createElement('option');
    blank.value = '';
    blank.textContent = filterMode ? 'Todos os estados' : 'Selecione o estado';
    select.append(blank);
    [['Estados mais procurados', true], ['Demais estados', false]].forEach(([label, popular]) => {
      const group = document.createElement('optgroup');
      group.label = label;
      brazilStates.filter(([code]) => popularStateCodes.has(code) === popular).forEach(([code, name]) => {
        const option = document.createElement('option');
        option.value = code;
        option.textContent = name;
        option.selected = code === active;
        group.append(option);
      });
      select.append(group);
    });
  }

  function replaceInputWithSelect(input, type, selected, filterMode = false) {
    if (!input || input.tagName === 'SELECT') return input;
    const select = document.createElement('select');
    ['id', 'name', 'class', 'autocomplete', 'aria-label'].forEach((attribute) => {
      const value = input.getAttribute(attribute);
      if (value) select.setAttribute(attribute, value);
    });
    select.required = input.required;
    select.disabled = input.disabled;
    select.dataset[type === 'state' ? 'locationState' : 'locationCity'] = '';
    if (type === 'state') appendStateOptions(select, selected, filterMode);
    input.replaceWith(select);
    return select;
  }

  function renameStateLabel(field) {
    const label = field?.closest('label, .field');
    const explicit = field?.id ? label?.querySelector(`label[for="${CSS.escape(field.id)}"]`) : null;
    if (explicit) explicit.textContent = 'Estado';
    if (label?.tagName === 'LABEL') {
      const text = [...label.childNodes].find((node) => node.nodeType === Node.TEXT_NODE && /\bUF\b/i.test(node.textContent));
      if (text) text.textContent = text.textContent.replace(/\bUF\b/i, 'Estado');
    }
  }

  function addLocationStatus(city, picker) {
    let status = picker.querySelector('[data-location-status]');
    if (status) return status;
    status = document.createElement('small');
    status.className = 'location-help';
    status.dataset.locationStatus = '';
    status.setAttribute('aria-live', 'polite');
    const label = city.closest('label, .field');
    label?.append(status);
    return status;
  }

  function prepareLocationPicker(picker, { filterMode = false } = {}) {
    if (!picker) return null;
    const stateSource = picker.querySelector('[data-location-state], [name="state"], [name="estado"], [name="uf"]');
    const citySource = picker.querySelector('[data-location-city], [name="city"], [name="cidade"]');
    if (!stateSource || !citySource) return null;
    const stateValue = stateSource.value || '';
    const cityValue = citySource.dataset.selectedCity || citySource.value || '';
    const state = replaceInputWithSelect(stateSource, 'state', stateValue, filterMode);
    const city = replaceInputWithSelect(citySource, 'city', cityValue, filterMode);
    state.dataset.locationState = '';
    city.dataset.locationCity = '';
    city.dataset.selectedCity = cityValue;
    picker.dataset.locationPicker = '';
    picker.dataset.locationMode = filterMode ? 'filter' : 'form';
    renameStateLabel(state);
    addLocationStatus(city, picker);
    return { picker, state, city };
  }

  function addGroupDirectoryState(form) {
    if (!form || form.querySelector('[name="uf"]')) return;
    const cityField = form.querySelector('[name="cidade"]')?.closest('label');
    if (!cityField) return;
    const label = document.createElement('label');
    const caption = document.createElement('span');
    const select = document.createElement('select');
    caption.textContent = 'Estado';
    select.name = 'uf';
    select.setAttribute('aria-label', 'Filtrar grupos por estado');
    appendStateOptions(select, params.get('uf') || '', true);
    label.append(caption, select);
    cityField.before(label);
  }

  function addVacancyState(form) {
    if (!form || form.querySelector('[name="estado"]')) return;
    const city = form.querySelector('[name="cidade"]');
    if (!city) return;
    const select = document.createElement('select');
    select.name = 'estado';
    select.setAttribute('aria-label', 'Filtrar vagas por estado');
    appendStateOptions(select, params.get('estado') || '', true);
    city.before(select);
  }

  addGroupDirectoryState(document.querySelector('.directory-search'));
  addVacancyState(searchForm);

  const pickerRoots = new Set(document.querySelectorAll('[data-location-picker]'));
  document.querySelectorAll('.publication-form, .stack-form, .lead-form, .directory-search, [data-search-form]').forEach((form) => {
    if (form.matches('.directory-search, [data-search-form]')) pickerRoots.add(form);
    const state = form.querySelector('[name="state"], [name="estado"], [name="uf"]');
    const city = form.querySelector('[name="city"], [name="cidade"]');
    if (state && city) pickerRoots.add(state.closest('.form-grid, [data-location-picker]') || form);
  });

  async function loadCities(picker, { clearSelection = false } = {}) {
    const state = picker.querySelector('[data-location-state]');
    const city = picker.querySelector('[data-location-city]');
    const status = picker.querySelector('[data-location-status]');
    if (!state || !city) return;
    const stateCode = state.value;
    const filterMode = picker.dataset.locationMode === 'filter';
    const selected = clearSelection ? '' : (city.dataset.selectedCity || city.value || '');
    city.dataset.selectedCity = '';
    if (!stateCode) {
      picker.dataset.locationRequest = '';
      city.disabled = false;
      city.replaceChildren();
      const blank = document.createElement('option');
      blank.value = '';
      blank.textContent = filterMode ? 'Todas as cidades' : 'Selecione primeiro o estado';
      city.append(blank);
      if (selected) {
        const preserved = document.createElement('option');
        preserved.value = selected;
        preserved.textContent = selected;
        preserved.selected = true;
        city.append(preserved);
      }
      if (status) status.textContent = filterMode ? 'Escolha um estado para listar seus municípios.' : 'Selecione o estado para carregar todas as cidades.';
      return;
    }
    const requestId = `${Date.now()}-${Math.random()}`;
    picker.dataset.locationRequest = requestId;
    city.disabled = true;
    if (status) status.textContent = 'Carregando todas as cidades…';
    try {
      const response = await fetch(`/api/public/localidades/estados/${encodeURIComponent(stateCode)}/municipios`, { headers: { Accept: 'application/json' } });
      const body = await response.json();
      if (!response.ok || !body.sucesso) throw new Error(body.erro || 'Não foi possível carregar as cidades.');
      if (picker.dataset.locationRequest !== requestId) return;
      const municipalities = Array.isArray(body.municipios) ? body.municipios : [];
      const featuredKeys = new Set((body.principais || []).map(normalizeLocation));
      const featured = municipalities.filter((name) => featuredKeys.has(normalizeLocation(name)));
      const remaining = municipalities.filter((name) => !featuredKeys.has(normalizeLocation(name)));
      city.replaceChildren();
      const blank = document.createElement('option');
      blank.value = '';
      blank.textContent = filterMode ? 'Todas as cidades' : 'Selecione a cidade';
      city.append(blank);
      const appendGroup = (label, names) => {
        if (!names.length) return;
        const group = document.createElement('optgroup');
        group.label = label;
        names.forEach((name) => {
          const option = document.createElement('option');
          option.value = name;
          option.textContent = name;
          option.selected = normalizeLocation(name) === normalizeLocation(selected);
          group.append(option);
        });
        city.append(group);
      };
      appendGroup('Principais cidades', featured);
      appendGroup(`Todas as cidades de ${stateCode}`, remaining);
      const found = municipalities.some((name) => normalizeLocation(name) === normalizeLocation(selected));
      if (selected && !found) {
        const preserved = document.createElement('option');
        preserved.value = selected;
        preserved.textContent = selected;
        preserved.selected = true;
        city.append(preserved);
      }
      if (status) status.textContent = body.completo
        ? `${municipalities.length} cidades disponíveis — lista completa do IBGE.`
        : 'Lista principal disponível; tente novamente em instantes para carregar todos os municípios.';
    } catch (error) {
      if (status) status.textContent = `${error.message} As opções principais continuam disponíveis.`;
    } finally {
      if (picker.dataset.locationRequest === requestId) city.disabled = false;
    }
  }

  pickerRoots.forEach((rootElement) => {
    const filterMode = rootElement.matches('.directory-search, [data-search-form]');
    const prepared = prepareLocationPicker(rootElement, { filterMode });
    if (!prepared) return;
    prepared.state.addEventListener('change', () => loadCities(prepared.picker, { clearSelection: true }));
    loadCities(prepared.picker);
  });


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

  const visibleFieldErrors = [...document.querySelectorAll('.field-error')];
  visibleFieldErrors.forEach((message, index) => {
    const field = message.parentElement?.querySelector('input:not([type="hidden"]), select, textarea');
    if (!field) return;
    if (!message.id) message.id = `field-error-${index + 1}`;
    field.setAttribute('aria-invalid', 'true');
    const describedBy = new Set(String(field.getAttribute('aria-describedby') || '').split(/\s+/).filter(Boolean));
    describedBy.add(message.id);
    field.setAttribute('aria-describedby', [...describedBy].join(' '));
  });
  if (visibleFieldErrors.length) {
    requestAnimationFrame(() => document.querySelector('[aria-invalid="true"]')?.focus({ preventScroll: false }));
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

(function companyPortalInteractions() {
  document.querySelectorAll('[data-copy-text]').forEach((button) => {
    button.addEventListener('click', async () => {
      const value = button.dataset.copyText || '';
      if (!value) return;
      try {
        await navigator.clipboard.writeText(value);
        const original = button.textContent;
        button.textContent = 'Link copiado ✓';
        setTimeout(() => { button.textContent = original; }, 1800);
      } catch {
        window.prompt('Copie o link:', value);
      }
    });
  });

  document.querySelectorAll('.brand-upload-card input[type="file"]').forEach((input) => {
    input.addEventListener('change', () => {
      const file = input.files?.[0];
      const preview = input.closest('.brand-upload-card')?.querySelector('.brand-upload-preview');
      if (!file || !preview || !file.type.startsWith('image/')) return;
      const old = preview.querySelector('img[data-local-preview]');
      if (old) URL.revokeObjectURL(old.src);
      const image = document.createElement('img');
      image.dataset.localPreview = '';
      image.src = URL.createObjectURL(file);
      image.alt = 'Prévia da imagem selecionada';
      preview.append(image);
    });
  });

  const destination = document.querySelector('input[name="candidatura_destino"]');
  const channels = document.querySelectorAll('input[name="candidatura_tipo"]');
  function syncCandidateDestination() {
    if (!destination || !channels.length) return;
    const selected = [...channels].find((item) => item.checked)?.value || 'WHATSAPP';
    const placeholders = {
      WHATSAPP: 'Ex.: (11) 99999-9999',
      URL: 'Ex.: https://empresa.com.br/candidatura',
      EMAIL: 'Ex.: vagas@empresa.com.br',
    };
    destination.placeholder = placeholders[selected];
    destination.inputMode = selected === 'WHATSAPP' ? 'tel' : 'text';
  }
  channels.forEach((item) => item.addEventListener('change', syncCandidateDestination));
  syncCandidateDestination();
})();
