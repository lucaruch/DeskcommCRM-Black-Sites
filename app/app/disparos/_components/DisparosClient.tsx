"use client";

/* Esta tela sincroniza filtros e dados remotos; os efeitos abaixo são a fronteira do fetch. */
/* eslint-disable react-hooks/set-state-in-effect */

import { useEffect, useMemo, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Archive,
  ArrowsClockwise,
  MagnifyingGlass,
  Megaphone,
  Pause,
  Play,
  Plus,
} from "@/lib/ui/icons";

type Campaign = {
  id: string;
  name: string;
  slug: string;
  status: string;
  settings: Record<string, unknown>;
  channel_session_id: string | null;
  metrics?: Record<string, number>;
};
type Stage = { id: string; name: string; slug: string; is_won: boolean; is_lost: boolean };
type Pipeline = { id: string; name: string };
type Channel = {
  id: string;
  display_name: string | null;
  phone_number: string | null;
  status: string;
};
type Recipient = {
  id: string;
  phone_number: string;
  status: string;
  step: number;
  data: Record<string, unknown>;
  scheduled_at: string | null;
  sent_at: string | null;
  replied_at: string | null;
  last_error: string | null;
};
type Detail = {
  campaign: Campaign;
  metrics: Record<string, number>;
  health: {
    attempted: number;
    failed: number;
    blocked: number;
    not_interested: number;
    opted_out: number;
    response_rate: number;
    opt_out_rate: number;
    circuit_breaker_open: boolean;
  };
  recipients: Recipient[];
  events: Array<{ id: string; type: string; created_at: string }>;
};
type Run = {
  run_id: string;
  source: string;
  received_at: string;
  prospects_received: number;
  prospects_created: number;
  duplicates: number;
  rejected: number;
  eligible: number;
  queued: number;
  awaiting_consent: number;
  dry_run: boolean;
  status: string;
};
type Tone = "success" | "warning" | "error" | "neutral";

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  const body = (await response.json()) as { data?: T; error?: { message?: string } };
  if (!response.ok) throw new Error(body.error?.message ?? "Não foi possível concluir a operação.");
  return body.data as T;
}

const statusLabel: Record<string, string> = {
  draft: "Rascunho",
  active: "Ativa",
  paused: "Pausada",
  completed: "Concluída",
  archived: "Arquivada",
  queued: "Na fila",
  processing: "Enviando",
  sent: "Enviada",
  replied: "Respondeu",
  awaiting_consent: "Aguardando consentimento",
  waiting_connection: "Aguardando conexão",
  not_interested: "Sem interesse",
  rejected: "Rejeitado",
  blocked: "Bloqueada",
  skipped: "Ignorada",
  failed: "Falhou",
  dry_run: "Teste",
};
function tone(status: string): Tone {
  if (["active", "sent", "replied"].includes(status)) return "success";
  if (["paused", "queued"].includes(status)) return "warning";
  if (["failed", "blocked"].includes(status)) return "error";
  return "neutral";
}

