"use client";
import {
  App,
  Button,
  Card,
  DatePicker,
  InputNumber,
  Select,
  Space,
  Statistic,
  Typography,
} from "antd";
import dayjs, { type Dayjs } from "dayjs";
import { useState } from "react";
import { ApiFailure, api, type Branch, type Customer, type Service, type Slot } from "@/lib/api";
import { useSession } from "@/lib/session";
import { fmtTime } from "@/lib/time";
import { useGet } from "@/lib/useApi";

export default function Page() {
  return (
    <App>
      <Simulator />
    </App>
  );
}

interface Tally {
  ok: number;
  conflict: number;
  other: number;
  ms: number;
}

/** Fires N simultaneous bookings at ONE slot. The database exclusion constraint must let exactly one through. */
function Simulator() {
  const { tenantId } = useSession();
  const branches = useGet<{ items: Branch[] }>("/admin/branches");
  const services = useGet<{ items: Service[] }>("/admin/services");
  const customers = useGet<{ items: Customer[] }>("/admin/customers?limit=200");
  const [branchId, setBranchId] = useState<string>();
  const [serviceId, setServiceId] = useState<string>();
  const [date, setDate] = useState<Dayjs>(dayjs().add(1, "day"));
  const [slot, setSlot] = useState<Slot>();
  const [n, setN] = useState(50);
  const [tally, setTally] = useState<Tally>();
  const [busy, setBusy] = useState(false);
  const ymd = date.format("YYYY-MM-DD");
  const avail = useGet<{ timezone: string; slots: Slot[] }>(
    branchId && serviceId
      ? `/branches/${branchId}/availability?serviceId=${serviceId}&from=${ymd}&to=${ymd}`
      : null,
  );
  const pool = customers.data?.items ?? [];

  async function fire() {
    if (!slot || !branchId || !serviceId || !pool.length) return;
    setBusy(true);
    const t0 = performance.now();
    const results = await Promise.allSettled(
      Array.from({ length: n }, (_, i) =>
        api(tenantId, "/bookings", {
          body: {
            branchId,
            serviceId,
            customerId: pool[i % pool.length]!.id,
            startAt: slot.startAt,
            staffId: slot.staffId,
            source: "admin",
          },
          headers: { "idempotency-key": `sim:${crypto.randomUUID()}` },
        }),
      ),
    );
    const t: Tally = { ok: 0, conflict: 0, other: 0, ms: Math.round(performance.now() - t0) };
    for (const r of results) {
      if (r.status === "fulfilled") t.ok++;
      else if (r.reason instanceof ApiFailure && r.reason.status === 409) t.conflict++;
      else t.other++;
    }
    setTally(t);
    setBusy(false);
    void avail.reload();
  }

  return (
    <Card title="Mô phỏng đặt đồng thời cùng một giờ">
      <Space direction="vertical" style={{ width: "100%" }}>
        <Typography.Paragraph type="secondary">
          Gửi N yêu cầu đặt song song vào đúng một giờ trống. Kết quả đúng: 1 thành công, N−1 bị từ
          chối (409), không bao giờ có hai lịch chồng nhau. Mỗi lần chạy tạo thật các lịch hẹn nguồn{" "}
          <code>admin</code>.
        </Typography.Paragraph>
        <Space wrap>
          <Select
            style={{ width: 240 }}
            placeholder="Chi nhánh"
            onChange={(v) => {
              setBranchId(v);
              setSlot(undefined);
            }}
            options={branches.data?.items.map((b) => ({ value: b.id, label: b.name }))}
          />
          <Select
            style={{ width: 240 }}
            placeholder="Dịch vụ"
            onChange={(v) => {
              setServiceId(v);
              setSlot(undefined);
            }}
            options={services.data?.items.map((s) => ({ value: s.id, label: s.name }))}
          />
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
          <Select
            style={{ width: 140 }}
            placeholder="Giờ"
            value={slot?.startAt}
            onChange={(v) => setSlot(avail.data?.slots.find((s) => s.startAt === v))}
            options={(avail.data?.slots ?? [])
              .filter((s) => new Date(s.startAt) > new Date())
              .map((s) => ({ value: s.startAt, label: fmtTime(s.startAt, avail.data!.timezone) }))}
          />
          <InputNumber
            min={2}
            max={200}
            value={n}
            onChange={(v) => setN(v ?? 50)}
            addonAfter="yêu cầu"
          />
          <Button
            type="primary"
            danger
            loading={busy}
            disabled={!slot || !pool.length}
            onClick={() => void fire()}
          >
            Bắn!
          </Button>
        </Space>
        {tally ? (
          <Space size="large">
            <Statistic
              title="Thành công"
              value={tally.ok}
              valueStyle={{ color: tally.ok === 1 ? "#3f8600" : "#cf1322" }}
            />
            <Statistic title="Bị từ chối (409)" value={tally.conflict} />
            <Statistic title="Lỗi khác" value={tally.other} />
            <Statistic title="Thời gian" value={tally.ms} suffix="ms" />
          </Space>
        ) : null}
      </Space>
    </Card>
  );
}
