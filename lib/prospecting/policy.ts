import { z } from "zod";

import { isWithinSchedule } from "@/lib/routing/eligibility";
import { normalizePhoneBR } from "@/lib/webhooks/inbound";

const optionalText = (max: number) => z.string().trim().max(max).optional();
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const timezone = z.string().refine((value) => {
  try {
    new Intl.DateTimeFormat("en", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}, "Fuso horario invalido.");

export const whatsappOptInSourceSchema = z.enum([
  "website_form",
  "landing_page",
  "qr_code",
  "existing_customer",
  "manual_confirmed",
  "inbound_whatsapp",
  "other_verified",
]);

export const prospectSchema = z.strictObject({
  empresa: z.string().trim().min(1).max(200),
  telefone: z
    .string()
    .trim()
    .max(40)
    .transform((value, ctx) => {
      const normalized = normalizePhoneBR(value);
      if (!normalized) {
        ctx.addIssue({ code: "custom", message: "Telefone invalido. Inclua DDD e DDI." });
        return z.NEVER;
      }
      return normalized;
    }),
  external_id: optionalText(200),
  nome: optionalText(200),
  responsavel: optionalText(200),
  email: z.email().max(254).optional(),
  cidade: optionalText(120),
  estado: optionalText(80),
  nicho: optionalText(200),
  site: z.url().max(2048).optional(),
  instagram: optionalText(200),
  origem: z.string().trim().min(1).max(100).default("chatgpt_prospeccao"),
  score: z.number().int().min(0).max(100).optional(),
  oportunidade: optionalText(2000),
  motivo_abordagem: optionalText(2000),
  mensagem_sugerida: optionalText(4000),
  whatsapp_opt_in: z.boolean().default(false),
  whatsapp_opt_in_source: whatsappOptInSourceSchema.nullable().default(null),
  whatsapp_opt_in_at: z.string().datetime({ offset: true }).nullable().default(null),
  metadata: z
    .record(z.string().max(100), z.unknown())
    .default({})
    .refine((value) => JSON.stringify(value).length <= 16000, "Metadata muito grande."),
});
export type Prospect = z.infer<typeof prospectSchema>;

export const DEFAULT_MESSAGE =
  "Ola {{responsavel}}, tudo bem? Sou da Black Sites. Vi a {{empresa}} e identifiquei uma possibilidade de {{oportunidade}}. Trabalhamos com automacoes para empresas e achei que poderia fazer sentido para voces. Posso te explicar rapidamente? Se preferir nao receber mensagens, responda SAIR.";

export const campaignSettingsSchema = z
  .strictObject({
    daily_limit: z.number().int().min(1).max(500).default(15),
    min_interval_seconds: z.number().int().min(60).max(86400).default(180),
    max_interval_seconds: z.number().int().min(60).max(86400).default(420),
    timezone: timezone.default("America/Sao_Paulo"),
    weekdays: z
      .array(z.number().int().min(0).max(6))
      .min(1)
      .max(7)
      .refine((days) => new Set(days).size === days.length)
      .default([1, 2, 3, 4, 5]),
    window_start: time.default("09:30"),
    window_end: time.default("17:30"),
    cooldown_days: z.number().int().min(1).max(365).default(60),
    minimum_score: z.number().int().min(0).max(100).default(70),
    consent_required: z.boolean().default(true),
    dry_run: z.boolean().default(false),
    circuit_breaker_enabled: z.boolean().default(true),
    circuit_failure_rate: z.number().min(0.01).max(1).default(0.35),
    circuit_opt_out_rate: z.number().min(0.01).max(1).default(0.15),
    circuit_breaker_open: z.boolean().default(false),
    circuit_breaker_reason: z.string().max(500).nullable().default(null),
    approval: z.enum(["automatic", "manual"]).default("automatic"),
    message: z.string().trim().min(1).max(4000).default(DEFAULT_MESSAGE),
    ai_personalization: z.boolean().default(false),
    agent_id: z.uuid().nullable().default(null),
    followups: z
      .array(
        z.strictObject({
          after_hours: z.number().int().min(24).max(720),
          message: z.string().trim().min(1).max(4000),
        }),
      )
      .max(2)
      .default([
        {
          after_hours: 48,
          message:
            "Ola! Retomando meu contato sobre sites e automacoes da Black Sites. Esse assunto faz sentido para a {{empresa}} neste momento? Se nao quiser receber novas mensagens, responda SAIR.",
        },
        {
          after_hours: 120,
          message:
            "Este e meu ultimo contato sobre o assunto. Se sites ou automacoes forem uma prioridade para a {{empresa}}, fico a disposicao. Obrigado pelo seu tempo!",
        },
      ]),
    reply_routing: z.enum(["existing", "ai", "human", "queue", "user"]).default("existing"),
    owner_user_id: z.uuid().nullable().default(null),
  })
  .superRefine((value, ctx) => {
    if (value.max_interval_seconds < value.min_interval_seconds)
      ctx.addIssue({
        code: "custom",
        path: ["max_interval_seconds"],
        message: "Intervalo maximo menor que o minimo.",
      });
    if (value.window_end <= value.window_start)
      ctx.addIssue({
        code: "custom",
        path: ["window_end"],
        message: "O fim deve ser posterior ao inicio.",
      });
    if (value.reply_routing === "user" && !value.owner_user_id)
      ctx.addIssue({ code: "custom", path: ["owner_user_id"], message: "Selecione o atendente." });
    if (value.ai_personalization && !value.agent_id)
      ctx.addIssue({ code: "custom", path: ["agent_id"], message: "Selecione o agente." });
    if (
      value.followups.some(
        (step, i) => i > 0 && step.after_hours <= value.followups[i - 1]!.after_hours,
      )
    )
      ctx.addIssue({
        code: "custom",
        path: ["followups"],
        message: "Follow-ups devem ter prazos crescentes.",
      });
  });
export type CampaignSettings = z.infer<typeof campaignSettingsSchema>;

export const campaignSchema = z.strictObject({
  name: z.string().trim().min(1).max(200),
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]{1,79}$/),
  description: z.string().max(2000).default(""),
  source: z.string().max(200).default("ChatGPT / Prospeccao Automatica"),
  tags: z.array(z.string().trim().min(1).max(80)).max(30).default([]),
  pipeline_id: z.uuid(),
  initial_stage_id: z.uuid(),
  sent_stage_id: z.uuid().nullable().default(null),
  reply_stage_id: z.uuid(),
  channel_session_id: z.uuid().nullable().default(null),
  settings: campaignSettingsSchema.prefault({}),
});
export type CampaignInput = z.infer<typeof campaignSchema>;

