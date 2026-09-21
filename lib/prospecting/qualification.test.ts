import { describe, expect, it } from "vitest";

import { qualifyProspect } from "./qualification";

const researched = {
  empresa: "Clínica Exemplo",
  site: "https://clinica-exemplo.com.br",
  nicho: "Clínica de saúde local",
  servicos_observados: "Atende clientes por telefone e recebe pedidos de orçamento pelo WhatsApp.",
  processo_atual:
    "A equipe recebe a solicitação, consulta a agenda e retorna manualmente ao interessado.",
  oportunidade:
    "Há muitas solicitações repetitivas de orçamento e agendamento que precisam de retorno.",
  motivo_abordagem:
    "O site público mostra contato direto e uma rotina de retorno manual para novos clientes.",
  automacao_proposta: "Organizar a entrada de contatos, a triagem e os lembretes de retorno.",
  status_comercial: "PESQUISADO",
  pesquisa_concluida: true,
  fontes_pesquisa: ["https://clinica-exemplo.com.br/contato"],
  evidencias_pesquisa: [
    "Página de contato pública com telefone, WhatsApp e chamada para agendamento.",
  ],
  porte_estimado: "pequena",
  sinais_automacao_existente: false,
};

describe("qualificação de prospecção", () => {
  it("aceita uma empresa pesquisada fora do mercado de automação", () => {
    expect(qualifyProspect(researched)).toMatchObject({ qualified: true, reason: "qualified" });
  });

  it("aceita empresa pesquisada sem site para oferta contextual de site", () => {
    expect(qualifyProspect({ ...researched, site: undefined })).toMatchObject({
      qualified: true,
      reason: "qualified",
    });
  });

  it("exclui quem já oferece CRM, automação ou IA", () => {
    expect(
      qualifyProspect({
        ...researched,
        nicho: "SaaS de CRM e automação de WhatsApp",
        servicos_observados: "CRM, API oficial do WhatsApp e automações para equipes comerciais.",
      }),
    ).toMatchObject({ qualified: false, reason: "existing_automation_or_crm" });
  });

  it("exige pesquisa, fontes, evidências e perfil de porte antes da fila", () => {
    expect(qualifyProspect({ ...researched, pesquisa_concluida: false })).toMatchObject({
      qualified: false,
      reason: "research_required",
    });
    expect(qualifyProspect({ ...researched, fontes_pesquisa: [] })).toMatchObject({
      qualified: false,
      reason: "research_required",
    });
    expect(qualifyProspect({ ...researched, porte_estimado: null })).toMatchObject({
      qualified: false,
      reason: "target_profile_required",
    });
  });
});
