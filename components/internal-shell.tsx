"use client"

import { useEffect, useState } from "react"
import Sidebar from "@/components/sidebar"

export function InternalShell({
  children,
  isHrUser,
  permissionKeys,
  isSuperAdmin,
}: {
  children: React.ReactNode
  isHrUser: boolean
  permissionKeys: string[]
  isSuperAdmin: boolean
}) {
  const [collapsed, setCollapsed] = useState(false)

  useEffect(() => {
    document.documentElement.classList.remove("dark")
  }, [])

  return (
    <div className="flex min-h-screen w-full bg-gray-50 dark:bg-[#23272f]">
      <Sidebar
        isHrUser={isHrUser}
        permissionKeys={permissionKeys}
        isSuperAdmin={isSuperAdmin}
        collapsed={collapsed}
        setCollapsed={setCollapsed}
      />
      <main className="flex-1 min-h-screen w-full p-8 overflow-auto">{children}</main>
    </div>
  )
}
