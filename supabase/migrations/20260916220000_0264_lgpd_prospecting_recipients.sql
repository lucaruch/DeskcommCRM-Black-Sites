-- A cascata de LGPD tambem precisa apagar os dados pessoais usados na prospeccao.
-- O legado e preservado como funcao interna para manter o contrato existente.
DO $$
BEGIN
  IF to_regprocedure('public.fn_lgpd_cascade_redact_contact(uuid,uuid,uuid)') IS NOT NULL
     AND to_regprocedure('public.fn_lgpd_cascade_redact_contact_legacy_0264(uuid,uuid,uuid)') IS NULL THEN
    ALTER FUNCTION public.fn_lgpd_cascade_redact_contact(uuid,uuid,uuid)
      RENAME TO fn_lgpd_cascade_redact_contact_legacy_0264;
  END IF;
END $$;

DO $create$
BEGIN
  IF to_regprocedure('public.fn_lgpd_cascade_redact_contact(uuid,uuid,uuid)') IS NULL THEN
    CREATE FUNCTION public.fn_lgpd_cascade_redact_contact(
      p_organization_id uuid,
      p_contact_id uuid,
      p_request_id uuid
    ) RETURNS jsonb
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $prospecting_lgpd$
DECLARE
  v_result jsonb;
  v_count integer;
BEGIN
  v_result := public.fn_lgpd_cascade_redact_contact_legacy_0264(
    p_organization_id,
    p_contact_id,
    p_request_id
  );

  UPDATE public.prospecting_recipients
     SET phone_number = '+000000000',
         external_id = NULL,
         company_key = 'anon-' || substring(p_contact_id::text from 1 for 8),
         site_key = NULL,
         data = '{}'::jsonb,
         message = NULL,
         last_error = NULL,
         status = CASE
           WHEN status IN ('sent','delivered','read','replied') THEN status
           ELSE 'blocked'
         END,
         updated_at = now()
   WHERE organization_id = p_organization_id
     AND contact_id = p_contact_id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  v_result := coalesce(v_result, '{}'::jsonb)
    || jsonb_build_object('prospecting_recipients', v_count);

  UPDATE public.prospecting_events
     SET metadata = '{}'::jsonb
   WHERE organization_id = p_organization_id
     AND recipient_id IN (
       SELECT id
         FROM public.prospecting_recipients
        WHERE organization_id = p_organization_id
          AND contact_id = p_contact_id
     );
  GET DIAGNOSTICS v_count = ROW_COUNT;

  RETURN v_result || jsonb_build_object('prospecting_events', v_count);
END;
$prospecting_lgpd$;
  END IF;
END
$create$;

REVOKE ALL ON FUNCTION public.fn_lgpd_cascade_redact_contact(uuid,uuid,uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_lgpd_cascade_redact_contact(uuid,uuid,uuid)
  TO service_role;
