"use client";

import { useRouter } from "next/navigation";
import { Check, FolderPlus, Upload } from "lucide-react";
import { useState } from "react";

function GithubMark({ className }: { className?: string }) {
  return <svg aria-hidden="true" className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M15 22v-4a4.8 4.8 0 0 0-1-3.5c3 0 6-1.5 6-6.5a5 5 0 0 0-1-3.5 4.5 4.5 0 0 0-.1-3.5s-1.1-.3-3.9 1.5a13.4 13.4 0 0 0-7 0C5.2.7 4.1 1 4.1 1A4.5 4.5 0 0 0 4 4.5a5 5 0 0 0-1 3.5c0 5 3 6.5 6 6.5a4.8 4.8 0 0 0-1 3.5v4" /><path d="M8 22v-3" /></svg>;
}

const sources = [
  { id: "github", title: "Repositorio Git", detail: "Conecta un repositorio y despliega una rama o tag.", icon: GithubMark },
  { id: "docker", title: "Imagen Docker", detail: "Usa una imagen Docker desde Docker Hub o tu registry.", icon: FolderPlus },
  { id: "artifact", title: "Subir Artefacto", detail: "Sube un .zip o .tar.gz de tu aplicación compilada.", icon: Upload }
] as const;

export function DeploymentSourceSelector() {
  const router = useRouter();
  const [source, setSource] = useState("github");

  return (
    <main className="deployment-wizard min-h-screen bg-background p-[18px] text-foreground sm:p-[18px]">
      <section className="deployment-wizard__card mx-auto flex min-h-[604px] w-full max-w-[1404px] flex-col rounded-[10px] border bg-card">
        <nav className="deployment-wizard__steps border-b px-10" aria-label="Pasos del despliegue">
          {(["Seleccionar", "Configurar", "Revisar", "Desplegar"] as const).map((label, index) => (
            <div className="deployment-wizard__step" key={label}>
              <span className={index === 0 ? "deployment-wizard__step-number deployment-wizard__step-number--active" : "deployment-wizard__step-number"}>{index === 0 ? <Check aria-hidden="true" /> : index + 1}</span>
              <span className="deployment-wizard__step-label">{label}</span>
            </div>
          ))}
        </nav>

        <div className="deployment-wizard__body flex flex-1 flex-col">
          <h1 className="deployment-wizard__title">Selecciona qué quieres desplegar</h1>
          <fieldset className="deployment-wizard__sources" aria-describedby="deployment-source-description">
            <legend id="deployment-source-description" className="sr-only">Selecciona una fuente para el despliegue</legend>
            {sources.map(({ id, title, detail, icon: Icon }, index) => (
              <label className={`deployment-wizard__source ${source === id ? "deployment-wizard__source--selected" : ""}`} key={id}>
                <input className="sr-only" type="radio" name="deployment-source" value={id} checked={source === id} onChange={() => setSource(id)} onKeyDown={(event) => {
                  if (event.key !== "ArrowRight" && event.key !== "ArrowDown" && event.key !== "ArrowLeft" && event.key !== "ArrowUp") return;
                  event.preventDefault();
                  const direction = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : -1;
                  const next = sources[(index + direction + sources.length) % sources.length]!;
                  setSource(next.id);
                  document.querySelector<HTMLInputElement>(`input[name="deployment-source"][value="${next.id}"]`)?.focus();
                }} />
                <Icon aria-hidden="true" className="deployment-wizard__source-icon" />
                <span className="deployment-wizard__source-copy"><strong>{title}</strong><span>{detail}</span></span>
                <span className="deployment-wizard__radio" aria-hidden="true" />
              </label>
            ))}
          </fieldset>

          <aside className="deployment-wizard__context" aria-labelledby="deployment-next-title">
            <h2 id="deployment-next-title">Lo que ocurrirá después</h2>
            <p><Check aria-hidden="true" /> <span className="deployment-wizard__context-copy--desktop">Conectaremos tu fuente, detectaremos la configuración y prepararemos el build.</span><span className="deployment-wizard__context-copy--mobile">Conecta tu fuente y prepara el build.</span></p>
            <p><Check aria-hidden="true" /> <span className="deployment-wizard__context-copy--desktop">Puedes cambiar estos datos antes del despliegue.</span><span className="deployment-wizard__context-copy--mobile">Podrás editar los datos antes de continuar.</span></p>
          </aside>
        </div>

        <footer className="deployment-wizard__footer">
          <button type="button" className="deployment-wizard__cancel" onClick={() => router.push("/deployments")}>Cancelar</button>
          <button type="button" className="deployment-wizard__next" onClick={() => router.push(`/deployments/new/configure?source=${source}`)}>Siguiente</button>
        </footer>
      </section>
    </main>
  );
}
