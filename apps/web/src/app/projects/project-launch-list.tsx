"use client";

import Link from "next/link";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { ProjectLaunchSummary } from "./project-launch-hub";

export type ProjectLaunchListProps = {
  rows: readonly ProjectLaunchSummary[];
};

export function ProjectLaunchList({ rows }: ProjectLaunchListProps) {
  return (
    <div data-testid="project-launch-list">
      <Table data-testid="projects-launch-hub-table">
        <TableHeader>
          <TableRow>
            <TableHead>Name</TableHead>
            <TableHead>Repository</TableHead>
            <TableHead>Branch</TableHead>
            <TableHead>Runtime</TableHead>
            <TableHead>Latest</TableHead>
            <TableHead>Next step</TableHead>
            <TableHead className="text-right">Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <LaunchHubRow key={row.project.id} row={row} />
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function LaunchHubRow({ row }: { row: ProjectLaunchSummary }) {
  return (
    <TableRow data-testid="project-launch-row" data-project-id={row.project.id}>
      <TableCell className="font-medium">
        <Link href={`/projects/${row.project.id}`} className="hover:underline">
          {row.project.name}
        </Link>
      </TableCell>
      <TableCell className="font-mono text-xs">{row.project.repoUrl}</TableCell>
      <TableCell><Badge variant="outline">{row.project.defaultBranch}</Badge></TableCell>
      <TableCell data-testid="project-launch-runtime">
        <div className="flex flex-col gap-1">
          <Badge variant={row.runtime.configured ? "secondary" : "destructive"} data-testid="project-launch-runtime-badge">
            {row.runtime.label}
          </Badge>
          <span className="text-xs text-muted-foreground">{row.runtime.detail}</span>
        </div>
      </TableCell>
      <TableCell data-testid="project-launch-latest">
        <div className="flex flex-col gap-1">
          <Badge variant={latestStatusVariant(row.latest.statusTone)} data-testid="project-launch-latest-badge">
            {row.latest.statusLabel}
          </Badge>
          {row.latest.deployment ? (
            <span className="font-mono text-xs text-muted-foreground" data-testid="project-launch-latest-id">
              {row.latest.deployment.id}
            </span>
          ) : (
            <span className="text-xs text-muted-foreground">No deployments yet</span>
          )}
        </div>
      </TableCell>
      <TableCell data-testid="project-launch-next-action" className="text-sm">{row.nextAction.label}</TableCell>
      <TableCell className="text-right">
        <div className="flex flex-wrap justify-end gap-2" data-testid="project-launch-actions">
          <Link href={row.configureHref}>
            <Button size="sm" variant="outline" data-testid="project-launch-cta-configure" aria-label={`Configure runtime for ${row.project.name}`}>Configure</Button>
          </Link>
          <Link href={row.deployHref}>
            <Button size="sm" variant="outline" data-testid="project-launch-cta-deploy" aria-label={`Open deploy panel for ${row.project.name}`}>Deploy</Button>
          </Link>
          {row.logsHref ? (
            <Link href={row.logsHref}>
              <Button size="sm" data-testid="project-launch-cta-logs" aria-label={`Open latest deployment logs for ${row.project.name}`}>Logs</Button>
            </Link>
          ) : null}
        </div>
      </TableCell>
    </TableRow>
  );
}

function latestStatusVariant(tone: ProjectLaunchSummary["latest"]["statusTone"]): "default" | "secondary" | "destructive" | "outline" {
  if (tone === "ready") return "secondary";
  if (tone === "attention") return "destructive";
  if (tone === "active") return "default";
  return "outline";
}
