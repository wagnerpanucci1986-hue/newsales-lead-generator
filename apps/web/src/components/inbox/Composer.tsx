'use client';

import { useRef, useState } from 'react';
import { api, apiUpload } from '@/lib/api';
import { formatSize, type Message } from '@/lib/inbox';

/** Campo de resposta: texto (Enter envia, Shift+Enter quebra linha) e um anexo. */
export function Composer({ conversationId, disabledReason, onSent }: { conversationId: string; disabledReason: string | null; onSent: (m: Message) => void }) {
  const [text, setText] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  async function send() {
    const body = text.trim();
    if (sending || (!body && !file)) return;
    setSending(true);
    setError(null);
    try {
      let res: { message: Message };
      if (file) {
        const form = new FormData();
        // Campos de texto antes do arquivo: o servidor lê o multipart em ordem.
        if (body) form.append('text', body);
        form.append('file', file);
        res = await apiUpload(`/conversations/${conversationId}/messages`, form);
      } else {
        res = await api(`/conversations/${conversationId}/messages`, { method: 'POST', body: { text: body } });
      }
      onSent(res.message);
      setText('');
      setFile(null);
      if (fileInput.current) fileInput.current.value = '';
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Não foi possível enviar');
    } finally {
      setSending(false);
    }
  }

  if (disabledReason) {
    return <p className="border-t border-slate-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">{disabledReason}</p>;
  }

  return (
    <div className="border-t border-slate-200 bg-white p-3">
      {error && <p role="alert" className="mb-2 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
      {file && (
        <div className="mb-2 flex items-center justify-between gap-3 rounded-lg bg-slate-100 px-3 py-2 text-sm">
          <span className="min-w-0 truncate">📎 {file.name} <span className="text-slate-500">({formatSize(file.size)})</span></span>
          <button className="shrink-0 text-slate-500 hover:text-slate-800" aria-label="Remover anexo" onClick={() => { setFile(null); if (fileInput.current) fileInput.current.value = ''; }}>✕</button>
        </div>
      )}
      <div className="flex items-end gap-2">
        <input ref={fileInput} type="file" className="hidden" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        <button className="btn btn-secondary px-3" aria-label="Anexar arquivo" title="Anexar arquivo" onClick={() => fileInput.current?.click()} disabled={sending}>📎</button>
        <textarea
          className="input max-h-40 min-h-[2.5rem] flex-1 resize-y"
          rows={1}
          placeholder={file ? 'Legenda (opcional)' : 'Escreva uma mensagem'}
          aria-label="Mensagem"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void send();
            }
          }}
        />
        <button className="btn btn-primary" onClick={() => void send()} disabled={sending || (!text.trim() && !file)}>{sending ? 'Enviando…' : 'Enviar'}</button>
      </div>
    </div>
  );
}
