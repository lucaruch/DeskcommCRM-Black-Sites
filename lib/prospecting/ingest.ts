import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import type { Queryable } from "@/lib/agent-engine/queue/queue";

import type { Actor } from "@/lib/api/handlers/types";
import { phoneLookupVariants } from "@/lib/channels/phone-variants";
import { enqueueJob } from "@/lib/agent-engine/queue/queue";
import { prospectingTransaction } from "./db";
import { campaignSettingsSchema, renderProspectingMessage, type Prospect } from "./policy";

export class ProspectingError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface IngestResult {
  accepted: boolean;
  created: boolean;
  updated: boolean;
  duplicate: boolean;
  queued: boolean;
  contact_id: string | null;
  lead_id: string | null;
  campaign_recipient_id: string | null;
  reason: string | null;
  status?: string;
  score?: number;
}

export interface ProspectingRunSummary {
  run_id: string;
  received: number;
  created: number;
  updated: number;
  duplicates: number;
  rejected: number;
  eligible: number;
  queued: number;
  awaiting_consent: number;
}

export function summarizeProspectingRun(
  runId: string,
  results: IngestResult[],
): ProspectingRunSummary {
  return {
    run_id: runId,
    received: results.length,
    created: results.filter((item) => item.created).length,
    updated: results.filter((item) => item.updated).length,
    duplicates: results.filter((item) => item.duplicate).length,
    rejected: results.filter((item) =>
      [
        "rejected",
        "suppressed",
        "contact_blocked",
        "identity_review_required",
        "cooldown",
        "active_negotiation",
        "already_replied",
      ].includes(item.reason ?? ""),
    ).length,
    eligible: results.filter((item) => item.status === "eligible" || item.queued).length,
    queued: results.filter((item) => item.queued).length,
    awaiting_consent: results.filter((item) => item.reason === "awaiting_consent").length,
  };
}

export async function recordProspectingEvent(
  db: Queryable,
  org: string,
  campaign: string,
  recipient: string | null,
  type: string,
  metadata: Record<string, unknown> = {},
): Promise<void> {
  await db.query(
    `insert into prospecting_events(organization_id,campaign_id,recipient_id,type,metadata)
    values($1,$2,$3,$4,$5)`,
    [org, campaign, recipient, type, metadata],
  );
}

function companyKey(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}
function websiteKey(value: string | undefined): string | null {
  if (!value) return null;
  return new URL(value).hostname.toLowerCase().replace(/^www\./, "");
}

