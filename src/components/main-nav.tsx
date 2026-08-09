'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/utils';

const LINKS = [
  { href: '/', label: 'Dashboard' },
  { href: '/draft', label: 'Draft Room' },
  { href: '/board', label: 'Board' },
  { href: '/keepers', label: 'Keepers' },
  { href: '/mock', label: 'Mocks' },
  { href: '/research', label: 'Research' },
  { href: '/league', label: 'League' },
  { href: '/sources', label: 'Sources' },
  { href: '/settings', label: 'Settings' },
];

export function MainNav() {
  const pathname = usePathname();

  return (
    <header className="sticky top-0 z-50 border-b bg-background/95 backdrop-blur">
      <div className="mx-auto flex w-full max-w-[1600px] items-center gap-1 px-4">
        <Link href="/" className="mr-4 flex items-center gap-2 py-3 font-semibold tracking-tight">
          <span className="grid h-6 w-6 place-items-center rounded bg-primary text-[11px] font-bold text-primary-foreground">
            DW
          </span>
          <span className="hidden sm:inline">Draft Workstation</span>
        </Link>

        <nav className="flex flex-1 items-center gap-0.5 overflow-x-auto thin-scroll">
          {LINKS.map((link) => {
            const active = link.href === '/' ? pathname === '/' : pathname.startsWith(link.href);
            return (
              <Link
                key={link.href}
                href={link.href}
                className={cn(
                  'whitespace-nowrap rounded-md px-3 py-1.5 text-sm transition-colors',
                  active
                    ? 'bg-secondary font-medium text-secondary-foreground'
                    : 'text-muted-foreground hover:bg-accent hover:text-foreground',
                )}
              >
                {link.label}
              </Link>
            );
          })}
        </nav>
      </div>
    </header>
  );
}
