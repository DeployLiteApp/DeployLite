"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import type { Agent } from "@deploylite/contracts";

export type ConfigureDraft = { repoUrl: string; branch: string; agentId: string };

export function validateConfigureDraft(draft: ConfigureDraft, agents: Agent[]): string | null {
  try { const url = new URL(draft.repoUrl); if (!(["http:", "https:"].includes(url.protocol) && url.hostname)) return "Repositorio no válido."; } catch { return "Repositorio no válido."; }
  if (!/^[^\s/]+(?:\/[^\s/]+)*$/.test(draft.branch.trim())) return "La rama o tag es obligatorio.";
  const agent = agents.find((item) => item.id === draft.agentId);
  if (!agent || agent.status !== "online") return "Selecciona un servidor permitido y disponible.";
  return null;
}

export function ConfigureDeploymentForm({ agents, metadataReady }: { agents: Agent[]; metadataReady: boolean }) {
  const router = useRouter();
  const [status, setStatus] = useState<"idle" | "error" | "validated">("idle");
  const [message, setMessage] = useState("");
  const [reviewDraft, setReviewDraft] = useState<ConfigureDraft | null>(null);
  const selectedAgent = agents.find((agent) => agent.id === reviewDraft?.agentId);
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const draft = { repoUrl: String(form.get("repoUrl") ?? "").trim(), branch: String(form.get("branch") ?? "").trim(), agentId: String(form.get("agentId") ?? "") };
    const error = !metadataReady ? "No se pudo comprobar la lista de servidores permitidos." : validateConfigureDraft(draft, agents);
    setStatus(error ? "error" : "validated");
    setMessage(error ?? "Configuración validada. No se ha creado ningún deployment.");
    setReviewDraft(error ? null : draft);
  }
  return <>
    <nav className="deployment-wizard__steps border-b px-10" aria-label="Pasos del despliegue">
      {["Seleccionar", "Configurar", "Revisar", "Desplegar"].map((label, index) => <div className="deployment-wizard__step" key={label}><span className={`deployment-wizard__step-number ${index < (reviewDraft ? 3 : 2) ? "deployment-wizard__step-number--active" : ""}`}>{index < (reviewDraft ? 3 : 2) ? "✓" : index + 1}</span><span className="deployment-wizard__step-label">{label}</span></div>)}
    </nav>
    <div hidden={Boolean(reviewDraft)} className="deployment-wizard__body deployment-configure__body flex flex-1 flex-col">
      <h1 className="deployment-wizard__title">Configura el deployment</h1>
      <form id="deployment-configure-form" className="deployment-configure__form" onSubmit={submit} noValidate aria-describedby="deployment-configure-status">
        <label htmlFor="deployment-repository">Repositorio</label><input id="deployment-repository" name="repoUrl" type="url" placeholder="https://github.com/organización/repositorio" aria-invalid={status === "error"} required />
        <label htmlFor="deployment-branch">Rama / tag</label><input id="deployment-branch" name="branch" defaultValue="main" placeholder="main" aria-invalid={status === "error"} required />
        <label htmlFor="deployment-server">Servidor</label><select id="deployment-server" name="agentId" defaultValue="" aria-invalid={status === "error"} required><option value="" disabled>Selecciona un servidor</option>{agents.filter((agent) => agent.status === "online").map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}</select>
        <aside className="deployment-configure__context" aria-labelledby="deployment-configure-context-title"><h2 id="deployment-configure-context-title">Configuración validada</h2><p>La rama y el servidor se comprobarán antes de crear el deployment.</p><p>Las variables no se configuran en esta pantalla.</p></aside>
        <p id="deployment-configure-status" className={`deployment-configure__status deployment-configure__status--${status}`} role={status === "error" ? "alert" : "status"} aria-live="polite">{message}</p>
      </form>
    </div>
    {reviewDraft ? <div className="deployment-wizard__body deployment-configure__review flex flex-1 flex-col"><h1 className="deployment-wizard__title">Revisa antes de desplegar</h1><dl className="deployment-configure__summary"><dt>Método</dt><dd>Repositorio Git</dd><dt>Repositorio</dt><dd>{reviewDraft.repoUrl}</dd><dt>Rama</dt><dd>{reviewDraft.branch}</dd><dt>Servidor</dt><dd>{selectedAgent?.name}</dd></dl><aside className="deployment-configure__context" aria-labelledby="deployment-review-context-title"><h2 id="deployment-review-context-title">Comprobaciones previas</h2><p>Validaremos acceso al repositorio, el servidor y la configuración elegida.</p><p>Nada se desplegará hasta que confirmes este paso.</p></aside><p id="deployment-unavailable-explanation" className="sr-only">El despliegue desde Git aún no está disponible. No se ha iniciado ningún despliegue.</p></div> : null}
    <footer className="deployment-wizard__footer">{reviewDraft ? <><button type="button" className="deployment-wizard__cancel" onClick={() => setReviewDraft(null)}>Volver</button><button type="button" className="deployment-configure__validate" disabled>Desplegar</button></> : <><button type="button" className="deployment-wizard__cancel" onClick={() => router.push("/deployments/new")}>Cancelar</button><button type="submit" form="deployment-configure-form" className="deployment-configure__validate" onClick={(event) => { const form = event.currentTarget.form; if (form) form.requestSubmit(); }}>Validar</button></>}</footer>
  </>;
}
