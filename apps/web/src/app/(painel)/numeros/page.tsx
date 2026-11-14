'use client';

import { useCallback, useEffect, useState } from 'react';
import { NumberForm } from '@/components/NumberForm';
import { QrModal } from '@/components/QrModal';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { formatPhone, STATUS_INFO, type NumberStatus, type WaNumber } from '@/lib/numbers';
import { useSocketEvent } from '@/lib/socket';

type Dialog = { kind: 'create' } | { kind: 'edit'; id: string } | { kind: 'qr'; id: string } | null;

export default function NumbersPage() {
  const { user } = useAuth();
  const canManage = user.role !== 'AGENT';
  const [numbers, setNumbers] = useState<WaNumber[] | null>(null);
  const [max, setMax] = useState(10);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await api<{ numbers: WaNumber[]; max: number }>('/numbers');
      setNumbers(res.numbers);
      setMax(res.max);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Não foi possível carregar os números');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Status em tempo real, vindo do worker.
  useSocketEvent<{ numberId: string; status: NumberStatus; phone: string | null; reason: string | null }>('number.status', (e) => {
    setNumbers((list) => list?.map((n) => (n.id === e.numberId ? { ...n, status: e.status, phone: e.phone ?? n.phone, statusReason: e.reason } : n)) ?? list);
  });

  async function act(number: WaNumber, action: 'connect' | 'disconnect' | 'logout' | 'delete') {
    const confirmText = {
      logout: `Desvincular “${number.nickname}” do WhatsApp? Será preciso ler o QR Code de novo para reconectar.`,
      delete: `Remover “${number.nickname}”? O aparelho será desvinculado. As conversas já espelhadas são mantidas.`,
    }[action as 'logout' | 'delete'];
    if (confirmText && !window.confirm(confirmText)) return;

    setError(null);
    setBusy(number.id);
    try {
      if (action === 'delete') {
        await api(`/numbers/${number.id}`, { method: 'DELETE' });
        setNumbers((list) => list?.filter((n) => n.id !== number.id) ?? list);
      } else {
        await api(`/numbers/${number.id}/${action}`, { method: 'POST' });
        if (action === 'connect') setDialog({ kind: 'qr', id: number.id });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Não foi possível concluir a operação');
    } finally {
      setBusy(null);
    }
  }

  const selected = dialog && 'id' in dialog ? numbers?.find((n) => n.id === dialog.id) : undefined;
  const full = (numbers?.length ?? 0) >= max;

  return (
    <div className="mx-auto max-w-6xl px-4 py-6 md:px-8">
      <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Números</h1>
          <p className="text-sm text-slate-500">
            {numbers ? `${numbers.length} de ${max} números cadastrados` : 'Carregando…'}
          </p>
        </div>
        {canManage && (
          <button className="btn btn-primary" disabled={full} onClick={() => setDialog({ kind: 'create' })} title={full ? `Limite de ${max} números atingido` : undefined}>
            Adicionar número
          </button>
        )}
      </div>

      {full && canManage && (
        <p className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          Limite de {max} números atingido. Remova um número para cadastrar outro.
        </p>
      )}
      {error && <p role="alert" className="mb-4 rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">{error}</p>}

      {numbers?.length === 0 && (
        <div className="card px-6 py-12 text-center">
          <p className="font-medium">Nenhum número cadastrado</p>
          <p className="mt-1 text-sm text-slate-500">
            {canManage ? 'Adicione um número e leia o QR Code com o celular para começar.' : 'Nenhum número foi atribuído a você ainda.'}
          </p>
        </div>
      )}

      <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {numbers?.map((n) => {
          const info = STATUS_INFO[n.status];
          const live = n.status === 'CONNECTED' || n.status === 'CONNECTING' || n.status === 'QR_PENDING';
          return (
            <li key={n.id} className="card flex flex-col overflow-hidden">
              <div className="h-1.5" style={{ backgroundColor: n.color }} />
              <div className="flex flex-1 flex-col gap-4 p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h2 className="truncate font-semibold">{n.nickname}</h2>
                    <p className="text-sm text-slate-500">{formatPhone(n.phone)}</p>
                  </div>
                  <span className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-medium ring-1 ring-inset ${info.className}`}>{info.label}</span>
                </div>

                {n.statusReason && n.status !== 'CONNECTED' && <p className="text-sm text-slate-600">{n.statusReason}</p>}

                <dl className="grid grid-cols-3 gap-2 text-center">
                  {[
                    ['Conversas', n.conversations],
                    ['Mensagens', n.messages],
                    ['Limite/dia', n.dailyLimit],
                  ].map(([label, value]) => (
                    <div key={label} className="rounded-lg bg-slate-50 px-2 py-2">
                      <dd className="text-sm font-semibold tabular-nums">{Number(value).toLocaleString('pt-BR')}</dd>
                      <dt className="text-xs text-slate-500">{label}</dt>
                    </div>
                  ))}
                </dl>

                {canManage && (
                  <div className="mt-auto flex flex-wrap gap-2">
                    {n.status === 'QR_PENDING' ? (
                      <button className="btn btn-primary" onClick={() => setDialog({ kind: 'qr', id: n.id })}>Ver QR Code</button>
                    ) : !live ? (
                      <button className="btn btn-primary" disabled={busy === n.id} onClick={() => act(n, 'connect')}>Conectar</button>
                    ) : null}
                    {live && <button className="btn btn-secondary" disabled={busy === n.id} onClick={() => act(n, 'disconnect')}>Desconectar</button>}
                    <button className="btn btn-secondary" onClick={() => setDialog({ kind: 'edit', id: n.id })}>Editar</button>
                    {n.phone && <button className="btn btn-secondary" disabled={busy === n.id} onClick={() => act(n, 'logout')}>Desvincular</button>}
                    <button className="btn btn-danger" disabled={busy === n.id} onClick={() => act(n, 'delete')}>Remover</button>
                  </div>
                )}
              </div>
            </li>
          );
        })}
      </ul>

      {dialog?.kind === 'create' && (
        <NumberForm
          onClose={() => setDialog(null)}
          onSaved={() => {
            setDialog(null);
            void load();
          }}
        />
      )}
      {dialog?.kind === 'edit' && selected && (
        <NumberForm
          number={selected}
          onClose={() => setDialog(null)}
          onSaved={() => {
            setDialog(null);
            void load();
          }}
        />
      )}
      {dialog?.kind === 'qr' && selected && (
        <QrModal
          number={selected}
          onClose={() => {
            setDialog(null);
            void load();
          }}
        />
      )}
    </div>
  );
}
