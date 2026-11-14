'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { AuthProvider, useAuth } from '@/lib/auth';

// Novas seções entram aqui conforme as fases são entregues.
// managerOnly: seções que o atendente não acessa.
const NAV = [
  { href: '/conversas', label: 'Conversas', managerOnly: false },
  { href: '/campanhas', label: 'Campanhas', managerOnly: true },
  { href: '/contatos', label: 'Contatos', managerOnly: true },
  { href: '/numeros', label: 'Números', managerOnly: false },
  { href: '/configuracoes', label: 'Configurações', managerOnly: true },
];

const ROLE_LABEL = { ADMIN: 'Administrador', MANAGER: 'Gestor', AGENT: 'Atendente' } as const;

function Shell({ children }: { children: React.ReactNode }) {
  const { user, logout } = useAuth();
  const pathname = usePathname();
  return (
    <div className="flex h-dvh flex-col md:flex-row">
      <aside className="flex shrink-0 items-center gap-4 border-b border-slate-200 bg-white px-4 py-3 md:w-56 md:flex-col md:items-stretch md:border-b-0 md:border-r md:py-5">
        <div className="hidden text-sm font-semibold tracking-tight sm:block md:px-2 md:pb-3 md:text-base">NewSales WhatsApp</div>
        <nav className="flex min-w-0 flex-1 gap-1 overflow-x-auto md:flex-col md:overflow-visible">
          {NAV.filter((item) => !item.managerOnly || user.role !== 'AGENT').map((item) => {
            const active = pathname.startsWith(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`shrink-0 rounded-lg px-3 py-2 text-sm font-medium ${active ? 'bg-brand-50 text-brand-700' : 'text-slate-600 hover:bg-slate-100'}`}
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
      <main className="min-h-0 min-w-0 flex-1 overflow-y-auto">{children}</main>
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
