"use client";
import { App, Button, Form, Input, InputNumber, Popconfirm, Space, Table, Tabs } from "antd";
import { api } from "@/lib/api";
import { useSession } from "@/lib/session";
import { useGet } from "@/lib/useApi";

export default function Page() {
  return (
    <App>
      <Tabs
        items={[
          {
            key: "branches",
            label: "Chi nhánh",
            children: (
              <Entity
                path="branches"
                columns={["name", "timezone", "address"]}
                fields={[
                  { n: "name" },
                  { n: "timezone", ph: "Asia/Ho_Chi_Minh" },
                  { n: "address", opt: true },
                ]}
              />
            ),
          },
          {
            key: "services",
            label: "Dịch vụ",
            children: (
              <Entity
                path="services"
                columns={["name", "durationMin", "priceCents", "cancelWindowHours"]}
                fields={[
                  { n: "name" },
                  { n: "durationMin", num: true },
                  { n: "priceCents", num: true, opt: true },
                ]}
              />
            ),
          },
          {
            key: "staff",
            label: "Nhân viên",
            children: (
              <Entity
                path="staff"
                columns={["fullName", "title"]}
                fields={[{ n: "fullName" }, { n: "title", opt: true }]}
              />
            ),
          },
          {
            key: "customers",
            label: "Khách",
            children: (
              <Entity
                path="customers"
                columns={["fullName", "email", "phone"]}
                fields={[{ n: "fullName" }, { n: "email", opt: true }, { n: "phone", opt: true }]}
              />
            ),
          },
        ]}
      />
    </App>
  );
}

interface Field {
  n: string;
  num?: boolean;
  opt?: boolean;
  ph?: string;
}

/** Generic list + create + delete over /admin/:entity. Working hours and time off stay API-only for now. */
function Entity({ path, columns, fields }: { path: string; columns: string[]; fields: Field[] }) {
  const { tenantId } = useSession();
  const { message } = App.useApp();
  const list = useGet<{ items: Record<string, unknown>[] }>(`/admin/${path}?limit=200`);
  const [form] = Form.useForm();

  async function create(values: Record<string, unknown>) {
    const body = Object.fromEntries(
      Object.entries(values).filter(([, v]) => v !== undefined && v !== ""),
    );
    try {
      await api(tenantId, `/admin/${path}`, { body });
      form.resetFields();
      message.success("Đã tạo");
      void list.reload();
    } catch (e) {
      message.error((e as Error).message);
    }
  }
  async function remove(id: string) {
    try {
      await api(tenantId, `/admin/${path}/${id}`, { method: "DELETE" });
      void list.reload();
    } catch (e) {
      message.error((e as Error).message);
    }
  }

  return (
    <Space direction="vertical" style={{ width: "100%" }}>
      <Form form={form} layout="inline" onFinish={(v) => void create(v)}>
        {fields.map((f) => (
          <Form.Item key={f.n} name={f.n} rules={[{ required: !f.opt }]}>
            {f.num ? <InputNumber placeholder={f.n} /> : <Input placeholder={f.ph ?? f.n} />}
          </Form.Item>
        ))}
        <Button type="primary" htmlType="submit">
          Thêm
        </Button>
      </Form>
      {list.error ? <span style={{ color: "#cf1322" }}>{list.error}</span> : null}
      <Table
        rowKey="id"
        size="small"
        loading={list.loading}
        dataSource={list.data?.items ?? []}
        columns={[
          ...columns.map((c) => ({ title: c, dataIndex: c })),
          {
            title: "",
            render: (_: unknown, r: Record<string, unknown>) => (
              <Popconfirm title="Xoá?" onConfirm={() => void remove(String(r.id))}>
                <Button size="small" danger>
                  Xoá
                </Button>
              </Popconfirm>
            ),
          },
        ]}
      />
    </Space>
  );
}
