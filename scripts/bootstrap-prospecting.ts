import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createPool } from "@/lib/agent-engine/db/pool";
import { campaignSettingsSchema, DEFAULT_MESSAGE } from "@/lib/prospecting/policy";

const args = new Set(process.argv.slice(2));
const orgArg = process.argv.find((value) => value.startsWith("--organization-id="));
const organizationId = orgArg?.slice("--organization-id=".length) ?? process.env.PROSPECTING_ORGANIZATION_ID;
const apply = args.has("--apply");
const createToken = args.has("--token");

if (!organizationId) throw new Error("Informe --organization-id=<uuid> ou PROSPECTING_ORGANIZATION_ID.");
if (!process.env.SUPABASE_DB_URL) throw new Error("SUPABASE_DB_URL ausente.");

const pool = createPool(process.env.SUPABASE_DB_URL);
const settings = campaignSettingsSchema.parse({ message: DEFAULT_MESSAGE });

async function main() {
  const db = await pool.connect();
  try {
    await db.query("begin");
    const org = await db.query<{ id: string }>("select id from organizations where id=$1", [organizationId]);
    if (!org.rows[0]) throw new Error("Organizacao nao encontrada.");
    const pipeline = await db.query<{ id: string }>(
      `select id from crm_pipelines where organization_id=$1 and is_archived=false
       order by is_default desc, position asc limit 1`,
      [organizationId],
    );
    if (!pipeline.rows[0]) throw new Error("A organizacao nao possui funil ativo.");
    const pipelineId = pipeline.rows[0].id;
    const stages = await db.query<{ id: string; slug: string; name: string; position: number; is_won: boolean; is_lost: boolean }>(
      `select id,slug,name,position,is_won,is_lost from crm_stages
       where organization_id=$1 and pipeline_id=$2 and is_archived=false order by position`,
      [organizationId, pipelineId],
    );
    const initial = stages.rows.find((stage) => stage.slug === "novo") ?? stages.rows.find((stage) => !stage.is_won && !stage.is_lost);
    const sent = stages.rows.find((stage) => stage.slug === "em_andamento") ?? stages.rows.find((stage) => !stage.is_won && !stage.is_lost && stage.id !== initial?.id);
    if (!initial || !sent) throw new Error("O funil precisa de pelo menos duas etapas abertas.");
    let reply = stages.rows.find((stage) => stage.slug === "prospeccao_respondeu");
    if (!reply && apply) {
      const position = Math.max(...stages.rows.map((stage) => Number(stage.position) || 0), 0) + 1000;
      const inserted = await db.query<{ id: string }>(
        `insert into crm_stages(organization_id,pipeline_id,name,slug,position,is_won,is_lost)
         values($1,$2,'Resposta da prospeccao','prospeccao_respondeu',$3,false,false) returning id`,
        [organizationId, pipelineId, position],
      );
      reply = { id: inserted.rows[0]!.id, slug: "prospeccao_respondeu", name: "Resposta da prospeccao", position, is_won: false, is_lost: false };
    }
    if (!reply) throw new Error("Nao foi possivel preparar a etapa de resposta.");
    const channel = await db.query<{ id: string; status: string }>(
      `select id,status from channel_sessions where organization_id=$1 and status='WORKING'
       and provider in ('waha','meta','zernio') order by created_at asc limit 1`,
      [organizationId],
    );
    const channelId = channel.rows[0]?.id ?? null;
    const campaign = await db.query<{ id: string; status: string }>(
      "select id,status from prospecting_campaigns where organization_id=$1 and slug='prospeccao-automatica' for update",
      [organizationId],
    );
    let campaignId: string;
    let campaignStatus: string;
    if (campaign.rows[0]) {
      campaignId = campaign.rows[0].id;
      campaignStatus = campaign.rows[0].status;
      if (apply) {
        const updated = await db.query<{ status: string }>(
          `update prospecting_campaigns set channel_session_id=coalesce(channel_session_id,$2),reply_stage_id=$3,
             status=case when status in ('draft','paused') and $2 is not null then 'active' else status end,
             updated_at=now()
           where organization_id=$1 and id=$4 returning status`,
          [organizationId, channelId, reply.id, campaignId],
        );
        campaignStatus = updated.rows[0]?.status ?? campaignStatus;
      }
    } else {
      campaignId = randomUUID();
      campaignStatus = channelId ? "active" : "paused";
      if (apply) {
        await db.query(
          `insert into prospecting_campaigns
           (id,organization_id,name,slug,description,source,tags,status,pipeline_id,initial_stage_id,sent_stage_id,reply_stage_id,channel_session_id,settings)
           values($1,$2,'Prospecção Automática - Black Sites','prospeccao-automatica',
             'Cadencia de prospeccao para leads autorizados.', 'ChatGPT / Prospeccao Automatica',
             $3,$4,$5,$6,$7,$8,$9,$10)`,
          [campaignId, organizationId, ["prospeccao", "black-sites"], campaignStatus, pipelineId, initial.id, sent.id, reply.id, channelId, settings],
        );
      }
    }
    let tokenPlaintext: string | null = null;
    if (apply && createToken) {
      const existing = await db.query<{ id: string }>("select id from api_tokens where organization_id=$1 and name='ChatGPT - Prospecção Black Sites' and revoked_at is null limit 1", [organizationId]);
      if (!existing.rows[0]) {
        const admin = await db.query<{ id: string }>("select user_id as id from user_organizations where organization_id=$1 and role='admin' and revoked_at is null order by created_at asc limit 1", [organizationId]);
        if (!admin.rows[0]) throw new Error("Nenhum administrador ativo para criar o token.");
        const prefix = `dsk_${randomBytes(4).toString("hex")}`;
        tokenPlaintext = `${prefix}_${randomBytes(32).toString("base64url")}`;
        const hash = createHash("sha256").update(tokenPlaintext).digest();
        await db.query(
          `insert into api_tokens(organization_id,created_by,name,prefix,token_hash,scopes)
           values($1,$2,'ChatGPT - Prospecção Black Sites',$3,$4,$5)`,
          [organizationId, admin.rows[0].id, prefix, `\\x${hash.toString("hex")}`, ["prospecting:write", "campaigns:read", "role:manager"]],
        );
      }
    }
    if (!apply) await db.query("rollback"); else await db.query("commit");
    process.stdout.write(JSON.stringify({ organization_id: organizationId, campaign_id: campaignId, campaign_status: campaignStatus, pipeline_id: pipelineId, channel_configured: Boolean(channelId), mode: apply ? "applied" : "dry_run", ...(tokenPlaintext ? { token_created: true, token_plaintext: tokenPlaintext } : {}) }) + "\n");
  } catch (error) {
    try { await db.query("rollback"); } catch { /* preserve original error */ }
    throw error;
  } finally { db.release(); await pool.end(); }
}

main().catch((error) => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
