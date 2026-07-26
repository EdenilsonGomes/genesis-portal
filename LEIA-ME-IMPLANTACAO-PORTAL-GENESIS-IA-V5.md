# Genesis IA V5 — Landing Page e Portal Público de Vagas

## O que este pacote entrega

Este projeto é um serviço público separado do painel administrativo. Ele utiliza o mesmo PostgreSQL e não substitui o painel atual.

Estrutura recomendada:

```text
genesisia.com.br             Landing page institucional
  ├── /vagas                 Portal público de vagas
  ├── /vagas/ID-titulo       Página individual da vaga
  ├── /anunciar-vaga         Formulário comercial para empresas
  └── /grupo                 Redirecionamento para o convite atual

app.genesisia.com.br         Painel protegido por login
```

Enquanto não houver domínio próprio, o portal e o painel podem continuar em endereços separados do EasyPanel.

## Integração com o painel

Não existe duplicação de cadastro.

```text
Recrutador cria a vaga no painel
           ↓
PostgreSQL tabela vagas
           ↓
Vaga com status ATIVA aparece no portal
```

Somente aparecem publicamente as vagas que atendem às regras:

```text
status = ATIVA
publicar_portal = true
empresa ativa
empresa visível no portal
data de encerramento ainda não vencida
```

Vagas em RASCUNHO, PAUSADA ou ENCERRADA não aparecem.

## Segurança das vagas externas

O formulário `/anunciar-vaga` não cria nem publica vagas. Ele cria um lead comercial em `portal_leads_empresas`.

Quando uma oportunidade externa for aprovada e cadastrada manualmente, use:

```text
origem_vaga = EMPRESA_EXTERNA
canal_candidatura = URL_EXTERNA ou EMAIL
```

A migração possui uma proteção que força:

```text
atendimento_chatbot = false
```

O workflow V5 também filtra as vagas do chatbot com:

```sql
COALESCE(v.atendimento_chatbot, TRUE) IS TRUE
```

Assim, vagas externas configuradas dessa maneira aparecem no portal, mas não são oferecidas pela Evelyn.

## Funcionalidades públicas

### Landing page

- visual de startup/SaaS;
- apresentação dos benefícios;
- CTA para candidatos;
- CTA para empresas;
- botão de login;
- botão para o portal de vagas;
- explicação da operação Genesis IA.

### Portal de vagas

- pesquisa por cargo, bairro, cidade ou empresa;
- filtro por cidade;
- cards com salário, escala, modalidade e localização;
- imagens temáticas automáticas por categoria;
- paginação;
- CTA para grupo de WhatsApp;
- CTA comercial para empresas.

### Página individual

- informações completas da vaga;
- empresa contratante;
- salário, escala, horário e modalidade;
- benefícios e requisitos;
- insalubridade;
- quantidade de vagas;
- botão direto para WhatsApp;
- mensagem pré-preenchida com código da vaga;
- QR Code no computador;
- CTA fixo no celular;
- botão para o grupo;
- vagas relacionadas.

### Empresas

O formulário coleta:

- empresa;
- CNPJ;
- contato;
- e-mail;
- WhatsApp;
- cidade e estado;
- quantidade aproximada;
- cargos;
- contexto da contratação;
- origem UTM.

O lead é salvo com status `NOVO`.

### Rastreamento

A tabela `portal_eventos` registra de forma simples:

- visualização de página;
- visualização de vaga;
- clique em candidatura;
- clique no grupo;
- busca;
- vagas relacionadas;
- origem e campanha.

O IP não é salvo em texto. O sistema guarda somente um hash.

## SEO e Google Vagas

O portal já inclui:

- HTML renderizado no servidor;
- URL amigável e canonical;
- título e descrição individuais;
- Open Graph;
- sitemap dinâmico;
- robots.txt;
- `Organization`;
- `WebSite` e `SearchAction`;
- `BreadcrumbList`;
- `JobPosting` em cada página individual;
- tratamento HTTP 410 para vagas encerradas;
- exclusão de páginas filtradas do índice por `noindex,follow`.

A marcação `JobPosting` utiliza os dados visíveis na página:

- título;
- descrição;
- empresa contratante;
- data de publicação;
- local;
- contrato;
- salário;
- experiência;
- quantidade de vagas;
- data de encerramento, quando cadastrada.

A exibição no Google não é garantida. Depois do deploy, ainda será necessário:

1. usar um domínio público com HTTPS;
2. cadastrar o domínio no Google Search Console;
3. enviar o sitemap;
4. validar algumas vagas no Rich Results Test;
5. configurar a Indexing API para acelerar inclusão, atualização e remoção de vagas.

## Implantação

### 1. Faça backup

Faça backup do PostgreSQL e exporte o chatbot atual antes de começar.

### 2. Execute a migração

Arquivo:

```text
sql/07_GENESIS_IA_PORTAL_PUBLICO_VAGAS_SEO_LEADS.sql
```

No PostgreSQL:

```bash
psql -U admin -d recrutamento-db
```

