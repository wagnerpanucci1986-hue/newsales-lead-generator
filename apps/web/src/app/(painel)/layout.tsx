'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { AuthProvider, useAuth } from '@/lib/auth';

// Novas seções entram aqui conforme as fases são entregues.
// roles: quem enxerga a seção (o servidor também barra o acesso).
const ALL = ['ADMIN', 'MANAGER', 'AGENT'] as const;
const MANAGERS = ['ADMIN', 'MANAGER'] as const;
const NAV: { href: string; label: string; roles: readonly string[] }[] = [
  { href: '/dashboard', label: 'Visão geral', roles: ALL },
  { href: '/conversas', label: 'Conversas', roles: ALL },
  { href: '/captacao', label: 'Captação', roles: MANAGERS },
  { href: '/campanhas', label: 'Campanhas', roles: MANAGERS },
  { href: '/contatos', label: 'Contatos', roles: MANAGERS },
  { href: '/automacoes', label: 'Automações', roles: MANAGERS },
  { href: '/numeros', label: 'Números', roles: ALL },
  { href: '/usuarios', label: 'Usuários', roles: ['ADMIN'] },
  { href: '/configuracoes', label: 'Configurações', roles: MANAGERS },
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
          {NAV.filter((item) => item.roles.includes(user.role)).map((item) => {
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
          <Link href="/perfil" className="min-w-0 rounded-lg px-2 py-1 hover:bg-slate-100" title="Minha conta: senha e verificação em duas etapas">
            <div className="truncate text-sm font-medium">{user.name}</div>
            <div className="hidden text-xs text-slate-500 md:block">{ROLE_LABEL[user.role]}</div>
          </Link>
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
