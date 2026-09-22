"use client";

import { PrivyProvider } from "@privy-io/react-auth";
import { WagmiProvider } from "@privy-io/wagmi";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { monadTestnet } from "@/lib/chains";
import { wagmiConfig } from "@/lib/wagmiConfig";

/// Set NEXT_PUBLIC_PRIVY_APP_ID in .env.local — create an app at
/// https://dashboard.privy.io to get one.
///
/// Login methods: passkey + email give a first-time user a wallet with no
/// seed phrase, but "wallet" is included too so someone who already has a
/// wallet on their phone isn't locked out. Per Privy's own docs,
/// `wallet_connect_qr` is desktop-only and never appears on mobile browsers
/// at all — so a mobile-only walletList would silently strand mobile wallet
/// users, which defeats the point. `wallet_connect` (the full WalletConnect
/// registry, not the QR-only variant) works on both desktop and mobile, so
/// it's listed alongside a couple of common named wallets that get a direct
/// deep-link button on mobile instead of round-tripping through the registry.
const PRIVY_APP_ID = process.env.NEXT_PUBLIC_PRIVY_APP_ID ?? "";

/// PrivyProvider throws synchronously (crashing the whole render tree with a
/// 500, not a catchable in-app error) when given an empty app ID. So rather
/// than let that happen on a fresh checkout with no .env.local yet, check
/// for it up front and show a plain setup screen instead of ever mounting
/// PrivyProvider/WagmiProvider — which also means nothing downstream can
/// call usePrivy()/useAccount() against a provider that was never rendered.
export function Providers({ children }: { children: ReactNode }) {
  const [queryClient] = useState(() => new QueryClient());

  if (!PRIVY_APP_ID) {
    return (
      <main className="min-h-screen flex items-center justify-center px-6 text-center">
        <div className="max-w-md">
          <h1 className="font-display text-xl font-semibold mb-3">Metroly isn&apos;t configured yet</h1>
          <p className="text-platform-soft text-sm">
            Set <code className="font-mono text-platform">NEXT_PUBLIC_PRIVY_APP_ID</code> in{" "}
            <code className="font-mono text-platform">frontend/.env.local</code> — create an app at{" "}
            <a href="https://dashboard.privy.io" className="underline text-platform" target="_blank" rel="noreferrer">
              dashboard.privy.io
            </a>{" "}
            to get one, then restart the dev server.
          </p>
        </div>
      </main>
    );
  }

  return (
    <PrivyProvider
      appId={PRIVY_APP_ID}
      config={{
        loginMethods: ["passkey", "email", "wallet"],
        appearance: {
          theme: "dark",
          accentColor: "#FFC53D",
          logo: undefined,
          walletList: ["metamask", "rainbow", "coinbase_wallet", "wallet_connect"],
        },
        embeddedWallets: {
          ethereum: { createOnLogin: "users-without-wallets" },
        },
        defaultChain: monadTestnet,
        supportedChains: [monadTestnet],
      }}
    >
      <QueryClientProvider client={queryClient}>
        <WagmiProvider config={wagmiConfig}>{children}</WagmiProvider>
      </QueryClientProvider>
    </PrivyProvider>
  );
}
