# Prospeccao Black Sites: estado de implementacao

Data: 2026-09-16. Branch: `feature/disparos-prospeccao`.

## Estado real

Implementacao publicada em producao em 2026-09-16 na imagem `b41d33d3`.
O worker recebeu a correção do bootstrap de escopos na imagem `de18a931`.
A campanha principal está em `dry_run` e `active` no banco para impedir qualquer
envio até a autenticação do Action ser configurada; o envio real deve ser ativado
explicitamente depois da homologação.

Base atualizada de `origin/main` ate `cf35c944`, preservando o commit local
`d7ac8581` (contexto de lead do site). Na primeira consulta, app, worker e
scheduler em producao utilizavam imagens oficiais 1.28.0, saudaveis.

## Implementado localmente

- `lib/prospecting/policy.ts`: schemas de campanha/prospect; normalizacao pelo
  helper existente; templates com variaveis permitidas; janela via regra de
  horario existente; jitter e decisao de envio. Bloqueios definitivos separados
  das esperas temporarias. Defaults: 15 novos contatos/dia, 180-420 segundos,
  segunda-sexta 09:30-17:30 America/Sao_Paulo, cooldown 60 dias, score minimo
  70 e follow-ups 48/120h.
- `lib/prospecting/db.ts`: pool existente e transacao com lock por organizacao.
- `lib/prospecting/ingest.ts`: idempotencia persistente, contato pela RPC
  existente, lead no funil, destinatario, evento e job duravel. Conflito de
  identidade exige revisao. Bloqueados/anonimizados, sem consentimento, abaixo
  do score minimo, suprimidos ou ja respondidos nao entram automaticamente.
- `lib/prospecting/http.ts`: auth dual existente, scope dedicado, limite de
  requisicoes, validacao e tamanho maximo de payload, erro sem detalhes de SQL.
- POST `/api/v1/prospecting/leads`: individual ou lote de ate 25, exige
  `Idempotency-Key`; aceita `prospects`, `run_id`, `source`, `generated_at` e
  `dry_run:true`.
- GET `/api/v1/prospecting/runs` e `/api/v1/prospecting/runs/{runId}`: histórico
  de execuções e destinatários por tenant.
- GET `/api/v1/prospecting/leads/[id]`: status por tenant, scope `campaigns:read`.
- `lib/prospecting/worker.ts`: consumidor `campaign_send` no worker, ledger de
  envio, cadencia, limites, janela, cooldown, follow-ups e reagendamento.
- Resposta inbound interrompe a cadencia, atualiza a etapa do lead, classifica
  sem interesse e trata STOP como opt-out terminal com suppression list.
- `/app/disparos`, APIs de campanha, GET de etapas e bootstrap idempotente em
  `scripts/bootstrap-prospecting.ts`.
- Documentação de integração em `docs/prospeccao-api.md`, contrato OpenAPI em
  `docs/chatgpt-prospeccao-openapi.yaml` e instruções do Action em
  `docs/chatgpt-prospecting-agent-instructions.md`.
- Migration 0263, apendice identico no baseline e registro no MANIFEST:
  campaigns/recipients/events/requests/runs/suppressions; FKs compostas; RLS;
  escrita somente por backend; eventos append-only. Aplicada no banco de
  produção após backup validado.

## Verificacoes executadas

- Dependencias instaladas com `corepack pnpm install --frozen-lockfile`
  (pnpm 9.15.9). Nao usar o pnpm global 11: ignora a configuracao do lockfile.
- Teste direcionado da política passou (28 testes), além de typecheck e lint
  direcionado dos arquivos alterados.
- Typecheck passou com heap de 6144 MB após a integração do worker e da UI.
  A tentativa com heap padrao morreu por falta de memoria, nao por erro de tipo.
- `scripts/test-prospecting-schema.sh`: Postgres pg15 descartável, sem porta
  publicada nem dados reais. Baseline install + update, replay da migration e
  privilegios passaram. Container removido pelo trap ao terminar.
- Invariantes adicionais declarados em
  `tests/invariants/prospecting-isolation.test.ts`; suite completa de invariantes
  ainda nao executada. O teste de privilegios NAO substitui prova com dois tenants.
- Nenhuma mensagem externa foi enviada. O token dedicado foi criado sem que o
  plaintext fosse registrado em Git, logs ou frontend.

## Trabalho obrigatório restante

1. No Action do ChatGPT, importar o OpenAPI, agendar a execução por volta de
   07:00 em `America/Sao_Paulo` e inserir o token dedicado no campo de segredo.
2. Homologar com `dry_run:true` e prospects fictícios; depois desligar `dry_run`,
   conferir a conexão `WORKING` e retomar a campanha pela tela do CRM.
3. O atualizador automático oficial permanece desativado nesta instalação porque
   ele não conhece as imagens customizadas; futuras releases devem repetir o
   fluxo de build/migration desta operação antes de habilitá-lo.

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
