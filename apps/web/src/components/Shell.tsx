"use client";
import { Alert, Button, Form, Input, Layout, Menu, Modal, Space, Typography } from "antd";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState, type ReactNode } from "react";
import { api } from "@/lib/api";
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
  const { tenantId, setTenantId, ready, login, setLogin } = useSession();
  const [open, setOpen] = useState(false);
  const [err, setErr] = useState<string>();
  async function doLogin(v: { email: string; password: string }) {
    try {
      const r = await api<{ token: string; role: string; customerId: string | null }>(
        tenantId,
        "/auth/login",
        { body: { tenantId, ...v } },
      );
      setLogin({ token: r.token, role: r.role, customerId: r.customerId });
      setOpen(false);
      setErr(undefined);
    } catch (e) {
      setErr((e as Error).message);
    }
  }
  const items =
    login?.role === "customer"
      ? ITEMS.filter((i) => i.key === "/" || i.key === "/waitlist")
      : ITEMS;
  const active = items
    .map((i) => i.key)
    .filter((k) => (k === "/" ? path === "/" : path.startsWith(k)));
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
          {login ? (
            <Space>
              <Typography.Text style={{ color: "#aaa" }}>{login.role}</Typography.Text>
              <Button size="small" onClick={() => setLogin(null)}>
                Đăng xuất
              </Button>
            </Space>
          ) : (
            <Button size="small" disabled={!tenantId} onClick={() => setOpen(true)}>
              Đăng nhập
            </Button>
          )}
        </Space>
      </Layout.Header>
      <Modal open={open} title="Đăng nhập" footer={null} onCancel={() => setOpen(false)}>
        <Form layout="vertical" onFinish={(v) => void doLogin(v)}>
          <Form.Item name="email" label="Email" rules={[{ required: true }]}>
            <Input autoComplete="username" />
          </Form.Item>
          <Form.Item name="password" label="Mật khẩu" rules={[{ required: true }]}>
            <Input.Password autoComplete="current-password" />
          </Form.Item>
          {err ? <Alert type="error" message={err} style={{ marginBottom: 12 }} /> : null}
          <Button type="primary" htmlType="submit">
            Đăng nhập
          </Button>
        </Form>
      </Modal>
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
