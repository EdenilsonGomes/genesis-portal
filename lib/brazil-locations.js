'use strict';

const BRAZIL_STATES = [
  { code: 'AC', name: 'Acre', region: 'Norte' },
  { code: 'AL', name: 'Alagoas', region: 'Nordeste' },
  { code: 'AP', name: 'Amapá', region: 'Norte' },
  { code: 'AM', name: 'Amazonas', region: 'Norte' },
  { code: 'BA', name: 'Bahia', region: 'Nordeste' },
  { code: 'CE', name: 'Ceará', region: 'Nordeste' },
  { code: 'DF', name: 'Distrito Federal', region: 'Centro-Oeste' },
  { code: 'ES', name: 'Espírito Santo', region: 'Sudeste' },
  { code: 'GO', name: 'Goiás', region: 'Centro-Oeste' },
  { code: 'MA', name: 'Maranhão', region: 'Nordeste' },
  { code: 'MT', name: 'Mato Grosso', region: 'Centro-Oeste' },
  { code: 'MS', name: 'Mato Grosso do Sul', region: 'Centro-Oeste' },
  { code: 'MG', name: 'Minas Gerais', region: 'Sudeste' },
  { code: 'PA', name: 'Pará', region: 'Norte' },
  { code: 'PB', name: 'Paraíba', region: 'Nordeste' },
  { code: 'PR', name: 'Paraná', region: 'Sul' },
  { code: 'PE', name: 'Pernambuco', region: 'Nordeste' },
  { code: 'PI', name: 'Piauí', region: 'Nordeste' },
  { code: 'RJ', name: 'Rio de Janeiro', region: 'Sudeste' },
  { code: 'RN', name: 'Rio Grande do Norte', region: 'Nordeste' },
  { code: 'RS', name: 'Rio Grande do Sul', region: 'Sul' },
  { code: 'RO', name: 'Rondônia', region: 'Norte' },
  { code: 'RR', name: 'Roraima', region: 'Norte' },
  { code: 'SC', name: 'Santa Catarina', region: 'Sul' },
  { code: 'SP', name: 'São Paulo', region: 'Sudeste' },
  { code: 'SE', name: 'Sergipe', region: 'Nordeste' },
  { code: 'TO', name: 'Tocantins', region: 'Norte' },
];

const MAIN_STATE_CODES = ['SP', 'RJ', 'MG', 'PR', 'RS', 'SC', 'BA', 'PE', 'GO', 'DF', 'CE', 'ES'];
const BRAZIL_STATE_CODES = BRAZIL_STATES.map((state) => state.code);

const MAIN_CITIES = {
  AC: ['Rio Branco', 'Cruzeiro do Sul', 'Sena Madureira'],
  AL: ['Maceió', 'Arapiraca', 'Rio Largo', 'Palmeira dos Índios'],
  AP: ['Macapá', 'Santana', 'Laranjal do Jari'],
  AM: ['Manaus', 'Parintins', 'Itacoatiara', 'Manacapuru'],
  BA: ['Salvador', 'Feira de Santana', 'Vitória da Conquista', 'Camaçari', 'Juazeiro', 'Lauro de Freitas', 'Itabuna', 'Barreiras'],
  CE: ['Fortaleza', 'Caucaia', 'Juazeiro do Norte', 'Maracanaú', 'Sobral', 'Crato'],
  DF: ['Brasília'],
  ES: ['Vitória', 'Vila Velha', 'Serra', 'Cariacica', 'Linhares', 'Cachoeiro de Itapemirim'],
  GO: ['Goiânia', 'Aparecida de Goiânia', 'Anápolis', 'Rio Verde', 'Águas Lindas de Goiás', 'Luziânia'],
  MA: ['São Luís', 'Imperatriz', 'São José de Ribamar', 'Timon', 'Caxias'],
  MT: ['Cuiabá', 'Várzea Grande', 'Rondonópolis', 'Sinop', 'Tangará da Serra'],
  MS: ['Campo Grande', 'Dourados', 'Três Lagoas', 'Corumbá'],
  MG: ['Belo Horizonte', 'Uberlândia', 'Contagem', 'Juiz de Fora', 'Betim', 'Montes Claros', 'Uberaba', 'Divinópolis'],
  PA: ['Belém', 'Ananindeua', 'Santarém', 'Marabá', 'Parauapebas', 'Castanhal'],
  PB: ['João Pessoa', 'Campina Grande', 'Santa Rita', 'Patos'],
  PR: ['Curitiba', 'Londrina', 'Maringá', 'Ponta Grossa', 'Cascavel', 'São José dos Pinhais', 'Foz do Iguaçu'],
  PE: ['Recife', 'Jaboatão dos Guararapes', 'Olinda', 'Caruaru', 'Petrolina', 'Paulista', 'Cabo de Santo Agostinho'],
  PI: ['Teresina', 'Parnaíba', 'Picos', 'Floriano'],
  RJ: ['Rio de Janeiro', 'São Gonçalo', 'Duque de Caxias', 'Nova Iguaçu', 'Niterói', 'Campos dos Goytacazes', 'Belford Roxo', 'São João de Meriti', 'Petrópolis', 'Volta Redonda'],
  RN: ['Natal', 'Mossoró', 'Parnamirim', 'São Gonçalo do Amarante'],
  RS: ['Porto Alegre', 'Caxias do Sul', 'Canoas', 'Pelotas', 'Santa Maria', 'Gravataí', 'Novo Hamburgo'],
  RO: ['Porto Velho', 'Ji-Paraná', 'Ariquemes', 'Vilhena'],
  RR: ['Boa Vista', 'Rorainópolis'],
  SC: ['Florianópolis', 'Joinville', 'Blumenau', 'São José', 'Itajaí', 'Chapecó', 'Criciúma'],
  SP: ['São Paulo', 'Guarulhos', 'Campinas', 'São Bernardo do Campo', 'Santo André', 'Osasco', 'Sorocaba', 'Ribeirão Preto', 'São José dos Campos', 'Santos', 'Jundiaí', 'Mogi das Cruzes', 'Piracicaba', 'Bauru'],
  SE: ['Aracaju', 'Nossa Senhora do Socorro', 'Lagarto', 'Itabaiana'],
  TO: ['Palmas', 'Araguaína', 'Gurupi', 'Porto Nacional'],
};

