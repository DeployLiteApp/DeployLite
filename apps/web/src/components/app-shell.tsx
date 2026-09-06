"use client";

import Link from "next/link";
import { Folder, Gauge, LayoutDashboard, Menu, Rocket, Search, Server, Settings2, X } from "lucide-react";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { LogoutButton } from "@/app/auth-controls";
import { getAuthApiBaseUrl } from "@/lib/auth-boundary";

type AppShellProps = { email: string; children: ReactNode; compactMobile?: boolean };
type NavItem = { href: string; label: string; icon: typeof LayoutDashboard };
type FutureItem = { label: string; icon: typeof LayoutDashboard };

const navItems: NavItem[] = [
  { href: "/dashboard", label: "Overview", icon: LayoutDashboard },
  { href: "/projects", label: "Projects", icon: Folder },
  { href: "/deployments", label: "Deployments", icon: Rocket }
];
const futureItems: FutureItem[] = [
  { label: "Environments", icon: Server },
  { label: "Servers", icon: Server },
  { label: "Variables", icon: Settings2 },
  { label: "Metrics", icon: Gauge },
  { label: "Logs", icon: Settings2 }
];

function isActive(pathname: string, href: string) {
  return pathname === href || (href !== "/dashboard" && pathname.startsWith(`${href}/`));
}

function Brand({ compactMobile = false }: { compactMobile?: boolean }) {
  return <Link href="/dashboard" className="flex items-center gap-2.5 font-semibold tracking-tight md:gap-3" aria-label="DeployLite overview">
    <span className="relative top-[-0.5px] flex size-6 items-center justify-center rounded-[6px] bg-[#2563eb] text-sm font-bold text-white md:top-0 md:size-7 md:rounded-[7px]">D</span>
    <span className={`${compactMobile ? "translate-y-[6.5px] text-lg" : "translate-y-[3.25px] text-[17px]"} md:translate-y-0 md:text-lg`}>DeployLite</span>
  </Link>;
}

function Navigation({ pathname, mobile = false, onNavigate, firstLinkRef }: { pathname: string; mobile?: boolean; onNavigate?: () => void; firstLinkRef?: RefObject<HTMLAnchorElement | null> }) {
  return <nav aria-label={mobile ? "Mobile primary" : "Primary"} className="flex flex-col gap-1">
    {navItems.map(({ href, label, icon: Icon }, index) => {
      const active = isActive(pathname, href);
      return <Link key={href} ref={index === 0 ? firstLinkRef : undefined} href={href} onClick={onNavigate} aria-current={active ? "page" : undefined} className={`flex h-8 items-center gap-3 rounded-md px-3 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#2563eb]/50 ${active ? "bg-[#f4f4f5] font-medium text-foreground dark:bg-[#27272a]" : "text-muted-foreground hover:bg-muted hover:text-foreground"}`}>
        <Icon aria-hidden="true" className="size-4" strokeWidth={1.8} /><span>{label}</span>
      </Link>;
    })}
    {!mobile ? futureItems.map(({ label, icon: Icon }) => <span key={label} className="flex h-8 cursor-not-allowed items-center gap-3 rounded-md px-3 text-sm text-muted-foreground/50" aria-disabled="true" title={`${label} is not available yet`}>
      <Icon aria-hidden="true" className="size-4" strokeWidth={1.8} /><span>{label}</span>
    </span>) : null}
  </nav>;
}

