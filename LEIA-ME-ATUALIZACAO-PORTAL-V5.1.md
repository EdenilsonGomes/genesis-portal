# Portal Genesis IA V5.1 — benefícios e ganhos

Esta atualização mantém a arquitetura e as variáveis do Portal V5.0.1.

Novidades:

- VR, VA, assiduidade e outros benefícios monetários;
- descrição do vale-transporte;
- observações de benefícios;
- insalubridade com valor aproximado;
- ganhos mensais aproximados, sem VT;
- dados incluídos na página da vaga e na descrição estruturada `JobPosting`.

## Implantação

1. Execute primeiro a migração SQL V6 no mesmo PostgreSQL.
2. Substitua o conteúdo do serviço do portal pelos arquivos deste pacote.
3. Mantenha as variáveis atuais.
4. Faça Redeploy.
5. Teste `/health/live`, `/health`, `/vagas` e uma página individual de vaga.

A soma é apenas informativa. Confirme com a empresa as regras dos benefícios, descontos e base da insalubridade.
