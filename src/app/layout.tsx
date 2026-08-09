import type { Metadata } from 'next';
import './globals.css';
import { MainNav } from '@/components/main-nav';

export const metadata: Metadata = {
  title: 'Draft Workstation',
  description: 'Private fantasy football draft and in-season decision workstation',
};

/**
 * Dark by default. Drafts happen at night, and the position colours were
 * chosen against the dark palette first.
 */
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark">
      <body className="min-h-screen bg-background font-sans antialiased">
        <MainNav />
        <main className="mx-auto w-full max-w-[1600px] px-4 py-5">{children}</main>
      </body>
    </html>
  );
}
