---
impacto: exige_acao
secao: adicionado
titulo: "Campanhas de prospecção com fila segura no CRM"
---

Adiciona a área Disparos, a API de ingestão idempotente, a campanha padrão, a
cadência persistente no worker e o tratamento de resposta/STOP. O envio passa
pelos mesmos gates de canal, ledger e opt-out do atendimento existente.

## Requer atenção

Depois do merge e da publicação das imagens, aplicar a migration, executar o
bootstrap da organização alvo e confirmar a conexão WhatsApp antes de iniciar
uma campanha. O token dedicado deve ser emitido e guardado uma única vez.
