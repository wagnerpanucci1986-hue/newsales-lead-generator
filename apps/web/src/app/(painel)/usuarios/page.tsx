'use client';

import { useCallback, useEffect, useState } from 'react';
import { Modal } from '@/components/Modal';
import { Pagination } from '@/components/Pagination';
import { api, type Role } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { formatDateTime } from '@/lib/crm';
import type { WaNumber } from '@/lib/numbers';

interface UserRow {
  id: string; name: string; email: string; role: Role; active: boolean; totpEnabled: boolean; lastLoginAt: string | null; numberIds: string[];
}
interface AuditEntry { id: string; action: string; entity: string | null; entityId: string | null; meta: unknown; ip: string | null; createdAt: string; user: { name: string; email: string } | null }

const ROLE_LABEL: Record<Role, string> = { ADMIN: 'Administrador', MANAGER: 'Gestor', AGENT: 'Atendente' };
const ROLE_HELP: Record<Role, string> = {
  ADMIN: 'Acesso total, incluindo usuários, auditoria e parâmetros de anti-banimento.',
  MANAGER: 'Números, contatos, campanhas, automações e todas as conversas.',
  AGENT: 'Somente as conversas dos números marcados abaixo.',
};
const blank = { name: '', email: '', role: 'AGENT' as Role, password: '', active: true, numberIds: [] as string[], resetTwoFactor: false };

