'use client';

import QRCode from 'qrcode';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import type { NumberStatus, QrPayload, WaNumber } from '@/lib/numbers';
import { useSocketEvent } from '@/lib/socket';
import { Modal } from './Modal';

/** Mostra o QR Code de pareamento e acompanha o status até conectar. */
export function QrModal({ number, onClose }: { number: WaNumber; onClose: () => void }) {
  const [qr, setQr] = useState<QrPayload | null>(null);
  const [image, setImage] = useState<string | null>(null);
  const status: NumberStatus = number.status;

  // QR já emitido antes de a janela abrir.
  useEffect(() => {
    api<{ qr: QrPayload | null }>(`/numbers/${number.id}/qr`)
      .then((r) => r.qr && setQr((current) => current ?? r.qr))
      .catch(() => undefined);
  }, [number.id]);

  useSocketEvent<QrPayload & { numberId: string }>('number.qr', (data) => {
    if (data.numberId === number.id) setQr(data);
  });

  useEffect(() => {
    if (!qr) return setImage(null);
    let active = true;
    QRCode.toDataURL(qr.qr, { width: 280, margin: 1 }).then((url) => active && setImage(url));
    return () => {
      active = false;
    };
  }, [qr]);

  const connected = status === 'CONNECTED';
  const failed = status === 'DISCONNECTED' || status === 'BANNED';

  return (
    <Modal title={`Conectar “${number.nickname}”`} onClose={onClose}>
      {connected ? (
        <div className="space-y-4 text-center">
          <p className="rounded-lg bg-emerald-50 px-3 py-4 text-sm font-medium text-emerald-800">Número conectado.</p>
          <p className="text-sm text-slate-600">O histórico recente começa a ser espelhado agora; isso pode levar alguns minutos.</p>
          <button className="btn btn-primary w-full" onClick={onClose}>Concluir</button>
        </div>
      ) : failed ? (
        <div className="space-y-4">
          <p role="alert" className="rounded-lg bg-red-50 px-3 py-3 text-sm text-red-700">
            {number.statusReason ?? 'Não foi possível conectar.'}
          </p>
          <button className="btn btn-secondary w-full" onClick={onClose}>Fechar</button>
        </div>
      ) : (
        <div className="space-y-4">
          <div className="flex aspect-square w-full items-center justify-center rounded-lg border border-slate-200 bg-white">
            {image && status === 'QR_PENDING' ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={image} alt="QR Code para parear o WhatsApp" className="h-full w-full p-3" />
            ) : (
              <span className="text-sm text-slate-500">{status === 'CONNECTING' && qr ? 'Finalizando conexão…' : 'Gerando QR Code…'}</span>
            )}
          </div>
          {qr && status === 'QR_PENDING' && (
            <p className="text-center text-xs text-slate-500">
              O código se renova sozinho ({qr.attempt} de {qr.maxAttempts}).
            </p>
          )}
          <ol className="list-decimal space-y-1 pl-5 text-sm text-slate-600">
            <li>Abra o WhatsApp no celular deste número.</li>
            <li>Toque em <strong>Mais opções</strong> ou <strong>Configurações</strong> e em <strong>Dispositivos conectados</strong>.</li>
            <li>Toque em <strong>Conectar dispositivo</strong> e aponte a câmera para este código.</li>
          </ol>
        </div>
      )}
    </Modal>
  );
}
