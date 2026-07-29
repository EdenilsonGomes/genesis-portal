BEGIN;

-- ============================================================
-- GENESIS IA V9
-- Auditoria híbrida, templates de vagas, idade mínima,
-- preferências de entrevista e proteção de documentos.
-- Migração idempotente: pode ser executada uma única vez em produção
-- e novamente em ambiente de teste sem duplicar estruturas.
-- ============================================================

-- 1. Regras adicionais por vaga.
ALTER TABLE vagas
    ADD COLUMN IF NOT EXISTS idade_minima INTEGER NOT NULL DEFAULT 25,
    ADD COLUMN IF NOT EXISTS entrevista_dias_semana SMALLINT[] NOT NULL DEFAULT ARRAY[1,2,3,4,5]::SMALLINT[],
    ADD COLUMN IF NOT EXISTS entrevista_horarios JSONB NOT NULL DEFAULT '["09:00","10:00","14:00","15:00"]'::JSONB,
    ADD COLUMN IF NOT EXISTS entrevista_duracao_minutos INTEGER NOT NULL DEFAULT 30,
    ADD COLUMN IF NOT EXISTS entrevista_busca_dias INTEGER NOT NULL DEFAULT 7,
    ADD COLUMN IF NOT EXISTS entrevista_evitar_feriados BOOLEAN NOT NULL DEFAULT TRUE;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'vagas_idade_minima_valida'
          AND conrelid = 'vagas'::regclass
    ) THEN
        ALTER TABLE vagas ADD CONSTRAINT vagas_idade_minima_valida
            CHECK (idade_minima BETWEEN 14 AND 100);
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'vagas_entrevista_duracao_valida'
          AND conrelid = 'vagas'::regclass
    ) THEN
        ALTER TABLE vagas ADD CONSTRAINT vagas_entrevista_duracao_valida
            CHECK (entrevista_duracao_minutos BETWEEN 10 AND 180);
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'vagas_entrevista_busca_dias_valida'
          AND conrelid = 'vagas'::regclass
    ) THEN
        ALTER TABLE vagas ADD CONSTRAINT vagas_entrevista_busca_dias_valida
            CHECK (entrevista_busca_dias BETWEEN 1 AND 60);
    END IF;
END;
$$;

-- Mantém o requisito atual da DL Green também nas vagas existentes.
UPDATE vagas SET idade_minima = 25 WHERE idade_minima IS NULL;

-- 2. Templates reutilizáveis de vagas.
CREATE TABLE IF NOT EXISTS vagas_templates (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    nome VARCHAR(160) NOT NULL,
    descricao TEXT,
    empresa_id BIGINT REFERENCES empresas(id) ON DELETE SET NULL,
    dados JSONB NOT NULL DEFAULT '{}'::JSONB,
    ativo BOOLEAN NOT NULL DEFAULT TRUE,
    criado_por TEXT,
    atualizado_por TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT vagas_templates_nome_unico UNIQUE (nome)
);

CREATE INDEX IF NOT EXISTS idx_vagas_templates_ativo_nome
    ON vagas_templates (ativo, nome);

DROP TRIGGER IF EXISTS vagas_templates_atualizar_updated_at ON vagas_templates;
CREATE TRIGGER vagas_templates_atualizar_updated_at
BEFORE UPDATE ON vagas_templates
FOR EACH ROW EXECUTE FUNCTION atualizar_updated_at();

-- 3. Estado seguro de processamento de documentos e deduplicação real.
ALTER TABLE documentos
    ADD COLUMN IF NOT EXISTS mensagem_id TEXT,
    ADD COLUMN IF NOT EXISTS hash_sha256 VARCHAR(64),
    ADD COLUMN IF NOT EXISTS status_processamento VARCHAR(30) NOT NULL DEFAULT 'CONCLUIDO',
    ADD COLUMN IF NOT EXISTS classificacao_confianca VARCHAR(20),
    ADD COLUMN IF NOT EXISTS processando_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS processado_at TIMESTAMPTZ;

