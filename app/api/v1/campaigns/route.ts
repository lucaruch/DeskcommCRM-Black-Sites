import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/supabase/admin";
import { campaignSchema } from "@/lib/prospecting/policy";

export const dynamic = "force-dynamic";

const CAMPAIGN_COLUMNS = "id,organization_id,name,slug,description,source,tags,status,pipeline_id,initial_stage_id,sent_stage_id,reply_stage_id,channel_session_id,settings,next_send_at,last_run_at,created_at,updated_at";

export async function GET(): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("viewer", { requestId, resource: "prospecting_campaigns" });
  if (!authz.ok) return authz.response;
  const db = createAdminClient();
  const { data, error } = await db.from("prospecting_campaigns").select(CAMPAIGN_COLUMNS)
    .eq("organization_id", authz.org.orgId).order("created_at", { ascending: false });
  if (error) return fail("internal_error", "Falha ao listar campanhas.", 500, { requestId });
  const ids = (data ?? []).map((row) => row.id);
  const metrics = new Map<string, Record<string, number>>();
  if (ids.length) {
    const result = await db.from("prospecting_recipients").select("campaign_id,status")
      .eq("organization_id", authz.org.orgId).in("campaign_id", ids);
    if (result.error) return fail("internal_error", "Falha ao ler metricas.", 500, { requestId });
    for (const row of result.data ?? []) {
      const current = metrics.get(row.campaign_id) ?? { total: 0 };
      current.total = (current.total ?? 0) + 1;
      current[row.status] = (current[row.status] ?? 0) + 1;
      metrics.set(row.campaign_id, current);
    }
  }
  return ok((data ?? []).map((row) => ({ ...row, metrics: metrics.get(row.id) ?? { total: 0 } })), { requestId });
}

export async function POST(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "prospecting_campaigns" });
  if (!authz.ok) return authz.response;
  let parsed;
  try { parsed = campaignSchema.parse(await req.json()); }
  catch (error) { return fail("validation_failed", "Verifique os campos da campanha.", 422, { requestId, details: error }); }
  const db = createAdminClient();
  const org = authz.org.orgId;
  const { data: pipeline } = await db.from("crm_pipelines").select("id").eq("organization_id", org).eq("id", parsed.pipeline_id).maybeSingle();
  const { data: stages } = await db.from("crm_stages").select("id").eq("organization_id", org).eq("pipeline_id", parsed.pipeline_id).in("id", [parsed.initial_stage_id, parsed.reply_stage_id, ...(parsed.sent_stage_id ? [parsed.sent_stage_id] : [])]);
  const expected = 2 + (parsed.sent_stage_id ? 1 : 0);
  if (!pipeline || (stages?.length ?? 0) !== expected) return fail("forbidden_tenant", "Funil ou etapa nao pertence a organizacao ativa.", 403, { requestId });
  const { data, error } = await db.from("prospecting_campaigns").insert({ ...parsed, organization_id: org, status: "draft" }).select(CAMPAIGN_COLUMNS).single();
  if (error) return fail(error.code === "23505" ? "conflict" : "internal_error", error.code === "23505" ? "Ja existe uma campanha com esta chave." : "Falha ao criar campanha.", error.code === "23505" ? 409 : 500, { requestId });
  void audit({ action: "prospecting.campaign_created", actorUserId: authz.user.id, organizationId: org, resourceType: "prospecting_campaign", resourceId: data.id, requestId, metadata: { slug: data.slug } });
  return ok(data, { status: 201, requestId });
}
