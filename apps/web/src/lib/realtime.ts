'use client';
import { useEffect, useRef, useState } from 'react';
import { io, type Socket } from 'socket.io-client';
import { useAuth } from './auth-store';

let socket: Socket | null = null;
let socketToken: string | null = null;

function socketUrl() {
  if (process.env.NEXT_PUBLIC_WS_URL) return process.env.NEXT_PUBLIC_WS_URL;
  const { protocol, hostname, port, origin } = window.location;
  // In local dev the web app (3000) and API (4000) run on different ports; in production they share an origin.
  return port === '3000' ? `${protocol}//${hostname}:4000` : origin;
}

function connect(token: string) {
  if (socket && socketToken === token) return socket;
  socket?.disconnect();
  socketToken = token;
  socket = io(`${socketUrl()}/realtime`, { auth: { token }, transports: ['websocket', 'polling'], reconnectionDelayMax: 10_000 });
  return socket;
}

/**
 * Subscribes to realtime events (optionally joining a branch room) and calls `onEvent` for each.
 * Returns whether the socket is currently connected so pages can fall back to polling.
 */
export function useRealtime(events: string[], onEvent: (event: string, data: unknown) => void, branchId?: string | null) {
  const token = useAuth((s) => s.accessToken);
  const handler = useRef(onEvent);
  handler.current = onEvent;
  const [connected, setConnected] = useState(false);
  const key = events.join(',');

  useEffect(() => {
    if (!token) return;
    const s = connect(token);
    const join = () => {
      setConnected(true);
      if (branchId) s.emit('subscribe', { branchId });
    };
    const drop = () => setConnected(false);
    const listeners = key.split(',').map((evt) => [evt, (data: unknown) => handler.current(evt, data)] as const);
    s.on('connect', join);
    s.on('disconnect', drop);
    for (const [evt, fn] of listeners) s.on(evt, fn);
    if (s.connected) join();
    return () => {
      s.off('connect', join);
      s.off('disconnect', drop);
      for (const [evt, fn] of listeners) s.off(evt, fn);
    };
  }, [token, branchId, key]);

  return connected;
}