CREATE UNIQUE INDEX IF NOT EXISTS uq_documentos_mensagem_id
    ON documentos (mensagem_id)
    WHERE mensagem_id IS NOT NULL AND BTRIM(mensagem_id) <> '';

CREATE INDEX IF NOT EXISTS idx_documentos_hash_candidato
    ON documentos (candidato_id, hash_sha256)
    WHERE hash_sha256 IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_documentos_processamento
    ON documentos (status_processamento, created_at DESC);

-- Normaliza documentos antigos sem afetar os que estiverem em processamento.
UPDATE documentos
SET status_processamento = CASE
    WHEN UPPER(COALESCE(tipo, '')) IN ('PENDENTE', 'PENDENTE_REVISAO') THEN 'PENDENTE'
    ELSE 'CONCLUIDO'
END
WHERE status_processamento IS NULL OR BTRIM(status_processamento) = '';

-- 4. Serialização do atendimento e validação de idade.
ALTER TABLE candidatos
    ADD COLUMN IF NOT EXISTS processamento_token UUID,
    ADD COLUMN IF NOT EXISTS processamento_bloqueado_ate TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS documento_processando BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS idade_validada BOOLEAN,
    ADD COLUMN IF NOT EXISTS idade_validada_em TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS idade_calculada INTEGER;

CREATE INDEX IF NOT EXISTS idx_candidatos_processamento_bloqueado
    ON candidatos (processamento_bloqueado_ate)
    WHERE processamento_bloqueado_ate IS NOT NULL;

-- 5. Execuções da auditoria híbrida.
CREATE TABLE IF NOT EXISTS auditorias_conversas (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    origem VARCHAR(20) NOT NULL DEFAULT 'MANUAL',
    inicio_periodo TIMESTAMPTZ NOT NULL,
    fim_periodo TIMESTAMPTZ NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'PROCESSANDO',
    total_conversas INTEGER NOT NULL DEFAULT 0,
    conversas_sem_alerta INTEGER NOT NULL DEFAULT 0,
    quantidade_criticos INTEGER NOT NULL DEFAULT 0,
    quantidade_altos INTEGER NOT NULL DEFAULT 0,
    quantidade_medios INTEGER NOT NULL DEFAULT 0,
    quantidade_baixos INTEGER NOT NULL DEFAULT 0,
    nota_qualidade NUMERIC(5,2),
    resumo TEXT,
    solicitado_por TEXT,
    erro TEXT,
    started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    finished_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT auditorias_conversas_origem_valida CHECK (origem IN ('MANUAL','AUTOMATICA','API')),
    CONSTRAINT auditorias_conversas_status_valido CHECK (status IN ('PROCESSANDO','CONCLUIDA','ERRO'))
);

CREATE INDEX IF NOT EXISTS idx_auditorias_conversas_created_at
    ON auditorias_conversas (created_at DESC);

CREATE TABLE IF NOT EXISTS auditoria_problemas (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    auditoria_id BIGINT REFERENCES auditorias_conversas(id) ON DELETE CASCADE,
    candidato_id BIGINT REFERENCES candidatos(id) ON DELETE CASCADE,
    vaga_id BIGINT REFERENCES vagas(id) ON DELETE SET NULL,
    categoria VARCHAR(80) NOT NULL,
    gravidade VARCHAR(15) NOT NULL,
    origem_deteccao VARCHAR(20) NOT NULL DEFAULT 'REGRA',
    confianca NUMERIC(5,2),
    titulo VARCHAR(220) NOT NULL,
    descricao TEXT NOT NULL,
    evidencia JSONB NOT NULL DEFAULT '{}'::JSONB,
    comportamento_esperado TEXT,
    sugestao_correcao TEXT,
    mensagem_usuario_id BIGINT,
    mensagem_ia_id BIGINT,
    fingerprint VARCHAR(64) NOT NULL,
    status_revisao VARCHAR(20) NOT NULL DEFAULT 'NOVO',
    revisado_por TEXT,
    revisado_at TIMESTAMPTZ,
    observacao_revisao TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT auditoria_problemas_gravidade_valida CHECK (gravidade IN ('CRITICA','ALTA','MEDIA','BAIXA')),
    CONSTRAINT auditoria_problemas_origem_valida CHECK (origem_deteccao IN ('REGRA','IA')),
    CONSTRAINT auditoria_problemas_status_valido CHECK (status_revisao IN ('NOVO','CONFIRMADO','FALSO_POSITIVO','CORRIGIDO','IGNORADO')),
    CONSTRAINT auditoria_problemas_fingerprint_unico UNIQUE (fingerprint)
);

