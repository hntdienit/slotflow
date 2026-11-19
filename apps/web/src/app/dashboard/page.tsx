"use client";
import {
  App,
  Button,
  Card,
  Col,
  DatePicker,
  Input,
  Modal,
  Row,
  Select,
  Space,
  Tag,
  Typography,
} from "antd";
import dayjs, { type Dayjs } from "dayjs";
import { useMemo, useState } from "react";
import { api, type Booking, type Branch, type Customer, type Service, type Slot } from "@/lib/api";
import { useSession } from "@/lib/session";
import { actionsFor, addDays, fmtTime, localDate, STATUS_COLOR, weekStart } from "@/lib/time";
import { useGet } from "@/lib/useApi";

export default function Page() {
  return (
    <App>
      <Dashboard />
    </App>
  );
}

const DAYS = ["T2", "T3", "T4", "T5", "T6", "T7", "CN"];

function Dashboard() {
  const { tenantId } = useSession();
  const { message } = App.useApp();
  const branches = useGet<{ items: Branch[] }>("/admin/branches");
  const services = useGet<{ items: Service[] }>("/admin/services");
  const customers = useGet<{ items: Customer[] }>("/admin/customers?limit=200");
  const [branchId, setBranchId] = useState<string>();
  const [anchor, setAnchor] = useState<Dayjs>(dayjs());
  const [q, setQ] = useState("");
  const [resched, setResched] = useState<Booking | null>(null);

  const branch = branches.data?.items.find((b) => b.id === branchId);
  const tz = branch?.timezone ?? "UTC";
  const start = weekStart(anchor.format("YYYY-MM-DD"));
  const days = Array.from({ length: 7 }, (_, i) => addDays(start, i));
  // Query a day wider on each side, then place by branch-local date, so the time zone never hides a booking.
  const from = new Date(`${addDays(start, -1)}T00:00:00Z`).toISOString();
  const to = new Date(`${addDays(start, 8)}T00:00:00Z`).toISOString();
  const bookings = useGet<Booking[]>(
    branchId ? `/bookings?branchId=${branchId}&from=${from}&to=${to}&limit=200` : null,
  );

  const name = (id: string) =>
    customers.data?.items.find((c) => c.id === id)?.fullName ?? id.slice(0, 8);
  const svc = (id: string) => services.data?.items.find((s) => s.id === id)?.name ?? "";
  const byDay = useMemo(() => {
    const m = new Map<string, Booking[]>();
    for (const b of bookings.data ?? []) {
      if (q && !name(b.customerId).toLowerCase().includes(q.toLowerCase())) continue;
      const d = localDate(b.startAt, tz);
      m.set(d, [...(m.get(d) ?? []), b]);
    }
    return m;
  }, [bookings.data, q, tz, customers.data]);

  async function act(b: Booking, action: string) {
    try {
      await api(tenantId, `/bookings/${b.id}/${action}`, {
        method: "POST",
        headers: { "x-actor": "manager" },
      });
      message.success("Đã cập nhật");
    } catch (e) {
      message.error((e as Error).message);
    }
    void bookings.reload();
  }

  return (
    <Space direction="vertical" style={{ width: "100%" }} size="middle">
      <Space wrap>
        <Select
          style={{ width: 280 }}
          placeholder="Chọn chi nhánh"
          value={branchId}
          onChange={setBranchId}
          options={branches.data?.items.map((b) => ({ value: b.id, label: b.name }))}
        />
        <Button onClick={() => setAnchor(anchor.subtract(7, "day"))}>‹ Tuần trước</Button>
        <DatePicker value={anchor} allowClear={false} onChange={(d) => d && setAnchor(d)} />
        <Button onClick={() => setAnchor(anchor.add(7, "day"))}>Tuần sau ›</Button>
        <Input.Search
          allowClear
          placeholder="Tìm khách theo tên"
          style={{ width: 220 }}
          onChange={(e) => setQ(e.target.value)}
        />
      </Space>
      {bookings.error ? <Typography.Text type="danger">{bookings.error}</Typography.Text> : null}
      <Row gutter={8}>
        {days.map((d, i) => (
          <Col key={d} flex="1 1 0" style={{ minWidth: 150 }}>
            <Card
              size="small"
              title={`${DAYS[i]} ${d.slice(8)}/${d.slice(5, 7)}`}
              loading={bookings.loading && !bookings.data}
            >
              {(byDay.get(d) ?? []).map((b) => (
                <Card key={b.id} size="small" style={{ marginBottom: 8 }}>
                  <Space direction="vertical" size={2} style={{ width: "100%" }}>
                    <Typography.Text strong>
                      {fmtTime(b.startAt, tz)}–{fmtTime(b.endAt, tz)}
                    </Typography.Text>
                    <Typography.Text>{name(b.customerId)}</Typography.Text>
                    <Typography.Text type="secondary">{svc(b.serviceId)}</Typography.Text>
                    <Space size={4} wrap>
                      <Tag color={STATUS_COLOR[b.status]}>{b.status}</Tag>
                      {b.source !== "web" ? <Tag>{b.source}</Tag> : null}
                    </Space>
                    <Space size={4} wrap>
                      {actionsFor(b.status).map((a) => (
                        <Button
                          key={a}
                          size="small"
                          danger={a === "cancel" || a === "no-show"}
                          onClick={() => (a === "reschedule" ? setResched(b) : void act(b, a))}
                        >
                          {a}
                        </Button>
                      ))}
                    </Space>
                  </Space>
                </Card>
              ))}
              {!(byDay.get(d) ?? []).length ? (
                <Typography.Text type="secondary">—</Typography.Text>
              ) : null}
            </Card>
          </Col>
        ))}
      </Row>
      {resched && branchId ? (
        <Reschedule
          booking={resched}
          tz={tz}
          onClose={(changed) => {
            setResched(null);
            if (changed) void bookings.reload();
          }}
        />
      ) : null}
    </Space>
  );
}

