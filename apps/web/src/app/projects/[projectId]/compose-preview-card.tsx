"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import type { ComposePreviewV1 } from "@deploylite/contracts";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldLabel } from "@/components/ui/field";
import { Textarea } from "@/components/ui/textarea";
import { previewProjectCompose } from "./compose-preview-client";

export function ComposePreviewCard({ projectId, apiBaseUrl }: { projectId: string; apiBaseUrl: string | null }) {
  const [document, setDocument] = useState("");
  const [preview, setPreview] = useState<ComposePreviewV1 | null>(null);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const revision = useRef(0);
  const request = useRef<AbortController | null>(null);

  useEffect(() => {
    revision.current += 1; request.current?.abort(); request.current = null;
    setDocument(""); setPreview(null); setError(""); setPending(false);
    return () => { revision.current += 1; request.current?.abort(); request.current = null; };
  }, [projectId, apiBaseUrl]);

  function edit(value: string) {
    revision.current += 1; setDocument(value); setPreview(null); setError("");
  }
  function clear() {
    edit(""); request.current?.abort(); request.current = null; setPending(false);
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (request.current || !document.trim()) return;
    const token = revision.current;
    const controller = new AbortController(); request.current = controller;
    setPreview(null); setError(""); setPending(true);
    const result = await previewProjectCompose({ projectId, apiBaseUrl, document, signal: controller.signal });
    if (request.current !== controller) return;
    request.current = null; setPending(false);
    if (revision.current !== token) return;
    if (result.kind === "ready") setPreview(result.preview); else setError(result.message);
  }

  return (
    <Card id="compose-preview">
      <CardHeader>
        <CardTitle><h2>Compose preview</h2></CardTitle>
        <CardDescription>Review services, networks and named volumes before using them. This preview supports Compose JSON with digest-pinned images and secret references.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <form onSubmit={submit} className="flex flex-col gap-3" aria-describedby="compose-preview-help compose-preview-status">
          <Field>
            <FieldLabel htmlFor="compose-document">Compose document (JSON)</FieldLabel>
            <Textarea id="compose-document" value={document} onChange={(event) => edit(event.target.value)} rows={8} autoComplete="off" spellCheck={false} className="font-mono" aria-describedby="compose-preview-help" />
          </Field>
          <p id="compose-preview-help" className="text-sm text-muted-foreground">Use secret references such as {"${APP_TOKEN}"}; never paste secret values. The draft stays in this page and is cleared when you leave. YAML is not supported yet.</p>
          <div className="flex flex-wrap gap-3">
            <Button type="submit" disabled={pending || !document.trim() || !apiBaseUrl}>{pending ? "Previewing..." : "Preview Compose"}</Button>
            <Button type="button" variant="outline" onClick={clear}>Clear draft</Button>
          </div>
          <p id="compose-preview-status" role={error ? "alert" : "status"} aria-live="polite" className={error ? "text-sm text-destructive" : "text-sm text-muted-foreground"}>
            {error || (pending ? "Checking the document..." : !apiBaseUrl ? "Compose preview is unavailable until the project API is configured." : "Preview only. No resources were created and no deployment was started.")}
          </p>
        </form>
        {preview ? <ComposePreviewPlan preview={preview} /> : null}
      </CardContent>
    </Card>
  );
}

function ComposePreviewPlan({ preview }: { preview: ComposePreviewV1 }) {
  return (
    <section aria-labelledby="compose-resources-heading" className="flex flex-col gap-3 text-sm">
      <h3 id="compose-resources-heading" className="font-medium">Proposed resources</h3>
      <p>{preview.services.length} services · {preview.networks.length} networks · {preview.volumes.length} volumes</p>
      <p className="text-muted-foreground">These names are proposals. Resource ownership and runtime availability have not been checked.</p>
      <dl><dt>Plan digest</dt><dd className="break-all font-mono text-xs">{preview.configDigest}</dd></dl>
      <ul aria-label="Proposed services" className="flex flex-col gap-3">
        {preview.services.map((service) => (
          <li key={service.name} className="rounded-md border p-3">
            <h4 className="font-medium">{service.name}</h4><p className="break-all font-mono text-xs">{service.image}</p>
            <p>Networks: {service.networks.join(", ")}</p>
            {service.volumes.map((mount) => <p key={mount.target}>{mount.source} → {mount.target} ({mount.readOnly ? "read only" : "read/write"})</p>)}
            {service.secretRefs.map((ref) => <p key={ref.key}>Secret reference: {ref.key} → {ref.secretRefId}</p>)}
          </li>
        ))}
      </ul>
      <ul aria-label="Proposed networks">
        {preview.networks.map((network) => <li key={network.key}><span className="font-mono text-xs">{network.runtimeName}</span> · {network.internal ? "internal" : "bridge"} · services: {network.attachedServices.join(", ") || "none"}</li>)}
      </ul>
      <ul aria-label="Proposed volumes">
        {preview.volumes.map((volume) => <li key={volume.key}><span className="font-mono text-xs">{volume.runtimeName}</span> · services: {volume.attachedServices.join(", ") || "none"}</li>)}
      </ul>
    </section>
  );
}