function UsersTab({ numbers }: { numbers: WaNumber[] }) {
  const { user: me } = useAuth();
  const [users, setUsers] = useState<UserRow[] | null>(null);
  const [editing, setEditing] = useState<{ id?: string; totp?: boolean; form: typeof blank } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  const load = useCallback(() => api<{ users: UserRow[] }>('/users').then((r) => setUsers(r.users)).catch((err) => setError(err.message)), []);
  useEffect(() => void load(), [load]);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!editing) return;
    setFormError(null);
    const { password, resetTwoFactor, ...rest } = editing.form;
    try {
      const body = { ...rest, ...(password ? { password } : {}), ...(resetTwoFactor ? { resetTwoFactor: true } : {}) };
      await api(editing.id ? `/users/${editing.id}` : '/users', { method: editing.id ? 'PATCH' : 'POST', body });
      setEditing(null);
      await load();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Não foi possível salvar');
    }
  }
  const setForm = <K extends keyof typeof blank>(k: K, v: (typeof blank)[K]) => setEditing((s) => (s ? { ...s, form: { ...s.form, [k]: v } } : s));
  const f = editing?.form;

  return (
    <div>
      <div className="mb-3 flex justify-end">
        <button className="btn btn-primary" onClick={() => { setFormError(null); setEditing({ form: blank }); }}>Novo usuário</button>
      </div>
      {error && <p role="alert" className="mb-3 rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">{error}</p>}
      <div className="card overflow-x-auto">
        <table className="w-full min-w-[720px] text-left text-sm">
          <thead className="border-b border-slate-200 bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
            <tr><th className="px-3 py-2.5">Usuário</th><th className="px-3 py-2.5">Perfil</th><th className="px-3 py-2.5">Números</th><th className="px-3 py-2.5">2 etapas</th><th className="px-3 py-2.5">Último acesso</th><th className="px-3 py-2.5 text-right">Ações</th></tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {users?.map((u) => (
              <tr key={u.id} className={u.active ? '' : 'text-slate-400'}>
                <td className="px-3 py-2.5"><p className="font-medium">{u.name}{u.id === me.id && ' (você)'}</p><p className="text-xs text-slate-500">{u.email}</p></td>
                <td className="px-3 py-2.5">{ROLE_LABEL[u.role]}{!u.active && <span className="ml-2 rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-600">Desativado</span>}</td>
                <td className="px-3 py-2.5 text-slate-600">{u.role !== 'AGENT' ? 'Todos' : u.numberIds.map((id) => numbers.find((n) => n.id === id)?.nickname).filter(Boolean).join(', ') || 'Nenhum'}</td>
                <td className="px-3 py-2.5">{u.totpEnabled ? 'Ativa' : '—'}</td>
                <td className="px-3 py-2.5 text-slate-600">{formatDateTime(u.lastLoginAt)}</td>
                <td className="px-3 py-2.5 text-right">
                  <button className="text-sm font-medium text-brand-700 hover:underline" onClick={() => { setFormError(null); setEditing({ id: u.id, totp: u.totpEnabled, form: { ...blank, name: u.name, email: u.email, role: u.role, active: u.active, numberIds: u.numberIds } }); }}>Editar</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {editing && f && (
        <Modal title={editing.id ? 'Editar usuário' : 'Novo usuário'} onClose={() => setEditing(null)}>
          <form onSubmit={save} className="space-y-3">
            <div><label className="label" htmlFor="u-name">Nome</label><input id="u-name" className="input" required value={f.name} onChange={(e) => setForm('name', e.target.value)} /></div>
            <div><label className="label" htmlFor="u-email">E-mail</label><input id="u-email" type="email" className="input" required value={f.email} onChange={(e) => setForm('email', e.target.value)} /></div>
            <div>
              <label className="label" htmlFor="u-role">Perfil</label>
              <select id="u-role" className="input" value={f.role} onChange={(e) => setForm('role', e.target.value as Role)}>
                {(Object.keys(ROLE_LABEL) as Role[]).map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
              </select>
              <p className="mt-1 text-xs text-slate-500">{ROLE_HELP[f.role]}</p>
            </div>
            {f.role === 'AGENT' && (
              <fieldset>
                <legend className="label">Números que este atendente pode ver</legend>
                <div className="flex flex-wrap gap-2">
                  {numbers.map((n) => (
                    <label key={n.id} className="flex cursor-pointer items-center gap-1.5 rounded-lg border border-slate-200 px-2.5 py-1.5 text-sm">
                      <input type="checkbox" className="accent-emerald-600" checked={f.numberIds.includes(n.id)} onChange={(e) => setForm('numberIds', e.target.checked ? [...f.numberIds, n.id] : f.numberIds.filter((x) => x !== n.id))} />
                      {n.nickname}
                    </label>
                  ))}
                  {numbers.length === 0 && <p className="text-sm text-slate-500">Nenhum número cadastrado.</p>}
                </div>
              </fieldset>
            )}
            <div>
              <label className="label" htmlFor="u-password">{editing.id ? 'Nova senha (deixe em branco para manter)' : 'Senha inicial'}</label>
              <input id="u-password" type="password" autoComplete="new-password" className="input" required={!editing.id} minLength={10} value={f.password} onChange={(e) => setForm('password', e.target.value)} />
              <p className="mt-1 text-xs text-slate-500">Mínimo de 10 caracteres. {editing.id && 'Trocar a senha encerra as sessões abertas do usuário.'}</p>
            </div>
            {editing.id && (
              <>
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" className="h-4 w-4 accent-emerald-600" checked={f.active} onChange={(e) => setForm('active', e.target.checked)} />
                  Usuário ativo
                </label>
                {editing.totp && (
                  <label className="flex items-start gap-2 text-sm">
                    <input type="checkbox" className="mt-0.5 h-4 w-4 accent-emerald-600" checked={f.resetTwoFactor} onChange={(e) => setForm('resetTwoFactor', e.target.checked)} />
                    <span>Desligar a verificação em duas etapas deste usuário <span className="block text-xs text-slate-500">Use quando a pessoa perdeu o celular e os códigos de recuperação.</span></span>
                  </label>
                )}
              </>
            )}
            {formError && <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{formError}</p>}
            <div className="flex justify-end gap-2">
              <button type="button" className="btn btn-secondary" onClick={() => setEditing(null)}>Cancelar</button>
              <button type="submit" className="btn btn-primary">Salvar</button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}

const ACTION_GROUPS = [['', 'Todas as ações'], ['auth.', 'Acesso'], ['user.', 'Usuários'], ['number.', 'Números'], ['campaign.', 'Campanhas'], ['contact.', 'Contatos'], ['blacklist.', 'Lista de bloqueio'], ['conversation.', 'Conversas'], ['automation.', 'Automações'], ['settings.', 'Configurações']] as const;

function AuditTab() {
  const [page, setPage] = useState(1);
  const [action, setAction] = useState('');
  const [data, setData] = useState<{ entries: AuditEntry[]; total: number; limit: number } | null>(null);

  useEffect(() => {
    api<{ entries: AuditEntry[]; total: number; limit: number }>(`/audit?page=${page}${action ? `&action=${action}` : ''}`).then(setData).catch(() => undefined);
  }, [page, action]);

  return (
    <div>
      <select className="input mb-3 w-auto" aria-label="Tipo de ação" value={action} onChange={(e) => { setPage(1); setAction(e.target.value); }}>
        {ACTION_GROUPS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
      </select>
      <div className="card overflow-x-auto">
        <table className="w-full min-w-[720px] text-left text-sm">
          <thead className="border-b border-slate-200 bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
            <tr><th className="px-3 py-2.5">Quando</th><th className="px-3 py-2.5">Quem</th><th className="px-3 py-2.5">Ação</th><th className="px-3 py-2.5">Detalhes</th><th className="px-3 py-2.5">IP</th></tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {data?.entries.map((e) => (
              <tr key={e.id} className="align-top">
                <td className="whitespace-nowrap px-3 py-2.5 text-slate-600">{formatDateTime(e.createdAt)}</td>
                <td className="px-3 py-2.5">{e.user?.name ?? 'Sistema'}</td>
                <td className="px-3 py-2.5 font-mono text-xs">{e.action}</td>
                <td className="max-w-md break-words px-3 py-2.5 font-mono text-xs text-slate-600">{e.meta ? JSON.stringify(e.meta) : ''}</td>
                <td className="px-3 py-2.5 text-slate-600">{e.ip ?? '—'}</td>
              </tr>
            ))}
            {data?.entries.length === 0 && <tr><td colSpan={5} className="px-3 py-8 text-center text-slate-500">Nenhum registro.</td></tr>}
          </tbody>
        </table>
      </div>
      {data && <Pagination page={page} limit={data.limit} total={data.total} onPage={setPage} />}
    </div>
  );
}

export default function UsersPage() {
  const [tab, setTab] = useState<'users' | 'audit'>('users');
  const [numbers, setNumbers] = useState<WaNumber[]>([]);
  useEffect(() => {
    api<{ numbers: WaNumber[] }>('/numbers').then((r) => setNumbers(r.numbers)).catch(() => undefined);
  }, []);
  return (
    <div className="mx-auto max-w-6xl px-4 py-6 md:px-8">
      <h1 className="text-xl font-semibold">Usuários</h1>
      <div role="tablist" className="mb-5 mt-3 flex gap-1 border-b border-slate-200">
        {([['users', 'Usuários'], ['audit', 'Log de auditoria']] as const).map(([key, label]) => (
          <button key={key} role="tab" aria-selected={tab === key} onClick={() => setTab(key)} className={`-mb-px border-b-2 px-3 py-2 text-sm font-medium ${tab === key ? 'border-brand-600 text-brand-700' : 'border-transparent text-slate-500 hover:text-slate-800'}`}>{label}</button>
        ))}
      </div>
      {tab === 'users' ? <UsersTab numbers={numbers} /> : <AuditTab />}
    </div>
  );
}
