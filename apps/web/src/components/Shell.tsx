"use client";
import { Alert, Input, Layout, Menu, Space, Typography } from "antd";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { useSession } from "@/lib/session";

const ITEMS = [
  { key: "/", label: <Link href="/">Đặt lịch</Link> },
  { key: "/dashboard", label: <Link href="/dashboard">Lịch tuần</Link> },
  { key: "/waitlist", label: <Link href="/waitlist">Waitlist</Link> },
  { key: "/admin", label: <Link href="/admin">Quản trị</Link> },
  { key: "/simulator", label: <Link href="/simulator">Mô phỏng tải</Link> },
];

export function Shell({ children }: { children: ReactNode }) {
  const path = usePathname();
  const { tenantId, setTenantId, ready } = useSession();
  const active = ITEMS.map((i) => i.key).filter((k) =>
    k === "/" ? path === "/" : path.startsWith(k),
  );
  return (
    <Layout style={{ minHeight: "100vh" }}>
      <Layout.Header style={{ display: "flex", alignItems: "center", gap: 16 }}>
        <Typography.Text strong style={{ color: "#fff", fontSize: 18 }}>
          SlotFlow
        </Typography.Text>
        <Menu
          theme="dark"
          mode="horizontal"
          selectedKeys={active}
          items={ITEMS}
          style={{ flex: 1, minWidth: 0 }}
        />
        <Space>
          <Typography.Text style={{ color: "#aaa" }}>Tenant</Typography.Text>
          <Input
            size="small"
            style={{ width: 300 }}
            placeholder="tenant id (uuid)"
            value={tenantId}
            onChange={(e) => setTenantId(e.target.value)}
            aria-label="tenant id"
          />
        </Space>
      </Layout.Header>
      <Layout.Content style={{ padding: 24, maxWidth: 1200, width: "100%", margin: "0 auto" }}>
        {ready && !tenantId ? (
          <Alert
            type="info"
            showIcon
            style={{ marginBottom: 16 }}
            message="Nhập tenant id ở góc trên bên phải"
            description="Chạy `pnpm --filter @slotflow/api seed` để tạo dữ liệu mẫu; lệnh in ra id của từng tenant."
          />
        ) : null}
        {children}
      </Layout.Content>
    </Layout>
  );
}
