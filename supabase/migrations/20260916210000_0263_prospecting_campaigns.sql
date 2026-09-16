-- Campanhas reutilizam contatos, leads, conversas e a fila duravel do CRM.
CREATE UNIQUE INDEX IF NOT EXISTS prospecting_contacts_org_id ON public.contacts(organization_id,id);
CREATE UNIQUE INDEX IF NOT EXISTS prospecting_leads_org_id ON public.crm_leads(organization_id,id);
CREATE UNIQUE INDEX IF NOT EXISTS prospecting_pipelines_org_id ON public.crm_pipelines(organization_id,id);
CREATE UNIQUE INDEX IF NOT EXISTS prospecting_stages_org_pipeline_id ON public.crm_stages(organization_id,pipeline_id,id);
CREATE UNIQUE INDEX IF NOT EXISTS prospecting_channels_org_id ON public.channel_sessions(organization_id,id);
CREATE UNIQUE INDEX IF NOT EXISTS prospecting_conversations_org_id ON public.conversations(organization_id,id);
CREATE UNIQUE INDEX IF NOT EXISTS prospecting_jobs_org_id ON public.job_queue(organization_id,id);

CREATE TABLE IF NOT EXISTS public.prospecting_campaigns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  slug text NOT NULL CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,79}$'),
  description text NOT NULL DEFAULT '',
  source text NOT NULL DEFAULT '',
  tags text[] NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','paused','completed','archived')),
  pipeline_id uuid NOT NULL,
  initial_stage_id uuid NOT NULL,
  sent_stage_id uuid,
  reply_stage_id uuid NOT NULL,
  channel_session_id uuid,
  settings jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(settings)='object'),
  next_send_at timestamptz,
  last_run_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id,id), UNIQUE (organization_id,slug),
  FOREIGN KEY (organization_id,pipeline_id) REFERENCES public.crm_pipelines(organization_id,id),
  FOREIGN KEY (organization_id,pipeline_id,initial_stage_id) REFERENCES public.crm_stages(organization_id,pipeline_id,id),
  FOREIGN KEY (organization_id,pipeline_id,sent_stage_id) REFERENCES public.crm_stages(organization_id,pipeline_id,id),
  FOREIGN KEY (organization_id,pipeline_id,reply_stage_id) REFERENCES public.crm_stages(organization_id,pipeline_id,id),
  FOREIGN KEY (organization_id,channel_session_id) REFERENCES public.channel_sessions(organization_id,id)
);

CREATE TABLE IF NOT EXISTS public.prospecting_recipients (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  campaign_id uuid NOT NULL,
  contact_id uuid NOT NULL,
  lead_id uuid NOT NULL,
  conversation_id uuid,
  phone_number text NOT NULL CHECK (phone_number ~ '^\+[0-9]{8,15}$'),
  external_id text,
  company_key text NOT NULL,
  site_key text,
  data jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(data)='object'),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','scheduled','queued','processing','sent','delivered','read','replied','failed','skipped','blocked','cancelled','opted_out','needs_template')),
  approved_at timestamptz,
  message text,
  job_id uuid,
  step integer NOT NULL DEFAULT 0 CHECK (step BETWEEN 0 AND 2),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts>=0),
  scheduled_at timestamptz,
  sent_at timestamptz,
  last_sent_at timestamptz,
  replied_at timestamptz,
  initial_sent_at timestamptz,
  last_error text,
  dry_run boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id,id), UNIQUE (organization_id,campaign_id,contact_id),
  FOREIGN KEY (organization_id,campaign_id) REFERENCES public.prospecting_campaigns(organization_id,id),
  FOREIGN KEY (organization_id,contact_id) REFERENCES public.contacts(organization_id,id),
  FOREIGN KEY (organization_id,lead_id) REFERENCES public.crm_leads(organization_id,id),
  FOREIGN KEY (organization_id,conversation_id) REFERENCES public.conversations(organization_id,id),
  FOREIGN KEY (organization_id,job_id) REFERENCES public.job_queue(organization_id,id) ON DELETE SET NULL (job_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS prospecting_external_identity ON public.prospecting_recipients(organization_id,campaign_id,external_id) WHERE external_id IS NOT NULL;
ALTER TABLE public.prospecting_recipients ADD COLUMN IF NOT EXISTS initial_sent_at timestamptz;
CREATE INDEX IF NOT EXISTS prospecting_recipient_queue ON public.prospecting_recipients(organization_id,status,scheduled_at);
CREATE INDEX IF NOT EXISTS prospecting_recipient_cooldown ON public.prospecting_recipients(organization_id,phone_number,last_sent_at DESC);
CREATE INDEX IF NOT EXISTS prospecting_recipient_site ON public.prospecting_recipients(organization_id,site_key);
CREATE INDEX IF NOT EXISTS prospecting_recipient_company ON public.prospecting_recipients(organization_id,company_key);

CREATE TABLE IF NOT EXISTS public.prospecting_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  campaign_id uuid NOT NULL,
  recipient_id uuid,
  type text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id,campaign_id) REFERENCES public.prospecting_campaigns(organization_id,id),
  FOREIGN KEY (organization_id,recipient_id) REFERENCES public.prospecting_recipients(organization_id,id)
);
CREATE INDEX IF NOT EXISTS prospecting_event_timeline ON public.prospecting_events(organization_id,campaign_id,created_at DESC);

