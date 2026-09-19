import type { Metadata } from "next";
import { Space_Grotesk, JetBrains_Mono } from "next/font/google";
import "./globals.css";
import { Providers } from "./providers";

const spaceGrotesk = Space_Grotesk({
  variable: "--font-space-grotesk",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
});

const metroMono = JetBrains_Mono({
  variable: "--font-metro-mono",
  subsets: ["latin"],
  weight: ["400", "500", "600"],
});

export const metadata: Metadata = {
  title: "Metroly — split costs, settle instantly",
  description: "A shared ledger for groups on Monad. Log an expense, settle up onchain, no IOUs.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className={`${spaceGrotesk.variable} ${metroMono.variable} antialiased`}>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
