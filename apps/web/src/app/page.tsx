"use client";
import {
  App,
  Button,
  Card,
  Col,
  DatePicker,
  Form,
  Input,
  Row,
  Select,
  Space,
  Steps,
  Tag,
  Typography,
  message,
} from "antd";
import dayjs, { type Dayjs } from "dayjs";
import { useMemo, useState } from "react";
import { Chat } from "@/components/Chat";
import { api, type Branch, type Customer, type Service, type Slot } from "@/lib/api";
import { useSession } from "@/lib/session";
import { fmtTime, localDate, money } from "@/lib/time";
import { useGet } from "@/lib/useApi";

interface Avail {
  timezone: string;
  slots: Slot[];
}

export default function BookingPage() {
  return (
    <App>
      <Booking />
    </App>
  );
}

function Booking() {
  const { tenantId, login } = useSession();
  const [msg, ctx] = message.useMessage();
  const branches = useGet<{ items: Branch[] }>("/admin/branches");
  const services = useGet<{ items: Service[] }>("/admin/services");
  const customers = useGet<{ items: Customer[] }>(
    login?.role === "customer" ? null : "/admin/customers?limit=200",
  );
  const [branchId, setBranchId] = useState<string>();
  const [serviceId, setServiceId] = useState<string>();
  const [date, setDate] = useState<Dayjs>(dayjs());
  const [slot, setSlot] = useState<Slot>();
  const [picked, setCustomerId] = useState<string | null>(null);
  // A logged-in customer always books as themselves (the API enforces it too).
  const customerId = login?.customerId ?? picked;
  const [done, setDone] = useState<string>();
  const [busy, setBusy] = useState(false);

  const branch = branches.data?.items.find((b) => b.id === branchId);
  const ymd = date.format("YYYY-MM-DD");
  const avail = useGet<Avail>(
    branchId && serviceId
      ? `/branches/${branchId}/availability?serviceId=${serviceId}&from=${ymd}&to=${ymd}`
      : null,
  );
  const tz = avail.data?.timezone ?? branch?.timezone ?? "UTC";
  const today = branch ? localDate(new Date(), branch.timezone) : ymd;
  const slots = useMemo(
    () => (avail.data?.slots ?? []).filter((s) => new Date(s.startAt) > new Date()),
    [avail.data],
  );
  const step = !branchId ? 0 : !serviceId ? 1 : !slot ? 2 : !customerId ? 3 : done ? 5 : 4;

  async function book() {
    if (!slot || !branchId || !serviceId || !customerId) return;
    setBusy(true);
    try {
      const key = `web:${customerId}:${slot.startAt}`; // retrying the same click never double-books
      const b = await api<{ id: string }>(tenantId, "/bookings", {
        body: {
          branchId,
          serviceId,
          customerId,
          startAt: slot.startAt,
          staffId: slot.staffId,
          source: "web",
        },
        headers: { "idempotency-key": key },
      });
      setDone(b.id);
      setSlot(undefined);
      void avail.reload(); // the booked time is no longer free
      msg.success("Đã đặt lịch");
    } catch (e) {
      msg.error((e as Error).message);
      void avail.reload(); // someone probably took the slot: show what is still free
      setSlot(undefined);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Row gutter={24}>
      {ctx}
      <Col xs={24} lg={14}>
        <Card title="Đặt lịch hẹn">
          <Steps
            size="small"
            current={step}
            style={{ marginBottom: 24 }}
            items={[
              { title: "Chi nhánh" },
              { title: "Dịch vụ" },
              { title: "Giờ" },
              { title: "Khách" },
              { title: "Xác nhận" },
            ]}
          />
          <Form layout="vertical">
            <Form.Item label="Chi nhánh">
              <Select
                value={branchId}
                placeholder="Chọn chi nhánh"
                loading={branches.loading}
                onChange={(v) => {
                  setBranchId(v);
                  setSlot(undefined);
                  setDone(undefined);
                }}
                options={branches.data?.items.map((b) => ({
                  value: b.id,
                  label: `${b.name} (${b.timezone})`,
                }))}
              />
            </Form.Item>
            <Form.Item label="Dịch vụ">
              <Select
                value={serviceId}
                placeholder="Chọn dịch vụ"
                loading={services.loading}
                onChange={(v) => {
                  setServiceId(v);
                  setSlot(undefined);
                  setDone(undefined);
                }}
                options={services.data?.items.map((s) => ({
                  value: s.id,
                  label: `${s.name} · ${s.durationMin} phút · ${money(s.priceCents)}`,
                }))}
              />
            </Form.Item>
            <Form.Item label="Ngày">
              <DatePicker
                value={date}
                allowClear={false}
                disabledDate={(d) => d.format("YYYY-MM-DD") < today}
                onChange={(d) => {
                  if (d) {
                    setDate(d);
                    setSlot(undefined);
                  }
                }}
              />
            </Form.Item>
            <Form.Item label={`Giờ trống (giờ chi nhánh, ${tz})`}>
              {avail.error ? <Typography.Text type="danger">{avail.error}</Typography.Text> : null}
              <Space wrap>
                {slots.map((s) => (
                  <Tag.CheckableTag
                    key={s.startAt + s.staffId}
                    checked={slot?.startAt === s.startAt}
                    onChange={() => setSlot(s)}
                  >
                    {fmtTime(s.startAt, tz)}
                  </Tag.CheckableTag>
                ))}
                {branchId && serviceId && !avail.loading && !slots.length ? (
                  <Typography.Text type="secondary">Không còn giờ trống ngày này.</Typography.Text>
                ) : null}
              </Space>
            </Form.Item>
            {login?.customerId ? null : (
              <Form.Item label="Khách">
                <Space.Compact style={{ width: "100%" }}>
                  <Select
                    showSearch
                    optionFilterProp="label"
                    style={{ width: "100%" }}
                    value={customerId}
                    placeholder="Chọn khách có sẵn"
                    onChange={(v) => setCustomerId(v)}
                    options={customers.data?.items.map((c) => ({
                      value: c.id,
                      label: `${c.fullName}${c.email ? ` · ${c.email}` : ""}`,
                    }))}
                  />
                </Space.Compact>
                <NewCustomer
                  onCreated={(c) => {
                    void customers.reload();
                    setCustomerId(c.id);
                  }}
                />
              </Form.Item>
            )}
            <Button
              type="primary"
              size="large"
              loading={busy}
              disabled={!slot || !customerId || !!done}
              onClick={() => void book()}
            >
              Xác nhận đặt lịch
            </Button>
            {done ? (
              <Typography.Paragraph style={{ marginTop: 12 }}>
                Mã lịch hẹn: <code>{done}</code>
              </Typography.Paragraph>
            ) : null}
          </Form>
        </Card>
      </Col>
      <Col xs={24} lg={10}>
        <Chat customerId={customerId} onBooked={() => void avail.reload()} />
      </Col>
    </Row>
  );
}

function NewCustomer({ onCreated }: { onCreated: (c: Customer) => void }) {
  const { tenantId } = useSession();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [err, setErr] = useState<string>();
  async function create() {
    try {
      const c = await api<Customer>(tenantId, "/admin/customers", {
        body: { fullName: name, ...(email ? { email } : {}) },
      });
      setName("");
      setEmail("");
      setErr(undefined);
      onCreated(c);
    } catch (e) {
      setErr((e as Error).message);
    }
  }
  return (
    <Space style={{ marginTop: 8 }} wrap>
      <Input
        placeholder="Hoặc tạo khách mới: họ tên"
        value={name}
        onChange={(e) => setName(e.target.value)}
      />
      <Input
        placeholder="email (tuỳ chọn)"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
      />
      <Button disabled={!name.trim()} onClick={() => void create()}>
        Tạo
      </Button>
      {err ? <Typography.Text type="danger">{err}</Typography.Text> : null}
    </Space>
  );
}
