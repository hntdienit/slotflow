"use client";
import { Button, Card, Input, List, Space, Typography } from "antd";
import { useState } from "react";
import { api } from "@/lib/api";
import { useSession } from "@/lib/session";

interface Msg {
  from: "me" | "bot";
  text: string;
}
interface Reply {
  conversationId: string;
  reply: string;
  awaiting: string | null;
  options: unknown[];
  booking?: { id: string };
}

/** Talks to POST /assistant/messages. The server owns the conversation, so refreshing the page loses nothing important. */
export function Chat({
  customerId,
  onBooked,
}: {
  customerId: string | null;
  onBooked?: () => void;
}) {
  const { tenantId } = useSession();
  const [msgs, setMsgs] = useState<Msg[]>([
    { from: "bot", text: 'Xin chào! Bạn có thể nhắn: "đặt Khám tổng quát chiều mai sau 3 giờ".' },
  ]);
  const [text, setText] = useState("");
  const [conv, setConv] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  async function send() {
    const message = text.trim();
    if (!message || !customerId) return;
    setText("");
    setMsgs((m) => [...m, { from: "me", text: message }]);
    setBusy(true);
    try {
      const r = await api<Reply>(tenantId, "/assistant/messages", {
        body: { message, conversationId: conv },
        headers: { "x-customer-id": customerId },
      });
      setConv(r.conversationId);
      setMsgs((m) => [...m, { from: "bot", text: r.reply }]);
      if (r.booking) onBooked?.();
    } catch (e) {
      setMsgs((m) => [...m, { from: "bot", text: `Lỗi: ${(e as Error).message}` }]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title="Trợ lý đặt lịch" size="small">
      <List
        size="small"
        dataSource={msgs}
        style={{ maxHeight: 360, overflow: "auto", marginBottom: 12 }}
        renderItem={(m) => (
          <List.Item style={{ justifyContent: m.from === "me" ? "flex-end" : "flex-start" }}>
            <Typography.Text
              style={{
                whiteSpace: "pre-line",
                background: m.from === "me" ? "#e6f4ff" : "#f5f5f5",
                padding: "4px 10px",
                borderRadius: 8,
              }}
            >
              {m.text}
            </Typography.Text>
          </List.Item>
        )}
      />
      <Space.Compact style={{ width: "100%" }}>
        <Input
          value={text}
          maxLength={500}
          disabled={!customerId}
          placeholder={customerId ? "Nhập tin nhắn…" : "Chọn khách ở bước 4 trước"}
          onChange={(e) => setText(e.target.value)}
          onPressEnter={() => void send()}
        />
        <Button type="primary" loading={busy} disabled={!customerId} onClick={() => void send()}>
          Gửi
        </Button>
      </Space.Compact>
    </Card>
  );
}
