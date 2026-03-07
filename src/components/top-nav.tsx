"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useAuth } from "@/lib/auth-context";

export function TopNav() {
  const pathname = usePathname();
  const router = useRouter();
  const { user, signOutUser } = useAuth();

  const handleSignOut = async () => {
    await signOutUser();
    router.replace("/login");
  };

  return (
    <header className="top-nav">
      <div className="top-nav__left">
        <Link href="/" className="brand">
          HOMI
        </Link>
        {user ? (
          <>
            <Link href="/dashboard" className={pathname === "/dashboard" ? "active-link" : "muted-link"}>
              Dashboard
            </Link>
          </>
        ) : null}
      </div>
      <div className="top-nav__right">
        {user ? <span className="user-email">{user.email}</span> : null}
        {user ? (
          <button type="button" className="ghost-button" onClick={handleSignOut}>
            로그아웃
          </button>
        ) : (
          <Link href="/login" className="ghost-button link-button">
            로그인
          </Link>
        )}
      </div>
    </header>
  );
}
