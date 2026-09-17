import type { NextRequest } from "next/server";
import { z } from "zod";
import { ok } from "@/lib/api/wrappers";
import { prospectingRoute, readProspectingJson } from "@/lib/prospecting/http";
import { ingestProspects, summarizeProspectingRun } from "@/lib/prospecting/ingest";
import { prospectSchema } from "@/lib/prospecting/policy";

export const dynamic = "force-dynamic";
const batch = z
  .strictObject({
    prospects: z.array(prospectSchema).min(1).max(25).optional(),
    leads: z.array(prospectSchema).min(1).max(25).optional(),
    source: z.string().trim().min(1).max(200).default("chatgpt_daily_prospecting"),
    run_id: z.string().trim().min(1).max(200).optional(),
    generated_at: z.string().datetime({ offset: true }).nullable().optional(),
    campaign_id: z.uuid().optional(),
    dry_run: z.boolean().default(false),
  })
  .superRefine((value, ctx) => {
    if (!value.prospects && !value.leads)
      ctx.addIssue({ code: "custom", path: ["prospects"], message: "Envie prospects ou leads." });
    if (value.prospects && value.leads)
      ctx.addIssue({ code: "custom", path: ["prospects"], message: "Use apenas uma lista." });
  });

export async function POST(req: NextRequest): Promise<Response> {
  return prospectingRoute(req, "prospecting:write", true, async (auth, requestId) => {
    const raw = await readProspectingJson(req);
    const multiple = !!raw && typeof raw === "object" && ("leads" in raw || "prospects" in raw);
    const idempotencyKey = z
      .string()
      .trim()
      .min(1)
      .max(200)
      .parse(req.headers.get("idempotency-key"));
    const input = multiple
      ? batch.parse(raw)
      : {
          leads: [prospectSchema.parse(raw)],
          campaign_id: undefined,
          dry_run: false,
          source: "chatgpt_daily_prospecting",
          run_id: idempotencyKey,
          generated_at: null,
        };
    const leads = (Array.isArray(input.prospects) ? input.prospects : input.leads) ?? [];
    const runId = input.run_id ?? idempotencyKey;
    const results = await ingestProspects({
      organizationId: auth.organizationId,
      actor: auth.actor,
      campaignId: input.campaign_id,
      leads,
      dryRun: input.dry_run,
      idempotencyKey,
      runId,
      source: input.source,
      generatedAt: input.generated_at,
    });
    return ok(multiple ? { ...summarizeProspectingRun(runId, results), results } : results[0], {
      requestId,
    });
  });
}
