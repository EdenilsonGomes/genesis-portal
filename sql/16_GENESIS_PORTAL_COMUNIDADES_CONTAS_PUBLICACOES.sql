BEGIN;

-- ============================================================
-- GENESIS IA — PORTAL UNIFICADO
-- Contas públicas, comunidades, submissões de vagas e métricas.
-- Migração idempotente e compatível com o MVP gg_* existente.
-- ============================================================

CREATE OR REPLACE FUNCTION atualizar_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- -----------------------------------------------------------------
-- Contas públicas: recrutadores e empresas que divulgam conteúdo.
-- Não substitui app_usuarios, usado pelo painel operacional interno.
-- -----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS portal_contas (
  id BIGSERIAL PRIMARY KEY,
  tipo VARCHAR(20) NOT NULL,
  nome VARCHAR(160) NOT NULL,
  email VARCHAR(200) NOT NULL,
  senha_hash TEXT NOT NULL,
  whatsapp VARCHAR(30) NOT NULL,
  empresa_nome VARCHAR(180),
  cnpj VARCHAR(30),
  cidade VARCHAR(120),
  estado CHAR(2),
  status VARCHAR(20) NOT NULL DEFAULT 'ATIVA',
  lead_status VARCHAR(30) NOT NULL DEFAULT 'NOVO',
  consentimento_comercial BOOLEAN NOT NULL DEFAULT FALSE,
  aceite_termos_em TIMESTAMPTZ,
  origem VARCHAR(80) NOT NULL DEFAULT 'CADASTRO_PORTAL',
  observacao_interna TEXT,
  ultimo_login_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT portal_contas_tipo_check CHECK (tipo IN ('RECRUTADOR','EMPRESA')),
  CONSTRAINT portal_contas_status_check CHECK (status IN ('ATIVA','BLOQUEADA','EXCLUIDA')),
  CONSTRAINT portal_contas_lead_status_check CHECK (lead_status IN ('NOVO','CONTATADO','QUALIFICADO','CLIENTE','SEM_INTERESSE'))
);

ALTER TABLE portal_contas ADD COLUMN IF NOT EXISTS aceite_termos_em TIMESTAMPTZ;

CREATE UNIQUE INDEX IF NOT EXISTS uq_portal_contas_email_lower
  ON portal_contas (LOWER(email));
