'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { AuthProvider, useAuth } from '@/lib/auth';

// Novas seções entram aqui conforme as fases são entregues.
const NAV = [{ href: '/numeros', label: 'Números' }];

const ROLE_LABEL = { ADMIN: 'Administrador', MANAGER: 'Gestor', AGENT: 'Atendente' } as const;

function Shell({ children }: { children: React.ReactNode }) {
  const { user, logout } = useAuth();
  const pathname = usePathname();
  return (
    <div className="min-h-screen md:flex">
      <aside className="flex shrink-0 items-center gap-4 border-b border-slate-200 bg-white px-4 py-3 md:w-56 md:flex-col md:items-stretch md:border-b-0 md:border-r md:py-5">
        <div className="text-sm font-semibold tracking-tight md:px-2 md:pb-3 md:text-base">NewSales WhatsApp</div>
        <nav className="flex flex-1 gap-1 md:flex-col">
          {NAV.map((item) => {
            const active = pathname.startsWith(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`rounded-lg px-3 py-2 text-sm font-medium ${active ? 'bg-brand-50 text-brand-700' : 'text-slate-600 hover:bg-slate-100'}`}
              >
                {item.label}
              </Link>
            );
          })}
        </nav>
        <div className="flex items-center gap-3 md:flex-col md:items-stretch md:border-t md:border-slate-200 md:pt-4">
          <div className="hidden min-w-0 px-2 md:block">
            <div className="truncate text-sm font-medium">{user.name}</div>
            <div className="text-xs text-slate-500">{ROLE_LABEL[user.role]}</div>
          </div>
          <button onClick={logout} className="btn btn-secondary">Sair</button>
        </div>
      </aside>
      <main className="min-w-0 flex-1 px-4 py-6 md:px-8">{children}</main>
    </div>
  );
}

export default function PanelLayout({ children }: { children: React.ReactNode }) {
  return (
    <AuthProvider>
      <Shell>{children}</Shell>
    </AuthProvider>
  );
}
