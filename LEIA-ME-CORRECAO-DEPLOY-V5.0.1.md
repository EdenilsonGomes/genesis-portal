# Genesis IA Portal V5.0.1 — correção de deploy

Esta revisão corrige dois pontos de implantação:

1. o servidor HTTP inicia mesmo quando o PostgreSQL demora alguns segundos para ficar acessível;
2. foi criado o endpoint de vida `/health/live`, que não depende do banco.

## Estrutura no GitHub

Os arquivos deste diretório devem ficar na raiz do repositório:

- `Dockerfile`
- `package.json`
- `server.js`
- `public/`
- `sql/`

Não deixe todos os arquivos dentro de uma segunda pasta `genesis_portal_v5`, salvo se configurar essa pasta como `Root Directory` no EasyPanel.

## EasyPanel

- porta do serviço: `3000`
- health check: `/health/live`
- crie o serviço no mesmo projeto/rede do PostgreSQL quando usar `PGHOST=recrutamento-db`

## Diagnóstico

- `/health/live`: confirma que o Node está no ar;
- `/health`: confirma Node + PostgreSQL.

Se `/health/live` funcionar e `/health` retornar 503, o problema é a conexão/rede/credenciais do PostgreSQL.