async function ingestOne(
  db: PoolClient,
  org: string,
  campaignId: string,
  lead: Prospect,
  dryRun: boolean,
  runId: string,
): Promise<IngestResult> {
  const campaign = (
    await db.query(
      `select * from prospecting_campaigns where organization_id=$1 and id=$2 for update`,
      [org, campaignId],
    )
  ).rows[0];
  if (!campaign) throw new ProspectingError(404, "not_found", "Campanha nao encontrada.");
  if (["completed", "archived"].includes(campaign.status))
    throw new ProspectingError(409, "conflict", "Campanha encerrada.");
  const settings = campaignSettingsSchema.parse(campaign.settings);
  const score = lead.score ?? 0;
  const consent = lead.whatsapp_opt_in === true;
  const phones = phoneLookupVariants(lead.telefone);
  const company = companyKey(lead.empresa);
  const site = websiteKey(lead.site);
  const suppression = (
    await db.query(
      `select id,reason from prospecting_suppressions where organization_id=$1
       and (phone_number=any($2::text[]) or ($3::text is not null and external_id=$3)
       or ($4::text is not null and site_key=$4)) limit 1`,
      [org, phones, lead.external_id || null, site],
    )
  ).rows[0];
  if (suppression)
    return {
      accepted: false,
      created: false,
      updated: false,
      duplicate: true,
      queued: false,
      contact_id: null,
      lead_id: null,
      campaign_recipient_id: null,
      reason: "suppressed",
      status: "blocked",
      score,
    };
  const matches = (
    await db.query(
      `select * from prospecting_recipients where organization_id=$1
    and (phone_number=any($2::text[]) or ($3::text is not null and external_id=$3)
      or ($4::text is not null and site_key=$4) or company_key=$5)
    order by created_at desc limit 20`,
      [org, phones, lead.external_id || null, site, company],
    )
  ).rows;
  // Identidade ambigua nunca altera o telefone de outra pessoa automaticamente.
  const identity = matches.find((r) => phones.includes(r.phone_number));
  const other = matches.find((r) => !phones.includes(r.phone_number));
  if (!identity && other)
    return {
      accepted: false,
      created: false,
      updated: false,
      duplicate: true,
      queued: false,
      contact_id: other.contact_id,
      lead_id: other.lead_id,
      campaign_recipient_id: other.id,
      reason: "identity_review_required",
      status: "rejected",
      score,
    };
  let contact = (
    await db.query(
      `select id,is_blocked,is_anonymized,consent from contacts
    where organization_id=$1 and phone_number=any($2::text[]) and is_merged_into is null
    order by is_anonymized desc,is_blocked desc,created_at asc limit 1 for update`,
      [org, phones],
    )
  ).rows[0];
  const revoked = contact?.consent?.marketing?.revoked_at;
  if (contact && (contact.is_blocked || contact.is_anonymized || revoked))
    return {
      accepted: false,
      created: false,
      updated: false,
      duplicate: !!identity,
      queued: false,
      contact_id: contact.id,
      lead_id: identity?.lead_id ?? null,
      campaign_recipient_id: identity?.id ?? null,
      reason: "contact_blocked",
      status: "blocked",
      score,
    };
  if (score < settings.minimum_score)
    return {
      accepted: false,
      created: false,
      updated: false,
      duplicate: false,
      queued: false,
      contact_id: contact?.id ?? null,
      lead_id: null,
      campaign_recipient_id: null,
      reason: "rejected",
      status: "rejected",
      score,
    };
  const existing = matches.find((r) => r.campaign_id === campaignId);
  if (existing) {
    await recordProspectingEvent(db, org, campaignId, existing.id, "recipient.rediscovered");
    await db.query(
      `update prospecting_recipients set data=data||$3::jsonb,score=$4,whatsapp_opt_in=$5,
       whatsapp_opt_in_source=$6,whatsapp_opt_in_at=$7,
       status=case when $5 and status='awaiting_consent' then 'pending' else status end,updated_at=now()
      where organization_id=$1 and id=$2`,
      [
        org,
        existing.id,
        lead,
        score,
        consent,
        lead.whatsapp_opt_in_source,
        lead.whatsapp_opt_in_at,
      ],
    );
    let queued = false;
    if (
      !dryRun &&
      consent &&
      ["awaiting_consent", "pending"].includes(existing.status) &&
      !existing.job_id
    ) {
      const queuedJob = await enqueueJob(db, org, {
        kind: "campaign_send",
        leadId: existing.contact_id,
        sourceEventId: `prospecting:${existing.id}:0`,
        payload: { prospecting_recipient_id: existing.id, step: 0 },
        runAfter: new Date(),
        maxAttempts: 8,
      });
      await db.query(
        `update prospecting_recipients set status='queued',job_id=$3,updated_at=now()
         where organization_id=$1 and id=$2`,
        [org, existing.id, queuedJob.job.id],
      );
      queued = true;
    }
    return {
      accepted: true,
      created: false,
      updated: true,
      duplicate: true,
      queued,
      contact_id: existing.contact_id,
      lead_id: existing.lead_id,
      campaign_recipient_id: existing.id,
      reason: queued ? "queued" : "already_enrolled",
      status: queued ? "eligible" : existing.status,
      score,
    };
  }
  const recent = matches.find(
    (r) =>
      r.last_sent_at &&
      Date.now() - new Date(r.last_sent_at).getTime() < settings.cooldown_days * 86400000,
  );
  if (recent)
    return {
      accepted: false,
      created: false,
      updated: false,
      duplicate: true,
      queued: false,
      contact_id: recent.contact_id,
      lead_id: recent.lead_id,
      campaign_recipient_id: recent.id,
      reason: "cooldown",
      status: "rejected",
      score,
    };
  const replied = contact
    ? (
        await db.query(
          `select 1 from conversations where organization_id=$1 and contact_id=$2
         and last_inbound_at is not null limit 1`,
          [org, contact.id],
        )
      ).rows[0]
    : null;
  if (replied)
    return {
      accepted: false,
      created: false,
      updated: false,
      duplicate: true,
      queued: false,
      contact_id: contact.id,
      lead_id: null,
      campaign_recipient_id: identity?.id ?? null,
      reason: "already_replied",
      status: "rejected",
      score,
    };
  if (!contact) {
    // A mesma funcao usada pelo Inbox resolve telefone com e sem o nono digito.
    const result = await db.query(
      `select public.fn_upsert_wa_contact($1,'phone',$2,null,$3,$4) as id`,
      [
        org,
        lead.telefone,
        lead.telefone.replace(/\D/g, ""),
        lead.responsavel || lead.nome || lead.empresa,
      ],
    );
    contact = { id: result.rows[0].id };
  }
  await db.query(
    `update contacts set source_metadata=source_metadata||jsonb_build_object('prospecting',$3::jsonb),
    email=coalesce(email,$4),updated_at=now() where organization_id=$1 and id=$2 and not is_anonymized and not is_blocked`,
    [org, contact.id, lead, lead.email ?? null],
  );
  let crmLead = (
    await db.query(
      `select id from crm_leads where organization_id=$1 and contact_id=$2
    and pipeline_id=$3 and status='open' order by created_at desc limit 1`,
      [org, contact.id, campaign.pipeline_id],
    )
  ).rows[0];
  if (!crmLead)
    crmLead = (
      await db.query(
        `insert into crm_leads(organization_id,pipeline_id,stage_id,contact_id,title,source,source_metadata,external_id,tags)
    values($1,$2,$3,$4,$5,$6,$7,$8,$9) returning id`,
        [
          org,
          campaign.pipeline_id,
          campaign.initial_stage_id,
          contact.id,
          lead.empresa,
          lead.origem,
          { prospecting: lead },
          lead.external_id || null,
          campaign.tags,
        ],
      )
    ).rows[0];
  const message = renderProspectingMessage(settings.message, lead);
  const recipient = (
    await db.query(
      `insert into prospecting_recipients(organization_id,campaign_id,contact_id,lead_id,
    phone_number,external_id,company_key,site_key,data,message,approved_at,dry_run,status,scheduled_at,
    run_id,score,whatsapp_opt_in,whatsapp_opt_in_source,whatsapp_opt_in_at)
    values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,case when $11 then now() else null end,$12,
      case when $13 then 'pending' else 'awaiting_consent' end,now(),$14,$15,$16,$17,$18) returning id`,
      [
        org,
        campaignId,
        contact.id,
        crmLead.id,
        lead.telefone,
        lead.external_id || null,
        company,
        site,
        lead,
        message,
        settings.approval === "automatic",
        dryRun,
        consent,
        runId,
        score,
        consent,
        lead.whatsapp_opt_in_source,
        lead.whatsapp_opt_in_at,
      ],
    )
  ).rows[0];
  await recordProspectingEvent(db, org, campaignId, recipient.id, "recipient.accepted", {
    dry_run: dryRun,
  });
  let queued = false;
  if (!dryRun && (consent || !settings.consent_required)) {
    const queuedJob = await enqueueJob(db, org, {
      kind: "campaign_send",
      leadId: contact.id,
      sourceEventId: `prospecting:${recipient.id}:0`,
      payload: { prospecting_recipient_id: recipient.id, step: 0 },
      runAfter: new Date(),
      maxAttempts: 8,
    });
    await db.query(
      `update prospecting_recipients set status='queued',job_id=$3,updated_at=now()
       where organization_id=$1 and id=$2`,
      [org, recipient.id, queuedJob.job.id],
    );
    queued = true;
  }
  return {
    accepted: true,
    created: true,
    updated: false,
    duplicate: false,
    queued,
    contact_id: contact.id,
    lead_id: crmLead.id,
    campaign_recipient_id: recipient.id,
    reason: dryRun
      ? "dry_run"
      : consent || !settings.consent_required
        ? "queued"
        : "awaiting_consent",
    status: dryRun
      ? "dry_run"
      : consent || !settings.consent_required
        ? "eligible"
        : "awaiting_consent",
    score,
  };
}

