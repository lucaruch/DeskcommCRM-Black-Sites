#!/usr/bin/env bash
set -euo pipefail
# Teste descartavel sem rede publicada e sem credenciais/dados de producao.
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CONTAINER="prospecting-schema-test-$$"
cleanup() { docker rm -fv "$CONTAINER" >/dev/null 2>&1 || true; }
trap cleanup EXIT
docker run -d --rm --name "$CONTAINER" --memory=384m --label blacksites.purpose=prospecting-schema-test \
  -e POSTGRES_PASSWORD=local-test-only pgvector/pgvector:pg15 >/dev/null
ready=0
for _ in $(seq 1 60); do
  if docker exec "$CONTAINER" pg_isready -h 127.0.0.1 -U postgres >/dev/null 2>&1; then ready=1; break; fi
  sleep 1
done
[ "$ready" = 1 ] || exit 1
# O mesmo prelude Supabase do harness canonico; nao manter uma segunda copia.
sed -n "/^psql_install <<'SQL'/,/^SQL$/p" "$ROOT/scripts/test-db.sh" | sed '1d;$d' \
  | docker exec -i "$CONTAINER" psql -U postgres -v ON_ERROR_STOP=1 -q >/dev/null
for pass in install update; do
  docker exec -i "$CONTAINER" psql -U postgres -v ON_ERROR_STOP=1 -q < "$ROOT/supabase/baseline.sql" >"$ROOT/$pass.log" 2>&1
  printf 'baseline %s OK\n' "$pass"
done
docker exec -i "$CONTAINER" psql -U postgres -v ON_ERROR_STOP=1 -q \
  < "$ROOT/supabase/migrations/20260916210000_0263_prospecting_campaigns.sql" >/dev/null 2>&1
docker exec -i "$CONTAINER" psql -U postgres -v ON_ERROR_STOP=1 -q <<'SQL'
do $$
declare n integer;
begin
  select count(*) into n from pg_class where relnamespace='public'::regnamespace
    and relname in ('prospecting_campaigns','prospecting_recipients','prospecting_events','prospecting_requests') and relrowsecurity;
  if n<>4 then raise exception 'RLS missing'; end if;
  if has_table_privilege('authenticated','public.prospecting_campaigns','INSERT') then raise exception 'write exposed'; end if;
  if has_table_privilege('anon','public.prospecting_requests','SELECT') then raise exception 'idempotency exposed'; end if;
  if has_table_privilege('service_role','public.prospecting_events','DELETE') then raise exception 'events mutable'; end if;
end $$;
SQL
printf 'migration replay and privileges OK\n'
docker exec -i "$CONTAINER" psql -U postgres -v ON_ERROR_STOP=1 -q \
  < "$ROOT/tests/fixtures/prospecting-isolation.sql"
printf 'two tenant RLS and composite FK OK\n'
if [ "${PROSPECTING_RUN_INGEST_TEST:-0}" = 1 ]; then
  docker run --rm --network "container:$CONTAINER" --memory=512m \
    -e SUPABASE_DB_URL=postgresql://postgres:local-test-only@127.0.0.1:5432/postgres \
    -e PROSPECTING_TEST_DATABASE=disposable \
    -v "$ROOT/lib/prospecting:/app/lib/prospecting:ro" \
    -v "$ROOT/scripts/test-prospecting-ingest.ts:/app/scripts/test-prospecting-ingest.ts:ro" \
    -v "$ROOT/tests/fixtures/prospecting-isolation.sql:/app/tests/fixtures/prospecting-isolation.sql:ro" \
    ghcr.io/melgarafael/deskcomm-worker:1.28.0 \
    pnpm exec tsx scripts/test-prospecting-ingest.ts
fi