export function DisparosClient({ podeEditar }: { podeEditar: boolean }) {
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [runs, setRuns] = useState<Run[]>([]);
  const [pipelines, setPipelines] = useState<Pipeline[]>([]);
  const [stages, setStages] = useState<Stage[]>([]);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [search, setSearch] = useState("");
  const [newOpen, setNewOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({
    name: "Prospecção Automática - Black Sites",
    slug: "prospeccao-automatica",
    pipeline: "",
    initial: "",
    sent: "",
    reply: "",
    channel: "",
  });

  async function refresh() {
    try {
      setError(null);
      const [rows, recentRuns] = await Promise.all([
        api<Campaign[]>("/api/v1/campaigns"),
        api<Run[]>("/api/v1/prospecting/runs?limit=8"),
      ]);
      setCampaigns(rows);
      setRuns(recentRuns);
      if (!selected && rows[0]) setSelected(rows[0].id);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Falha ao carregar disparos.");
    }
  }
  async function loadDetail(id: string) {
    try {
      setDetail(await api<Detail>(`/api/v1/campaigns/${id}`));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Falha ao carregar campanha.");
    }
  }
  useEffect(() => {
    void refresh();
    void Promise.all([
      api<Pipeline[]>("/api/v1/pipelines").then(setPipelines),
      api<Channel[]>("/api/v1/channel-sessions").then(setChannels),
    ]).catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (selected) void loadDetail(selected);
  }, [selected]);
  useEffect(() => {
    if (!form.pipeline) {
      setStages([]);
      return;
    }
    void api<Stage[]>(`/api/v1/pipelines/${form.pipeline}/stages`)
      .then((items) => {
        setStages(items);
        setForm((old) => ({
          ...old,
          initial: old.initial || items[0]?.id || "",
          sent:
            old.sent ||
            items.find((item) => item.is_won || item.slug.includes("proposta"))?.id ||
            items[1]?.id ||
            "",
          reply:
            old.reply ||
            items.find((item) => item.slug.includes("contato") || item.slug.includes("negociacao"))
              ?.id ||
            items[0]?.id ||
            "",
        }));
      })
      .catch(() => setStages([]));
  }, [form.pipeline]);

  const visible = useMemo(
    () =>
      campaigns.filter((campaign) => campaign.name.toLowerCase().includes(search.toLowerCase())),
    [campaigns, search],
  );
  const totals = useMemo(
    () =>
      campaigns.reduce(
        (out, campaign) => {
          const metrics = campaign.metrics ?? {};
          out.total += metrics.total ?? 0;
          out.sent += metrics.sent ?? 0;
          out.replied += metrics.replied ?? 0;
          out.awaiting += metrics.awaiting_consent ?? 0;
          return out;
        },
        { total: 0, sent: 0, replied: 0, awaiting: 0 },
      ),
    [campaigns],
  );

  async function action(actionName: string) {
    if (!selected) return;
    setBusy(true);
    try {
      await api(`/api/v1/campaigns/${selected}/action`, {
        method: "POST",
        body: JSON.stringify({ action: actionName }),
      });
      await refresh();
      await loadDetail(selected);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Não foi possível alterar a campanha.");
    } finally {
      setBusy(false);
    }
  }
  async function createCampaign() {
    setBusy(true);
    try {
      const created = await api<Campaign>("/api/v1/campaigns", {
        method: "POST",
        body: JSON.stringify({
          name: form.name,
          slug: form.slug,
          pipeline_id: form.pipeline,
          initial_stage_id: form.initial,
          sent_stage_id: form.sent || null,
          reply_stage_id: form.reply,
          channel_session_id: form.channel || null,
          settings: {},
        }),
      });
      setNewOpen(false);
      await refresh();
      setSelected(created.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Não foi possível criar a campanha.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto flex w-full max-w-7xl flex-col gap-6 p-4 sm:p-6">
      <header className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="flex items-center gap-2">
            <Megaphone size={22} aria-hidden />
            <h1 className="text-2xl font-semibold tracking-tight">Disparos</h1>
          </div>
          <p className="mt-1 text-sm text-text-muted">
            Prospecção acompanhada do primeiro contato à resposta.
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => void refresh()} disabled={busy}>
            <ArrowsClockwise size={15} aria-hidden />
            Atualizar
          </Button>
          {podeEditar && (
            <Button size="sm" onClick={() => setNewOpen(true)}>
              <Plus size={15} aria-hidden />
              Nova campanha
            </Button>
          )}
        </div>
      </header>
      {error && (
        <div className="rounded-lg border border-error bg-error-bg px-4 py-3 text-sm text-error-fg">
          {error}
        </div>
      )}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
        <Card>
          <CardContent className="p-4">
            <p className="text-xs text-text-muted">Leads recebidos</p>
            <p className="mt-1 text-2xl font-semibold">{totals.total}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <p className="text-xs text-text-muted">Aguardando consentimento</p>
            <p className="mt-1 text-2xl font-semibold">{totals.awaiting}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <p className="text-xs text-text-muted">Primeiros contatos enviados</p>
            <p className="mt-1 text-2xl font-semibold">{totals.sent}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <p className="text-xs text-text-muted">Respostas</p>
            <p className="mt-1 text-2xl font-semibold">{totals.replied}</p>
          </CardContent>
        </Card>
      </div>
      <div className="grid gap-6 lg:grid-cols-[minmax(280px,0.8fr)_minmax(0,1.6fr)]">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle>Campanhas</CardTitle>
            <CardDescription>{campaigns.length} configurada(s)</CardDescription>
            <div className="relative pt-2">
              <MagnifyingGlass
                size={15}
                className="absolute top-5 left-2.5 text-text-muted"
                aria-hidden
              />
              <Input
                className="h-9 pl-8"
                placeholder="Buscar campanha"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
          </CardHeader>
          <CardContent className="space-y-1">
            {visible.length === 0 ? (
              <p className="py-8 text-center text-sm text-text-muted">
                Nenhuma campanha encontrada.
              </p>
            ) : (
              visible.map((campaign) => (
                <button
                  key={campaign.id}
                  type="button"
                  onClick={() => setSelected(campaign.id)}
                  className={`flex w-full items-center justify-between gap-3 rounded-md px-3 py-3 text-left transition-colors ${selected === campaign.id ? "bg-accent-soft" : "hover:bg-surface-elevated"}`}
                >
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium">{campaign.name}</span>
                    <span className="mt-1 block text-xs text-text-muted">
                      {campaign.metrics?.total ?? 0} leads
                    </span>
                  </span>
                  <Badge variant={tone(campaign.status)}>
                    {statusLabel[campaign.status] ?? campaign.status}
                  </Badge>
                </button>
              ))
            )}
          </CardContent>
        </Card>
        <Card>
          {!detail ? (
            <CardContent className="flex min-h-80 items-center justify-center p-6 text-sm text-text-muted">
              Selecione uma campanha.
            </CardContent>
          ) : (
            <>
              <CardHeader className="flex-row items-start justify-between gap-4 pb-4">
                <div>
                  <CardTitle>{detail.campaign.name}</CardTitle>
                  <CardDescription className="mt-1">
                    {String(detail.campaign.settings?.timezone ?? "America/Sao_Paulo")} ·{" "}
                    {String(detail.campaign.settings?.window_start ?? "09:30")}–
                    {String(detail.campaign.settings?.window_end ?? "17:30")} ·{" "}
                    {String(detail.campaign.settings?.daily_limit ?? 15)}/dia · score mínimo{" "}
                    {String(detail.campaign.settings?.minimum_score ?? 70)}
                  </CardDescription>
                </div>
                <div className="flex gap-2">
                  {podeEditar && detail.campaign.status === "draft" && (
                    <Button size="sm" onClick={() => void action("start")} disabled={busy}>
                      <Play size={15} aria-hidden />
                      Iniciar
                    </Button>
                  )}
                  {podeEditar && detail.campaign.status === "active" && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => void action("pause")}
                      disabled={busy}
                    >
                      <Pause size={15} aria-hidden />
                      Pausar
                    </Button>
                  )}
                  {podeEditar && detail.campaign.status === "paused" && (
                    <Button size="sm" onClick={() => void action("resume")} disabled={busy}>
                      <Play size={15} aria-hidden />
                      Retomar
                    </Button>
                  )}
                  {podeEditar && detail.campaign.status !== "archived" && (
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label="Arquivar campanha"
                      onClick={() => void action("archive")}
                      disabled={busy}
                    >
                      <Archive size={16} aria-hidden />
                    </Button>
                  )}
                </div>
              </CardHeader>
              <CardContent className="space-y-5">
                {detail.health.circuit_breaker_open && (
                  <div className="rounded-md border border-error bg-error-bg px-3 py-2 text-sm text-error-fg">
                    Circuit breaker ativo: a campanha está pausada para proteger a reputação do
                    canal.
                  </div>
                )}
                <div className="flex flex-wrap gap-2">
                  {Object.entries(detail.metrics).map(([key, value]) => (
                    <Badge key={key} variant={tone(key)}>
                      {statusLabel[key] ?? key}: {value}
                    </Badge>
                  ))}
                </div>
                <div className="grid gap-3 sm:grid-cols-4">
                  <div className="rounded-md border px-3 py-2">
                    <p className="text-xs text-text-muted">Taxa de resposta</p>
                    <p className="mt-1 font-semibold">
                      {(detail.health.response_rate * 100).toFixed(1)}%
                    </p>
                  </div>
                  <div className="rounded-md border px-3 py-2">
                    <p className="text-xs text-text-muted">Sem interesse</p>
                    <p className="mt-1 font-semibold">{detail.health.not_interested}</p>
                  </div>
                  <div className="rounded-md border px-3 py-2">
                    <p className="text-xs text-text-muted">Opt-outs</p>
                    <p className="mt-1 font-semibold">{detail.health.opted_out}</p>
                  </div>
                  <div className="rounded-md border px-3 py-2">
                    <p className="text-xs text-text-muted">Falhas</p>
                    <p className="mt-1 font-semibold">{detail.health.failed}</p>
                  </div>
                </div>
                <div className="overflow-x-auto rounded-md border">
                  <table className="w-full text-left text-sm">
                    <thead className="bg-surface-elevated text-xs text-text-muted">
                      <tr>
                        <th className="px-3 py-2">Empresa</th>
                        <th className="px-3 py-2">Telefone</th>
                        <th className="px-3 py-2">Oportunidade</th>
                        <th className="px-3 py-2">Automação proposta</th>
                        <th className="px-3 py-2">Status</th>
                        <th className="px-3 py-2">Etapa</th>
                        <th className="px-3 py-2">Atualizado</th>
                      </tr>
                    </thead>
                    <tbody>
                      {detail.recipients.slice(0, 100).map((recipient) => (
                        <tr key={recipient.id} className="border-t">
                          <td className="px-3 py-2">{String(recipient.data.empresa ?? "-")}</td>
                          <td className="px-3 py-2">{recipient.phone_number}</td>
                          <td className="max-w-56 px-3 py-2">
                            <span className="line-clamp-2" title={String(recipient.data.oportunidade ?? "-")}>
                              {String(recipient.data.oportunidade ?? "-")}
                            </span>
                          </td>
                          <td className="max-w-64 px-3 py-2">
                            <span
                              className="line-clamp-2"
                              title={String(recipient.data.automacao_proposta ?? "-")}
                            >
                              {String(recipient.data.automacao_proposta ?? "-")}
                            </span>
                          </td>
                          <td className="px-3 py-2">
                            <Badge variant={tone(recipient.status)}>
                              {statusLabel[recipient.status] ?? recipient.status}
                            </Badge>
                          </td>
                          <td className="px-3 py-2">{recipient.step + 1}</td>
                          <td className="px-3 py-2 text-xs text-text-muted">
                            {recipient.sent_at
                              ? new Date(recipient.sent_at).toLocaleString("pt-BR")
                              : recipient.scheduled_at
                                ? new Date(recipient.scheduled_at).toLocaleString("pt-BR")
                                : "-"}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {detail.recipients.length === 0 && (
                    <p className="p-8 text-center text-sm text-text-muted">
                      A campanha ainda não recebeu leads.
                    </p>
                  )}
                </div>
              </CardContent>
            </>
          )}
        </Card>
      </div>
      <Card>
        <CardHeader className="pb-3">
          <CardTitle>Execuções recentes</CardTitle>
          <CardDescription>Histórico dos lotes recebidos pelo Action do ChatGPT.</CardDescription>
        </CardHeader>
        <CardContent>
          {runs.length === 0 ? (
            <p className="py-4 text-sm text-text-muted">Nenhuma execução registrada.</p>
          ) : (
            <div className="overflow-x-auto rounded-md border">
              <table className="w-full text-left text-sm">
                <thead className="bg-surface-elevated text-xs text-text-muted">
                  <tr>
                    <th className="px-3 py-2">Execução</th>
                    <th className="px-3 py-2">Recebidos</th>
                    <th className="px-3 py-2">Elegíveis</th>
                    <th className="px-3 py-2">Fila</th>
                    <th className="px-3 py-2">Consentimento</th>
                    <th className="px-3 py-2">Data</th>
                  </tr>
                </thead>
                <tbody>
                  {runs.map((run) => (
                    <tr key={run.run_id} className="border-t">
                      <td className="px-3 py-2 font-medium">{run.run_id}</td>
                      <td className="px-3 py-2">{run.prospects_received}</td>
                      <td className="px-3 py-2">{run.eligible}</td>
                      <td className="px-3 py-2">{run.queued}</td>
                      <td className="px-3 py-2">{run.awaiting_consent}</td>
                      <td className="px-3 py-2 text-xs text-text-muted">
                        {new Date(run.received_at).toLocaleString("pt-BR")}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
      {newOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <Card className="w-full max-w-xl">
            <CardHeader>
              <CardTitle>Nova campanha</CardTitle>
              <CardDescription>Defina o funil e a conexão antes de iniciar.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <Input
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="Nome da campanha"
              />
              <Input
                value={form.slug}
                onChange={(e) => setForm({ ...form, slug: e.target.value })}
                placeholder="Slug"
              />
              <Select
                value={form.pipeline}
                onValueChange={(value) =>
                  setForm({ ...form, pipeline: value, initial: "", sent: "", reply: "" })
                }
              >
                <SelectTrigger>
                  <SelectValue placeholder="Funil" />
                </SelectTrigger>
                <SelectContent>
                  {pipelines.map((pipeline) => (
                    <SelectItem key={pipeline.id} value={pipeline.id}>
                      {pipeline.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <div className="grid gap-3 sm:grid-cols-3">
                <Select
                  value={form.initial}
                  onValueChange={(value) => setForm({ ...form, initial: value })}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Entrada" />
                  </SelectTrigger>
                  <SelectContent>
                    {stages.map((stage) => (
                      <SelectItem key={stage.id} value={stage.id}>
                        {stage.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Select
                  value={form.sent}
                  onValueChange={(value) => setForm({ ...form, sent: value })}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Enviado" />
                  </SelectTrigger>
                  <SelectContent>
                    {stages.map((stage) => (
                      <SelectItem key={stage.id} value={stage.id}>
                        {stage.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Select
                  value={form.reply}
                  onValueChange={(value) => setForm({ ...form, reply: value })}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Resposta" />
                  </SelectTrigger>
                  <SelectContent>
                    {stages.map((stage) => (
                      <SelectItem key={stage.id} value={stage.id}>
                        {stage.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <Select
                value={form.channel}
                onValueChange={(value) => setForm({ ...form, channel: value })}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Conexão WhatsApp (opcional)" />
                </SelectTrigger>
                <SelectContent>
                  {channels.map((channel) => (
                    <SelectItem key={channel.id} value={channel.id}>
                      {channel.display_name || channel.phone_number || channel.id} ·{" "}
                      {channel.status}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <div className="flex justify-end gap-2">
                <Button variant="outline" onClick={() => setNewOpen(false)}>
                  Cancelar
                </Button>
                <Button
                  onClick={() => void createCampaign()}
                  disabled={busy || !form.pipeline || !form.initial || !form.reply}
                >
                  Criar campanha
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      )}
    </main>
  );
}