function Reschedule({
  booking,
  tz,
  onClose,
}: {
  booking: Booking;
  tz: string;
  onClose: (changed: boolean) => void;
}) {
  const { tenantId } = useSession();
  const { message } = App.useApp();
  const [date, setDate] = useState<Dayjs>(dayjs(localDate(booking.startAt, tz)));
  const [slot, setSlot] = useState<Slot>();
  const ymd = date.format("YYYY-MM-DD");
  const avail = useGet<{ slots: Slot[] }>(
    `/branches/${booking.branchId}/availability?serviceId=${booking.serviceId}&from=${ymd}&to=${ymd}`,
  );
  async function save() {
    if (!slot) return;
    try {
      await api(tenantId, `/bookings/${booking.id}/reschedule`, {
        method: "PATCH",
        body: { startAt: slot.startAt, staffId: slot.staffId },
        headers: { "x-actor": "manager" },
      });
      message.success("Đã đổi lịch");
      onClose(true);
    } catch (e) {
      message.error((e as Error).message);
      void avail.reload();
    }
  }
  return (
    <Modal
      open
      title="Đổi lịch"
      onCancel={() => onClose(false)}
      onOk={() => void save()}
      okButtonProps={{ disabled: !slot }}
      okText="Đổi"
    >
      <Space direction="vertical">
        <DatePicker
          value={date}
          allowClear={false}
          onChange={(d) => {
            if (d) {
              setDate(d);
              setSlot(undefined);
            }
          }}
        />
        <Space wrap>
          {(avail.data?.slots ?? [])
            .filter((s) => new Date(s.startAt) > new Date())
            .map((s) => (
              <Tag.CheckableTag
                key={s.startAt + s.staffId}
                checked={slot?.startAt === s.startAt}
                onChange={() => setSlot(s)}
              >
                {fmtTime(s.startAt, tz)}
              </Tag.CheckableTag>
            ))}
        </Space>
      </Space>
    </Modal>
  );
}
