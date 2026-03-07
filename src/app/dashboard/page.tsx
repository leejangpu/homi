"use client";

import Link from "next/link";
import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/auth-context";

export default function DashboardPage() {
  const router = useRouter();
  const { user, loading } = useAuth();

  useEffect(() => {
    if (!loading && !user) {
      router.replace("/login");
    }
  }, [user, loading, router]);

  if (loading) {
    return (
      <section className="stack">
        <div className="card">
          <h1 className="title-lg">대시보드</h1>
          <p className="meta-text">로그인 상태를 확인하는 중입니다.</p>
        </div>
      </section>
    );
  }

  if (!user) {
    return (
      <section className="stack">
        <div className="card">
          <h1 className="title-lg">대시보드</h1>
          <p className="meta-text">로그인이 필요합니다.</p>
          <Link href="/login" className="link-button primary-button">
            로그인 페이지로 이동
          </Link>
        </div>
      </section>
    );
  }

  return (
    <section className="stack">
      <div className="card">
        <h1 className="title-lg">대시보드</h1>
        <p className="meta-text">{user.email} 로그인됨</p>
      </div>
    </section>
  );
}
