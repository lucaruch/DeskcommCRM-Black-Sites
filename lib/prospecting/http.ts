import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { resolveAuthDual, type AuthDual } from "@/lib/api/auth-dual";
import { fail } from "@/lib/api/wrappers";
import { checkRateLimit } from "@/lib/ai/dispatcher/rate-limit";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { logger } from "@/lib/logger";
import { ProspectingError } from "./ingest";

export type ProspectingAuth = Extract<AuthDual, { ok: true }>;
export async function prospectingRoute(
  req: NextRequest,
  scope: string,
  write: boolean,
  handler: (auth: ProspectingAuth, requestId: string) => Promise<Response>,
): Promise<Response> {
  const requestId = randomUUID();
  try {
    if (write) {
      const denied = await requireSupportWrite();
      if (denied) return denied;
    }
    if (
      req.headers.has("authorization") &&
      !/^Bearer\s+dsk_\S+$/i.test(req.headers.get("authorization")!)
    )
      return fail("unauthenticated", "Token invalido.", 401, { requestId });
    const auth = await resolveAuthDual(req, {
      requestId,
      resource: "prospecting",
      role: write ? "manager" : "viewer",
      scope,
    });
    if (!auth.ok) return auth.response;
    const limit = await checkRateLimit(`prospecting:${auth.organizationId}`, 60, 60);
    if (!limit.allowed)
      return fail("rate_limited", "Limite de requisicoes atingido.", 429, {
        requestId,
        headers: { "Retry-After": "60" },
      });
    return await handler(auth, requestId);
  } catch (error) {
    if (error instanceof z.ZodError)
      return fail("validation_failed", "Verifique os campos enviados.", 422, {
        requestId,
        details: error.issues.map((issue) => ({ path: issue.path, message: issue.message })),
      });
    if (error instanceof ProspectingError)
      return fail(error.code, error.message, error.status, { requestId });
    // Nao expor SQL, dados recebidos ou credenciais ao cliente/log.
    logger.error("[prospecting] falha de operacao", { request_id: requestId });
    return fail("internal_error", "Nao foi possivel concluir a operacao.", 500, { requestId });
  }
}

export async function readProspectingJson(req: NextRequest): Promise<unknown> {
  const contentLength = Number(req.headers.get("content-length") ?? 0);
  if (contentLength > 256000)
    throw new ProspectingError(413, "invalid_request", "Payload muito grande.");
  const reader = req.body?.getReader();
  if (!reader) throw new ProspectingError(400, "invalid_request", "Corpo JSON obrigatorio.");
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for (;;) {
    const part = await reader.read();
    if (part.done) break;
    bytes += part.value.byteLength;
    if (bytes > 256000) {
      await reader.cancel();
      throw new ProspectingError(413, "invalid_request", "Payload muito grande.");
    }
    chunks.push(part.value);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new ProspectingError(400, "invalid_request", "JSON invalido.");
  }
}
