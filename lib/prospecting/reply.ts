import type { createAdminClient } from "@/lib/supabase/admin";
import { ehPedidoDeOptOut } from "@/lib/opt-out/deteccao";
import { logger } from "@/lib/logger";

type Admin = ReturnType<typeof createAdminClient>;

export function isProspectingNotInterested(text: string | null): boolean {
  const normalized = (text ?? "")
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();

  return [
    /\bsem interesse\b/,
    /\bnao\s+(?:tenho|quero|possuo)\s+interesse\b/,
    /\bnao\s+(?:preciso|quero|tenho necessidade)\b/,
    /\bja\s+(?:tenho|uso|possuo)\b.{0,100}\b(?:site|sistema|crm|bot|automacao|fornecedor|agencia|solucao)\b/,
    /\b(?:tenho|uso|possuo)\b.{0,80}\b(?:fornecedor|agencia|empresa|solucao)\b/,
    /\b(?:pode|podem)\s+(?:parar|encerrar|nao mandar|nao enviar)\b/,
    /\bnao\s+(?:mandem|mandar|enviem|enviar)\s+mais\b/,
  ].some((pattern) => pattern.test(normalized));
}

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
    const notInterested = !optedOut && isProspectingNotInterested(input.texto);
    const nextStatus = optedOut ? "opted_out" : notInterested ? "not_interested" : "replied";
    const now = new Date().toISOString();
    for (const recipient of recipients) {
      await admin
        .from("prospecting_recipients")
        .update({ status: nextStatus, replied_at: now, last_error: null, updated_at: now })
        .eq("organization_id", input.organizationId)
        .eq("id", recipient.id)
        .in("status", ["pending", "scheduled", "queued", "processing", "sent"]);
    }

    if (optedOut) {
      const details = await admin
        .from("prospecting_recipients")
        .select("campaign_id,phone_number,external_id,site_key")
        .eq("organization_id", input.organizationId)
        .eq("contact_id", input.contactId);
      for (const recipient of details.data ?? []) {
        await admin.from("prospecting_suppressions").upsert(
          {
            organization_id: input.organizationId,
            contact_id: input.contactId,
            phone_number: recipient.phone_number,
            external_id: recipient.external_id,
            site_key: recipient.site_key,
            reason: "opt_out",
            source: "inbound_whatsapp",
          },
          { onConflict: "organization_id,phone_number" },
        );
      }
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
        type: optedOut
          ? "recipient.opted_out"
          : notInterested
            ? "recipient.not_interested"
            : "recipient.replied",
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
