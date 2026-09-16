import type { createAdminClient } from "@/lib/supabase/admin";
import { ehPedidoDeOptOut } from "@/lib/opt-out/deteccao";
import { logger } from "@/lib/logger";

type Admin = ReturnType<typeof createAdminClient>;

/**
 * Uma resposta encerra a cadencia automatica daquele contato. O Inbox continua
 * sendo a conversa de verdade: este registro apenas impede que um follow-up
 * atrasado concorra com a pessoa ou com o atendente.
 */
export async function registrarRespostaDeProspeccao(
  admin: Admin,
  input: { organizationId: string; contactId: string; texto: string | null },
): Promise<void> {
  try {
    const { data: recipients, error } = await admin
      .from("prospecting_recipients")
      .select("id,campaign_id,lead_id,status")
      .eq("organization_id", input.organizationId)
      .eq("contact_id", input.contactId)
      .in("status", ["pending", "scheduled", "queued", "processing", "sent"]);
    if (error || !recipients?.length) return;

    const optedOut = ehPedidoDeOptOut(input.texto);
    const nextStatus = optedOut ? "opted_out" : "replied";
    const now = new Date().toISOString();
    for (const recipient of recipients) {
      await admin
        .from("prospecting_recipients")
        .update({ status: nextStatus, replied_at: now, last_error: null, updated_at: now })
        .eq("organization_id", input.organizationId)
        .eq("id", recipient.id)
        .in("status", ["pending", "scheduled", "queued", "processing", "sent"]);
    }

    await admin
      .from("job_queue")
      .update({
        status: "failed",
        last_error: optedOut ? "contact_opted_out" : "contact_replied",
        locked_by: null,
        locked_at: null,
      })
      .eq("organization_id", input.organizationId)
      .eq("contact_id", input.contactId)
      .eq("kind", "campaign_send")
      .eq("status", "pending");

    const campaignIds = [...new Set(recipients.map((recipient) => recipient.campaign_id))];
    const { data: campaigns } = await admin
      .from("prospecting_campaigns")
      .select("id,reply_stage_id")
      .eq("organization_id", input.organizationId)
      .in("id", campaignIds);
    const stages = new Map(
      (campaigns ?? []).map((campaign) => [campaign.id, campaign.reply_stage_id]),
    );
    for (const recipient of recipients) {
      const stage = stages.get(recipient.campaign_id);
      if (stage) {
        await admin
          .from("crm_leads")
          .update({ stage_id: stage, updated_at: now })
          .eq("organization_id", input.organizationId)
          .eq("id", recipient.lead_id);
      }
    }
    await admin.from("prospecting_events").insert(
      recipients.map((recipient) => ({
        organization_id: input.organizationId,
        campaign_id: recipient.campaign_id,
        recipient_id: recipient.id,
        type: optedOut ? "recipient.opted_out" : "recipient.replied",
        metadata: { source: "inbound_message" },
      })),
    );
  } catch (error) {
    logger.error("prospeccao: nao foi possivel interromper a cadencia apos inbound", {
      organization_id: input.organizationId,
      contact_id: input.contactId,
      detail: error instanceof Error ? error.message.slice(0, 160) : "desconhecido",
    });
  }
}
