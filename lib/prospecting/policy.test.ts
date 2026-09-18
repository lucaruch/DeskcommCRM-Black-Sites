import { describe, expect, it } from "vitest";

import {
  campaignJitterSeconds,
  campaignSettingsSchema,
  decideCampaignSend,
  prospectSchema,
  renderProspectingMessage,
  withinCampaignWindow,
  type SendSnapshot,
} from "./policy";

const settings = campaignSettingsSchema.parse({});
const now = new Date("2026-09-16T15:00:00Z");
const snapshot: SendSnapshot = {
  campaign_status: "active",
  channel_working: true,
  blocked: false,
  suppressed: false,
  anonymized: false,
  opted_out: false,
  replied: false,
  cancelled: false,
  approved: true,
  valid_phone: true,
  valid_message: true,
  dry_run: false,
  consent: true,
  qualified: true,
  score: 100,
  circuit_breaker_open: false,
  initial: true,
  new_contacts_today: 0,
  last_other_campaign_send: null,
  next_send_at: null,
};

describe("contrato de prospeccao", () => {
  it("normaliza telefone usando a mesma regra da captacao", () => {
    const lead = prospectSchema.parse({
      empresa: "TESTE INTERNO BLACK SITES",
      telefone: "(13) 99999-9999",
    });
    expect(lead.telefone).toBe("+5513999999999");
    expect(lead.origem).toBe("chatgpt_prospeccao");
  });
  it.each([
    { empresa: "Empresa", telefone: "123" },
    { empresa: "", telefone: "5513999999999" },
    { empresa: "Empresa", telefone: "5513999999999", organization_id: "outro-tenant" },
    { empresa: "Empresa", telefone: "5513999999999", score: 101 },
  ])("rejeita entrada invalida e tenant externo %#", (input) => {
    expect(prospectSchema.safeParse(input).success).toBe(false);
  });
  it("recusa fuso, janela e intervalo invalidos", () => {
    for (const input of [
      { timezone: "unknown" },
      { window_start: "25:00" },
      { window_start: "18:00", window_end: "09:00" },
      { weekdays: [] },
      { min_interval_seconds: 301, max_interval_seconds: 300 },
      { reply_routing: "user" },
      { ai_personalization: true },
      {
        followups: [
          { after_hours: 72, message: "A" },
          { after_hours: 24, message: "B" },
        ],
      },
    ])
      expect(campaignSettingsSchema.safeParse(input).success).toBe(false);
  });
  it("nao inventa valores nem interpola os dados outra vez", () => {
    expect(
      renderProspectingMessage("Ola {{responsavel}}, da {{empresa}}!", { empresa: "Teste" }),
    ).toBe("Ola, da Teste!");
    expect(() => renderProspectingMessage("{{empresa}}", { empresa: "{{nome}}" })).toThrow();
    expect(() => renderProspectingMessage("{{senha}}", {})).toThrow();
    expect(() => renderProspectingMessage("{{nome}}", {})).toThrow();
  });
});

describe("politica de envio no backend", () => {
  it("autoriza somente dentro da janela em Sao Paulo", () => {
    expect(withinCampaignWindow(settings, now)).toBe(true);
    expect(withinCampaignWindow(settings, new Date("2026-09-16T12:29:00Z"))).toBe(false);
    expect(withinCampaignWindow(settings, new Date("2026-09-16T12:30:00Z"))).toBe(true);
    expect(withinCampaignWindow(settings, new Date("2026-09-16T20:30:00Z"))).toBe(false);
    expect(withinCampaignWindow(settings, new Date("2026-09-19T15:00:00Z"))).toBe(false);
  });
  it("respeita os dois extremos do jitter", () => {
    expect(campaignJitterSeconds(settings, 0)).toBe(180);
    expect(campaignJitterSeconds(settings, 0.999999)).toBe(420);
    expect(() => campaignJitterSeconds(settings, 1)).toThrow();
    expect(() => campaignJitterSeconds(settings, NaN)).toThrow();
  });
  it("permite destinatario elegivel", () => {
    expect(decideCampaignSend(snapshot, settings, now)).toEqual({ allowed: true });
  });
  it.each(["blocked", "anonymized", "opted_out", "replied", "cancelled", "dry_run"] as const)(
    "bloqueia definitivamente %s, inclusive follow-up",
    (flag) => {
      for (const initial of [true, false]) {
        expect(
          decideCampaignSend({ ...snapshot, initial, [flag]: true }, settings, now),
        ).toMatchObject({ allowed: false, terminal: true });
      }
    },
  );
  it.each(["draft", "paused"])("aguarda campanha %s", (status) => {
    expect(
      decideCampaignSend({ ...snapshot, campaign_status: status }, settings, now),
    ).toMatchObject({ allowed: false, terminal: false, reason: "campaign_inactive" });
  });
  it.each(["completed", "archived"])("cancela campanha %s", (status) => {
    expect(
      decideCampaignSend({ ...snapshot, campaign_status: status }, settings, now),
    ).toMatchObject({ allowed: false, terminal: true });
  });
  it.each(["channel_working", "approved", "valid_phone", "valid_message"] as const)(
    "recusa quando %s ausente",
    (flag) => {
      expect(decideCampaignSend({ ...snapshot, [flag]: false }, settings, now)).toMatchObject({
        allowed: false,
      });
    },
  );
  it("limita novos contatos mas nao conta follow-ups como novos contatos", () => {
    expect(
      decideCampaignSend({ ...snapshot, new_contacts_today: 20 }, settings, now),
    ).toMatchObject({ reason: "daily_limit" });
    expect(
      decideCampaignSend({ ...snapshot, initial: false, new_contacts_today: 20 }, settings, now),
    ).toEqual({ allowed: true });
  });
  it("bloqueia reabordagem durante 60 dias", () => {
    expect(
      decideCampaignSend(
        { ...snapshot, last_other_campaign_send: new Date(now.getTime() - 86400000) },
        settings,
        now,
      ),
    ).toMatchObject({ reason: "cooldown" });
    expect(
      decideCampaignSend(
        { ...snapshot, last_other_campaign_send: new Date(now.getTime() - 60 * 86400000) },
        settings,
        now,
      ),
    ).toEqual({ allowed: true });
  });
  it("respeita o horario e a reserva do proximo envio", () => {
    expect(
      decideCampaignSend({ ...snapshot, next_send_at: new Date(now.getTime() + 1) }, settings, now),
    ).toMatchObject({ reason: "interval" });
    expect(decideCampaignSend(snapshot, settings, new Date("2026-09-20T15:00:00Z"))).toMatchObject({
      reason: "outside_window",
    });
  });
  it("exige consentimento, score e mantém o circuito em espera", () => {
    expect(decideCampaignSend({ ...snapshot, consent: false }, settings, now)).toMatchObject({
      allowed: false,
      terminal: true,
      reason: "awaiting_consent",
    });
    expect(decideCampaignSend({ ...snapshot, score: 69 }, settings, now)).toMatchObject({
      allowed: false,
      terminal: true,
      reason: "score_below_minimum",
    });
    expect(
      decideCampaignSend({ ...snapshot, circuit_breaker_open: true }, settings, now),
    ).toMatchObject({
      allowed: false,
      terminal: false,
      reason: "circuit_breaker",
    });
  });
  it("bloqueia contato que perdeu a qualificação", () => {
    expect(decideCampaignSend({ ...snapshot, qualified: false }, settings, now)).toMatchObject({
      allowed: false,
      terminal: true,
      reason: "not_qualified",
    });
  });
});
