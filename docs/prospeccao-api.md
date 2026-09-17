# API de prospecção

## Autenticação

As rotas aceitam sessão do CRM ou `Authorization: Bearer dsk_...`. O token de
integração dedicado usa apenas `prospecting:write`, `prospecting:read`,
`role:manager` e `actor:ai_agent`.
Tokens são criados em Configurações → Tokens de API; o segredo aparece uma vez.

## Importar leads

`POST /api/v1/prospecting/leads` exige `Idempotency-Key` e aceita um lead ou um
lote de até 25 itens. A organização vem da sessão/token, nunca do corpo.

```json
{
  "dry_run": true,
  "source": "chatgpt_daily_prospecting",
  "run_id": "2026-09-16T07:00:00-03:00",
  "generated_at": "2026-09-16T07:00:00-03:00",
  "prospects": [
    {
      "empresa": "Empresa Demonstração",
      "telefone": "+5511999999999",
      "site": "https://empresa-exemplo.invalid",
      "origem": "chatgpt_prospeccao",
      "motivo_abordagem": "Presença digital a atualizar",
      "score": 82,
      "whatsapp_opt_in": false,
      "whatsapp_opt_in_source": null,
      "whatsapp_opt_in_at": null
    }
  ]
}
```

Use `dry_run: true` para homologação. O modo não cria mensagem externa nem job
de envio. Para produção, envie somente contatos com base legal e respeite o
pedido de saída `SAIR`/STOP; o CRM cancela a cadência ao receber uma resposta.

`GET /api/v1/prospecting/leads/{id}` retorna o status do destinatário. Use
`GET /api/v1/prospecting/runs` para listar lotes e
`GET /api/v1/prospecting/runs/{runId}` para consultar seus resultados. A API
persiste a chave de idempotência por organização e recusa replay com corpo
diferente ou outro lote usando o mesmo `run_id`.

## Operação

A campanha padrão é `prospeccao-automatica`, com janela de segunda a sexta,
09:30–17:30 em `America/Sao_Paulo`, limite de 15 primeiros contatos por dia,
intervalo aleatório de 180–420 segundos, score mínimo 70 e cooldown de 60 dias.
Consentimento explícito é obrigatório para envio iniciado via WhatsApp. A tela
`/app/disparos` mostra a campanha, fila, estágios, métricas e respostas.
