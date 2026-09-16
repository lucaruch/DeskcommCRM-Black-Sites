import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

export async function GET(
  _req: NextRequest,
  context: { params: Promise<{ runId: string }> },
): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("viewer", { requestId, resource: "prospecting_runs" });
  if (!authz.ok) return authz.response;
  const runId = z
    .string()
    .trim()
    .min(1)
    .max(200)
    .safeParse((await context.params).runId);
  if (!runId.success) return fail("not_found", "Execucao nao encontrada.", 404, { requestId });
  const db = createAdminClient();
  const [run, recipients] = await Promise.all([
    db
      .from("prospecting_runs")
      .select(
        "id,run_id,source,generated_at,started_at,received_at,prospects_received,prospects_created,prospects_updated,duplicates,rejected,eligible,queued,awaiting_consent,dry_run,status,error_message,created_at,updated_at",
      )
      .eq("organization_id", authz.org.orgId)
      .eq("run_id", runId.data)
      .maybeSingle(),
    db
      .from("prospecting_recipients")
      .select(
        "id,campaign_id,contact_id,phone_number,external_id,data,status,score,whatsapp_opt_in,whatsapp_opt_in_source,run_id,created_at,updated_at,last_error",
      )
      .eq("organization_id", authz.org.orgId)
      .eq("run_id", runId.data)
      .order("created_at", { ascending: true })
      .limit(500),
  ]);
  if (run.error || recipients.error)
    return fail("internal_error", "Falha ao ler execucao.", 500, { requestId });
  if (!run.data) return fail("not_found", "Execucao nao encontrada.", 404, { requestId });
  return ok({ run: run.data, recipients: recipients.data ?? [] }, { requestId });
}
