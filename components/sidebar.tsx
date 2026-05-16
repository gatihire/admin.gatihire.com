"use client";

import Image from "next/image";
import { Users, Search, FileText, Settings, ChevronLeft, ChevronRight, Moon, Sun, BarChart, Briefcase, Building2, Shield, CreditCard } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { usePathname, useRouter } from "next/navigation";

interface SidebarProps {
  isHrUser?: boolean;
  permissionKeys?: string[];
  isSuperAdmin?: boolean;
  collapsed: boolean;
  setCollapsed: (collapsed: boolean) => void;
}

const navItems = [
  { href: "/upload", name: "Upload", icon: FileText, anyOf: ["candidates.edit"] },
  { href: "/jobs", name: "Jobs", icon: Briefcase, anyOf: ["jobs.view", "jobs.post", "jobs.edit"] },
  { href: "/candidates", name: "Candidates", icon: Users, anyOf: ["candidates.view", "candidates.edit"] },
  { href: "/clients", name: "Clients", icon: Building2, anyOf: ["jobs.view", "jobs.post", "jobs.edit"] },
  { href: "/clients/dashboard", name: "Client Analytics", icon: BarChart, anyOf: ["jobs.view", "analytics.view"] },
  { href: "/clients/credit-requests", name: "Credit Requests", icon: CreditCard, anyOf: ["jobs.view", "jobs.post", "jobs.edit", "users.manage"], badgeKey: "creditRequests" },
  { href: "/search", name: "Smart Search", icon: Search, anyOf: ["candidates.view", "candidates.edit", "candidates.search", "candidates.search-only"] },
  { href: "/jd-generator", name: "JD Generator", icon: FileText, anyOf: ["jobs.post", "jobs.edit"] },
  { href: "/admin/google-candidates", name: "Google Candidates", icon: Users, anyOf: ["users.manage"] },
  { href: "/analytics", name: "My Analytics", icon: BarChart, anyOf: ["analytics.view"], isHrOnly: true },
  { href: "/super-admin", name: "Super Admin", icon: Shield, anyOf: ["roles.manage", "users.manage"], superAdminOnly: true },
  { href: "/admin", name: "Admin", icon: Settings, anyOf: ["export.data", "users.manage"] },
];

