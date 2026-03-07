"use client";

import { FirebaseError } from "firebase/app";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/auth-context";

function toAuthErrorMessage(error: unknown): string {
  if (error instanceof FirebaseError) {
    switch (error.code) {
      case "auth/configuration-not-found":
        return "Google 로그인 설정을 찾을 수 없습니다. Firebase Console에서 Google 제공자를 활성화하고 저장해 주세요.";
      case "auth/popup-closed-by-user":
        return "구글 로그인 팝업이 닫혔습니다.";
      case "auth/popup-blocked":
        return "브라우저에서 팝업이 차단되었습니다. 팝업 허용 후 다시 시도해 주세요.";
      case "auth/cancelled-popup-request":
        return "다른 로그인 팝업 요청이 진행 중입니다. 잠시 후 다시 시도해 주세요.";
      case "unavailable":
      case "auth/network-request-failed":
        return "네트워크 연결 상태를 확인해 주세요.";
      default:
        return `오류가 발생했습니다. (${error.code})`;
    }
  }

  if (error instanceof Error) {
    return error.message;
  }

  return "인증 처리 중 알 수 없는 오류가 발생했습니다.";
}

export default function LoginPage() {
  const router = useRouter();
  const { user, loading, signInWithGoogle } = useAuth();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!loading && user) {
      router.replace("/dashboard");
    }
  }, [loading, user, router]);

  const handleGoogleSignIn = async () => {
    if (submitting) {
      return;
    }
    setSubmitting(true);
    setError("");
    try {
      await signInWithGoogle();
      router.replace("/dashboard");
    } catch (error) {
      setError(toAuthErrorMessage(error));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section className="card">
      <h1 className="title-md">Google 로그인</h1>
      <p className="meta-text">이 서비스는 Google 계정 로그인만 지원합니다.</p>
      <button style={{ marginTop: 12 }} type="button" className="primary-button" disabled={submitting} onClick={handleGoogleSignIn}>
        {submitting ? "처리 중..." : "Google로 계속하기"}
      </button>
      {error ? <p className="error-text">{error}</p> : null}
    </section>
  );
}
