# Prospeccao Black Sites: estado de implementacao

Data: 2026-09-16. Branch: `feature/disparos-prospeccao`.

## Estado real

Implementacao pronta no codigo, ainda NAO publicada. Nao executar bootstrap nem habilitar
disparos a partir deste checkpoint. A producao nao foi alterada nesta etapa.

Base atualizada de `origin/main` ate `cf35c944`, preservando o commit local
`d7ac8581` (contexto de lead do site). Na primeira consulta, app, worker e
scheduler em producao utilizavam imagens oficiais 1.28.0, saudaveis.

## Implementado localmente

- `lib/prospecting/policy.ts`: schemas de campanha/prospect; normalizacao pelo
  helper existente; templates com variaveis permitidas; janela via regra de
  horario existente; jitter e decisao de envio. Bloqueios definitivos separados
  das esperas temporarias. Defaults: 20 novos contatos/dia, 120-300 segundos,
  segunda-sexta 09-18 America/Sao_Paulo, cooldown 30 dias, follow-ups 24/72h.
- `lib/prospecting/db.ts`: pool existente e transacao com lock por organizacao.
- `lib/prospecting/ingest.ts`: idempotencia persistente, contato pela RPC
  existente, lead no funil, destinatario, evento e job duravel. Conflito de
  identidade exige revisao. Bloqueados/anonimizados nao entram.
- `lib/prospecting/http.ts`: auth dual existente, scope dedicado, limite de
  requisicoes, validacao e tamanho maximo de payload, erro sem detalhes de SQL.
- POST `/api/v1/prospecting/leads`: individual ou lote de ate 25, exige
  `Idempotency-Key`; lote aceita `dry_run:true`.
- GET `/api/v1/prospecting/leads/[id]`: status por tenant, scope `campaigns:read`.
- `lib/prospecting/worker.ts`: consumidor `campaign_send` no worker, ledger de
  envio, cadencia, limites, janela, cooldown, follow-ups e reagendamento.
- Resposta inbound interrompe a cadencia, atualiza a etapa do lead e trata STOP
  como opt-out terminal.
- `/app/disparos`, APIs de campanha, GET de etapas e bootstrap idempotente em
  `scripts/bootstrap-prospecting.ts`.
- Documentação de integração em `docs/prospeccao-api.md`.
- Migration 0263, apendice identico no baseline e registro no MANIFEST:
  campaigns/recipients/events/requests; FKs compostas; RLS; escrita somente
  por backend; eventos append-only. Nao aplicada no banco de producao.

## Verificacoes executadas

- Dependencias instaladas com `corepack pnpm install --frozen-lockfile`
  (pnpm 9.15.9). Nao usar o pnpm global 11: ignora a configuracao do lockfile.
- 45 testes passaram: policy, rota de ingestao e manifesto.
- Typecheck passou com heap de 6144 MB após a integração do worker e da UI.
  A tentativa com heap padrao morreu por falta de memoria, nao por erro de tipo.
- `scripts/test-prospecting-schema.sh`: Postgres pg15 descartável, sem porta
  publicada nem dados reais. Baseline install + update, replay da migration e
  privilegios passaram. Container removido pelo trap ao terminar.
- Invariantes adicionais declarados em
  `tests/invariants/prospecting-isolation.test.ts`; suite completa de invariantes
  ainda nao executada. O teste de privilegios NAO substitui prova com dois tenants.
- Nenhuma mensagem externa enviada e nenhum token criado.

## Trabalho obrigatório restante

1. Aplicar migration, fazer backup e publicar app/worker/scheduler em produção.
2. Executar bootstrap duas vezes na organização alvo; confirmar conexão `WORKING`
   e a campanha pausada quando não houver conexão pronta.
3. Emitir o token dedicado somente após a migração, guardando o plaintext uma vez.
4. Executar dry-run com `TESTE INTERNO BLACK SITES`, sem destinatários externos,
   e confirmar saúde, fila, Inbox e tela de Disparos.
   e dry-run com TESTE INTERNO BLACK SITES, sem destinatarios externos.
9. Atualizador automatico: hoje substitui imagens app/worker/scheduler pelas
   oficiais. Implementar estrategia de releases customizadas antes do deploy
   para nao perder o modulo. Nao desligar silenciosamente as atualizacoes.
8. Mapa de arquitetura, Living System Checklist, nota `.changes/`, suites de
    regressao, commits revisados e status final honesto por item.

## Pontos de integracao identificados

- Auth: `lib/api/auth-dual.ts` e `lib/mcp/auth.ts` (tokens dsk_, hash SHA256).
- Contatos: `fn_upsert_wa_contact`; canais: `lib/channels/`.
- Conversa: `lib/automation/start-conversation.ts` e
  `lib/messaging/open-shared-contact-conversation.ts`.
- Envio: `app/api/v1/messages/_handler.ts`; identidade de envio:
  `lib/agent-engine/edge/crm/send-ledger.ts`.
- Worker: `workers/agent-worker/main.ts`; fila:
  `lib/agent-engine/queue/queue.ts`.
- Follow-up: `lib/followup/engine.ts`, `enroll.ts`, `turn-bridge.ts`.
- STOP: `lib/opt-out/deteccao.ts` e ingestao de canal existente.

O codigo deste checkpoint NAO representa entrega completa do pedido.
