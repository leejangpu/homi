import type { Metadata } from "next";
import { ReactNode } from "react";
import { AiCommandBar } from "@/components/ai-command-bar";
import { TopNav } from "@/components/top-nav";
import { AuthProvider } from "@/lib/auth-context";
import "./globals.css";

export const metadata: Metadata = {
  title: "HOMI",
  description: "Family personal web app"
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ko">
      <body>
        <AuthProvider>
          <div className="page-shell">
            <TopNav />
            <main className="container">{children}</main>
            <AiCommandBar />
          </div>
        </AuthProvider>
      </body>
    </html>
  );
}
