import Link from "next/link";
import { loadRequestAuthSession } from "@/lib/server-auth";
import { DeploymentSourceSelector } from "./deployment-source-selector";

export const dynamic = "force-dynamic";

export default async function NewDeploymentPage() {
  const auth = await loadRequestAuthSession();
  if (auth.kind !== "authenticated") {
    return (
      <main className="deployment-wizard-auth mx-auto flex min-h-screen w-full max-w-3xl items-center px-6 py-12">
        <div className="w-full rounded-xl border bg-card p-6 text-card-foreground">
          <h1 className="text-lg font-semibold">Sign in required</h1>
          <p className="mt-2 text-sm text-muted-foreground">Sign in before starting a deployment.</p>
          <Link href="/" className="mt-6 inline-flex h-9 items-center rounded-lg bg-primary px-3 text-sm font-medium text-primary-foreground">Return to sign in</Link>
        </div>
      </main>
    );
  }

  return <DeploymentSourceSelector />;
}
