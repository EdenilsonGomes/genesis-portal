BEGIN;

-- ============================================================
-- GENESIS IA — PORTAL PÚBLICO DE VAGAS
-- Campos públicos, SEO, candidatura, leads e analytics.
-- Migração idempotente: pode ser executada novamente com segurança.
-- ============================================================

CREATE OR REPLACE FUNCTION atualizar_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Dados públicos da empresa contratante.
ALTER TABLE empresas ADD COLUMN IF NOT EXISTS nome_publico VARCHAR(180);
ALTER TABLE empresas ADD COLUMN IF NOT EXISTS descricao_publica TEXT;
ALTER TABLE empresas ADD COLUMN IF NOT EXISTS logo_url TEXT;
ALTER TABLE empresas ADD COLUMN IF NOT EXISTS site_url TEXT;
ALTER TABLE empresas ADD COLUMN IF NOT EXISTS exibir_no_portal BOOLEAN NOT NULL DEFAULT TRUE;

-- Configuração pública da vaga.
ALTER TABLE vagas ADD COLUMN IF NOT EXISTS publicar_portal BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE vagas ADD COLUMN IF NOT EXISTS destaque_portal BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE vagas ADD COLUMN IF NOT EXISTS portal_publicado_em TIMESTAMPTZ;
ALTER TABLE vagas ADD COLUMN IF NOT EXISTS imagem_capa_url TEXT;
ALTER TABLE vagas ADD COLUMN IF NOT EXISTS seo_titulo VARCHAR(180);
ALTER TABLE vagas ADD COLUMN IF NOT EXISTS seo_descricao VARCHAR(320);
ALTER TABLE vagas ADD COLUMN IF NOT EXISTS canal_candidatura VARCHAR(30) NOT NULL DEFAULT 'WHATSAPP_GENESIS';
ALTER TABLE vagas ADD COLUMN IF NOT EXISTS whatsapp_candidatura VARCHAR(40);
ALTER TABLE vagas ADD COLUMN IF NOT EXISTS candidatura_url TEXT;
ALTER TABLE vagas ADD COLUMN IF NOT EXISTS candidatura_email VARCHAR(200);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'vagas_canal_candidatura_check'
      AND conrelid = 'vagas'::regclass
  ) THEN
    ALTER TABLE vagas
      ADD CONSTRAINT vagas_canal_candidatura_check
      CHECK (canal_candidatura IN ('WHATSAPP_GENESIS', 'URL_EXTERNA', 'EMAIL'));
  END IF;
END;
$$;

CREATE INDEX IF NOT EXISTS idx_vagas_portal_ativas
  ON vagas (status, publicar_portal, destaque_portal, portal_publicado_em DESC)
  WHERE publicar_portal IS TRUE;

CREATE INDEX IF NOT EXISTS idx_empresas_exibir_portal
  ON empresas (ativo, exibir_no_portal, nome);

-- Registra a primeira publicação quando uma vaga passa a ficar pública e ativa.
CREATE OR REPLACE FUNCTION definir_portal_publicado_em()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.status = 'ATIVA'
     AND COALESCE(NEW.publicar_portal, TRUE) IS TRUE
     AND NEW.portal_publicado_em IS NULL THEN
    NEW.portal_publicado_em = NOW();
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS vagas_definir_portal_publicado_em ON vagas;
CREATE TRIGGER vagas_definir_portal_publicado_em
BEFORE INSERT OR UPDATE OF status, publicar_portal ON vagas
FOR EACH ROW
EXECUTE FUNCTION definir_portal_publicado_em();

UPDATE vagas
SET portal_publicado_em = COALESCE(portal_publicado_em, created_at, NOW())
WHERE status = 'ATIVA'
  AND COALESCE(publicar_portal, TRUE) IS TRUE
  AND portal_publicado_em IS NULL;

-- Leads comerciais enviados pelo formulário /anunciar-vaga.
CREATE TABLE IF NOT EXISTS portal_leads_empresas (
  id BIGSERIAL PRIMARY KEY,
  empresa_nome VARCHAR(180) NOT NULL,
  cnpj VARCHAR(30),
  contato_nome VARCHAR(160) NOT NULL,
  email VARCHAR(200) NOT NULL,
  whatsapp VARCHAR(40) NOT NULL,
  cidade VARCHAR(120),
  estado CHAR(2),
  quantidade_vagas INTEGER NOT NULL DEFAULT 1,
  cargos_interesse TEXT NOT NULL,
  mensagem TEXT,
  origem VARCHAR(80) NOT NULL DEFAULT 'PORTAL_EMPRESAS',
  utm_source VARCHAR(160),
  utm_medium VARCHAR(160),
  utm_campaign VARCHAR(200),
  status VARCHAR(30) NOT NULL DEFAULT 'NOVO',
  observacao_interna TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT portal_leads_quantidade_check CHECK (quantidade_vagas >= 1),
  CONSTRAINT portal_leads_status_check CHECK (status IN ('NOVO','EM_CONTATO','QUALIFICADO','PROPOSTA','CLIENTE','DESCARTADO'))
);

CREATE INDEX IF NOT EXISTS idx_portal_leads_status_created
  ON portal_leads_empresas (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_portal_leads_email
  ON portal_leads_empresas (LOWER(email));
CREATE INDEX IF NOT EXISTS idx_portal_leads_whatsapp
  ON portal_leads_empresas (whatsapp);

DROP TRIGGER IF EXISTS portal_leads_atualizar_updated_at ON portal_leads_empresas;
CREATE TRIGGER portal_leads_atualizar_updated_at
BEFORE UPDATE ON portal_leads_empresas
FOR EACH ROW
EXECUTE FUNCTION atualizar_updated_at();

-- Eventos anônimos usados para medir visualizações e cliques do portal.
CREATE TABLE IF NOT EXISTS portal_eventos (
  id BIGSERIAL PRIMARY KEY,
  vaga_id BIGINT REFERENCES vagas(id) ON DELETE SET NULL,
  evento VARCHAR(60) NOT NULL,
  sessao_id VARCHAR(120),
  pagina TEXT,
  origem TEXT,
  meio VARCHAR(160),
  campanha VARCHAR(200),
  metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
  ip_hash VARCHAR(128),
  user_agent TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_portal_eventos_vaga_data
  ON portal_eventos (vaga_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_portal_eventos_tipo_data
  ON portal_eventos (evento, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_portal_eventos_sessao
  ON portal_eventos (sessao_id, created_at DESC)
  WHERE sessao_id IS NOT NULL;

COMMIT;

-- Conferência rápida:
SELECT column_name
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'vagas'
  AND column_name IN (
    'publicar_portal','destaque_portal','portal_publicado_em','imagem_capa_url',
    'seo_titulo','seo_descricao','canal_candidatura','whatsapp_candidatura',
    'candidatura_url','candidatura_email'
  )
ORDER BY column_name;

SELECT TO_REGCLASS('public.portal_leads_empresas') AS portal_leads_empresas,
       TO_REGCLASS('public.portal_eventos') AS portal_eventos;
