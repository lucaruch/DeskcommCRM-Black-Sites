import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/supabase/admin";
import { campaignSettingsSchema } from "@/lib/prospecting/policy";

export const dynamic = "force-dynamic";
const idSchema = z.uuid();
const patchSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    description: z.string().max(2000).optional(),
    source: z.string().max(200).optional(),
    tags: z.array(z.string().trim().min(1).max(80)).max(30).optional(),
    channel_session_id: z.uuid().nullable().optional(),
    // O schema completo tem superRefine e não aceita partial(). O objeto é
    // validado novamente depois de mesclado com a configuração atual.
    settings: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

async function findCampaign(org: string, id: string) {
  return createAdminClient()
    .from("prospecting_campaigns")
    .select("*")
    .eq("organization_id", org)
    .eq("id", id)
    .maybeSingle();
}

export async function GET(
  _req: NextRequest,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("viewer", { requestId, resource: "prospecting_campaigns" });
  if (!authz.ok) return authz.response;
  const id = idSchema.safeParse((await context.params).id);
  if (!id.success) return fail("not_found", "Campanha nao encontrada.", 404, { requestId });
  const result = await findCampaign(authz.org.orgId, id.data);
  if (result.error) return fail("internal_error", "Falha ao ler campanha.", 500, { requestId });
  if (!result.data) return fail("not_found", "Campanha nao encontrada.", 404, { requestId });
  const db = createAdminClient();
  const [recipients, events] = await Promise.all([
    db
      .from("prospecting_recipients")
      .select(
        "id,contact_id,lead_id,phone_number,external_id,data,status,message,step,attempts,scheduled_at,sent_at,replied_at,last_error,dry_run,created_at,updated_at",
      )
      .eq("organization_id", authz.org.orgId)
      .eq("campaign_id", id.data)
      .order("created_at", { ascending: false }),
    db
      .from("prospecting_events")
      .select("id,recipient_id,type,metadata,created_at")
      .eq("organization_id", authz.org.orgId)
      .eq("campaign_id", id.data)
      .order("created_at", { ascending: false })
      .limit(300),
  ]);
  if (recipients.error || events.error)
    return fail("internal_error", "Falha ao ler detalhes da campanha.", 500, { requestId });
  const metrics = (recipients.data ?? []).reduce<Record<string, number>>((all, row) => {
    all.total = (all.total ?? 0) + 1;
    all[row.status] = (all[row.status] ?? 0) + 1;
    return all;
  }, {});
  return ok(
    {
      campaign: result.data,
      metrics,
      recipients: recipients.data ?? [],
      events: events.data ?? [],
    },
    { requestId },
  );
}

export async function PATCH(
  req: NextRequest,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "prospecting_campaigns" });
  if (!authz.ok) return authz.response;
  const id = idSchema.safeParse((await context.params).id);
  if (!id.success) return fail("not_found", "Campanha nao encontrada.", 404, { requestId });
  let patch;
  try {
    patch = patchSchema.parse(await req.json());
  } catch {
    return fail("validation_failed", "Configuracao invalida.", 422, { requestId });
  }
  const current = await findCampaign(authz.org.orgId, id.data);
  if (current.error || !current.data)
    return fail("not_found", "Campanha nao encontrada.", 404, { requestId });
  if (patch.channel_session_id) {
    const channel = await createAdminClient()
      .from("channel_sessions")
      .select("id")
      .eq("organization_id", authz.org.orgId)
      .eq("id", patch.channel_session_id)
      .maybeSingle();
    if (channel.error) return fail("internal_error", "Falha ao validar canal.", 500, { requestId });
    if (!channel.data)
      return fail("forbidden_tenant", "Canal nao pertence a esta organizacao.", 403, { requestId });
  }
  const mergedSettings = patch.settings
    ? campaignSettingsSchema.safeParse({ ...current.data.settings, ...patch.settings })
    : null;
  if (mergedSettings && !mergedSettings.success)
    return fail("validation_failed", "As regras de cadencia sao invalidas.", 422, { requestId });
  const data = { ...patch, ...(mergedSettings ? { settings: mergedSettings.data } : {}) };
  const updated = await createAdminClient()
    .from("prospecting_campaigns")
    .update(data)
    .eq("organization_id", authz.org.orgId)
    .eq("id", id.data)
    .select("*")
    .single();
  if (updated.error)
    return fail("internal_error", "Falha ao atualizar campanha.", 500, { requestId });
  void audit({
    action: "prospecting.campaign_updated",
    actorUserId: authz.user.id,
    organizationId: authz.org.orgId,
    resourceType: "prospecting_campaign",
    resourceId: updated.data.id,
    requestId,
    metadata: { fields: Object.keys(patch) },
  });
  return ok(updated.data, { requestId });
}
