import Link from "next/link";
import { loadRequestAuthSession, loadRequestDashboardMetadata } from "@/lib/server-auth";
import { AppShell } from "@/components/app-shell";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ProjectsBrowserList } from "./projects-browser-list";
import { ProjectLaunchList } from "./project-launch-list";
import { orderProjectLaunchSummaries, summarizeProjectLaunch } from "./project-launch-hub";
import { filterProjectLaunchSummaries } from "./project-list-filters";

export const dynamic = "force-dynamic";

type ProjectsPageProps = { searchParams?: Promise<{ query?: string | string[] }> };

export default async function ProjectsPage({ searchParams }: ProjectsPageProps) {
  const auth = await loadRequestAuthSession();
  if (auth.kind !== "authenticated") {
    return (
      <main className="mx-auto flex min-h-screen w-full max-w-3xl items-center px-6 py-12">
        <Card className="w-full">
          <CardHeader>
            <CardTitle>Sign in required</CardTitle>
            <CardDescription>Sign in to manage projects.</CardDescription>
          </CardHeader>
          <CardContent>
            <Link href="/">
              <Button>Return to sign in</Button>
            </Link>
          </CardContent>
        </Card>
      </main>
    );
  }

  const metadata = await loadRequestDashboardMetadata();
  if (metadata.kind === "error") {
    return (
      <AppShell email={auth.user.email}>
        <Card>
          <CardHeader>
            <CardTitle>Unable to load projects</CardTitle>
            <CardDescription>Reason: {metadata.reason}</CardDescription>
          </CardHeader>
        </Card>
      </AppShell>
    );
  }

  const { projects, deployments } = metadata.data;
  const queryValue = (await searchParams)?.query;
  const query = Array.isArray(queryValue) ? queryValue[0] ?? "" : queryValue ?? "";
  const allRows = orderProjectLaunchSummaries(projects.map((project) => summarizeProjectLaunch(project, deployments)));
  const launchHubRows = filterProjectLaunchSummaries(allRows, { query, status: "all", runtime: "all" });
  const readyCount = launchHubRows.filter((row) => row.nextAction.ctaKey === "inspect-latest-logs").length;
  return (
    <AppShell email={auth.user.email}>
      <div className="mx-auto flex max-w-[1132px] flex-col gap-[20.5px] md:gap-[18px]">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="mt-0 text-[27px] font-bold leading-8 tracking-[-0.03em] md:mt-1.5 md:text-[28px] md:leading-9">Projects</h1>
            <p className="mt-1 text-[13px] text-muted-foreground md:hidden">Tus servicios</p>
          </div>
          <Link href="/projects/new"><Button className="h-9 w-[118px] justify-center rounded-md bg-[#2563eb] px-0 text-xs text-white hover:bg-[#1d4ed8]">+ Nuevo proyecto</Button></Link>
        </div>

        {projects.length === 0 ? (
          <Card data-testid="projects-browser-empty">
            <CardHeader>
              <CardTitle>No projects yet</CardTitle>
              <CardDescription>Create your first project to start the deploy flow.</CardDescription>
            </CardHeader>
            <CardContent>
              <Link href="/projects/new">
                <Button>Create project</Button>
              </Link>
            </CardContent>
          </Card>
        ) : (
          <><ProjectsBrowserList rows={launchHubRows} /><details className="sr-only"><summary>Deployment readiness details</summary><span data-testid="projects-launch-hub-badge">Launch hub</span><span>All projects</span><span data-testid="projects-launch-hub-summary">{readyCount}/{projects.length} launchable</span><ProjectLaunchList rows={launchHubRows} /></details></>
        )}
      </div>
    </AppShell>
  );
}