export default function Sidebar({ isHrUser = false, permissionKeys = [], isSuperAdmin = false, collapsed, setCollapsed }: SidebarProps) {
  const [isDark, setIsDark] = useState(false);
  const [pendingCredits, setPendingCredits] = useState(0);
  const router = useRouter();
  const pathname = usePathname() || "";

  const activeHref = useMemo(() => {
    const path = pathname.split("?")[0]
    if (path.startsWith("/clients/dashboard")) return "/clients/dashboard"
    if (path.startsWith("/clients/credit-requests")) return "/clients/credit-requests"
    if (path.startsWith("/clients/")) return "/clients"
    return path
  }, [pathname])

  useEffect(() => {
    document.documentElement.classList.remove("dark");
    setIsDark(false);
  }, []);

  // Poll for pending credit requests every 60s
  useEffect(() => {
    const fetchPending = async () => {
      try {
        const res = await fetch("/api/clients/credit-requests?status=pending", { credentials: "include" })
        if (res.ok) {
          const data = await res.json()
          setPendingCredits((data.requests || []).length)
        }
      } catch {}
    }
    fetchPending()
    const interval = setInterval(fetchPending, 60_000)
    return () => clearInterval(interval)
  }, [])

  const toggleDark = () => {
    setIsDark((prev) => {
      const next = !prev;
      document.documentElement.classList.toggle("dark", next);
      return next;
    });
  };

  const handleLogout = async () => {
    try {
      await fetch("/api/auth/logout", { method: "POST" });
    } catch {}
    document.cookie = "auth=; path=/; expires=Thu, 01 Jan 1970 00:00:00 UTC;";
    document.cookie = "hr_user=; path=/; expires=Thu, 01 Jan 1970 00:00:00 UTC;";
    router.push("/login");
  };

  const logoSrc = isDark
    ? "https://i.postimg.cc/3x2xmLqs/log-def.png"
    : "https://i.postimg.cc/qMqv04M9/output-onlinepngtools.png";

  const badges: Record<string, number> = {
    creditRequests: pendingCredits,
  }

  return (
    <aside
      className={`sticky top-0 h-screen flex flex-col transition-all duration-300 z-30 shadow-[4px_0_24px_rgba(0,0,0,0.02)] ${
        collapsed
          ? 'w-20 bg-white dark:bg-[#18181b] border-r border-zinc-100 dark:border-zinc-800'
          : 'w-64 bg-white dark:bg-[#18181b] border-r border-zinc-100 dark:border-zinc-800'
      }`}
    >
      <div className="p-6 flex items-center justify-between h-[88px]">
        <div className={`flex items-center overflow-hidden transition-all duration-300 ${collapsed ? 'w-0 opacity-0' : 'w-[150px] opacity-100'}`}>
          <Image src={logoSrc} alt="Truckinzy Logo" width={150} height={40} priority className="object-contain" />
        </div>
        <button
          className={`flex items-center justify-center w-8 h-8 rounded-full border border-zinc-200 bg-white hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-800 dark:hover:bg-zinc-700 text-zinc-500 shadow-sm transition-all hover:scale-105 focus:outline-none ${collapsed ? 'mx-auto' : ''}`}
          onClick={() => setCollapsed(!collapsed)}
          aria-label="Toggle sidebar"
        >
          {collapsed ? <ChevronRight size={16} strokeWidth={2.5} /> : <ChevronLeft size={16} strokeWidth={2.5} />}
        </button>
      </div>
      <div className="px-4 pb-2">
        <div className="h-px w-full bg-gradient-to-r from-transparent via-zinc-200 dark:via-zinc-700 to-transparent"></div>
      </div>
      <nav className="flex-1 mt-4 overflow-y-auto px-3 scrollbar-hide pb-4">
        <ul className="space-y-1.5">
          {navItems.map((item) => {
            if ((item as any).isHrOnly && !isHrUser) return null;
            if ((item as any).superAdminOnly && !isSuperAdmin) return null;
            const anyOf = Array.isArray((item as any).anyOf) ? (item as any).anyOf : null
            if (anyOf && !anyOf.some((p: string) => permissionKeys.includes(p))) return null
            const Icon = item.icon;
            const isActive = activeHref === (item as any).href;
            const badgeKey = (item as any).badgeKey as string | undefined
            const badgeCount = badgeKey ? (badges[badgeKey] || 0) : 0
            return (
              <li key={(item as any).href} className="relative">
                <button
                  type="button"
                  onClick={() => router.push((item as any).href)}
                  className={`flex items-center w-full px-3 py-3 rounded-xl transition-all duration-200 group focus:outline-none ${
                    isActive
                      ? "bg-blue-50/80 text-blue-600 font-medium dark:bg-blue-900/20 dark:text-blue-400 shadow-[inset_0_1px_1px_rgba(255,255,255,0.5),0_1px_3px_rgba(0,0,0,0.05)] ring-1 ring-blue-100 dark:ring-blue-900/40"
                      : "text-zinc-600 hover:bg-zinc-50 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800/50 dark:hover:text-zinc-200"
                  } ${collapsed ? "justify-center" : ""}`}
                >
                  <span className={`relative flex items-center justify-center ${isActive ? "text-blue-600 dark:text-blue-400" : "text-zinc-400 group-hover:text-zinc-600 dark:group-hover:text-zinc-300"} transition-colors`}>
                    <Icon size={20} strokeWidth={isActive ? 2.5 : 2} />
                    {badgeCount > 0 && collapsed && (
                      <span className="absolute -top-1.5 -right-1.5 bg-red-500 text-white text-[9px] font-bold rounded-full w-4 h-4 flex items-center justify-center leading-none shadow-sm ring-2 ring-white dark:ring-[#18181b]">
                        {badgeCount > 9 ? "9+" : badgeCount}
                      </span>
                    )}
                  </span>
                  {!collapsed && <span className={`flex-1 text-left ml-3 text-[14px] ${isActive ? "font-semibold tracking-tight" : "font-medium"}`}>{item.name}</span>}
                  {!collapsed && badgeCount > 0 && (
                    <span className="ml-auto bg-red-500 text-white text-[10px] font-bold rounded-full px-2 py-0.5 min-w-[20px] text-center leading-none shadow-sm">
                      {badgeCount > 99 ? "99+" : badgeCount}
                    </span>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      </nav>
      <div className="mt-auto p-4 flex flex-col items-center gap-3 border-t border-zinc-100 dark:border-zinc-800/50 bg-zinc-50/50 dark:bg-[#18181b]">
        <button
          onClick={toggleDark}
          className={`flex items-center gap-3 px-3 py-2.5 rounded-xl border border-zinc-200 dark:border-zinc-700/80 bg-white dark:bg-zinc-800 hover:bg-zinc-50 dark:hover:bg-zinc-700 text-zinc-600 dark:text-zinc-300 transition-all shadow-sm hover:shadow focus:ring-2 focus:ring-blue-100 focus:outline-none w-full ${collapsed ? "justify-center" : ""}`}
          title={isDark ? "Switch to Light Mode" : "Switch to Dark Mode"}
        >
          {isDark ? <Sun size={18} className="text-amber-500" strokeWidth={2.5} /> : <Moon size={18} className="text-blue-500" strokeWidth={2.5} />}
          {!collapsed && <span className="text-sm font-medium">{isDark ? "Light Mode" : "Dark Mode"}</span>}
        </button>
        <button
          onClick={handleLogout}
          className={`flex items-center gap-3 px-3 py-2.5 rounded-xl border border-red-100 dark:border-red-900/30 bg-red-50/50 dark:bg-red-900/10 hover:bg-red-100 dark:hover:bg-red-900/20 text-red-600 dark:text-red-400 transition-all focus:ring-2 focus:ring-red-100 focus:outline-none w-full ${collapsed ? "justify-center" : ""}`}
          title="Logout"
        >
          <div className="flex items-center justify-center">
            <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="opacity-80"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"></path><polyline points="16 17 21 12 16 7"></polyline><line x1="21" y1="12" x2="9" y2="12"></line></svg>
          </div>
          {!collapsed && <span className="text-sm font-semibold">Logout</span>}
        </button>
      </div>
    </aside>
  );
}
