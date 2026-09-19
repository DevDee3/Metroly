"use client";

import { usePrivy } from "@privy-io/react-auth";

export function ConnectButton() {
  const { ready, authenticated, login, logout, user } = usePrivy();

  if (!ready) {
    return <span className="text-sm text-platform-soft">loading…</span>;
  }

  if (authenticated) {
    const label = user?.email?.address ?? user?.wallet?.address?.slice(0, 6) ?? "you";
    return (
      <button
        onClick={logout}
        className="border border-platform px-3 py-1 text-sm hover:bg-platform hover:text-night transition-colors"
      >
        {label} · sign out
      </button>
    );
  }

  return (
    <button
      onClick={login}
      className="bg-signal text-signal-ink px-4 py-1.5 text-sm font-medium cursor-pointer hover:brightness-95 transition-[filter]"
    >
      Sign in with passkey
    </button>
  );
}
