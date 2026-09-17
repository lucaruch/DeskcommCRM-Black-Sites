import type { Pool } from "pg";

import { sendTurnMessage, type SendOutcome } from "@/lib/agent-engine/edge/crm/send-message";
import { enqueueJob, type JobRow, type Queryable } from "@/lib/agent-engine/queue/queue";
import type { CrmEdgeConfig } from "@/lib/agent-engine/edge/crm/mcp-client";
import {
  campaignJitterSeconds,
  campaignSettingsSchema,
  decideCampaignSend,
  renderProspectingMessage,
  withinCampaignWindow,
} from "./policy";
import { recordProspectingEvent } from "./ingest";
import { prospectingJobEventId } from "./job-event-id";

export class ProspectingDeferredError extends Error {
  constructor(
    public readonly retryAt: Date,
    reason: string,
  ) {
    super(`prospeccao aguardando: ${reason}`);
    this.name = "ProspectingDeferredError";
  }
}

type RecipientRow = {
  id: string;
  organization_id: string;
  campaign_id: string;
  contact_id: string;
  lead_id: string;
  conversation_id: string | null;
  status: string;
  message: string | null;
  data: Record<string, unknown>;
  step: number;
  attempts: number;
  approved_at: Date | null;
  dry_run: boolean;
  initial_sent_at: Date | null;
  sent_at: Date | null;
  replied_at: Date | null;
  campaign_status: string;
  campaign_settings: unknown;
  channel_session_id: string | null;
  channel_status: string | null;
  contact_blocked: boolean;
  contact_anonymized: boolean;
  consent: Record<string, unknown> | null;
  score: number | null;
  whatsapp_opt_in: boolean;
  suppressed: boolean;
  last_inbound_at: Date | null;
  next_send_at: Date | null;
  sent_stage_id: string | null;
};

function nextWindow(settings: ReturnType<typeof campaignSettingsSchema.parse>, now: Date): Date {
  for (let minutes = 15; minutes <= 8 * 24 * 60; minutes += 15) {
    const candidate = new Date(now.getTime() + minutes * 60_000);
    if (withinCampaignWindow(settings, candidate)) return candidate;
  }
  return new Date(now.getTime() + 60 * 60_000);
}

function retryAt(
  row: RecipientRow,
  settings: ReturnType<typeof campaignSettingsSchema.parse>,
  now: Date,
  reason: string,
): Date {
  if (reason === "interval" && row.next_send_at && row.next_send_at > now) return row.next_send_at;
  if (reason === "outside_window") return nextWindow(settings, now);
  if (reason === "circuit_breaker") return new Date(now.getTime() + 30 * 60_000);
  if (reason === "channel_unavailable") return new Date(now.getTime() + 5 * 60_000);
  return new Date(now.getTime() + 60_000);
}

function terminalStatus(reason: string): string {
  if (reason === "contact_blocked") return "blocked";
  if (reason === "awaiting_consent") return "awaiting_consent";
  if (reason === "score_below_minimum") return "rejected";
  if (reason === "circuit_breaker") return "queued";
  if (reason === "replied") return "replied";
  if (reason === "cancelled") return "cancelled";
  if (reason === "campaign_closed" || reason === "invalid_recipient_or_message") return "skipped";
  return "failed";
}