const municipalityCache = new Map();
const IBGE_BASE_URL = 'https://servicodados.ibge.gov.br/api/v1/localidades';

function normalizeStateCode(value) {
  const code = String(value || '').trim().toUpperCase();
  return BRAZIL_STATE_CODES.includes(code) ? code : '';
}

function stateName(code) {
  return BRAZIL_STATES.find((state) => state.code === normalizeStateCode(code))?.name || '';
}

function mainCities(code) {
  return [...(MAIN_CITIES[normalizeStateCode(code)] || [])];
}

function uniqueCityNames(items) {
  const seen = new Set();
  return items
    .map((item) => String(item?.nome || item?.name || item || '').trim())
    .filter((name) => {
      const key = name.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
      if (!name || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((left, right) => left.localeCompare(right, 'pt-BR'));
}

async function loadMunicipalities(code, fetchImpl = globalThis.fetch) {
  const state = normalizeStateCode(code);
  if (!state) {
    const error = new Error('Estado inválido.');
    error.statusCode = 400;
    throw error;
  }

  const cached = municipalityCache.get(state);
  if (cached?.expiresAt > Date.now()) return cached.value;

  try {
    if (typeof fetchImpl !== 'function') throw new Error('Cliente HTTP indisponível.');
    const response = await fetchImpl(`${IBGE_BASE_URL}/estados/${state}/municipios?orderBy=nome`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) throw new Error(`IBGE respondeu HTTP ${response.status}.`);
    const body = await response.json();
    const cities = uniqueCityNames(Array.isArray(body) ? body : []);
    if (!cities.length) throw new Error('O IBGE não retornou municípios.');
    const value = { state, stateName: stateName(state), cities, featured: mainCities(state), complete: true, source: 'IBGE' };
    municipalityCache.set(state, { value, expiresAt: Date.now() + 24 * 60 * 60 * 1_000 });
    return value;
  } catch (error) {
    const cities = mainCities(state);
    const value = { state, stateName: stateName(state), cities, featured: cities, complete: false, source: 'fallback', warning: error.message };
    municipalityCache.set(state, { value, expiresAt: Date.now() + 5 * 60 * 1_000 });
    return value;
  }
}

function clearMunicipalityCache() {
  municipalityCache.clear();
}

module.exports = {
  BRAZIL_STATES,
  BRAZIL_STATE_CODES,
  MAIN_STATE_CODES,
  MAIN_CITIES,
  IBGE_BASE_URL,
  normalizeStateCode,
  stateName,
  mainCities,
  loadMunicipalities,
  clearMunicipalityCache,
};
