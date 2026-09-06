import { loadRequestAuthSession } from "@/lib/server-auth";
import { loadRequestDashboardMetadata } from "@/lib/server-auth";
import Link from "next/link";
import { ConfigureDeploymentForm } from "./configure-form";

export const dynamic = "force-dynamic";

export default async function ConfigureDeploymentPage({ searchParams }: { searchParams: Promise<{ source?: string }> }) {
  const auth = await loadRequestAuthSession();
  if (auth.kind !== "authenticated") return <main className="mx-auto flex min-h-screen max-w-3xl items-center p-6"><Link href="/">Sign in required</Link></main>;
  const source = (await searchParams).source;
  const metadata = source === "github" ? await loadRequestDashboardMetadata() : null;
  const agents = metadata?.kind === "ready" ? metadata.data.agents : [];
  return (
    <main className="deployment-wizard min-h-screen bg-background p-[18px] text-foreground">
      <section className="deployment-wizard__card mx-auto flex min-h-[604px] w-full max-w-[1404px] flex-col rounded-[10px] border bg-card">
        {source === "github" ? <ConfigureDeploymentForm agents={agents} metadataReady={metadata?.kind === "ready"} /> : <div className="deployment-configure__unsupported"><h1>Fuente no válida</h1><p>Solo se puede configurar un repositorio Git en esta pantalla.</p><Link href="/deployments/new">Volver</Link></div>}
      </section>
    </main>
  );
}
