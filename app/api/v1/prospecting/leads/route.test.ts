import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "./route";
import { validateBearerToken, McpAuthError } from "@/lib/mcp/auth";
import { ingestProspects } from "@/lib/prospecting/ingest";
import { checkRateLimit } from "@/lib/ai/dispatcher/rate-limit";
import { isPublicPath } from "@/lib/auth/public-paths";
import type * as McpModule from "@/lib/mcp/auth";
import type * as IngestModule from "@/lib/prospecting/ingest";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn(() => ({})) }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn(() => ({})) }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/ai/dispatcher/rate-limit", () => ({ checkRateLimit: vi.fn() }));
vi.mock("@/lib/logger", () => ({ logger: { error: vi.fn() } }));
vi.mock("@/lib/mcp/auth", async () => ({
  ...(await vi.importActual<typeof McpModule>("@/lib/mcp/auth")),
  validateBearerToken: vi.fn(),
}));
vi.mock("@/lib/prospecting/ingest", async () => ({
  ...(await vi.importActual<typeof IngestModule>("@/lib/prospecting/ingest")),
  ingestProspects: vi.fn(),
}));

const org = "26300000-0000-4000-8000-000000000001";
const lead = { empresa: "TESTE INTERNO BLACK SITES", telefone: "5513999999999" };
function request(body: unknown = lead, headers: Record<string, string> = {}) {
  return new NextRequest("https://crm.example.test/api/v1/prospecting/leads", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer dsk_test",
      "idempotency-key": "test-1",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(validateBearerToken).mockResolvedValue({
    organizationId: org,
    role: "manager",
    actor: { type: "api_token", id: "26300000-0000-4000-8000-000000000002" },
    apiTokenId: "token-id",
    scopes: ["prospecting:write"],
  });
  vi.mocked(checkRateLimit).mockResolvedValue({
    allowed: true,
    count: 1,
    limit: 60,
    window_sec: 60,
  });
  vi.mocked(ingestProspects).mockResolvedValue([
    {
      accepted: true,
      created: true,
      updated: false,
      duplicate: false,
      queued: false,
      contact_id: "contact",
      lead_id: "lead",
      campaign_recipient_id: "recipient",
      reason: "pending_scheduling",
    },
  ]);
});

describe("POST prospeccao", () => {
  it("usa organizacao do token e telefone normalizado", async () => {
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(ingestProspects).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: org,
        idempotencyKey: "test-1",
        leads: [expect.objectContaining({ telefone: "+5513999999999" })],
      }),
    );
    expect((await response.json()).data.queued).toBe(false);
  });
  it("recusa token invalido sem tocar o banco de prospeccao", async () => {
    vi.mocked(validateBearerToken).mockRejectedValue(
      new McpAuthError(-32001, 401, "Token invalido"),
    );
    expect((await POST(request())).status).toBe(401);
    expect(ingestProspects).not.toHaveBeenCalled();
  });
  it("recusa header malformado sem cair na sessao", async () => {
    expect((await POST(request(lead, { authorization: "Basic invalid" }))).status).toBe(401);
    expect(ingestProspects).not.toHaveBeenCalled();
  });
  it("recusa scope generico de escrita", async () => {
    vi.mocked(validateBearerToken).mockResolvedValue({
      organizationId: org,
      role: "manager",
      actor: { type: "api_token", id: "token" },
      apiTokenId: "token",
      scopes: ["mcp:write"],
    });
    expect((await POST(request())).status).toBe(403);
    expect(ingestProspects).not.toHaveBeenCalled();
  });
  it("recusa injecao de organizacao", async () => {
    expect((await POST(request({ ...lead, organization_id: "outro" }))).status).toBe(422);
    expect(ingestProspects).not.toHaveBeenCalled();
  });
  it("exige Idempotency-Key", async () => {
    expect((await POST(request(lead, { "idempotency-key": "" }))).status).toBe(422);
  });
  it("aceita lote dry-run e preserva o marcador ate o servico", async () => {
    expect((await POST(request({ leads: [lead], dry_run: true }))).status).toBe(200);
    expect(ingestProspects).toHaveBeenCalledWith(expect.objectContaining({ dryRun: true }));
  });
  it("aceita o dossie comercial de automacao", async () => {
    const response = await POST(
      request({
        leads: [
          {
            ...lead,
            score: 88,
            responsavel: "Contato Exemplo",
            cargo_decisor: "Gerente comercial",
            acesso_decisor: 8,
            servicos_observados: "Atendimento por WhatsApp e formulario no site.",
            canais_atendimento: "WhatsApp e Instagram",
            processo_atual: "Orcamentos respondidos manualmente.",
            oportunidade: "Qualificacao de pedidos de orcamento",
            automacao_proposta: "WhatsApp + IA + CRM + follow-up",
            fluxo_automacao: "site -> WhatsApp -> qualificacao -> CRM -> vendedor",
            mensagem_inicial: "Ola! Posso mostrar uma ideia para agilizar seus orcamentos?",
            followup_1: "Posso te enviar um exemplo pratico?",
            followup_2: "Retomo este assunto ou prefere falar em outro momento?",
            ultima_mensagem: "Encerrando por aqui. Fico a disposicao.",
            roteiro_audio: "Ola! Identifiquei uma forma de agilizar seus orcamentos.",
            roteiro_demonstracao: "Mostrar o fluxo do WhatsApp ao CRM em um minuto.",
            proxima_acao: "Revisar e aprovar a abordagem",
            status_comercial: "PRONTO PARA CONTATO",
          },
        ],
        dry_run: true,
      }),
    );
    expect(response.status).toBe(200);
    expect(ingestProspects).toHaveBeenCalledWith(
      expect.objectContaining({
        leads: [expect.objectContaining({ automacao_proposta: "WhatsApp + IA + CRM + follow-up" })],
      }),
    );
  });
  it("rejeita lote acima de 30 e telefone invalido", async () => {
    expect((await POST(request({ leads: Array.from({ length: 31 }, () => lead) }))).status).toBe(
      422,
    );
    expect((await POST(request({ ...lead, telefone: "123" }))).status).toBe(422);
    expect(ingestProspects).not.toHaveBeenCalled();
  });
  it("limita requisicoes por tenant e informa retry", async () => {
    vi.mocked(checkRateLimit).mockResolvedValue({
      allowed: false,
      count: 61,
      limit: 60,
      window_sec: 60,
    });
    const response = await POST(request());
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("60");
    expect(ingestProspects).not.toHaveBeenCalled();
  });
  it("nao revela detalhes internos em falha inesperada", async () => {
    vi.mocked(ingestProspects).mockRejectedValue(new Error("PRIVATE DATABASE DETAIL"));
    const response = await POST(request());
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain("PRIVATE DATABASE DETAIL");
  });
  it("limita corpo antes de interpretar", async () => {
    expect((await POST(request(lead, { "content-length": "256001" }))).status).toBe(413);
    expect(ingestProspects).not.toHaveBeenCalled();
  });
  it("proxy dispensa cookie somente nas rotas que possuem auth dual", () => {
    expect(isPublicPath("/api/v1/prospecting/leads")).toBe(true);
    expect(isPublicPath(`/api/v1/prospecting/leads/${org}`)).toBe(true);
    expect(isPublicPath("/api/v1/prospecting/admin")).toBe(false);
    expect(isPublicPath("/api/v1/prospecting/leads/unsafe/path")).toBe(false);
  });
});