CREATE INDEX IF NOT EXISTS idx_portal_contas_tipo_created
  ON portal_contas (tipo, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_portal_contas_lead_status
  ON portal_contas (lead_status, created_at DESC);

DROP TRIGGER IF EXISTS portal_contas_atualizar_updated_at ON portal_contas;
CREATE TRIGGER portal_contas_atualizar_updated_at
BEFORE UPDATE ON portal_contas
FOR EACH ROW EXECUTE FUNCTION atualizar_updated_at();

-- Sessões revogáveis para o login público.
CREATE TABLE IF NOT EXISTS portal_sessoes (
  token_hash CHAR(64) PRIMARY KEY,
  conta_id BIGINT NOT NULL REFERENCES portal_contas(id) ON DELETE CASCADE,
  ip_hash VARCHAR(128),
  user_agent TEXT,
  expires_at TIMESTAMPTZ NOT NULL,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_portal_sessoes_conta
  ON portal_sessoes (conta_id, expires_at DESC);
CREATE INDEX IF NOT EXISTS idx_portal_sessoes_expira
  ON portal_sessoes (expires_at);

-- -----------------------------------------------------------------
-- Estrutura de grupos. Cria se o MVP antigo ainda não tiver criado.
-- -----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS gg_groups (
  id SERIAL PRIMARY KEY,
  name VARCHAR(160) NOT NULL,
  slug VARCHAR(190) UNIQUE NOT NULL,
  description TEXT NOT NULL,
  rules TEXT,
  invite_url TEXT,
  image_url TEXT,
  category VARCHAR(80) NOT NULL,
  state VARCHAR(2) NOT NULL DEFAULT 'SP',
  city VARCHAR(120) NOT NULL,
  region VARCHAR(120),
  group_type VARCHAR(40) NOT NULL DEFAULT 'emprego',
  admin_only BOOLEAN NOT NULL DEFAULT FALSE,
  accepts_jobs BOOLEAN NOT NULL DEFAULT FALSE,
  charges_members BOOLEAN NOT NULL DEFAULT FALSE,
  owner_name VARCHAR(160),
  owner_email VARCHAR(180),
  owner_phone VARCHAR(30),
  status VARCHAR(30) NOT NULL DEFAULT 'pending',
  verified BOOLEAN NOT NULL DEFAULT FALSE,
  featured BOOLEAN NOT NULL DEFAULT FALSE,
  last_verified_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- O MVP antigo pode já possuir gg_groups com apenas parte das colunas.
-- As adições abaixo mantêm a migração idempotente e evitam erro 42703 ao publicar.
ALTER TABLE gg_groups ADD COLUMN IF NOT EXISTS name VARCHAR(160);
ALTER TABLE gg_groups ADD COLUMN IF NOT EXISTS slug VARCHAR(190);
ALTER TABLE gg_groups ADD COLUMN IF NOT EXISTS description TEXT;
ALTER TABLE gg_groups ADD COLUMN IF NOT EXISTS rules TEXT;
ALTER TABLE gg_groups ADD COLUMN IF NOT EXISTS invite_url TEXT;
ALTER TABLE gg_groups ADD COLUMN IF NOT EXISTS image_url TEXT;
ALTER TABLE gg_groups ADD COLUMN IF NOT EXISTS category VARCHAR(80);
ALTER TABLE gg_groups ADD COLUMN IF NOT EXISTS state VARCHAR(2) DEFAULT 'SP';
ALTER TABLE gg_groups ADD COLUMN IF NOT EXISTS city VARCHAR(120);
ALTER TABLE gg_groups ADD COLUMN IF NOT EXISTS region VARCHAR(120);
ALTER TABLE gg_groups ADD COLUMN IF NOT EXISTS group_type VARCHAR(40) DEFAULT 'emprego';
ALTER TABLE gg_groups ADD COLUMN IF NOT EXISTS admin_only BOOLEAN DEFAULT FALSE;
ALTER TABLE gg_groups ADD COLUMN IF NOT EXISTS accepts_jobs BOOLEAN DEFAULT FALSE;
ALTER TABLE gg_groups ADD COLUMN IF NOT EXISTS charges_members BOOLEAN DEFAULT FALSE;
ALTER TABLE gg_groups ADD COLUMN IF NOT EXISTS owner_name VARCHAR(160);
ALTER TABLE gg_groups ADD COLUMN IF NOT EXISTS owner_email VARCHAR(180);
ALTER TABLE gg_groups ADD COLUMN IF NOT EXISTS owner_phone VARCHAR(30);
ALTER TABLE gg_groups ADD COLUMN IF NOT EXISTS status VARCHAR(30) DEFAULT 'pending';
ALTER TABLE gg_groups ADD COLUMN IF NOT EXISTS verified BOOLEAN DEFAULT FALSE;
ALTER TABLE gg_groups ADD COLUMN IF NOT EXISTS featured BOOLEAN DEFAULT FALSE;
ALTER TABLE gg_groups ADD COLUMN IF NOT EXISTS last_verified_at TIMESTAMPTZ;
ALTER TABLE gg_groups ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW();
ALTER TABLE gg_groups ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();

ALTER TABLE gg_groups ADD COLUMN IF NOT EXISTS owner_account_id BIGINT;
ALTER TABLE gg_groups ADD COLUMN IF NOT EXISTS rejection_reason TEXT;
ALTER TABLE gg_groups ADD COLUMN IF NOT EXISTS moderation_note TEXT;
ALTER TABLE gg_groups ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ;
ALTER TABLE gg_groups ADD COLUMN IF NOT EXISTS submitted_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE gg_groups ADD COLUMN IF NOT EXISTS seo_title VARCHAR(180);
ALTER TABLE gg_groups ADD COLUMN IF NOT EXISTS seo_description VARCHAR(320);
ALTER TABLE gg_groups ADD COLUMN IF NOT EXISTS invite_code_hash CHAR(64);
ALTER TABLE gg_groups ADD COLUMN IF NOT EXISTS official BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE gg_groups ADD COLUMN IF NOT EXISTS accepts_candidate_messages BOOLEAN NOT NULL DEFAULT FALSE;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'gg_groups_owner_account_fk'
      AND conrelid = 'gg_groups'::regclass
  ) THEN
    ALTER TABLE gg_groups
      ADD CONSTRAINT gg_groups_owner_account_fk
      FOREIGN KEY (owner_account_id) REFERENCES portal_contas(id) ON DELETE SET NULL;
  END IF;
END;
$$;

CREATE INDEX IF NOT EXISTS ix_gg_groups_slug ON gg_groups(slug);
CREATE INDEX IF NOT EXISTS ix_gg_groups_public_search
  ON gg_groups(status, featured DESC, state, city, category, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_gg_groups_owner
  ON gg_groups(owner_account_id, status, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS uq_gg_groups_invite_hash
  ON gg_groups(invite_code_hash)
  WHERE invite_code_hash IS NOT NULL;

DROP TRIGGER IF EXISTS gg_groups_atualizar_updated_at ON gg_groups;
CREATE TRIGGER gg_groups_atualizar_updated_at
BEFORE UPDATE ON gg_groups
FOR EACH ROW EXECUTE FUNCTION atualizar_updated_at();

-- Imagem otimizada armazenada separadamente para não inflar consultas.
CREATE TABLE IF NOT EXISTS portal_grupo_imagens (
  grupo_id INTEGER PRIMARY KEY REFERENCES gg_groups(id) ON DELETE CASCADE,
  conteudo BYTEA NOT NULL,
  mime_type VARCHAR(80) NOT NULL DEFAULT 'image/webp',
  largura INTEGER,
  altura INTEGER,
  tamanho_bytes INTEGER NOT NULL,
  origem VARCHAR(30) NOT NULL DEFAULT 'UPLOAD',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
DROP TRIGGER IF EXISTS portal_grupo_imagens_atualizar_updated_at ON portal_grupo_imagens;
CREATE TRIGGER portal_grupo_imagens_atualizar_updated_at
BEFORE UPDATE ON portal_grupo_imagens
FOR EACH ROW EXECUTE FUNCTION atualizar_updated_at();

CREATE TABLE IF NOT EXISTS gg_group_views (
  id SERIAL PRIMARY KEY,
  group_id INTEGER NOT NULL REFERENCES gg_groups(id) ON DELETE CASCADE,
  visitor_day_hash VARCHAR(80) NOT NULL,
  source VARCHAR(240),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_gg_group_view_day UNIQUE (group_id, visitor_day_hash)
);
CREATE INDEX IF NOT EXISTS ix_gg_group_views_group_id ON gg_group_views(group_id);

CREATE TABLE IF NOT EXISTS gg_group_clicks (
  id SERIAL PRIMARY KEY,
  group_id INTEGER NOT NULL REFERENCES gg_groups(id) ON DELETE CASCADE,
  visitor_hash VARCHAR(80) NOT NULL,
  source VARCHAR(240),
  job_id BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE gg_group_clicks ALTER COLUMN job_id TYPE BIGINT USING job_id::BIGINT;
ALTER TABLE gg_group_clicks ADD COLUMN IF NOT EXISTS sessao_id VARCHAR(120);
ALTER TABLE gg_group_clicks ADD COLUMN IF NOT EXISTS utm_source VARCHAR(160);
ALTER TABLE gg_group_clicks ADD COLUMN IF NOT EXISTS utm_medium VARCHAR(160);
ALTER TABLE gg_group_clicks ADD COLUMN IF NOT EXISTS utm_campaign VARCHAR(200);
CREATE INDEX IF NOT EXISTS ix_gg_group_clicks_group_id ON gg_group_clicks(group_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ix_gg_group_clicks_job_id ON gg_group_clicks(job_id, created_at DESC);

CREATE TABLE IF NOT EXISTS gg_group_reports (
  id SERIAL PRIMARY KEY,
  group_id INTEGER NOT NULL REFERENCES gg_groups(id) ON DELETE CASCADE,
  reason VARCHAR(100) NOT NULL,
  details TEXT,
  contact VARCHAR(180),
  status VARCHAR(30) NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE gg_group_reports ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMPTZ;
ALTER TABLE gg_group_reports ADD COLUMN IF NOT EXISTS resolved_by BIGINT REFERENCES app_usuarios(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS ix_gg_group_reports_status ON gg_group_reports(status, created_at DESC);

-- -----------------------------------------------------------------
-- Vagas enviadas por contas públicas. Só viram vagas oficiais após
-- moderação no painel, evitando escrever diretamente em vagas.
-- -----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS portal_vagas_submissoes (
  id BIGSERIAL PRIMARY KEY,
  conta_id BIGINT NOT NULL REFERENCES portal_contas(id) ON DELETE CASCADE,
  empresa_nome VARCHAR(180) NOT NULL,
  titulo VARCHAR(180) NOT NULL,
  cargo VARCHAR(180) NOT NULL,
  descricao TEXT NOT NULL,
  requisitos TEXT,
  beneficios TEXT,
  cidade VARCHAR(120) NOT NULL,
  estado CHAR(2) NOT NULL DEFAULT 'SP',
  bairro VARCHAR(120),
  modalidade VARCHAR(40) NOT NULL DEFAULT 'Presencial',
  tipo_contrato VARCHAR(60),
  escala VARCHAR(120),
  horario VARCHAR(180),
  salario NUMERIC(12,2),
  quantidade_vagas INTEGER NOT NULL DEFAULT 1,
  whatsapp_contato VARCHAR(30),
  status VARCHAR(30) NOT NULL DEFAULT 'PENDENTE',
  rejection_reason TEXT,
  moderation_note TEXT,
  vaga_id BIGINT REFERENCES vagas(id) ON DELETE SET NULL,
  approved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT portal_vagas_submissoes_status_check CHECK (status IN ('PENDENTE','EM_REVISAO','APROVADA','REJEITADA','CONVERTIDA','CANCELADA')),
  CONSTRAINT portal_vagas_submissoes_qtd_check CHECK (quantidade_vagas >= 1),
  CONSTRAINT portal_vagas_submissoes_salario_check CHECK (salario IS NULL OR salario >= 0)
);
CREATE INDEX IF NOT EXISTS idx_portal_vagas_submissoes_conta
  ON portal_vagas_submissoes(conta_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_portal_vagas_submissoes_status
  ON portal_vagas_submissoes(status, created_at DESC);
DROP TRIGGER IF EXISTS portal_vagas_submissoes_atualizar_updated_at ON portal_vagas_submissoes;
CREATE TRIGGER portal_vagas_submissoes_atualizar_updated_at
BEFORE UPDATE ON portal_vagas_submissoes
FOR EACH ROW EXECUTE FUNCTION atualizar_updated_at();

-- Relação explícita para campanhas e recomendações de vagas por grupo.
CREATE TABLE IF NOT EXISTS portal_vaga_grupos (
  vaga_id BIGINT NOT NULL REFERENCES vagas(id) ON DELETE CASCADE,
  grupo_id INTEGER NOT NULL REFERENCES gg_groups(id) ON DELETE CASCADE,
  status VARCHAR(30) NOT NULL DEFAULT 'SUGERIDO',
  codigo_campanha VARCHAR(100),
  publicado_em TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (vaga_id, grupo_id),
  CONSTRAINT portal_vaga_grupos_status_check CHECK (status IN ('SUGERIDO','PLANEJADO','PUBLICADO','PAUSADO'))
);
CREATE INDEX IF NOT EXISTS idx_portal_vaga_grupos_grupo
  ON portal_vaga_grupos(grupo_id, status, created_at DESC);
DROP TRIGGER IF EXISTS portal_vaga_grupos_atualizar_updated_at ON portal_vaga_grupos;
CREATE TRIGGER portal_vaga_grupos_atualizar_updated_at
BEFORE UPDATE ON portal_vaga_grupos
FOR EACH ROW EXECUTE FUNCTION atualizar_updated_at();

-- Marca os grupos legados como enviados antes desta migração.
UPDATE gg_groups
SET submitted_at = COALESCE(submitted_at, created_at, NOW())
WHERE submitted_at IS NULL;

COMMIT;

-- Conferência rápida
SELECT TO_REGCLASS('public.portal_contas') AS portal_contas,
       TO_REGCLASS('public.portal_sessoes') AS portal_sessoes,
       TO_REGCLASS('public.gg_groups') AS grupos,
       TO_REGCLASS('public.portal_vagas_submissoes') AS vagas_submissoes;
