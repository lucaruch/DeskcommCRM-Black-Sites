/**
 * Qualificação mínima para prospecção: a fila só recebe empresas pesquisadas,
 * com evidência verificável e sem sinais públicos de já venderem a mesma classe
 * de automação/CRM. A decisão é pura para ser usada no ingest e antes do envio.
 */

export type ProspectQualificationReason =
  "qualified" | "research_required" | "existing_automation_or_crm" | "target_profile_required";

export interface ProspectQualificationInput {
  empresa?: string;
  site?: string;
  nicho?: string;
  servicos_observados?: string;
  processo_atual?: string;
  oportunidade?: string;
  motivo_abordagem?: string;
  automacao_proposta?: string;
  status_comercial?: string;
  pesquisa_concluida?: boolean;
  fontes_pesquisa?: string[];
  evidencias_pesquisa?: string[];
  porte_estimado?: string | null;
  sinais_automacao_existente?: boolean;
}

export interface ProspectQualification {
  qualified: boolean;
  reason: ProspectQualificationReason;
  evidence: string[];
}

const DIRECT_SOLUTION_PATTERNS = [
  /\bcrm\b/i,
  /\bsaas\b/i,
  /\bsoftware\b/i,
  /\bchatbots?\b/i,
  /\bbots?\b/i,
  /\bautom[aã]ç(?:a|ã)o\b/i,
  /\bautoma(?:tion|coes|ções)\b/i,
  /\bagentes?\s+de\s+ia\b/i,
  /\bintelig[eê]ncia\s+artificial\b/i,
  /\bwhatsapp\s+oficial\b/i,
  /\bwhatsapp\s+business\s+api\b/i,
  /\bapi\s+do\s+whatsapp\b/i,
  /\bomnichannel\b/i,
  /\bplataforma\s+de\s+(?:atendimento|vendas|marketing|crm)\b/i,
  /\bmarketing\s+automation\b/i,
];

const REQUIRED_RESEARCH_TEXT: Array<keyof ProspectQualificationInput> = [
  "servicos_observados",
  "processo_atual",
  "oportunidade",
  "motivo_abordagem",
];

function meaningful(value: unknown, minLength: number): value is string {
  return typeof value === "string" && value.trim().length >= minLength;
}

function publicBusinessSignals(input: ProspectQualificationInput): string {
  return [input.empresa, input.nicho, input.servicos_observados, input.processo_atual]
    .filter((value): value is string => typeof value === "string")
    .join(" ");
}

export function qualifyProspect(input: ProspectQualificationInput): ProspectQualification {
  const evidence = (input.evidencias_pesquisa ?? []).filter((item) => meaningful(item, 20));
  const sources = (input.fontes_pesquisa ?? []).filter(
    (item) => typeof item === "string" && item.length > 0,
  );

  if (
    input.sinais_automacao_existente === true ||
    DIRECT_SOLUTION_PATTERNS.some((pattern) => pattern.test(publicBusinessSignals(input)))
  ) {
    return {
      qualified: false,
      reason: "existing_automation_or_crm",
      evidence,
    };
  }

  if (
    input.pesquisa_concluida !== true ||
    !sources.length ||
    !evidence.length ||
    !REQUIRED_RESEARCH_TEXT.every((field) => meaningful(input[field], 40)) ||
    !["PESQUISADO", "PRONTO PARA CONTATO"].includes(input.status_comercial ?? "")
  ) {
    return { qualified: false, reason: "research_required", evidence };
  }

  if (
    !input.porte_estimado ||
    !["micro", "pequena", "media", "local", "regional"].includes(input.porte_estimado)
  ) {
    return { qualified: false, reason: "target_profile_required", evidence };
  }

  return { qualified: true, reason: "qualified", evidence };
}