CREATE INDEX IF NOT EXISTS idx_auditoria_problemas_status_gravidade
    ON auditoria_problemas (status_revisao, gravidade, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_auditoria_problemas_candidato
    ON auditoria_problemas (candidato_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_auditoria_problemas_auditoria
    ON auditoria_problemas (auditoria_id, created_at DESC);

DROP TRIGGER IF EXISTS auditoria_problemas_atualizar_updated_at ON auditoria_problemas;
CREATE TRIGGER auditoria_problemas_atualizar_updated_at
BEFORE UPDATE ON auditoria_problemas
FOR EACH ROW EXECUTE FUNCTION atualizar_updated_at();

CREATE TABLE IF NOT EXISTS auditoria_feedback (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    problema_id BIGINT NOT NULL REFERENCES auditoria_problemas(id) ON DELETE CASCADE,
    decisao VARCHAR(20) NOT NULL,
    observacao TEXT,
    revisado_por TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT auditoria_feedback_decisao_valida CHECK (decisao IN ('CONFIRMADO','FALSO_POSITIVO','CORRIGIDO','IGNORADO'))
);

CREATE INDEX IF NOT EXISTS idx_auditoria_feedback_problema
    ON auditoria_feedback (problema_id, created_at DESC);

-- 6. Histórico de mudança de etapa para permitir auditoria objetiva de saltos.
CREATE TABLE IF NOT EXISTS candidato_etapas_historico (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    candidato_id BIGINT NOT NULL REFERENCES candidatos(id) ON DELETE CASCADE,
    etapa_anterior TEXT,
    etapa_nova TEXT,
    status_anterior TEXT,
    status_novo TEXT,
    origem TEXT NOT NULL DEFAULT 'SISTEMA',
    dados_contexto JSONB NOT NULL DEFAULT '{}'::JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_candidato_etapas_historico
    ON candidato_etapas_historico (candidato_id, created_at DESC);

CREATE OR REPLACE FUNCTION genesis_registrar_mudanca_etapa()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF OLD.etapa IS DISTINCT FROM NEW.etapa OR OLD.status IS DISTINCT FROM NEW.status THEN
        INSERT INTO candidato_etapas_historico
        (candidato_id, etapa_anterior, etapa_nova, status_anterior, status_novo, origem, dados_contexto)
        VALUES
        (NEW.id, OLD.etapa, NEW.etapa, OLD.status, NEW.status, 'BANCO',
         JSONB_BUILD_OBJECT('vaga_id', NEW.vaga_id, 'aprovado', NEW.aprovado, 'cep', NEW.cep));
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS candidatos_registrar_mudanca_etapa ON candidatos;
CREATE TRIGGER candidatos_registrar_mudanca_etapa
AFTER UPDATE OF etapa, status ON candidatos
FOR EACH ROW EXECUTE FUNCTION genesis_registrar_mudanca_etapa();

COMMIT;

-- Verificações:
-- SELECT idade_minima, entrevista_horarios, entrevista_dias_semana FROM vagas LIMIT 5;
-- SELECT * FROM vagas_templates ORDER BY id DESC;
-- SELECT * FROM auditorias_conversas ORDER BY id DESC;
