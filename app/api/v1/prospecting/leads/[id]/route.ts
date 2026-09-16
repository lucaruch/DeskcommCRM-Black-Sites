import type { NextRequest } from "next/server";
import { z } from "zod";
import { ok, fail } from "@/lib/api/wrappers";
import { prospectingRoute } from "@/lib/prospecting/http";
import { prospectingPool } from "@/lib/prospecting/db";

export const dynamic = "force-dynamic";
export async function GET(
  req: NextRequest,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  return prospectingRoute(req, "campaigns:read", false, async (auth, requestId) => {
    const id = z.uuid().parse((await context.params).id);
    const { rows } = await prospectingPool().query(
      `select id,campaign_id,contact_id,lead_id,status,step,attempts,
      scheduled_at,sent_at,replied_at,last_error,dry_run from prospecting_recipients where organization_id=$1 and id=$2`,
      [auth.organizationId, id],
    );
    return rows[0]
      ? ok(rows[0], { requestId })
      : fail("not_found", "Destinatario nao encontrado.", 404, { requestId });
  });
}
