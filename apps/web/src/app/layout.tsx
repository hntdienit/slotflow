import { AntdRegistry } from "@ant-design/nextjs-registry";
import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Shell } from "@/components/Shell";
import { SessionProvider } from "@/lib/session";

export const metadata: Metadata = {
  title: "SlotFlow",
  description: "Multi-branch appointment booking",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="vi">
      <body style={{ margin: 0 }}>
        <AntdRegistry>
          <SessionProvider>
            <Shell>{children}</Shell>
          </SessionProvider>
        </AntdRegistry>
      </body>
    </html>
  );
}
