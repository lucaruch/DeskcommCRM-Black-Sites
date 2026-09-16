import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { prospectingPool } from "../lib/prospecting/db";
import { ingestProspects, ProspectingError } from "../lib/prospecting/ingest";
import { prospectSchema } from "../lib/prospecting/policy";

async function main(): Promise<void> {
  const url = new URL(process.env.SUPABASE_DB_URL ?? "http://invalid");
  assert.equal(process.env.PROSPECTING_TEST_DATABASE, "disposable");
  assert.equal(url.hostname, "127.0.0.1", "Este teste recusa banco remoto.");
  assert.equal(url.password, "local-test-only", "Use apenas o banco descartavel do harness.");
  const pool = prospectingPool();
  try {
    const fixture = readFileSync("tests/fixtures/prospecting-isolation.sql", "utf8").replace(
      /rollback;\s*$/,
      "commit;",
    );
    await pool.query(fixture);
    const org = "26300000-0000-4000-8000-000000000001";
    const campaign = "26300000-4444-4000-8000-000000000001";
    const actor = { type: "user" as const, id: "26300000-1111-4000-8000-000000000001" };
    const lead = prospectSchema.parse({
      empresa: "TESTE INTERNO BLACK SITES",
      telefone: "5513999999999",
      origem: "integration_test",
      external_id: "test-internal-1",
    });
    const base = { organizationId: org, campaignId: campaign, actor, leads: [lead], dryRun: true };
    const first = await ingestProspects({ ...base, idempotencyKey: "initial" });
    assert.equal(first[0]?.created, true);
    assert.equal(first[0]?.queued, false);
    assert.equal(first[0]?.reason, "dry_run");
    assert.deepEqual(await ingestProspects({ ...base, idempotencyKey: "initial" }), first);
    const repeat = await ingestProspects({ ...base, idempotencyKey: "rediscovery" });
    assert.equal(repeat[0]?.duplicate, true);
    assert.equal(repeat[0]?.campaign_recipient_id, first[0]?.campaign_recipient_id);
    await assert.rejects(
      () =>
        ingestProspects({
          ...base,
          leads: [{ ...lead, empresa: "Outra" }],
          idempotencyKey: "initial",
        }),
      (error: unknown) => error instanceof ProspectingError && error.status === 409,
    );
    const raceLead = prospectSchema.parse({
      empresa: "TESTE CONCORRENCIA",
      telefone: "5513999999998",
      origem: "integration_test",
    });
    const race = await Promise.all(
      [1, 2].map((n) =>
        ingestProspects({ ...base, leads: [raceLead], idempotencyKey: `race-${n}` }),
      ),
    );
    assert.equal(race.flat().filter((r) => r.created).length, 1);
    assert.equal(race.flat().filter((r) => r.duplicate).length, 1);
    await pool.query(
      "update contacts set is_blocked=true,blocked_at=now(),blocked_reason='stop_keyword' where organization_id=$1 and id=$2",
      [org, first[0]?.contact_id],
    );
    const blocked = await ingestProspects({ ...base, idempotencyKey: "blocked" });
    assert.equal(blocked[0]?.accepted, false);
    assert.equal(blocked[0]?.reason, "contact_blocked");
    const second = await ingestProspects({
      ...base,
      organizationId: "26300000-0000-4000-8000-000000000002",
      campaignId: "26300000-4444-4000-8000-000000000002",
      actor: { type: "user", id: "26300000-1111-4000-8000-000000000002" },
      idempotencyKey: "initial",
    });
    assert.equal(second[0]?.created, true);
    assert.notEqual(second[0]?.contact_id, first[0]?.contact_id);
    const { rows } = await pool.query(
      "select count(*)::int as n from prospecting_recipients where organization_id=$1",
      [org],
    );
    assert.equal(rows[0].n, 2);
    const messages = await pool.query(
      "select count(*)::int as n from messages where organization_id=$1",
      [org],
    );
    assert.equal(messages.rows[0].n, 0);
    process.stdout.write(
      "ingest: create, rediscovery, replay, conflict, concurrency, STOP and tenant isolation OK; zero messages\n",
    );
  } finally {
    await pool.end();
  }
}
main().catch(() => {
  process.stderr.write("prospecting integration test failed\n");
  process.exitCode = 1;
});