async function loadRecipient(
  pool: Queryable,
  org: string,
  id: string,
): Promise<RecipientRow | null> {
  const { rows } = await pool.query<RecipientRow>(
    `select r.id,r.organization_id,r.campaign_id,r.contact_id,r.lead_id,r.conversation_id,
       r.status,r.message,r.data,r.step,r.attempts,r.approved_at,r.dry_run,r.initial_sent_at,
       r.sent_at,r.replied_at,c.status as campaign_status,c.settings as campaign_settings,
       c.channel_session_id,ch.status as channel_status,cnt.is_blocked as contact_blocked,
       cnt.is_anonymized as contact_anonymized,cnt.consent,
       r.score,r.whatsapp_opt_in,
       exists(select 1 from prospecting_suppressions s where s.organization_id=r.organization_id
         and (s.phone_number=r.phone_number or (s.external_id is not null and s.external_id=r.external_id)
           or (s.site_key is not null and s.site_key=r.site_key))) as suppressed,
       conv.last_inbound_at,c.next_send_at,c.sent_stage_id
     from prospecting_recipients r
     join prospecting_campaigns c on c.organization_id=r.organization_id and c.id=r.campaign_id
     left join channel_sessions ch on ch.organization_id=c.organization_id and ch.id=c.channel_session_id
     join contacts cnt on cnt.organization_id=r.organization_id and cnt.id=r.contact_id
     left join conversations conv on conv.organization_id=r.organization_id and conv.id=r.conversation_id
     where r.organization_id=$1 and r.id=$2
     for update of r`,
    [org, id],
  );
  return rows[0] ?? null;
}

