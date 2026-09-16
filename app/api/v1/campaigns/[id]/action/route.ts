import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";
import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";
const action = z.enum(["start", "pause", "resume", "complete", "archive"]);
export async function POST(req: NextRequest, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const requestId = randomUUID(); const authz = await requireRole("manager", { requestId, resource: "prospecting_campaigns" });
  if (!authz.ok) return authz.response;
  const id = z.uuid().safeParse((await context.params).id); if (!id.success) return fail("not_found", "Campanha nao encontrada.", 404, { requestId });
  let requested: z.infer<typeof action>; try { requested = action.parse((await req.json()).action); } catch { return fail("validation_failed", "Acao invalida.", 422, { requestId }); }
  const db = createAdminClient(); const current = await db.from("prospecting_campaigns").select("status,channel_session_id").eq("organization_id", authz.org.orgId).eq("id", id.data).maybeSingle();
  if (current.error || !current.data) return fail("not_found", "Campanha nao encontrada.", 404, { requestId });
  const next: Record<string,string> = { start: "active", resume: "active", pause: "paused", complete: "completed", archive: "archived" };
  if (requested === "start" || requested === "resume") {
    if (!current.data.channel_session_id) return fail("conflict", "Selecione uma conexao WhatsApp antes de iniciar.", 409, { requestId });
    const channel = await db.from("channel_sessions").select("status").eq("organization_id", authz.org.orgId).eq("id", current.data.channel_session_id).maybeSingle();
    if (channel.data?.status !== "WORKING") return fail("conflict", "A conexao WhatsApp precisa estar ativa.", 409, { requestId });
  }
  const updated = await db.from("prospecting_campaigns").update({ status: next[requested], updated_at: new Date().toISOString() }).eq("organization_id", authz.org.orgId).eq("id", id.data).select("id,status").single();
  if (updated.error) return fail("internal_error", "Falha ao alterar estado.", 500, { requestId });
  void audit({ action: `prospecting.campaign_${requested}`, actorUserId: authz.user.id, organizationId: authz.org.orgId, resourceType: "prospecting_campaign", resourceId: updated.data.id, requestId, metadata: { from: current.data.status, to: next[requested] } });
  return ok(updated.data, { requestId });
}
