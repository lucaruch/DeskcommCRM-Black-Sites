import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("viewer", { requestId, resource: "prospecting_runs" });
  if (!authz.ok) return authz.response;
  const limit = z.coerce
    .number()
    .int()
    .min(1)
    .max(100)
    .catch(30)
    .parse(req.nextUrl.searchParams.get("limit"));
  const result = await createAdminClient()
    .from("prospecting_runs")
    .select(
      "id,run_id,source,generated_at,started_at,received_at,prospects_received,prospects_created,prospects_updated,duplicates,rejected,eligible,queued,awaiting_consent,dry_run,status,error_message,created_at,updated_at",
    )
    .eq("organization_id", authz.org.orgId)
    .order("received_at", { ascending: false })
    .limit(limit);
  if (result.error) return fail("internal_error", "Falha ao listar execucoes.", 500, { requestId });
  return ok(result.data ?? [], { requestId });
}
