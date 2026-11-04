CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE TABLE users (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), username VARCHAR(120) UNIQUE NOT NULL,
 email VARCHAR(255) UNIQUE NOT NULL, password_hash TEXT, external_subject VARCHAR(255) UNIQUE,
 role VARCHAR(40) NOT NULL CHECK(role IN ('admin','station_manager','ground_staff','technical_publications','safety_officer','auditor')),
 station_code VARCHAR(20), fleet_scope TEXT[] NOT NULL DEFAULT '{}', is_active BOOLEAN NOT NULL DEFAULT TRUE,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE manuals (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), identifier VARCHAR(100) NOT NULL, title TEXT NOT NULL,
 revision_number VARCHAR(50) NOT NULL, publication_date DATE, effective_date DATE,
 status VARCHAR(20) NOT NULL DEFAULT 'draft', fleet_types TEXT[] NOT NULL DEFAULT '{}', source_uri TEXT,
 UNIQUE(identifier,revision_number)
);
CREATE TABLE manual_clauses (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), manual_id UUID NOT NULL REFERENCES manuals(id) ON DELETE CASCADE,
 clause_identifier VARCHAR(120) NOT NULL, chapter VARCHAR(80), section VARCHAR(80),
 parent_clause_id UUID REFERENCES manual_clauses(id), title TEXT, procedure_text TEXT NOT NULL,
 sequence_no INTEGER NOT NULL DEFAULT 0, station_scope TEXT[] NOT NULL DEFAULT '{}',
 fleet_scope TEXT[] NOT NULL DEFAULT '{}', role_scope TEXT[] NOT NULL DEFAULT '{}',
 UNIQUE(manual_id,clause_identifier)
);
CREATE TABLE safety_bulletins (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), identifier VARCHAR(100) UNIQUE NOT NULL,
 title TEXT NOT NULL, category VARCHAR(80), issue_date DATE NOT NULL, effective_from TIMESTAMPTZ NOT NULL,
 expires_at TIMESTAMPTZ, incorporation_condition TEXT, status VARCHAR(20) NOT NULL DEFAULT 'draft',
 affected_stations TEXT[] NOT NULL DEFAULT '{}', affected_roles TEXT[] NOT NULL DEFAULT '{}',
 fleet_scope TEXT[] NOT NULL DEFAULT '{}', source_uri TEXT
);
CREATE TABLE regulatory_directives (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), authority VARCHAR(20) NOT NULL,
 reference_number VARCHAR(120) UNIQUE NOT NULL, title TEXT NOT NULL, issue_date DATE NOT NULL,
 effective_from TIMESTAMPTZ NOT NULL, compliance_deadline TIMESTAMPTZ, enforcement_status VARCHAR(40) DEFAULT 'open',
 status VARCHAR(20) NOT NULL DEFAULT 'active', source_uri TEXT
);
CREATE TABLE supersession_edges (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), source_type VARCHAR(30) NOT NULL, source_id UUID NOT NULL,
 source_clause_identifier VARCHAR(120), target_type VARCHAR(30) NOT NULL, target_id UUID NOT NULL,
 target_clause_identifier VARCHAR(120), relationship_type VARCHAR(20) NOT NULL,
 priority_tier INTEGER NOT NULL, resolution_state VARCHAR(20) NOT NULL DEFAULT 'active',
 effective_from TIMESTAMPTZ, effective_until TIMESTAMPTZ
);
CREATE INDEX idx_edges_target ON supersession_edges(target_type,target_id,target_clause_identifier);
CREATE TABLE source_steps (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), source_type VARCHAR(30) NOT NULL, source_id UUID NOT NULL,
 target_clause_identifier VARCHAR(120) NOT NULL, step_text TEXT NOT NULL, sequence_no INTEGER DEFAULT 0,
 priority_tier INTEGER NOT NULL, station_scope TEXT[] DEFAULT '{}', fleet_scope TEXT[] DEFAULT '{}',
 role_scope TEXT[] DEFAULT '{}'
);
CREATE INDEX idx_source_steps_clause ON source_steps(target_clause_identifier);
CREATE TABLE compiled_procedures (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), manual_clause_id UUID NOT NULL REFERENCES manual_clauses(id),
 station_code VARCHAR(20), fleet_type VARCHAR(80), operational_role VARCHAR(80),
 compiled_text JSONB NOT NULL, conflict_detected BOOLEAN DEFAULT FALSE, resolver_version VARCHAR(40) NOT NULL,
 compiled_at TIMESTAMPTZ DEFAULT NOW(), valid_from TIMESTAMPTZ DEFAULT NOW(), valid_until TIMESTAMPTZ
);
CREATE TABLE staff_acknowledgments (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), user_id UUID NOT NULL REFERENCES users(id),
 bulletin_id UUID REFERENCES safety_bulletins(id), directive_id UUID REFERENCES regulatory_directives(id),
 procedure_identifier VARCHAR(120), station_code VARCHAR(20) NOT NULL,
 acknowledgment_state VARCHAR(20) NOT NULL, acknowledged_at TIMESTAMPTZ, created_at TIMESTAMPTZ DEFAULT NOW(),
 CHECK(bulletin_id IS NOT NULL OR directive_id IS NOT NULL OR procedure_identifier IS NOT NULL)
);
CREATE INDEX idx_ack_station_state ON staff_acknowledgments(station_code,acknowledgment_state);
CREATE TABLE procedure_snapshots (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), manual_clause_id UUID NOT NULL REFERENCES manual_clauses(id),
 snapshot_at TIMESTAMPTZ DEFAULT NOW(), scope JSONB DEFAULT '{}'::jsonb,
 effective_procedure JSONB NOT NULL, source_lineage JSONB DEFAULT '[]'::jsonb, resolver_version VARCHAR(40) NOT NULL
);
CREATE TABLE document_sync_runs (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), source_system VARCHAR(120) NOT NULL,
 status VARCHAR(20) NOT NULL, started_at TIMESTAMPTZ DEFAULT NOW(), completed_at TIMESTAMPTZ,
 records_processed INTEGER DEFAULT 0, error_message TEXT
);
