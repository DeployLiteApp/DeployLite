"use client";

import { useEffect, useRef, useState } from "react";
import type { ComposeResourceMetadata, ComposeResourcePage, ComposeRevisionHistoryPageV1, ComposeRevisionV1 } from "@deploylite/contracts";
import { Button } from "@/components/ui/button";
import { listProjectComposes, readProjectComposeHistory, readProjectComposeRevision } from "./compose-preview-client";

type Props = { projectId: string; apiBaseUrl: string | null; refreshKey: number; onLoad: (revision: ComposeRevisionV1, latestRevisionId: string) => void };
export function ComposeRevisionsPanel({ projectId, apiBaseUrl, refreshKey, onLoad }: Props) {
  const [resources, setResources] = useState<ComposeResourcePage | null>(null);
  const [selected, setSelected] = useState<ComposeResourceMetadata | null>(null);
  const [history, setHistory] = useState<ComposeRevisionHistoryPageV1 | null>(null);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const opened = useRef(false);
  const request = useRef<AbortController | null>(null);
  function cancel() { request.current?.abort(); request.current = null; }
  useEffect(() => {
    cancel(); opened.current = false; setResources(null); setSelected(null); setHistory(null); setError(""); setPending(false);
    return cancel;
  }, [projectId, apiBaseUrl]);
  useEffect(() => { if (opened.current) void browse(); }, [refreshKey]); // No request until deliberate browsing.

  function start() { cancel(); const controller = new AbortController(); request.current = controller; setError(""); setPending(true); return controller; }
  function finish(controller: AbortController) { if (request.current !== controller) return false; request.current = null; setPending(false); return true; }
  async function browse(offset = 0) {
    opened.current = true; const controller = start(); setResources(null); setSelected(null); setHistory(null);
    const result = await listProjectComposes({ projectId, apiBaseUrl, offset, signal: controller.signal });
    if (!finish(controller)) return;
    if (result.kind === "ready") setResources(result.data); else setError(result.message);
  }
  async function view(resource: ComposeResourceMetadata, offset = 0) {
    const controller = start(); setSelected(resource); setHistory(null);
    const result = await readProjectComposeHistory({ projectId, apiBaseUrl, composeId: resource.id, offset, signal: controller.signal });
    if (!finish(controller)) return;
    if (result.kind === "ready") setHistory(result.data); else setError(result.message);
  }
  async function load(revisionId: string) {
    if (!selected) return;
    const controller = start();
    const result = await readProjectComposeRevision({ projectId, apiBaseUrl, composeId: selected.id, revisionId, signal: controller.signal });
    if (!finish(controller)) return;
    if (result.kind === "ready") onLoad(result.data, selected.latestRevisionId); else setError(result.message);
  }
  return <section aria-label="Saved Compose" className="flex flex-col gap-3 text-sm">
    <Button type="button" variant="outline" disabled={!apiBaseUrl || pending} onClick={() => void browse()}>Browse saved Compose</Button>
    {pending ? <p role="status">Loading saved Compose...</p> : null}
    {error ? <p role="alert" className="text-destructive">{error}</p> : null}
    {resources ? <>
      {resources.resources.length === 0 ? <p>No saved Compose configurations.</p> : <ul className="flex flex-wrap gap-2">{resources.resources.map((resource) => <li key={resource.id}>
        <Button type="button" variant="outline" disabled={pending} onClick={() => void view(resource)}>{resource.serviceNames.join(", ")} · revision {resource.latestNumber}</Button>
      </li>)}</ul>}
      <Paging page={resources} disabled={pending} label="configurations" onChange={(offset) => void browse(offset)} />
    </> : null}
    {history && selected ? <div className="flex flex-col gap-2">
      <h3 className="font-medium">Saved revision history</h3>
      <p>Load an earlier configuration into the draft, then preview it again before saving a new revision.</p>
      <ul className="flex flex-col gap-2">{history.revisions.map((item) => <li key={item.id} className="flex flex-wrap items-center gap-3">
        <Button type="button" variant="outline" disabled={pending} onClick={() => void load(item.id)}>Load revision {item.number}</Button>
        <span>{new Date(item.createdAt).toLocaleString()} · {item.serviceCount} services</span>
      </li>)}</ul>
      <Paging page={history} disabled={pending} label="revisions" onChange={(offset) => void view(selected, offset)} />
    </div> : null}
  </section>;
}
function Paging({ page, disabled, label, onChange }: { page: { limit: number; offset: number; total: number }; disabled: boolean; label: string; onChange: (offset: number) => void }) {
  if (page.total <= page.limit) return null;
  return <div className="flex gap-2">
    <Button type="button" variant="outline" disabled={disabled || page.offset === 0} onClick={() => onChange(Math.max(0, page.offset - page.limit))}>Previous {label}</Button>
    <Button type="button" variant="outline" disabled={disabled || page.offset + page.limit >= page.total || page.offset + page.limit > 1_000_000} onClick={() => onChange(page.offset + page.limit)}>Next {label}</Button>
  </div>;
}
