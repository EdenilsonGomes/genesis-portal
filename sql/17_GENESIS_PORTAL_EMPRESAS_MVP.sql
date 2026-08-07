BEGIN;

ALTER TABLE portal_contas
  ADD COLUMN IF NOT EXISTS origem_ref VARCHAR(120);

CREATE TABLE IF NOT EXISTS portal_empresas (
  id BIGSERIAL PRIMARY KEY,
  empresa_id BIGINT NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  owner_account_id BIGINT NOT NULL REFERENCES portal_contas(id) ON DELETE CASCADE,
  slug VARCHAR(180) NOT NULL,
  nome_publico VARCHAR(180) NOT NULL,
  segmento VARCHAR(120),
  resumo TEXT,
  cidade VARCHAR(120),
  estado CHAR(2),
  site_url TEXT,
  instagram_url TEXT,
  linkedin_url TEXT,
  cor_primaria VARCHAR(7) NOT NULL DEFAULT '#159c50',
  status VARCHAR(20) NOT NULL DEFAULT 'RASCUNHO',
  onboarding_step SMALLINT NOT NULL DEFAULT 1,
  origem_ref VARCHAR(120),
  publicado_em TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT portal_empresas_status_check CHECK (status IN ('RASCUNHO','ATIVO','SUSPENSO')),
  CONSTRAINT portal_empresas_onboarding_check CHECK (onboarding_step BETWEEN 1 AND 3),
  CONSTRAINT portal_empresas_cor_check CHECK (cor_primaria ~ '^#[0-9A-Fa-f]{6}$')
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_portal_empresas_empresa
  ON portal_empresas(empresa_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_portal_empresas_owner
  ON portal_empresas(owner_account_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_portal_empresas_slug_lower
  ON portal_empresas(LOWER(slug));
CREATE INDEX IF NOT EXISTS idx_portal_empresas_status
  ON portal_empresas(status, updated_at DESC);

DROP TRIGGER IF EXISTS portal_empresas_atualizar_updated_at ON portal_empresas;
CREATE TRIGGER portal_empresas_atualizar_updated_at
BEFORE UPDATE ON portal_empresas
FOR EACH ROW EXECUTE FUNCTION atualizar_updated_at();

CREATE TABLE IF NOT EXISTS portal_empresa_imagens (
  portal_empresa_id BIGINT NOT NULL REFERENCES portal_empresas(id) ON DELETE CASCADE,
  tipo VARCHAR(10) NOT NULL,
  conteudo BYTEA NOT NULL,
  mime_type VARCHAR(120) NOT NULL DEFAULT 'image/webp',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (portal_empresa_id, tipo),
  CONSTRAINT portal_empresa_imagens_tipo_check CHECK (tipo IN ('LOGO','CAPA'))
);

ALTER TABLE portal_eventos
  ADD COLUMN IF NOT EXISTS empresa_id BIGINT REFERENCES empresas(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_portal_eventos_empresa_data
  ON portal_eventos(empresa_id, created_at DESC)
  WHERE empresa_id IS NOT NULL;

COMMIT;

SELECT
  TO_REGCLASS('public.portal_empresas') AS portal_empresas,
  TO_REGCLASS('public.portal_empresa_imagens') AS portal_empresa_imagens,
  EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='portal_eventos' AND column_name='empresa_id'
  ) AS eventos_com_empresa;