async function reserveSend(
  pool: Pool,
  row: RecipientRow,
  settings: ReturnType<typeof campaignSettingsSchema.parse>,
  now: Date,
  requestedStep: number,
): Promise<{ row: RecipientRow; message: string } | ProspectingDeferredError | null> {
  const db = await pool.connect();
  try {
    await db.query("begin");
    await db.query("select pg_advisory_xact_lock(hashtextextended($1,263))", [row.organization_id]);
    const current = await loadRecipient(db, row.organization_id, row.id);
    if (!current) {
      await db.query("rollback");
      return null;
    }
    current.step = Math.max(current.step, requestedStep);
    const effectiveSettings = campaignSettingsSchema.parse(current.campaign_settings);
    if (effectiveSettings.circuit_breaker_enabled && !effectiveSettings.circuit_breaker_open) {
      const recent = await db.query<{ status: string }>(
        `select status from prospecting_recipients
         where organization_id=$1 and campaign_id=$2
           and status in ('sent','delivered','read','replied','failed','blocked','opted_out','not_interested')
         order by updated_at desc limit 40`,
        [row.organization_id, row.campaign_id],
      );
      const sample = recent.rows;
      const failures = sample.filter((item) => ["failed", "blocked"].includes(item.status)).length;
      const optOuts = sample.filter((item) => item.status === "opted_out").length;
      if (
        sample.length >= 10 &&
        (failures / sample.length >= effectiveSettings.circuit_failure_rate ||
          optOuts / sample.length >= effectiveSettings.circuit_opt_out_rate)
      ) {
        const reason = `circuit_breaker failures=${failures}/${sample.length} opt_outs=${optOuts}/${sample.length}`;
        await db.query(
          `update prospecting_campaigns
           set status='paused',settings=settings||jsonb_build_object('circuit_breaker_open',true,'circuit_breaker_reason',$3),updated_at=now()
           where organization_id=$1 and id=$2`,
          [row.organization_id, row.campaign_id, reason],
        );
        await recordProspectingEvent(
          db,
          row.organization_id,
          row.campaign_id,
          row.id,
          "campaign.circuit_breaker",
          { reason },
        );
        await db.query("commit");
        throw new ProspectingDeferredError(
          new Date(now.getTime() + 30 * 60_000),
          "circuit_breaker",
        );
      }
    }
    const { rows: sentRows } = await db.query<{ n: number }>(
      `select count(*)::int as n from prospecting_recipients
       where organization_id=$1 and campaign_id=$3
         and initial_sent_at >= ((now() at time zone $2)::date at time zone $2)
         and initial_sent_at < (((now() at time zone $2)::date + 1) at time zone $2)`,
      [row.organization_id, effectiveSettings.timezone, row.campaign_id],
    );
    const { rows: otherRows } = await db.query<{ last_sent_at: Date | null }>(
      `select max(initial_sent_at) as last_sent_at from prospecting_recipients
       where organization_id=$1 and contact_id=$2 and id<>$3`,
      [row.organization_id, row.contact_id, row.id],
    );
    const consent = current.consent ?? {};
    const snapshot = {
      campaign_status: current.campaign_status,
      channel_working: current.channel_status === "WORKING",
      blocked: current.contact_blocked,
      anonymized: current.contact_anonymized,
      suppressed: current.suppressed,
      opted_out: Boolean((consent.marketing as Record<string, unknown> | undefined)?.revoked_at),
      replied: Boolean(current.last_inbound_at),
      consent: current.whatsapp_opt_in,
      score: current.score ?? 0,
      circuit_breaker_open: effectiveSettings.circuit_breaker_open,
      cancelled: [
        "cancelled",
        "blocked",
        "opted_out",
        "replied",
        "skipped",
        "not_interested",
        "awaiting_consent",
        "rejected",
      ].includes(current.status),
      approved: Boolean(current.approved_at),
      valid_phone: true,
      valid_message: Boolean(current.message),
      dry_run: current.dry_run,
      initial: current.step === 0,
      new_contacts_today: sentRows[0]?.n ?? 0,
      last_other_campaign_send: otherRows[0]?.last_sent_at ?? null,
      next_send_at: current.next_send_at,
    };
    const decision = decideCampaignSend(snapshot, effectiveSettings, now);
    if (!decision.allowed) {
      const deferred = [
        "campaign_inactive",
        "channel_unavailable",
        "circuit_breaker",
        "awaiting_approval",
        "cooldown",
        "daily_limit",
        "interval",
        "outside_window",
      ].includes(decision.reason);
      if (!deferred) {
        await db.query(
          "update prospecting_recipients set status=$3,last_error=$4,updated_at=now() where organization_id=$1 and id=$2",
          [row.organization_id, row.id, terminalStatus(decision.reason), decision.reason],
        );
        await recordProspectingEvent(
          db,
          row.organization_id,
          row.campaign_id,
          row.id,
          `recipient.${terminalStatus(decision.reason)}`,
          { reason: decision.reason, step: current.step },
        );
        await db.query("commit");
        return null;
      }
      const retry = retryAt(current, effectiveSettings, now, decision.reason);
      await db.query(
        "update prospecting_recipients set status=case when $3='channel_unavailable' then 'waiting_connection' else 'queued' end,last_error=$3,updated_at=now() where organization_id=$1 and id=$2",
        [row.organization_id, row.id, decision.reason],
      );
      await db.query("rollback");
      return new ProspectingDeferredError(retry, decision.reason);
    }
    const delay = campaignJitterSeconds(effectiveSettings, Math.random());
    await db.query(
      `update prospecting_campaigns set next_send_at=now()+($2 * interval '1 second'),last_run_at=now(),updated_at=now()
       where organization_id=$1 and id=$3`,
      [row.organization_id, delay, row.campaign_id],
    );
    await db.query(
      "update prospecting_recipients set status='processing',step=$3,attempts=attempts+1,updated_at=now() where organization_id=$1 and id=$2",
      [row.organization_id, row.id, current.step],
    );
    await db.query("commit");
    const message =
      current.step === 0
        ? (current.message ?? "")
        : renderProspectingMessage(
            effectiveSettings.followups[current.step - 1]?.message ?? "",
            current.data,
          );
    return { row: current, message };
  } catch (error) {
    try {
      await db.query("rollback");
    } catch {
      /* the original error is more useful */
    }
    throw error;
  } finally {
    db.release();
  }
}

