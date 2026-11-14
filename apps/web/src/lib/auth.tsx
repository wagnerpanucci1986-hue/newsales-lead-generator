'use client';

import { useRouter } from 'next/navigation';
import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { logout as apiLogout, refreshSession, type User } from './api';
import { disconnectSocket } from './socket';

interface AuthState {
  user: User;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth fora do AuthProvider');
  return ctx;
}

/** Protege as páginas do painel: sem sessão válida, manda para o login. */
export function AuthProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [user, setUser] = useState<User | null>(null);

  useEffect(() => {
    let active = true;
    refreshSession().then((u) => {
      if (!active) return;
      if (u) setUser(u);
      else router.replace('/login');
    });
    return () => {
      active = false;
    };
  }, [router]);

  const logout = useCallback(async () => {
    disconnectSocket();
    await apiLogout();
    router.replace('/login');
  }, [router]);

  if (!user) {
    return <div className="flex min-h-screen items-center justify-center text-sm text-slate-500">Carregando…</div>;
  }
  return <AuthContext.Provider value={{ user, logout }}>{children}</AuthContext.Provider>;
}
