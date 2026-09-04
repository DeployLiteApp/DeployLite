import Link from "next/link";
import type { ReactNode } from "react";
import { LogoutButton } from "@/app/auth-controls";
import { getAuthApiBaseUrl } from "@/lib/auth-boundary";

type AppShellProps = {
  email: string;
  children: ReactNode;
};

type NavItem = { href: string; label: string };

const navItems: NavItem[] = [
  { href: "/dashboard", label: "Dashboard" },
  { href: "/projects", label: "Projects" },
  { href: "/deployments", label: "Deployments" }
];

export function AppShell({ email, children }: AppShellProps) {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="border-b">
        <div className="mx-auto flex w-full max-w-6xl items-center justify-between gap-2 px-4 py-3 sm:gap-4 sm:px-6">
          <div className="flex min-w-0 items-center gap-4 sm:gap-6">
            <Link href="/dashboard" className="font-semibold tracking-tight">
              DeployLite
            </Link>
            <nav aria-label="Primary" className="hidden items-center gap-4 text-sm text-muted-foreground sm:flex">
              {navItems.map((item) => (
                <Link key={item.href} href={item.href} className="hover:text-foreground">
                  {item.label}
                </Link>
              ))}
            </nav>
          </div>
          <div className="flex shrink-0 items-center gap-2 text-sm sm:gap-3">
            <span className="sr-only text-muted-foreground sm:not-sr-only">{email}</span>
            <LogoutButton apiBaseUrl={getAuthApiBaseUrl()} />
          </div>
        </div>
      </header>
      <main className="mx-auto w-full max-w-6xl px-6 py-8">{children}</main>
    </div>
  );
}