async function markOutcome(
  pool: Pool,
  row: RecipientRow,
  outcome: SendOutcome,
  conversationId: string,
): Promise<void> {
  if (outcome.kind === "queued") {
    await pool.query(
      "update prospecting_recipients set status='queued',last_error='channel_queued',conversation_id=$3,updated_at=now() where organization_id=$1 and id=$2",
      [row.organization_id, row.id, conversationId],
    );
    throw new ProspectingDeferredError(new Date(Date.now() + 5 * 60_000), "channel_queued");
  }
  if (outcome.kind === "blocked") {
    await pool.query(
      "update prospecting_recipients set status='blocked',last_error='contact_blocked',updated_at=now() where organization_id=$1 and id=$2",
      [row.organization_id, row.id],
    );
    await recordProspectingEvent(
      pool,
      row.organization_id,
      row.campaign_id,
      row.id,
      "recipient.blocked",
      { step: row.step },
    );
    return;
  }
  if (outcome.kind === "failed") throw new Error("campaign_message_failed");
  await pool.query(
    `update prospecting_recipients
       set status='sent',sent_at=now(),last_sent_at=now(),initial_sent_at=case when step=0 then coalesce(initial_sent_at,now()) else initial_sent_at end,
           conversation_id=$3,last_error=null,updated_at=now()
     where organization_id=$1 and id=$2`,
    [row.organization_id, row.id, conversationId],
  );
  await recordProspectingEvent(
    pool,
    row.organization_id,
    row.campaign_id,
    row.id,
    "recipient.sent",
    { step: row.step, crm_message_id: outcome.crmMessageId },
  );
  if (row.step === 0 && row.sent_stage_id) {
    await pool.query(
      "update crm_leads set stage_id=$3,updated_at=now() where organization_id=$1 and id=$2",
      [row.organization_id, row.lead_id, row.sent_stage_id],
    );
  }
}

export function createProspectingSendHandler(
  cfg: CrmEdgeConfig,
): (job: JobRow, pool: Pool) => Promise<void> {
  return async (job, pool) => {
    const recipientId = job.payload.prospecting_recipient_id;
    if (typeof recipientId !== "string") throw new Error("campaign_recipient_missing");
    const requestedStep =
      typeof job.payload.step === "number" && Number.isInteger(job.payload.step)
        ? Math.max(0, Math.min(2, job.payload.step))
        : 0;
    const row = await loadRecipient(pool, job.organization_id, recipientId);
    if (!row) return;
    const settings = campaignSettingsSchema.parse(row.campaign_settings);
    if (requestedStep > 0 && !row.initial_sent_at)
      throw new ProspectingDeferredError(new Date(Date.now() + 30 * 60_000), "initial_not_sent");
    const reserved = await reserveSend(pool, row, settings, new Date(), requestedStep);
    if (reserved instanceof ProspectingDeferredError) throw reserved;
    if (!reserved) return;
    let conversationId = reserved.row.conversation_id;
    if (!conversationId) {
      if (!reserved.row.channel_session_id)
        throw new ProspectingDeferredError(new Date(Date.now() + 5 * 60_000), "channel_missing");
      const { ensureConversation } = await import("@/lib/automation/start-conversation");
      conversationId = await ensureConversation(
        cfg.supabase,
        job.organization_id,
        reserved.row.contact_id,
        reserved.row.channel_session_id,
      );
      await pool.query(
        "update prospecting_recipients set conversation_id=$3 where organization_id=$1 and id=$2",
        [job.organization_id, recipientId, conversationId],
      );
    }
    const outcome = await sendTurnMessage(pool, cfg, {
      tenantId: job.organization_id,
      leadId: reserved.row.contact_id,
      jobId: job.id,
      seq: 1,
      conversationId,
      body: reserved.message,
    });
    await markOutcome(pool, reserved.row, outcome, conversationId);
    const next = settings.followups[reserved.row.step];
    if (next && reserved.row.step < 2) {
      const followupAt = new Date(Date.now() + next.after_hours * 60 * 60_000);
      await enqueueJob(pool, job.organization_id, {
        kind: "campaign_send",
        leadId: reserved.row.contact_id,
        sourceEventId: prospectingJobEventId(recipientId, reserved.row.step + 1),
        payload: { prospecting_recipient_id: recipientId, step: reserved.row.step + 1 },
        runAfter: followupAt,
        maxAttempts: 8,
      });
    }
  };
}
