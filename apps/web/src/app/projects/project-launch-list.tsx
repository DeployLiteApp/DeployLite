"use client";

import Link from "next/link";
import { useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { filterProjectLaunchSummaries, parseProjectRuntimeFilter, parseProjectStatusFilter, PROJECT_RUNTIME_FILTER_OPTIONS, PROJECT_STATUS_FILTER_OPTIONS, type ProjectListFilterCriteria } from "./project-list-filters";
import type { ProjectLaunchSummary } from "./project-launch-hub";

export type ProjectLaunchListProps = {
  rows: readonly ProjectLaunchSummary[];
};

export function getProjectListFilterFeedback(displayedCount: number, totalCount: number): string {
  const summary = `Showing ${displayedCount} of ${totalCount} loaded projects.`;
  return displayedCount === 0 ? `${summary} No matching projects. Adjust the filters to see loaded projects.` : summary;
}

export function ProjectLaunchList({ rows }: ProjectLaunchListProps) {
  const [criteria, setCriteria] = useState<ProjectListFilterCriteria>({ query: "", status: "all", runtime: "all" });
  const visibleRows = filterProjectLaunchSummaries(rows, criteria);

  return (
    <div className="flex flex-col gap-4" data-testid="project-launch-list">
      <fieldset className="grid gap-4 rounded-lg border border-border/60 p-4 md:grid-cols-[minmax(0,2fr)_minmax(12rem,1fr)_minmax(12rem,1fr)]">
        <legend className="sr-only">Filter loaded projects</legend>
        <div className="flex flex-col gap-2">
          <Label htmlFor="project-list-query">Search projects</Label>
          <Input id="project-list-query" name="query" type="search" placeholder="Name, repository, or branch" value={criteria.query} aria-controls="project-launch-list-results" onChange={(event) => setCriteria((current) => ({ ...current, query: event.target.value }))} />
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="project-list-status">Deployment status</Label>
          <select id="project-list-status" name="status" value={criteria.status} aria-controls="project-launch-list-results" className="h-8 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30" onChange={(event) => setCriteria((current) => ({ ...current, status: parseProjectStatusFilter(event.target.value) }))}>
            {PROJECT_STATUS_FILTER_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="project-list-runtime">Runtime readiness</Label>
          <select id="project-list-runtime" name="runtime" value={criteria.runtime} aria-controls="project-launch-list-results" className="h-8 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30" onChange={(event) => setCriteria((current) => ({ ...current, runtime: parseProjectRuntimeFilter(event.target.value) }))}>
            {PROJECT_RUNTIME_FILTER_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
        </div>
      </fieldset>
      <div data-testid="project-launch-filter-feedback" role="status" aria-live="polite" aria-atomic="true" className="text-sm text-muted-foreground">{getProjectListFilterFeedback(visibleRows.length, rows.length)}</div>
      <div id="project-launch-list-results">
      {visibleRows.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border p-6 text-center" data-testid="project-launch-filter-empty"><p className="font-medium">No matching projects.</p><p className="mt-1 text-sm text-muted-foreground">Try adjusting the search, status, or runtime filters.</p></div>
      ) : <Table data-testid="projects-launch-hub-table">
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
            {visibleRows.map((row) => (
            <LaunchHubRow key={row.project.id} row={row} />
          ))}
        </TableBody>
      </Table>}
      </div>
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
