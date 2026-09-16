import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { lastLine, sql } from "./gov-helpers";

describe("prospeccao: superficie do banco", () => {
  it("isola dois tenants e recusa referencia cruzada", () => {
    expect(() =>
      sql(readFileSync(resolve("tests/fixtures/prospecting-isolation.sql"), "utf8")),
    ).not.toThrow();
  });
  it("todas as tabelas novas possuem RLS", () => {
    expect(
      lastLine(
        sql(`select count(*) from pg_class where relnamespace='public'::regnamespace
      and relname in ('prospecting_campaigns','prospecting_recipients','prospecting_events','prospecting_requests')
      and relrowsecurity`),
      ),
    ).toBe("4");
  });
  it("sessao nao pode escrever campanha fora do guard da API", () => {
    expect(
      lastLine(
        sql("select has_table_privilege('authenticated','public.prospecting_campaigns','INSERT')"),
      ),
    ).toBe("f");
    expect(
      lastLine(
        sql("select has_table_privilege('authenticated','public.prospecting_recipients','UPDATE')"),
      ),
    ).toBe("f");
  });
  it("chaves de idempotencia nao sao legiveis pela API publica do Supabase", () => {
    expect(
      lastLine(
        sql("select has_table_privilege('authenticated','public.prospecting_requests','SELECT')"),
      ),
    ).toBe("f");
    expect(
      lastLine(sql("select has_table_privilege('anon','public.prospecting_requests','SELECT')")),
    ).toBe("f");
  });
  it("eventos append-only inclusive sob service role", () => {
    expect(
      lastLine(
        sql("select has_table_privilege('service_role','public.prospecting_events','INSERT')"),
      ),
    ).toBe("t");
    for (const privilege of ["UPDATE", "DELETE", "TRUNCATE"])
      expect(
        lastLine(
          sql(
            `select has_table_privilege('service_role','public.prospecting_events','${privilege}')`,
          ),
        ),
      ).toBe("f");
  });
  it("vinculos de recursos existentes levam a organizacao na FK", () => {
    expect(
      lastLine(
        sql(`select count(*) from pg_constraint
      where contype='f' and conrelid='public.prospecting_recipients'::regclass
      and cardinality(conkey)=2`),
      ),
    ).toBe("5");
  });
});
