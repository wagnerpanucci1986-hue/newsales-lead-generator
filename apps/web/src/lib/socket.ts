'use client';

import { useEffect, useRef } from 'react';
import { io, type Socket } from 'socket.io-client';
import { API_URL, getAccessToken, refreshSession } from './api';

let socket: Socket | null = null;

export function getSocket(): Socket {
  if (!socket) {
    // Sem URL, o Socket.IO conecta na própria origem da página.
    socket = io(API_URL || undefined, {
      // Função: cada reconexão usa o token atual, não o da primeira conexão.
      auth: (cb) => cb({ token: getAccessToken() }),
      transports: ['websocket', 'polling'],
    });
    // Token expirado na reconexão: renova e tenta de novo.
    socket.on('connect_error', async (err) => {
      if (err.message === 'unauthorized' && (await refreshSession())) socket?.connect();
    });
  }
  return socket;
}

export function disconnectSocket(): void {
  socket?.disconnect();
  socket = null;
}

/** Assina um evento de tempo real enquanto o componente estiver montado. */
export function useSocketEvent<T>(event: string, handler: (data: T) => void): void {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    const s = getSocket();
    const listener = (data: T) => ref.current(data);
    s.on(event, listener);
    return () => {
      s.off(event, listener);
    };
  }, [event]);
}
