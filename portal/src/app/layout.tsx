import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = { title: "Devenum AI — Command Center", description: "Autonomous Virtual Software House" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark">
      <body>{children}</body>
    </html>
  );
}
