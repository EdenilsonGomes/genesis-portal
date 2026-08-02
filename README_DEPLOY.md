# Deploy seguro no Easypanel

Este roteiro preserva o portal e o painel atuais e permite voltar ao deployment anterior rapidamente.

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

Use o conteúdo da pasta `portal/` no mesmo repositório conectado ao serviço atual do portal.

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