export async function ingestProspects(input: {
  organizationId: string;
  actor: Actor;
  campaignId?: string;
  leads: Prospect[];
  dryRun: boolean;
  idempotencyKey: string;
  runId?: string;
  source?: string;
  generatedAt?: string | null;
}): Promise<IngestResult[]> {
  return prospectingTransaction(input.organizationId, async (db) => {
    const org = input.organizationId;
    const hash = createHash("sha256")
      .update(
        JSON.stringify({
          campaign: input.campaignId ?? null,
          leads: input.leads,
          dry_run: input.dryRun,
        }),
      )
      .digest("hex");
    const runId = input.runId ?? input.idempotencyKey;
    const source = input.source ?? "chatgpt_daily_prospecting";
    const prior = (
      await db.query(
        "select body_hash,response from prospecting_requests where organization_id=$1 and idempotency_key=$2",
        [org, input.idempotencyKey],
      )
    ).rows[0];
    if (prior) {
      if (prior.body_hash !== hash)
        throw new ProspectingError(
          409,
          "conflict",
          "Idempotency-Key ja utilizada com outro conteudo.",
        );
      return prior.response as IngestResult[];
    }
    const run = (
      await db.query(
        `select id from prospecting_runs where organization_id=$1 and run_id=$2 for update`,
        [org, runId],
      )
    ).rows[0];
    if (run)
      throw new ProspectingError(
        409,
        "conflict",
        "run_id ja processado com outra chave de idempotencia.",
      );
    await db.query(
      `insert into prospecting_runs(organization_id,run_id,source,generated_at,started_at,prospects_received,dry_run)
       values($1,$2,$3,$4,now(),$5,$6)`,
      [org, runId, source, input.generatedAt ?? null, input.leads.length, input.dryRun],
    );
    const campaign =
      input.campaignId ??
      (
        await db.query(
          "select id from prospecting_campaigns where organization_id=$1 and slug='prospeccao-automatica'",
          [org],
        )
      ).rows[0]?.id;
    if (!campaign)
      throw new ProspectingError(409, "conflict", "A campanha padrao ainda nao foi configurada.");
    const results: IngestResult[] = [];
    for (const lead of input.leads)
      results.push(await ingestOne(db, org, campaign, lead, input.dryRun, runId));
    const summary = summarizeProspectingRun(runId, results);
    await db.query(
      "insert into prospecting_requests(organization_id,idempotency_key,run_id,body_hash,response) values($1,$2,$3,$4,$5)",
      [org, input.idempotencyKey, runId, hash, JSON.stringify(results)],
    );
    await db.query(
      `update prospecting_runs set prospects_created=$3,prospects_updated=$4,duplicates=$5,rejected=$6,
       eligible=$7,queued=$8,awaiting_consent=$9,status='processed',updated_at=now()
       where organization_id=$1 and run_id=$2`,
      [
        org,
        runId,
        summary.created,
        summary.updated,
        summary.duplicates,
        summary.rejected,
        summary.eligible,
        summary.queued,
        summary.awaiting_consent,
      ],
    );
    await db.query(
      `insert into api_audit_log(organization_id,actor_user_id,actor_api_token_id,action,resource_type,resource_id,metadata,bypassed_rls)
      values($1,$2,$3,'prospecting.accepted','prospecting_campaign',$4,$5,true)`,
      [
        org,
        input.actor.type === "user" ? input.actor.id : null,
        input.actor.type === "api_token" ? input.actor.id : null,
        campaign,
        { count: results.length, dry_run: input.dryRun },
      ],
    );
    return results;
  });
}
