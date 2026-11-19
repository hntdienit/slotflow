"use client";
import { App, Button, Select, Space, Table, Tag } from "antd";
import { useState } from "react";
import { api, type Branch, type Customer, type Service, type WaitlistEntry } from "@/lib/api";
import { useSession } from "@/lib/session";
import { fmtDateTime } from "@/lib/time";
import { useGet } from "@/lib/useApi";

export default function Page() {
  return (
    <App>
      <Waitlist />
    </App>
  );
}

const COLOR: Record<string, string> = {
  waiting: "blue",
  offered: "gold",
  booked: "green",
  cancelled: "default",
  expired: "default",
};

function Waitlist() {
  const { tenantId } = useSession();
  const { message } = App.useApp();
  const branches = useGet<{ items: Branch[] }>("/admin/branches");
  const services = useGet<{ items: Service[] }>("/admin/services");
  const customers = useGet<{ items: Customer[] }>("/admin/customers?limit=200");
  const [branchId, setBranchId] = useState<string>();
  const [status, setStatus] = useState<string>();
  const qs = new URLSearchParams({
    limit: "200",
    ...(branchId ? { branchId } : {}),
    ...(status ? { status } : {}),
  });
  const entries = useGet<WaitlistEntry[]>(`/waitlist?${qs}`);
  const tz = (id: string) => branches.data?.items.find((b) => b.id === id)?.timezone ?? "UTC";

  async function leave(id: string) {
    try {
      await api(tenantId, `/waitlist/${id}`, { method: "DELETE" });
      message.success("Đã rời hàng chờ");
    } catch (e) {
      message.error((e as Error).message);
    }
    void entries.reload();
  }

  return (
    <Space direction="vertical" style={{ width: "100%" }}>
      <Space>
        <Select
          allowClear
          style={{ width: 240 }}
          placeholder="Chi nhánh"
          onChange={setBranchId}
          options={branches.data?.items.map((b) => ({ value: b.id, label: b.name }))}
        />
        <Select
          allowClear
          style={{ width: 160 }}
          placeholder="Trạng thái"
          onChange={setStatus}
          options={Object.keys(COLOR).map((s) => ({ value: s, label: s }))}
        />
        <Button onClick={() => void entries.reload()}>Làm mới</Button>
      </Space>
      <Table<WaitlistEntry>
        rowKey="id"
        size="small"
        loading={entries.loading}
        dataSource={entries.data ?? []}
        columns={[
          {
            title: "Khách",
            render: (_, e) =>
              customers.data?.items.find((c) => c.id === e.customerId)?.fullName ??
              e.customerId.slice(0, 8),
          },
          {
            title: "Dịch vụ",
            render: (_, e) => services.data?.items.find((s) => s.id === e.serviceId)?.name,
          },
          {
            title: "Khung giờ mong muốn",
            render: (_, e) =>
              `${fmtDateTime(e.windowStart, tz(e.branchId))} → ${fmtDateTime(e.windowEnd, tz(e.branchId))}`,
          },
          {
            title: "Trạng thái",
            dataIndex: "status",
            render: (s: string) => <Tag color={COLOR[s]}>{s}</Tag>,
          },
          {
            title: "",
            render: (_, e) =>
              e.status === "waiting" || e.status === "offered" ? (
                <Button size="small" danger onClick={() => void leave(e.id)}>
                  Rời hàng chờ
                </Button>
              ) : null,
          },
        ]}
      />
    </Space>
  );
}
