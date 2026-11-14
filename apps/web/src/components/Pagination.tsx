'use client';

export function Pagination({ page, limit, total, onPage }: { page: number; limit: number; total: number; onPage: (p: number) => void }) {
  const pages = Math.max(1, Math.ceil(total / limit));
  if (total <= limit) return <p className="px-1 py-3 text-sm text-slate-500">{total.toLocaleString('pt-BR')} {total === 1 ? 'registro' : 'registros'}</p>;
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 px-1 py-3 text-sm text-slate-600">
      <span>{((page - 1) * limit + 1).toLocaleString('pt-BR')}–{Math.min(page * limit, total).toLocaleString('pt-BR')} de {total.toLocaleString('pt-BR')}</span>
      <span className="flex items-center gap-2">
        <button className="btn btn-secondary py-1.5" disabled={page <= 1} onClick={() => onPage(page - 1)}>Anterior</button>
        <span>Página {page} de {pages}</span>
        <button className="btn btn-secondary py-1.5" disabled={page >= pages} onClick={() => onPage(page + 1)}>Próxima</button>
      </span>
    </div>
  );
}
