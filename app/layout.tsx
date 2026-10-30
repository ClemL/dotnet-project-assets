import type { Metadata, Viewport } from 'next';
import { Footer } from '@/components/Footer';
import './globals.css';

export const metadata: Metadata = {
  title: 'Assets Graph',
  description: 'Analyze NuGet project.assets.json files in the browser: dependencies, duplicates, origins, and internal build order.',
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      {/* Column flex, so the footer's margin-top: auto pushes it to the bottom on short pages. */}
      <body className="flex min-h-screen flex-col bg-page text-ink antialiased">
        {children}
        <Footer />
      </body>
    </html>
  );
}
