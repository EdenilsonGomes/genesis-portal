BEGIN;

ALTER TABLE empresas
    ADD COLUMN IF NOT EXISTS nome_publico VARCHAR(180),
    ADD COLUMN IF NOT EXISTS descricao_publica TEXT,
    ADD COLUMN IF NOT EXISTS logo_url TEXT,
    ADD COLUMN IF NOT EXISTS site_url TEXT,
    ADD COLUMN IF NOT EXISTS cidade VARCHAR(120),
    ADD COLUMN IF NOT EXISTS estado CHAR(2),
    ADD COLUMN IF NOT EXISTS exibir_no_portal BOOLEAN NOT NULL DEFAULT TRUE;

ALTER TABLE vagas
    ADD COLUMN IF NOT EXISTS publicar_portal BOOLEAN NOT NULL DEFAULT TRUE,
    ADD COLUMN IF NOT EXISTS destaque_portal BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS atendimento_chatbot BOOLEAN NOT NULL DEFAULT TRUE,
    ADD COLUMN IF NOT EXISTS canal_candidatura VARCHAR(30) NOT NULL DEFAULT 'WHATSAPP_GENESIS',
    ADD COLUMN IF NOT EXISTS candidatura_url TEXT,
    ADD COLUMN IF NOT EXISTS candidatura_email VARCHAR(200),
    ADD COLUMN IF NOT EXISTS whatsapp_candidatura VARCHAR(30),
    ADD COLUMN IF NOT EXISTS imagem_capa_url TEXT,
    ADD COLUMN IF NOT EXISTS seo_titulo VARCHAR(180),
    ADD COLUMN IF NOT EXISTS seo_descricao VARCHAR(320),
    ADD COLUMN IF NOT EXISTS portal_publicado_em TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS origem_vaga VARCHAR(40) NOT NULL DEFAULT 'RECRUTADOR_INTERNO';

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'vagas_canal_candidatura_valido'
          AND conrelid = 'vagas'::regclass
    ) THEN
        ALTER TABLE vagas
            ADD CONSTRAINT vagas_canal_candidatura_valido
            CHECK (canal_candidatura IN ('WHATSAPP_GENESIS', 'URL_EXTERNA', 'EMAIL'));
    END IF;
END;
$$;

UPDATE vagas
SET portal_publicado_em = COALESCE(portal_publicado_em, created_at, NOW())
WHERE status = 'ATIVA'
  AND portal_publicado_em IS NULL;

CREATE INDEX IF NOT EXISTS idx_vagas_portal_ativas
    ON vagas (status, publicar_portal, data_encerramento, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_vagas_chatbot_ativas
    ON vagas (status, atendimento_chatbot, updated_at DESC);

CREATE TABLE IF NOT EXISTS portal_leads_empresas (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    empresa_nome VARCHAR(180) NOT NULL,
    cnpj VARCHAR(30),
    contato_nome VARCHAR(160) NOT NULL,
    email VARCHAR(200) NOT NULL,
    whatsapp VARCHAR(40) NOT NULL,
    cidade VARCHAR(120),
    estado CHAR(2),
    quantidade_vagas INTEGER,
    cargos_interesse TEXT,
    mensagem TEXT,
    origem VARCHAR(120),
    utm_source VARCHAR(160),
    utm_medium VARCHAR(160),
    utm_campaign VARCHAR(200),
    status VARCHAR(30) NOT NULL DEFAULT 'NOVO',
    responsavel VARCHAR(120),
    observacao_interna TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT portal_leads_empresas_status_valido
        CHECK (status IN ('NOVO', 'EM_CONTATO', 'QUALIFICADO', 'PROPOSTA', 'CLIENTE', 'DESCARTADO'))
);

CREATE INDEX IF NOT EXISTS idx_portal_leads_empresas_status_created
    ON portal_leads_empresas (status, created_at DESC);

CREATE TABLE IF NOT EXISTS portal_eventos (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    vaga_id BIGINT,
    evento VARCHAR(60) NOT NULL,
    sessao_id VARCHAR(120),
    pagina TEXT,
    origem TEXT,
    meio TEXT,
    campanha TEXT,
    metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
    ip_hash VARCHAR(128),
    user_agent TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT portal_eventos_vaga_fk
        FOREIGN KEY (vaga_id)
        REFERENCES vagas(id)
        ON UPDATE CASCADE
        ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_portal_eventos_vaga_created
    ON portal_eventos (vaga_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_portal_eventos_tipo_created
    ON portal_eventos (evento, created_at DESC);

CREATE OR REPLACE FUNCTION genesis_portal_marcar_publicacao()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.status = 'ATIVA'
       AND NEW.publicar_portal IS TRUE
       AND (
            OLD.status IS DISTINCT FROM NEW.status
            OR OLD.publicar_portal IS DISTINCT FROM NEW.publicar_portal
            OR NEW.portal_publicado_em IS NULL
       )
    THEN
        NEW.portal_publicado_em = COALESCE(NEW.portal_publicado_em, NOW());
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS vagas_genesis_portal_publicacao ON vagas;
CREATE TRIGGER vagas_genesis_portal_publicacao
BEFORE UPDATE ON vagas
FOR EACH ROW
EXECUTE FUNCTION genesis_portal_marcar_publicacao();


CREATE OR REPLACE FUNCTION genesis_portal_proteger_vaga_externa()
RETURNS TRIGGER AS $$
BEGIN
    IF UPPER(COALESCE(NEW.origem_vaga, '')) IN ('PORTAL_EMPRESA', 'EMPRESA_EXTERNA')
       OR UPPER(COALESCE(NEW.canal_candidatura, '')) IN ('URL_EXTERNA', 'EMAIL')
    THEN
        NEW.atendimento_chatbot = FALSE;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS vagas_genesis_portal_proteger_externa ON vagas;
CREATE TRIGGER vagas_genesis_portal_proteger_externa
BEFORE INSERT OR UPDATE OF origem_vaga, canal_candidatura, atendimento_chatbot ON vagas
FOR EACH ROW
EXECUTE FUNCTION genesis_portal_proteger_vaga_externa();

COMMIT;

-- Conferências:
-- SELECT column_name FROM information_schema.columns
-- WHERE table_name = 'vagas'
--   AND column_name IN ('publicar_portal', 'atendimento_chatbot', 'canal_candidatura', 'portal_publicado_em');
-- SELECT TO_REGCLASS('public.portal_leads_empresas');
-- SELECT TO_REGCLASS('public.portal_eventos');