Cole o SQL completo. O final precisa retornar `COMMIT`.

### 3. Crie um novo serviço no EasyPanel

Não substitua o painel atual.

Crie um novo serviço, por exemplo:

```text
genesis-portal
```

Use este projeto como diretório raiz.

Porta:

```text
3000
```

### 4. Configure as variáveis

Use `.env.example` como referência.

Variáveis mínimas:

```env
PORT=3000
NODE_ENV=production
PGHOST=recrutamento-db
PGPORT=5432
PGDATABASE=recrutamento-db
PGUSER=admin
PGPASSWORD=SENHA_DO_BANCO
DB_SSL=false

SITE_URL=https://URL_PUBLICA_DO_PORTAL
PANEL_URL=https://projeto-painel-vagas.d7lmap.easypanel.host
BRAND_NAME=Genesis IA
CANDIDATE_WHATSAPP_NUMBER=5511913022278
COMMERCIAL_WHATSAPP_NUMBER=5511913022278
PORTAL_ANALYTICS_SECRET=CHAVE_LONGA_E_NOVA
```

O `SITE_URL` não pode terminar com `/`.

### 5. Configure o grupo

Opção mais simples:

```env
WHATSAPP_GROUP_URL=https://chat.whatsapp.com/CODIGO_ATUAL
```

Opção recomendada, com convite consultado no WAHA e cache de dez minutos:

```env
WAHA_BASE_URL=http://NOME_DO_SERVICO_WAHA:3000
WAHA_API_KEY=CHAVE_DO_WAHA
WAHA_SESSION=whats_junior
WAHA_GROUP_ID=120363000000000000@g.us
```

A API key nunca é enviada ao navegador.

### 6. Importe o chatbot V5

Arquivo:

```text
n8n/01_GENESIS_IA_CHATBOT_OPERACIONAL_V5_PORTAL.json
```

Ele é igual ao V4.1 no fluxo principal, mas não oferece vagas com `atendimento_chatbot = false`.

Após importar:

- confira as credenciais;
- reconecte os subworkflows de entrevista e reprovação;
- desative o chatbot anterior;
- ative somente o V5.

### 7. Alerta de novo lead de empresa

Importe:

```text
n8n/08_GENESIS_IA_ALERTA_LEAD_EMPRESA_PORTAL_V5.json
```

No serviço do n8n, configure:

```env
LEAD_EMPRESA_WEBHOOK_TOKEN=UMA_CHAVE_LONGA
PORTAL_LEAD_ALERT_PHONE=55DDDNUMERO
```

No portal, configure:

```env
LEAD_EMPRESA_WEBHOOK_URL=https://SEU_N8N/webhook/genesis-portal-lead-empresa-v5
LEAD_EMPRESA_WEBHOOK_TOKEN=A_MESMA_CHAVE
```

Publique o workflow. Quando uma empresa enviar o formulário, o lead será salvo no PostgreSQL e a equipe poderá receber um aviso no WhatsApp.

## Testes

### Teste A — integração

1. Crie uma vaga no painel.
2. Deixe o status como `RASCUNHO`.
3. Confirme que não aparece no portal.
4. Altere para `ATIVA`.
5. Atualize `/vagas`.
6. Confirme que a vaga apareceu.

### Teste B — WhatsApp

1. Abra a vaga no celular.
2. Clique em candidatar-se.
3. Confirme que o WhatsApp abre com título e código.
4. Abra no computador.
5. Escaneie o QR Code.

### Teste C — vagas externas

Depois de criar uma vaga externa de teste, execute:

```sql
UPDATE vagas
SET
    origem_vaga = 'EMPRESA_EXTERNA',
    canal_candidatura = 'URL_EXTERNA',
    candidatura_url = 'https://empresa.com/candidatura'
WHERE id = ID_DA_VAGA;
```

Confirme:

```sql
SELECT atendimento_chatbot
FROM vagas
WHERE id = ID_DA_VAGA;
```

O resultado esperado é `false`.

### Teste D — lead comercial

1. Abra `/anunciar-vaga`.
2. Envie um cadastro de teste.
3. Consulte:

```sql
SELECT *
FROM portal_leads_empresas
ORDER BY id DESC
LIMIT 5;
```

4. Confira o alerta no WhatsApp, caso o workflow 08 esteja ativo.

### Teste E — SEO

Confira:

```text
/robots.txt
/sitemap.xml
/vagas/ID-slug
```

Na página individual, visualize o código-fonte e procure por:

```text
"@type":"JobPosting"
```

## Próxima fase recomendada

Depois do piloto público funcionar:

- adicionar os leads de empresas dentro da aba Monitoramento;
- criar tela de configuração pública da empresa;
- criar controles no formulário de vagas para publicação, destaque e canal de candidatura;
- conectar Search Console e Indexing API;
- criar dashboard de conversão do portal por vaga;
- adicionar páginas de cidade e categoria para SEO local;
- adicionar política de privacidade e termos adaptados à operação.
