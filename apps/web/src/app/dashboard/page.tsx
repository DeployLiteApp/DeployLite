import Link from "next/link";
import { CheckCircle2, CircleAlert, Clock3, XCircle } from "lucide-react";
import React from "react";
import { formatBytes } from "../../lib/scaffold-shell";
import { formatRelativeTime, getDashboardActivity, getDashboardMetrics, summarizeDashboardStatuses } from "./dashboard-view-model";
import { loadRequestAuthSession, loadRequestDashboardMetadata } from "../../lib/server-auth";
import { AppShell } from "@/components/app-shell";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const auth = await loadRequestAuthSession();

  if (auth.kind !== "authenticated") {
    return (
      <main className="mx-auto flex min-h-screen w-full max-w-3xl items-center px-6 py-12">
        <Card className="w-full">
          <CardHeader>
            <CardTitle>Sign in required</CardTitle>
            <CardDescription>The dashboard needs a valid local API session before metadata can be loaded.</CardDescription>
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
            <CardTitle>Unable to load platform data</CardTitle>
            <CardDescription>Reason: {metadata.reason}</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <Alert variant="destructive">
              <AlertTitle>API rejected the dashboard request</AlertTitle>
              <AlertDescription>Retry after the local API is running and the session is valid. Do not start Docker, VPS, Dokploy, Traefik, ACME, DNS, domain, or deployment work for this state.</AlertDescription>
            </Alert>
            <Link href="/dashboard">
              <Button>Retry dashboard</Button>
            </Link>
          </CardContent>
        </Card>
      </AppShell>
    );
  }

  const { agents, deployments, projects } = metadata.data;
  const agent = agents[0];
  const resources = agent?.resourceSnapshot;
  const metrics = getDashboardMetrics(projects, deployments, agents);
  const activity = getDashboardActivity(deployments, projects);
  const statusSummary = summarizeDashboardStatuses(deployments);
  const statusIcons = { succeeded: CheckCircle2, failed: CircleAlert, running: Clock3, queued: Clock3, canceled: XCircle };

  return (
    <AppShell compactMobile email={auth.user.email}>
      <div className="mx-auto flex w-full flex-col px-1 md:w-[1138px] md:max-w-none md:px-0">
        <div>
          <h1 className="text-[28px] font-bold leading-9 tracking-[-0.03em] md:relative md:top-[6px]">Overview</h1>
          <p className="sr-only">Authenticated platform data · request {metadata.requestId}</p>
          <p className="sr-only">Signed in as {auth.user.email}. Deployment execution, VPS, Dokploy, Docker socket, Traefik, ACME, DNS, and domain work remain intentionally out of scope for this local MVP screen.</p>
        </div>

        <section aria-label="Platform metrics" className="mt-[42px] grid grid-cols-[159px_159px] gap-x-3 gap-y-[18px] dark:mt-[45px] md:mt-[11px] md:grid-cols-[repeat(4,258px)] md:gap-6 dark:md:mt-[14px]">
          {metrics.map(({ label, value }) => <Card className="h-[94px] gap-0 rounded-[8px] border border-[#e4e4e7] bg-white p-4 ring-1 ring-[#e4e4e7] dark:border-[#27272a] dark:bg-[#18181b] dark:ring-[#27272a] md:h-[118px] md:p-5" key={label}>
            <p className="text-xs text-muted-foreground md:text-sm">{label}</p>
            <p className="mt-4 text-[28px] font-semibold leading-8 tabular-nums">{value ?? "—"}</p>
            {value === null ? <p className="sr-only">Not available: environment data is not included in the dashboard API response.</p> : null}
          </Card>)}
        </section>

        <div className="mt-[38px] grid gap-6 md:mt-[30px] md:grid-cols-[650px_460px] md:gap-7">
          <Card className="min-h-[232px] rounded-[8px] border border-[#e4e4e7] bg-white p-4 ring-1 ring-[#e4e4e7] dark:border-[#27272a] dark:bg-[#18181b] dark:ring-[#27272a] md:h-[402px] md:min-h-0 md:p-6">
            <div className="flex items-center justify-between">
              <h2 className="text-base font-medium">Recent activity</h2>
              <Link className="text-[13px] font-medium text-primary hover:underline" href="/deployments">View all</Link>
            </div>
            {activity.length === 0 ? <p className="mt-10 text-sm text-muted-foreground">No deployment activity is available yet.</p> : <ul className="mt-5" aria-label="Recent deployment activity">
              {activity.map(({ id, projectName, status, startedAt }, index) => { const Icon = statusIcons[status]; return <li className={`flex min-h-[48px] items-center gap-3 border-b border-[#e4e4e7] last:border-0 dark:border-[#27272a] md:min-h-[61px] md:gap-4 ${index > 2 ? "hidden md:flex" : ""}`} key={id}>
                <span className="flex size-[30px] shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground"><Icon aria-hidden="true" className="size-4" /></span>
                <div className="min-w-0 flex-1"><Link className="block truncate text-[13px] font-semibold hover:underline" href={`/deployments/${id}`}>{projectName}</Link><span className="text-xs text-muted-foreground">Deployment {id} · {status}</span></div>
                <time className="shrink-0 text-xs text-muted-foreground" dateTime={startedAt}>{formatRelativeTime(startedAt)}</time>
              </li>; })}
            </ul>}
          </Card>

          <div className="hidden flex-col gap-[26px] md:flex">
            <Card className="h-[190px] min-h-0 rounded-[8px] border border-[#e4e4e7] bg-white p-6 ring-1 ring-[#e4e4e7] dark:border-[#27272a] dark:bg-[#18181b] dark:ring-[#27272a]">
              <h2 className="text-base font-medium">Deployment status</h2>
              <ul aria-label="Deployment status counts" className="mt-6 grid grid-cols-2 gap-x-6 gap-y-4">
                {statusSummary.map(({ label, count, tone }) => <li className="flex items-center justify-between text-sm" key={label}><span className="flex items-center gap-2"><span className={`size-2 rounded-full ${tone === "success" ? "bg-emerald-500" : tone === "danger" ? "bg-red-500" : tone === "info" ? "bg-blue-500" : "bg-amber-500"}`} aria-hidden="true" />{label}</span><strong className="tabular-nums">{count}</strong></li>)}
              </ul>
            </Card>
            <Card className="h-[186px] min-h-0 rounded-[8px] border border-[#e4e4e7] bg-white p-6 ring-1 ring-[#e4e4e7] dark:border-[#27272a] dark:bg-[#18181b] dark:ring-[#27272a]">
              <h2 className="text-base font-medium">Resources</h2>
              {resources ? <><p className="mt-2 text-xs text-muted-foreground">{agent?.name} · {agent?.status}</p><div className="mt-5 grid grid-cols-3 gap-4 text-xs text-muted-foreground">
                <ResourceStat label="CPU" value={`${Math.round(resources.cpuLoad * 100)}%`} />
                <ResourceStat label="Memory" value={`${formatBytes(resources.memoryUsedBytes)} / ${formatBytes(resources.memoryTotalBytes)}`} />
                <ResourceStat label="Disk" value={`${formatBytes(resources.diskUsedBytes)} / ${formatBytes(resources.diskTotalBytes)}`} />
              </div></> : <p className="mt-6 text-sm text-muted-foreground">Not available: no agent heartbeat telemetry was provided.</p>}
            </Card>
          </div>
          <details className="rounded-[8px] border border-[#e4e4e7] bg-white ring-1 ring-[#e4e4e7] dark:border-[#27272a] dark:bg-[#18181b] dark:ring-[#27272a] md:hidden">
            <summary className="cursor-pointer list-none p-4 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#2563eb]/50">Deployment details</summary>
            <div className="flex flex-col gap-6 border-t border-[#e4e4e7] p-4 dark:border-[#27272a]">
              <section aria-label="Deployment status">
                <h2 className="text-base font-medium">Deployment status</h2>
                <ul aria-label="Deployment status counts" className="mt-4 grid grid-cols-2 gap-x-6 gap-y-4">
                  {statusSummary.map(({ label, count, tone }) => <li className="flex items-center justify-between text-sm" key={label}><span className="flex items-center gap-2"><span className={`size-2 rounded-full ${tone === "success" ? "bg-emerald-500" : tone === "danger" ? "bg-red-500" : tone === "info" ? "bg-blue-500" : "bg-amber-500"}`} aria-hidden="true" />{label}</span><strong className="tabular-nums">{count}</strong></li>)}
                </ul>
              </section>
              <section aria-label="Resources">
                <h2 className="text-base font-medium">Resources</h2>
                {resources ? <><p className="mt-2 text-xs text-muted-foreground">{agent?.name} · {agent?.status}</p><div className="mt-5 grid grid-cols-3 gap-4 text-xs text-muted-foreground"><ResourceStat label="CPU" value={`${Math.round(resources.cpuLoad * 100)}%`} /><ResourceStat label="Memory" value={`${formatBytes(resources.memoryUsedBytes)} / ${formatBytes(resources.memoryTotalBytes)}`} /><ResourceStat label="Disk" value={`${formatBytes(resources.diskUsedBytes)} / ${formatBytes(resources.diskTotalBytes)}`} /></div></> : <p className="mt-6 text-sm text-muted-foreground">Not available: no agent heartbeat telemetry was provided.</p>}
              </section>
            </div>
          </details>
        </div>
      </div>
    </AppShell>
  );
}

function ResourceStat({ label, value }: { label: string; value: string }) {
  return <div><p>{label}</p><p className="mt-2 font-medium tabular-nums text-foreground">{value}</p></div>;
}
