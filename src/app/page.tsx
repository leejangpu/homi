"use client";

import Link from "next/link";
import { useAuth } from "@/lib/auth-context";

export default function HomePage() {
  const { user, loading } = useAuth();

  return (
    <section className="stack">
      <div className="card">
        <h1 className="title-lg">우리 집 통합 웹앱</h1>
        <p className="meta-text">Google 로그인 후 대시보드에서 기능을 관리할 수 있습니다.</p>
      </div>

      <div className="card">
        {loading ? <p>로그인 상태를 확인하는 중...</p> : null}
        {!loading && user ? (
          <Link href="/dashboard" className="link-button primary-button">
            대시보드로 이동
          </Link>
        ) : null}
        {!loading && !user ? (
          <Link href="/login" className="link-button primary-button">
            로그인 시작
          </Link>
        ) : null}
      </div>
    </section>
  );
}
