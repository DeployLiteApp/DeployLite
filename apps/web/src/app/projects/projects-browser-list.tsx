import Link from "next/link";
import { ChevronRight, Folder } from "lucide-react";
import type { ProjectLaunchSummary } from "./project-launch-hub";

export function ProjectsBrowserList({ rows }: { rows: readonly ProjectLaunchSummary[] }) {
  return <div className="flex w-full flex-col gap-4 md:w-[1130px] md:-ml-1.5 md:gap-4 dark:md:ml-0" data-testid="projects-browser-list">
    {rows.map((row) => <article key={row.project.id} data-testid="projects-browser-row" data-project-id={row.project.id} className="group flex min-h-[62px] items-center rounded-lg border border-[#e4e4e7] bg-white px-4 transition-colors hover:border-[#cbd5e1] dark:border-[#27272a] dark:bg-[#18181b] dark:hover:border-[#3f3f46] md:h-[68px] md:px-4">
      <Folder aria-hidden="true" className="size-4 shrink-0 text-[#2563eb]" strokeWidth={1.8} />
      <Link href={`/projects/${row.project.id}`} aria-label={`${row.project.name}. ${row.runtime.detail}. Latest deployment: ${row.latest.statusLabel}. Next action: ${row.nextAction.label}.`} className="ml-4 min-w-0 flex-1 rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#2563eb]/50">
        <span className="block truncate text-[15px] font-semibold leading-5 text-foreground">{row.project.name}</span>
        <span className="block truncate text-xs leading-5 text-muted-foreground">{row.project.repoUrl} · {row.project.defaultBranch}</span>
        <span className="sr-only">Runtime: {row.runtime.detail}. Latest deployment: {row.latest.statusLabel}. Next action: {row.nextAction.label}.</span>
      </Link>
      <ChevronRight aria-hidden="true" className="ml-3 size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" strokeWidth={1.8} />
    </article>)}
  </div>;
}
