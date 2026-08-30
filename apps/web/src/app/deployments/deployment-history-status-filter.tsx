"use client";

import type { Deployment } from "@deploylite/contracts";
import Link from "next/link";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { deploymentStatusFilterOptions, filterDeploymentsByStatus, type DeploymentStatusFilter } from "./deployment-history-status-filter-model";

export function DeploymentHistoryStatusFilter({ deployments }: { deployments: readonly Deployment[] }) {
  const [selectedStatus, setSelectedStatus] = useState<DeploymentStatusFilter>("all");
  const filteredDeployments = filterDeploymentsByStatus(deployments, selectedStatus);
  const resultCount = `${filteredDeployments.length} deployment record${filteredDeployments.length === 1 ? "" : "s"}`;
  const resultCopy = selectedStatus === "all" ? `Showing ${resultCount}.` : `Showing ${resultCount} with status ${selectedStatus}.`;

  return (
    <div className="flex flex-col gap-4" data-testid="deployment-history-status-filter">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="flex flex-col gap-2">
          <label className="text-sm font-medium" htmlFor="deployment-status-filter">Filter by status</label>
          <select className="h-9 rounded-md border border-input bg-background px-3 text-sm" id="deployment-status-filter" value={selectedStatus} onChange={(event) => setSelectedStatus(event.target.value as DeploymentStatusFilter)}>
            {deploymentStatusFilterOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
        </div>
        <Button type="button" variant="outline" disabled={selectedStatus === "all"} onClick={() => setSelectedStatus("all")}>Show all statuses</Button>
      </div>
      <p id="deployment-status-result-count" aria-live="polite" aria-atomic="true" className="text-sm text-muted-foreground">{resultCopy}</p>
      {filteredDeployments.length === 0 ? (
        <div className="rounded-md border border-dashed p-6" data-testid="deployment-filter-no-match" role="status">
          <p className="font-medium">No deployments match the selected status.</p>
          <p className="text-sm text-muted-foreground">Use Show all statuses to reset the filter and view the loaded history.</p>
        </div>
      ) : (
        <Table><TableHeader><TableRow><TableHead>ID</TableHead><TableHead>Project</TableHead><TableHead>Status</TableHead><TableHead>Commit</TableHead><TableHead>Started</TableHead><TableHead>Finished</TableHead><TableHead></TableHead></TableRow></TableHeader><TableBody>
          {filteredDeployments.map((deployment) => <TableRow key={deployment.id}>
            <TableCell className="font-mono text-xs">{deployment.id}</TableCell><TableCell className="font-mono text-xs">{deployment.projectId}</TableCell>
            <TableCell><Badge variant={statusVariant(deployment.status)}>{deployment.status}</Badge></TableCell><TableCell className="font-mono text-xs">{deployment.commitSha}</TableCell>
            <TableCell className="text-xs text-muted-foreground">{new Date(deployment.startedAt).toLocaleString()}</TableCell><TableCell className="text-xs text-muted-foreground">{deployment.finishedAt ? new Date(deployment.finishedAt).toLocaleString() : "—"}</TableCell>
            <TableCell><Link href={`/deployments/${deployment.id}`}><Button size="sm" variant="outline">Logs</Button></Link></TableCell>
          </TableRow>)}
        </TableBody></Table>
      )}
    </div>
  );
}

function statusVariant(status: Deployment["status"]): "default" | "secondary" | "destructive" | "outline" {
  if (status === "succeeded") return "secondary";
  if (status === "failed" || status === "canceled") return "destructive";
  if (status === "running" || status === "queued") return "default";
  return "outline";
}
