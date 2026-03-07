"use client";

import { httpsCallable } from "firebase/functions";
import { FormEvent, useState } from "react";
import { usePathname } from "next/navigation";
import { useAuth } from "@/lib/auth-context";
import { functions } from "@/lib/firebase/client";

interface AiCommandPayload {
  text: string;
  path: string;
  uid: string;
}

export function AiCommandBar() {
  const pathname = usePathname();
  const { user } = useAuth();
  const [text, setText] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState("");

  if (!user) {
    return null;
  }

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmed = text.trim();
    if (!trimmed || submitting) {
      return;
    }

    setSubmitting(true);
    setMessage("");
    try {
      const callable = httpsCallable<AiCommandPayload, { accepted?: boolean; message?: string }>(functions, "aiCommand");
      const result = await callable({
        text: trimmed,
        path: pathname || "/",
        uid: user.uid
      });
      setMessage(result.data?.message || "AI 요청이 접수되었습니다. (Function shell)");
      setText("");
    } catch {
      setMessage("AI Function shell 호출에 실패했습니다. (백엔드 미구현 상태)");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="ai-bar-shell">
      <form className="ai-bar" onSubmit={handleSubmit}>
        <input
          className="ai-bar__input"
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder='예: "오늘 월급 300만원 들어왔어 입력해줘"'
        />
        <button className="primary-button ai-bar__button" disabled={submitting || !text.trim()} type="submit">
          {submitting ? "요청 중..." : "AI 입력"}
        </button>
      </form>
      {message ? <p className="ai-bar__message">{message}</p> : null}
    </div>
  );
}