const TEMPLATE_FIELDS = new Set([
  "nome",
  "empresa",
  "responsavel",
  "cidade",
  "estado",
  "nicho",
  "site",
  "instagram",
  "oportunidade",
  "motivo_abordagem",
]);

/** Substituicao unica: dados externos nunca se tornam uma segunda instrucao de template. */
export function renderProspectingMessage(template: string, data: Record<string, unknown>): string {
  const rendered = template
    .replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (_match, key: string) => {
      if (!TEMPLATE_FIELDS.has(key)) throw new Error("Variavel de mensagem desconhecida.");
      const value = data[key];
      return typeof value === "string" ? value.replace(/[\r\n\t]+/g, " ").trim() : "";
    })
    .replace(/ +/g, " ")
    .replace(/ +([,.!?])/g, "$1")
    .trim();
  if (!rendered || rendered.length > 4000 || /\{\{|\}\}/.test(rendered))
    throw new Error("Mensagem vazia, muito longa ou com variavel invalida.");
  return rendered;
}

export function withinCampaignWindow(settings: CampaignSettings, now: Date): boolean {
  return isWithinSchedule(
    {
      timezone: settings.timezone,
      windows: settings.weekdays.map((dow) => ({
        dow,
        start: settings.window_start,
        end: settings.window_end,
      })),
    },
    now,
  );
}

export function campaignJitterSeconds(settings: CampaignSettings, random: number): number {
  if (!Number.isFinite(random) || random < 0 || random >= 1)
    throw new Error("Random fora do intervalo.");
  return (
    settings.min_interval_seconds +
    Math.floor(random * (settings.max_interval_seconds - settings.min_interval_seconds + 1))
  );
}

export type SendDecision =
  { allowed: true } | { allowed: false; reason: string; terminal: boolean };
export interface SendSnapshot {
  campaign_status: string;
  channel_working: boolean;
  blocked: boolean;
  suppressed: boolean;
  anonymized: boolean;
  opted_out: boolean;
  replied: boolean;
  cancelled: boolean;
  approved: boolean;
  valid_phone: boolean;
  valid_message: boolean;
  dry_run: boolean;
  consent: boolean;
  score: number;
  circuit_breaker_open: boolean;
  initial: boolean;
  new_contacts_today: number;
  last_other_campaign_send: Date | null;
  next_send_at: Date | null;
}

/** Executada novamente na borda de envio, nunca apenas durante a importacao. */
export function decideCampaignSend(
  s: SendSnapshot,
  settings: CampaignSettings,
  now: Date,
): SendDecision {
  const deny = (reason: string, terminal: boolean): SendDecision => ({
    allowed: false,
    reason,
    terminal,
  });
  if (s.dry_run) return deny("dry_run", true);
  if (s.opted_out || s.blocked || s.anonymized || s.suppressed)
    return deny("contact_blocked", true);
  if (s.replied) return deny("replied", true);
  if (settings.consent_required && !s.consent) return deny("awaiting_consent", true);
  if (s.score < settings.minimum_score) return deny("score_below_minimum", true);
  if (s.circuit_breaker_open) return deny("circuit_breaker", false);
  if (s.cancelled) return deny("cancelled", true);
  if (!s.valid_phone || !s.valid_message) return deny("invalid_recipient_or_message", true);
  if (["completed", "archived"].includes(s.campaign_status)) return deny("campaign_closed", true);
  if (s.campaign_status !== "active") return deny("campaign_inactive", false);
  if (!s.channel_working) return deny("channel_unavailable", false);
  if (!s.approved) return deny("awaiting_approval", false);
  if (
    s.initial &&
    s.last_other_campaign_send &&
    now.getTime() - s.last_other_campaign_send.getTime() < settings.cooldown_days * 86400000
  )
    return deny("cooldown", false);
  if (s.initial && s.new_contacts_today >= settings.daily_limit) return deny("daily_limit", false);
  if (s.next_send_at && s.next_send_at > now) return deny("interval", false);
  if (!withinCampaignWindow(settings, now)) return deny("outside_window", false);
  return { allowed: true };
}
