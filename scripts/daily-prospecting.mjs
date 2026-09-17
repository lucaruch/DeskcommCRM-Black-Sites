const CRM_URL = (process.env.CRM_PROSPECTING_URL || "https://crm.bksly.com.br").replace(/\/$/, "");
const OPENAI_MODEL = process.env.OPENAI_PROSPECTING_MODEL || "gpt-5.4-mini";
const dryRun = process.env.PROSPECTING_DRY_RUN === "true";

const openaiKey = process.env.OPENAI_API_KEY?.trim();
const crmToken = process.env.CRM_PROSPECTING_TOKEN?.trim();
if (!openaiKey) throw new Error("OPENAI_API_KEY ausente.");
if (!crmToken) throw new Error("CRM_PROSPECTING_TOKEN ausente.");

const generatedAt = new Date().toISOString();
const runId = `openai-${generatedAt.replace(/[:.]/g, "-")}`;
const idempotencyKey = `daily-prospecting-${runId}`;

const prospectSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "empresa",
    "telefone",
    "site",
    "cidade",
    "estado",
    "nicho",
    "servicos_observados",
    "processo_atual",
    "score",
    "acesso_decisor",
    "oportunidade",
    "motivo_abordagem",
    "automacao_proposta",
    "fluxo_automacao",
    "mensagem_inicial",
    "followup_1",
    "followup_2",
    "ultima_mensagem",
    "proxima_acao",
    "fontes_verificadas",
  ],
  properties: {
    empresa: { type: "string" },
    telefone: { type: "string" },
    site: { type: "string" },
    cidade: { type: "string" },
    estado: { type: "string" },
    nicho: { type: "string" },
    servicos_observados: { type: "string" },
    processo_atual: { type: "string" },
    score: { type: "integer", minimum: 70, maximum: 100 },
    acesso_decisor: { type: "integer", minimum: 0, maximum: 10 },
    oportunidade: { type: "string" },
    motivo_abordagem: { type: "string" },
    automacao_proposta: { type: "string" },
    fluxo_automacao: { type: "string" },
    mensagem_inicial: { type: "string" },
    followup_1: { type: "string" },
    followup_2: { type: "string" },
    ultima_mensagem: { type: "string" },
    proxima_acao: { type: "string" },
    fontes_verificadas: { type: "array", minItems: 1, maxItems: 10, items: { type: "string" } },
  },
};

const instruction = `
Voce e o pesquisador comercial da Black Sites. Execute uma rodada diaria de prospeccao B2B para automacao de atendimento, WhatsApp, IA, CRM, follow-up, agenda, formularios e integracoes.

Data e hora da rodada: ${generatedAt}. Pesquise somente empresas brasileiras reais e use informacoes publicas verificaveis na web. Pesquise pelo menos 20 candidatas em cidades e estados variados e selecione exatamente 10 com maior potencial, score minimo 70.

Para cada selecionada, confirme no site oficial ou fonte publica confiavel: nome, cidade/UF, telefone comercial publico com DDD, site, servicos e um processo repetitivo observavel. Inclua em fontes_verificadas as URLs consultadas. Nao invente pessoas, cargos, telefones, e-mails, necessidades ou fatos. Nao use dados privados.

O objetivo desta rodada e apenas registrar prospects no CRM para revisao humana. Nao envie WhatsApp, e-mail, DM, ligue, preencha formularios, marque reunioes ou fale com qualquer empresa. Todos os prospects devem entrar sem consentimento de WhatsApp.

Crie uma abordagem curta e cordial baseada em uma evidenca real. Inclua saida clara com SAIR nos follow-ups. Sugira uma automacao especifica para cada empresa, sem prometer resultado.
`;

async function requestOpenAI() {
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${openaiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      tools: [{ type: "web_search" }],
      input: instruction,
      store: false,
      text: {
        format: {
          type: "json_schema",
          name: "daily_prospecting_batch",
          strict: true,
          schema: {
            type: "object",
            additionalProperties: false,
            required: ["prospects"],
            properties: {
              prospects: { type: "array", minItems: 10, maxItems: 10, items: prospectSchema },
            },
          },
        },
      },
    }),
  });
  const body = await response.json();
  if (!response.ok)
    throw new Error(`OpenAI HTTP ${response.status}: ${body.error?.message || "falha"}`);
  if (typeof body.output_text !== "string" || !body.output_text.trim())
    throw new Error("OpenAI nao retornou JSON estruturado.");
  return JSON.parse(body.output_text);
}

function usablePhone(value) {
  const digits = String(value).replace(/\D/g, "");
  return (
    (digits.startsWith("55") && (digits.length === 12 || digits.length === 13)) ||
    (!digits.startsWith("55") && (digits.length === 10 || digits.length === 11))
  );
}

function prepareProspects(batch) {
  if (!Array.isArray(batch?.prospects) || batch.prospects.length !== 10)
    throw new Error("A pesquisa nao retornou exatamente 10 prospects.");
  const prospects = batch.prospects.map((prospect) => ({
    ...prospect,
    origem: "openai_scheduled_search",
    status_comercial: "PESQUISADO",
    whatsapp_opt_in: false,
    whatsapp_opt_in_source: null,
    whatsapp_opt_in_at: null,
    metadata: {
      fontes_verificadas: prospect.fontes_verificadas,
      automated_run: true,
      generated_by: OPENAI_MODEL,
    },
  }));
  const invalid = prospects.filter((prospect) => !usablePhone(prospect.telefone));
  if (invalid.length) throw new Error(`Telefone invalido em ${invalid.length} prospect(s).`);
  return prospects;
}

async function postToCrm(prospects) {
  const response = await fetch(`${CRM_URL}/api/v1/prospecting/leads`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${crmToken}`,
      "Content-Type": "application/json",
      "Idempotency-Key": idempotencyKey,
    },
    body: JSON.stringify({
      prospects,
      source: "openai_scheduled_prospecting",
      run_id: runId,
      generated_at: generatedAt,
      dry_run: dryRun,
    }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok)
    throw new Error(`CRM HTTP ${response.status}: ${body.error?.message || "falha"}`);
  return body.data || body;
}

try {
  const batch = prepareProspects(await requestOpenAI());
  const result = await postToCrm(batch);
  console.log(
    JSON.stringify({
      ok: true,
      run_id: runId,
      received: result.received ?? batch.length,
      created: result.created ?? null,
      duplicates: result.duplicates ?? null,
      rejected: result.rejected ?? null,
      awaiting_consent: result.awaiting_consent ?? null,
      queued: result.queued ?? null,
      dry_run: dryRun,
      message: "Prospects cadastrados no CRM; nenhum contato externo foi enviado.",
    }),
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
