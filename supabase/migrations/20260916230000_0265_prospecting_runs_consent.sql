-- Execucoes diarias, consentimento explicito e suppression list da prospeccao.
-- Tudo e idempotente para permitir reexecucao durante deploy/rollback.

ALTER TABLE public.prospecting_recipients
  ADD COLUMN IF NOT EXISTS run_id text,
  ADD COLUMN IF NOT EXISTS score smallint,
  ADD COLUMN IF NOT EXISTS whatsapp_opt_in boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS whatsapp_opt_in_source text,
  ADD COLUMN IF NOT EXISTS whatsapp_opt_in_at timestamptz;

ALTER TABLE public.prospecting_recipients DROP CONSTRAINT IF EXISTS prospecting_recipients_status_check;
ALTER TABLE public.prospecting_recipients ADD CONSTRAINT prospecting_recipients_status_check
  CHECK (status IN (
    'pending','scheduled','queued','processing','sent','delivered','read','replied',
    'failed','skipped','blocked','cancelled','opted_out','needs_template',
    'awaiting_consent','waiting_connection','not_interested','rejected'
  ));
ALTER TABLE public.prospecting_recipients DROP CONSTRAINT IF EXISTS prospecting_recipients_score_check;
ALTER TABLE public.prospecting_recipients ADD CONSTRAINT prospecting_recipients_score_check
  CHECK (score IS NULL OR score BETWEEN 0 AND 100);
ALTER TABLE public.prospecting_recipients DROP CONSTRAINT IF EXISTS prospecting_recipients_opt_in_source_check;
ALTER TABLE public.prospecting_recipients ADD CONSTRAINT prospecting_recipients_opt_in_source_check
  CHECK (whatsapp_opt_in_source IS NULL OR whatsapp_opt_in_source IN (
    'website_form','landing_page','qr_code','existing_customer','manual_confirmed',
    'inbound_whatsapp','other_verified'
  ));

CREATE TABLE IF NOT EXISTS public.prospecting_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  run_id text NOT NULL CHECK (length(run_id) BETWEEN 1 AND 200),
  source text NOT NULL CHECK (length(source) BETWEEN 1 AND 200),
  generated_at timestamptz,
  started_at timestamptz,
  received_at timestamptz NOT NULL DEFAULT now(),
  prospects_received integer NOT NULL DEFAULT 0 CHECK (prospects_received >= 0),
  prospects_created integer NOT NULL DEFAULT 0 CHECK (prospects_created >= 0),
  prospects_updated integer NOT NULL DEFAULT 0 CHECK (prospects_updated >= 0),
  duplicates integer NOT NULL DEFAULT 0 CHECK (duplicates >= 0),
  rejected integer NOT NULL DEFAULT 0 CHECK (rejected >= 0),
  eligible integer NOT NULL DEFAULT 0 CHECK (eligible >= 0),
  queued integer NOT NULL DEFAULT 0 CHECK (queued >= 0),
  awaiting_consent integer NOT NULL DEFAULT 0 CHECK (awaiting_consent >= 0),
  dry_run boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'received' CHECK (status IN ('received','processed','failed')),
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, run_id)
);

ALTER TABLE public.prospecting_requests ADD COLUMN IF NOT EXISTS run_id text;
CREATE UNIQUE INDEX IF NOT EXISTS prospecting_requests_run_id
  ON public.prospecting_requests(organization_id, run_id)
  WHERE run_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS prospecting_recipients_run
  ON public.prospecting_recipients(organization_id, run_id);

CREATE TABLE IF NOT EXISTS public.prospecting_suppressions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  contact_id uuid,
  phone_number text,
  external_id text,
  site_key text,
  reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 200),
  source text NOT NULL DEFAULT 'manual',
  suppressed_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, contact_id) REFERENCES public.contacts(organization_id, id)
);
CREATE UNIQUE INDEX IF NOT EXISTS prospecting_suppressions_phone
  ON public.prospecting_suppressions(organization_id, phone_number)
  WHERE phone_number IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS prospecting_suppressions_external
  ON public.prospecting_suppressions(organization_id, external_id)
  WHERE external_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS prospecting_suppressions_site
  ON public.prospecting_suppressions(organization_id, site_key)
  WHERE site_key IS NOT NULL;

ALTER TABLE public.prospecting_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.prospecting_suppressions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.prospecting_runs, public.prospecting_suppressions FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.prospecting_runs TO authenticated;
GRANT SELECT ON public.prospecting_suppressions TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.prospecting_runs TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.prospecting_suppressions TO service_role;
DROP POLICY IF EXISTS tenant_isolation_prospecting_runs_all ON public.prospecting_runs;
CREATE POLICY tenant_isolation_prospecting_runs_all ON public.prospecting_runs
  FOR SELECT TO authenticated USING (organization_id IN (SELECT public.fn_user_org_ids()));
DROP POLICY IF EXISTS tenant_isolation_prospecting_suppressions_all ON public.prospecting_suppressions;
CREATE POLICY tenant_isolation_prospecting_suppressions_all ON public.prospecting_suppressions
  FOR SELECT TO authenticated USING (organization_id IN (SELECT public.fn_user_org_ids()));