function Account({ email }: { email: string }) {
  return <div className="flex items-center justify-between gap-3 border-t border-[#e4e4e7] pt-4 dark:border-[#27272a]">
    <div className="flex min-w-0 items-center gap-3">
      <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-[#dbeafe] text-xs font-semibold text-[#1d4ed8]" aria-hidden="true">{email.slice(0, 1).toUpperCase()}</span>
      <span className="truncate text-sm text-muted-foreground" title={email}>{email}</span>
    </div>
    <LogoutButton apiBaseUrl={getAuthApiBaseUrl()} />
  </div>;
}

export function AppShell({ email, children, compactMobile = false }: AppShellProps) {
  const pathname = usePathname();
  const [menuOpen, setMenuOpen] = useState(false);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const firstMobileLinkRef = useRef<HTMLAnchorElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    firstMobileLinkRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setMenuOpen(false);
        menuButtonRef.current?.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [menuOpen]);

  return <div className="min-h-screen bg-[#fafafa] text-foreground dark:bg-[#18181b]">
    <aside className="fixed inset-y-0 left-0 z-20 hidden w-[244px] border-r border-[#e4e4e7] bg-white px-[18px] py-[30px] dark:border-[#27272a] dark:bg-[#18181b] md:flex md:flex-col">
      <div className="ml-3"><Brand /></div>
      <p className="mt-9 px-3 text-[11px] font-medium tracking-[0.08em] text-muted-foreground">WORKSPACE</p>
      <div className="mt-3"><Navigation pathname={pathname} /></div>
      <div className="mt-auto"><Account email={email} /></div>
    </aside>
    <header className={`relative z-10 flex items-center justify-between border-b border-[#e4e4e7] bg-white dark:border-[#27272a] dark:bg-[#18181b] md:ml-[244px] md:h-[72px] md:px-8 md:pr-[26px] ${compactMobile ? "h-[64px] px-6" : "h-[70px] px-5"}`}>
      <div className="md:hidden"><Brand compactMobile={compactMobile} /></div>
      <span className="sr-only md:block">{navItems.find((item) => isActive(pathname, item.href))?.label ?? "Overview"}</span>
      <div className={`absolute left-8 ${compactMobile ? "top-[calc(50%+1.5px)]" : "top-1/2"} hidden -translate-y-1/2 items-center md:flex`}>
        <form action="/projects" className="relative">
          <Search aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <input aria-label="Search projects" className="h-[34px] w-[320px] rounded-md border border-border bg-[#fafafa] pl-9 pr-12 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-[#2563eb]/50 dark:bg-[#18181b]" name="query" placeholder="Search projects" type="search" />
          <kbd className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 rounded border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground">⌘K</kbd>
        </form>
      </div>
      <Link href="/projects/new" className={`ml-auto hidden h-[34px] w-[78px] items-center justify-center rounded-md bg-[#2563eb] text-xs font-medium text-white hover:bg-[#1d4ed8] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#2563eb]/50 md:flex ${compactMobile ? "translate-y-[1.5px]" : ""}`}>New</Link>
      <button ref={menuButtonRef} type="button" className="flex size-[34px] items-center justify-center rounded-md border border-border text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#2563eb]/50 md:hidden" aria-label={menuOpen ? "Close navigation menu" : "Open navigation menu"} aria-expanded={menuOpen} aria-controls="mobile-navigation" onClick={() => setMenuOpen((open) => !open)}>
        {menuOpen ? <X aria-hidden="true" className="size-4" /> : <Menu aria-hidden="true" className="size-4" />}
      </button>
    </header>
    {menuOpen ? <div id="mobile-navigation" className="absolute inset-x-0 z-10 border-b border-[#e4e4e7] bg-white px-5 py-4 shadow-sm dark:border-[#27272a] dark:bg-[#18181b] md:hidden"><Navigation pathname={pathname} mobile onNavigate={() => setMenuOpen(false)} firstLinkRef={firstMobileLinkRef} /><div className="mt-4"><Account email={email} /></div></div> : null}
    <main className={`bg-[#fafafa] px-5 pb-24 md:ml-[244px] md:min-h-[calc(100vh-72px)] md:px-8 md:py-8 ${compactMobile ? "min-h-[calc(100vh-64px)] pt-[30px] dark:bg-[#09090b]" : "min-h-[calc(100vh-70px)] pt-[34px] dark:bg-[#18181b]"}`}>{children}</main>
    <nav aria-label="Mobile bottom navigation" className="fixed inset-x-0 bottom-0 z-20 grid h-[72px] grid-cols-5 border-t border-[#e4e4e7] bg-white dark:border-[#27272a] dark:bg-[#18181b] md:hidden">
      {navItems.map(({ href, label, icon: Icon }) => {
        const active = isActive(pathname, href);
        return <Link key={href} href={href} aria-current={active ? "page" : undefined} aria-label={label} className={`relative flex items-center justify-center ${active ? "text-[#2563eb]" : "text-muted-foreground"}`}><Icon aria-hidden="true" className="size-5" strokeWidth={1.8} />{active ? <span className="absolute bottom-2 size-1 rounded-full bg-[#2563eb]" aria-hidden="true" /> : null}</Link>;
      })}
      <span className="flex items-center justify-center text-muted-foreground/40" aria-disabled="true" aria-label="Servers unavailable"><Server aria-hidden="true" className="size-5" strokeWidth={1.8} /></span>
      <span className="flex items-center justify-center text-muted-foreground/40" aria-disabled="true" aria-label="Metrics unavailable"><Gauge aria-hidden="true" className="size-5" strokeWidth={1.8} /></span>
    </nav>
  </div>;
}
