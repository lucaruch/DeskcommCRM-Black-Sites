import type { NextRequest } from "next/server";
import { z } from "zod";
import { ok } from "@/lib/api/wrappers";
import { prospectingRoute, readProspectingJson } from "@/lib/prospecting/http";
import { ingestProspects } from "@/lib/prospecting/ingest";
import { prospectSchema } from "@/lib/prospecting/policy";

export const dynamic = "force-dynamic";
const batch = z.strictObject({
  leads: z.array(prospectSchema).min(1).max(25),
  campaign_id: z.uuid().optional(),
  dry_run: z.boolean().default(false),
});

export async function POST(req: NextRequest): Promise<Response> {
  return prospectingRoute(req, "prospecting:write", true, async (auth, requestId) => {
    const raw = await readProspectingJson(req);
    const multiple = !!raw && typeof raw === "object" && "leads" in raw;
    const input = multiple
      ? batch.parse(raw)
      : { leads: [prospectSchema.parse(raw)], campaign_id: undefined, dry_run: false };
    const key = z.string().trim().min(1).max(200).parse(req.headers.get("idempotency-key"));
    const results = await ingestProspects({
      organizationId: auth.organizationId,
      actor: auth.actor,
      campaignId: input.campaign_id,
      leads: input.leads,
      dryRun: input.dry_run,
      idempotencyKey: key,
    });
    return ok(multiple ? results : results[0], { requestId });
  });
}