CREATE TABLE IF NOT EXISTS public.prospecting_requests (
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 200),
  body_hash text NOT NULL,
  response jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id,idempotency_key)
);

ALTER TABLE public.prospecting_campaigns ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.prospecting_recipients ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.prospecting_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.prospecting_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.prospecting_campaigns,public.prospecting_recipients,public.prospecting_events,public.prospecting_requests FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.prospecting_campaigns,public.prospecting_recipients,public.prospecting_events TO authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE ON public.prospecting_campaigns,public.prospecting_recipients,public.prospecting_requests TO service_role;
GRANT SELECT,INSERT ON public.prospecting_events TO service_role;
DROP POLICY IF EXISTS tenant_isolation_prospecting_campaigns_all ON public.prospecting_campaigns;
CREATE POLICY tenant_isolation_prospecting_campaigns_all ON public.prospecting_campaigns FOR SELECT TO authenticated USING (organization_id IN (SELECT public.fn_user_org_ids()));
DROP POLICY IF EXISTS tenant_isolation_prospecting_recipients_all ON public.prospecting_recipients;
CREATE POLICY tenant_isolation_prospecting_recipients_all ON public.prospecting_recipients FOR SELECT TO authenticated USING (organization_id IN (SELECT public.fn_user_org_ids()));
DROP POLICY IF EXISTS tenant_isolation_prospecting_events_all ON public.prospecting_events;
CREATE POLICY tenant_isolation_prospecting_events_all ON public.prospecting_events FOR SELECT TO authenticated USING (organization_id IN (SELECT public.fn_user_org_ids()));

-- Sem policy para requests: chave/idempotencia acessivel somente pelo backend autenticado.

-- O disparo usa a mesma fila duravel e o mesmo worker dos turnos do CRM.
ALTER TABLE public.job_queue DROP CONSTRAINT IF EXISTS job_queue_kind_check;
ALTER TABLE public.job_queue ADD CONSTRAINT job_queue_kind_check
  CHECK (kind IN ('inbound_turn','followup_turn','watchdog','flywheel','case_reply_turn','operator_turn','transactional_delivery','approved_reply','campaign_send'));
ALTER TABLE public.job_queue DROP CONSTRAINT IF EXISTS job_queue_turn_needs_contact;
DO $$
DECLARE c text;
BEGIN
  SELECT conname INTO c FROM pg_constraint
   WHERE conrelid = 'public.job_queue'::regclass AND contype='c'
     AND pg_get_constraintdef(oid) ILIKE '%contact_id is not null%';
  IF c IS NOT NULL THEN EXECUTE format('ALTER TABLE public.job_queue DROP CONSTRAINT %I', c); END IF;
END $$;
ALTER TABLE public.job_queue ADD CONSTRAINT job_queue_turn_needs_contact
  CHECK ((kind IN ('inbound_turn','followup_turn','case_reply_turn','operator_turn','transactional_delivery','approved_reply','campaign_send')) = (contact_id IS NOT NULL));
