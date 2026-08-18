# Atualização 13.1 — Portal de Empresas MVP

Antes do deploy desta versão, aplique `sql/17_GENESIS_PORTAL_EMPRESAS_MVP.sql`. Depois execute `npm run preflight:companies` e `npm run test:companies`. As novas páginas principais são `/portal-para-empresas`, `/empresas` e `/meu-portal`. A migration é aditiva e as vagas continuam na tabela oficial `vagas`.

## Domínios oficiais e identificação institucional

O mesmo serviço atende o site institucional e o portal público, escolhendo a página inicial pelo hostname. Configure no EasyPanel:

```env
INSTITUTIONAL_URL=https://genesisrecruta.com.br
SITE_URL=https://vagas.genesisrecruta.com.br
PANEL_URL=https://app.genesisrecruta.com.br
BRAND_NAME=Gênesis Recruta
PRIVACY_EMAIL=junior13djd@gmail.com
ORGANIZATION_LEGAL_NAME=50.374.306 Edenilson Gomes do Nascimento Junior
ORGANIZATION_CNPJ=50.374.306/0001-86
ORGANIZATION_RESPONSIBLE=Edenilson Gomes do Nascimento Junior
ORGANIZATION_CITY=São Paulo
ORGANIZATION_STATE=SP
```

`genesisrecruta.com.br` exibe a landing institucional. A raiz de `vagas.genesisrecruta.com.br` continua exibindo o portal de vagas, e `app.genesisrecruta.com.br` continua apontando para o serviço do painel.

---

# Deploy seguro no Easypanel

Este roteiro preserva o portal e o painel atuais e permite voltar ao deployment anterior rapidamente.

## Versão 13.0.1

- corrige a restrição antiga que rejeitava grupos na categoria **Free lances**;
- repara os valores padrão de `verified`, `featured`, `created_at` e `updated_at` em bancos vindos do serviço legado;
- remove o campo manual de UF e oferece **Estado → Cidade** com estados principais primeiro e todos os municípios do estado pela API oficial do IBGE;
- corrige o redirecionamento para o grupo oficial de vagas;
- entrega novas identidades para **Gênesis** e **Vagas & Grupos**, mantendo os dois posicionamentos separados;
- moderniza páginas, cards, formulários, responsividade, foco, mensagens de erro e navegação móvel;
- amplia preflight e testes de conta, localização, grupo, vaga, upload e compatibilidade do banco.

Nenhuma variável nova é obrigatória para esta correção. O cache de CSS e JavaScript é atualizado automaticamente pela versão da aplicação.

> **Obrigatório nesta versão:** execute `npm run migrate:communities` depois de publicar os arquivos. Sem essa etapa, bancos que vieram do serviço antigo podem continuar recusando “Free lances”.

## 1. Faça os backups

### PostgreSQL

No terminal do serviço PostgreSQL:

```bash
pg_dump -U SEU_USUARIO -d recrutamento-db -Fc -f /tmp/genesis-antes-integracao.dump
```

Para um backup apenas da estrutura:

```bash
pg_dump -U SEU_USUARIO -d recrutamento-db --schema-only --no-owner --no-privileges -f /tmp/estrutura-antes-integracao.sql
```

Também mantenha uma cópia dos repositórios atuais do portal e do painel.

## 2. Atualize o portal

Use o conteúdo da raiz deste pacote no mesmo repositório conectado ao serviço atual do portal (`server.js`, `community.js`, `public/`, `sql/` e demais arquivos).

Não altere inicialmente:

- nome do serviço;
- porta interna 3000;
- PostgreSQL;
- domínio temporário;
- credenciais já utilizadas.

Adicione ou confira estas variáveis:

```env
NODE_ENV=production
SITE_URL=https://projeto-genesis-portal.d7lmap.easypanel.host
PANEL_URL=https://URL-ATUAL-DO-PAINEL
PORTAL_AUTH_SECRET=CHAVE_ESTAVEL_DE_48_OU_MAIS_CARACTERES
PORTAL_ANALYTICS_SECRET=OUTRA_CHAVE_ESTAVEL
PORTAL_SESSION_DAYS=14
DB_POOL_MAX=10
```

Gere uma chave:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

Use valores diferentes em `PORTAL_AUTH_SECRET` e `PORTAL_ANALYTICS_SECRET`.

Preserve todas as variáveis atuais de PostgreSQL, WhatsApp, WAHA e webhooks.

## 3. Faça o primeiro deploy do portal

O serviço pode iniciar antes da migration, mas as rotas novas apresentarão uma mensagem de estrutura incompleta até a migration ser executada.

No terminal do serviço recém-publicado:

```bash
npm run migrate:communities
```

O comando é idempotente: pode ser executado novamente sem apagar os registros.

Depois execute:

```bash
npm run preflight
```

Resultado esperado:

```text
Pré-checagem concluída.
```

Faça um novo restart/redeploy do portal.

Confirme também:

```bash
curl -fsS https://SEU-DOMINIO/health/communities
```

O retorno deve informar `"version":"13.0.1"`, `"status":"ok"`, `"category_free_lances":"ok"` e `"legacy_required_columns":"ok"`.

## 4. Teste o portal antes de alterar o painel

Abra:

```text
/health
/
/vagas
/grupos
/cadastro
/robots.txt
/sitemap.xml
```

No terminal:

```bash
npm run smoke
```

## 5. Atualize o painel

Use o conteúdo da pasta `painel/` no mesmo repositório do painel atual.

Preserve todas as variáveis existentes e adicione:

```env
PORTAL_BASE_URL=https://projeto-genesis-portal.d7lmap.easypanel.host
PUBLIC_BASE_URL=https://projeto-genesis-portal.d7lmap.easypanel.host
DB_POOL_MAX=8
```

Mantenha o login interno atual:

```env
APP_LOGIN_USER=...
APP_LOGIN_PASSWORD=...
APP_SESSION_SECRET=...
```

Faça o deploy e entre no painel. Para usuários administradores aparecerá o item:

```text
Portal e grupos
```

## 6. Teste funcional completo

### Conta pública

1. Abra `/cadastro`.
2. Crie uma conta de teste como Recrutador.
3. Confira `/minha-conta`.
4. Envie um grupo.
5. Envie uma vaga externa.

### Moderação interna

1. Entre no painel interno com usuário administrador.
2. Abra **Portal e grupos**.
3. Revise o grupo e teste o convite.
4. Aprove o grupo.
5. Revise a vaga externa.
6. Converta a vaga para rascunho oficial.
7. Confirme que ela apareceu na gestão de vagas, mas não foi publicada automaticamente.

### Portal público

1. Abra `/grupos` em aba anônima.
2. Confira o card aprovado.
3. Abra a página individual.
4. Teste o redirecionamento para o WhatsApp.
5. Confira a contagem de acessos no painel.
6. Envie uma denúncia de teste e resolva-a no painel.

## 7. Serviço antigo de grupos

Não desligue o MVP antigo imediatamente.

Mantenha-o durante a verificação. Após confirmar que:

- grupos antigos estão visíveis;
- novos grupos podem ser cadastrados;
- painel consegue moderar;
- imagens carregam;
- métricas são registradas;

você pode desligar o serviço Python antigo. Não apague as tabelas `gg_*`.

## 8. Rollback rápido

Se o portal ou painel apresentar erro:

1. No Easypanel, selecione o deployment anterior do serviço afetado.
2. Faça rollback/redeploy.
3. Não reverta a migration de imediato; ela é aditiva e as versões antigas ignoram as tabelas novas.
4. Se necessário, desative temporariamente o menu/links novos retornando ao código anterior.

Não execute `DROP TABLE` durante um incidente. Primeiro restaure a aplicação e investigue os logs.
