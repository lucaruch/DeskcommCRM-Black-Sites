# API de prospecção

## Autenticação

As rotas aceitam sessão do CRM ou `Authorization: Bearer dsk_...`. O token de
integração deve ter `prospecting:write`, `campaigns:read` e `role:manager`.
Tokens são criados em Configurações → Tokens de API; o segredo aparece uma vez.

## Importar leads

`POST /api/v1/prospecting/leads` exige `Idempotency-Key` e aceita um lead ou um
lote de até 25 itens. A organização vem da sessão/token, nunca do corpo.

```json
{
  "dry_run": true,
  "leads": [{
    "empresa": "Empresa Demonstração",
    "telefone": "+5511999999999",
    "site": "https://empresa-exemplo.invalid",
    "origem": "chatgpt_prospeccao",
    "motivo_abordagem": "Presença digital a atualizar"
  }]
}
```

Use `dry_run: true` para homologação. O modo não cria mensagem externa nem job
de envio. Para produção, envie somente contatos com base legal e respeite o
pedido de saída `SAIR`/STOP; o CRM cancela a cadência ao receber uma resposta.

`GET /api/v1/prospecting/leads/{id}` retorna o status do destinatário. A API
persiste a chave de idempotência por organização e recusa replay com corpo
diferente.

## Operação

A campanha padrão é `prospeccao-automatica`, com janela de segunda a sexta,
09:00–18:00 em `America/Sao_Paulo`, limite de 20 primeiros contatos por dia,
intervalo aleatório de 120–300 segundos e cooldown de 30 dias. A tela
`/app/disparos` mostra a campanha, fila, estágios, métricas e respostas.
