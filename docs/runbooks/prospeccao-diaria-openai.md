# Prospeccao diaria automatica

O workflow `.github/workflows/prospeccao-diaria.yml` substitui a tarefa do ChatGPT para a parte que precisa realmente chamar o CRM. Ele roda todos os dias as 07:00 em Sao Paulo, pesquisa com a Responses API + web search e envia um lote idempotente para `POST /api/v1/prospecting/leads`.

## Configuracao no repositorio

No GitHub, em **Settings > Secrets and variables > Actions**:

- crie o secret `OPENAI_API_KEY` com a chave da plataforma OpenAI;
- crie o secret `CRM_PROSPECTING_TOKEN` com o token `dsk_` que tenha apenas `prospecting:write` e `prospecting:read`;
- crie a variable `PROSPECCAO_AUTOMATICA_LIGADA` com valor `1`;
- opcionalmente crie a variable `OPENAI_PROSPECTING_MODEL` com o modelo desejado; o padrao e `gpt-5.4-mini`.

O token nunca deve ser colocado em arquivo, prompt, log ou action do ChatGPT. O workflow usa `whatsapp_opt_in: false`, portanto o resultado entra no CRM para revisao e consentimento; nenhum WhatsApp e enviado por este processo.

## Teste seguro

Em **Actions > Prospeccao diaria -> CRM > Run workflow**, execute manualmente. O job deve terminar verde e mostrar um JSON com `run_id`, `received`, `created`, `awaiting_consent` e `queued: 0`. Depois, no CRM, abra **Disparos** e confira uma nova execucao com a mesma `run_id`.

Se o job falhar, ele termina vermelho. Nao ha sucesso falso em HTTP 401, 422, 429 ou 5xx.
