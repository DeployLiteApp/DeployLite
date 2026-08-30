import Link from "next/link";
import { loadRequestAuthSession, loadRequestDashboardMetadata } from "@/lib/server-auth";
import { AppShell } from "@/components/app-shell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ProjectLaunchList } from "./project-launch-list";
import { summarizeProjectLaunch } from "./project-launch-hub";

export const dynamic = "force-dynamic";

export default async function ProjectsPage() {
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
  const launchHubRows = projects.map((project) => summarizeProjectLaunch(project, deployments));
  const readyCount = launchHubRows.filter((row) => row.nextAction.ctaKey === "inspect-latest-logs").length;

  return (
    <AppShell email={auth.user.email}>
      <div className="flex flex-col gap-6">
        <div className="flex items-center justify-between">
          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-2">
              <h1 className="text-2xl font-semibold tracking-tight">Projects</h1>
              <Badge variant="secondary" data-testid="projects-launch-hub-badge">Launch hub</Badge>
            </div>
            <p className="text-sm text-muted-foreground">
              Review each project&apos;s runtime readiness, latest deployment status, and jump to the next action to keep launches moving.
            </p>
          </div>
          <Link href="/projects/new">
            <Button>New project</Button>
          </Link>
        </div>

        {projects.length === 0 ? (
          <Card>
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
          <Card>
            <CardHeader>
              <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                <div>
                  <CardTitle>All projects</CardTitle>
                  <CardDescription>
                    {projects.length} configured · {readyCount} with a latest deployment to inspect
                  </CardDescription>
                </div>
                <Badge variant="outline" data-testid="projects-launch-hub-summary">
                  {readyCount}/{projects.length} launchable
                </Badge>
              </div>
            </CardHeader>
            <CardContent>
              <ProjectLaunchList rows={launchHubRows} />
            </CardContent>
          </Card>
        )}
      </div>
    </AppShell>
  );
}
