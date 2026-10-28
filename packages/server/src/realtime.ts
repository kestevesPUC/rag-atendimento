import type { Server as HttpServer } from 'node:http';
import { Server, type Socket } from 'socket.io';
import { ClientEvents, ServerEvents } from '@rag/shared';
import type { AuthUser } from './auth';
import { rooms } from './bus';
import type { Services } from './context';

interface SocketData {
  user: AuthUser;
  token: string;
}

const RECHECK_MS = 30_000;

/**
 * Socket.IO (doc 04 §3). Cada usuário entra SOMENTE nas próprias salas (setor, usuário e, se
 * administrador, `admins`) — o isolamento por setor vale para o tempo real, não só para a API.
 */
export function attachRealtime(httpServer: HttpServer, s: Services): { close(): Promise<void> } {
  const io = new Server<Record<string, never>, Record<string, never>, Record<string, never>, SocketData>(httpServer, {
    cors: { origin: true },
    maxHttpBufferSize: 64 * 1024,
  });

  io.use((socket, next) => {
    try {
      const token = (socket.handshake.auth as { token?: string } | undefined)?.token;
      if (!token) return next(new Error('UNAUTHENTICATED'));
      socket.data = { user: s.auth.authenticate(token), token };
      next();
    } catch {
      next(new Error('UNAUTHENTICATED'));
    }
  });

  io.on('connection', (socket: Socket) => {
    const { user, token } = (socket as Socket & { data: SocketData }).data;
    void socket.join(rooms.user(user.id));
    if (user.sectorId) void socket.join(rooms.sector(user.sectorId));
    if (user.role === 'ADMIN') void socket.join(rooms.admins);
    socket.emit(ServerEvents.whatsappStatus, user.role === 'ADMIN' ? s.channel.getStatus() : { state: s.channel.getStatus().state });

    // Se o token expirar ou o usuário for desativado/mudar de setor, derruba: o app reconecta com credenciais novas.
    const recheck = setInterval(() => {
      try {
        const now = s.auth.authenticate(token);
        if (now.sectorId !== user.sectorId || now.role !== user.role) socket.disconnect(true);
      } catch {
        socket.disconnect(true);
      }
    }, RECHECK_MS);
    recheck.unref?.();
    socket.on('disconnect', () => clearInterval(recheck));

    // Presença: só repassa a quem está na mesma sala do setor da conversa, e só se o usuário pode lê-la.
    const relay = (type: 'typing' | 'viewing') => (payload: unknown) => {
      const id = (payload as { conversationId?: unknown } | null)?.conversationId;
      if (typeof id !== 'string') return;
      const conv = s.convs.row(id);
      if (!conv || !s.conversations.canRead(user, conv)) return;
      const targets = conv.sector_id ? [rooms.sector(conv.sector_id), rooms.admins] : [rooms.admins];
      socket.to(targets).emit(ServerEvents.presence, { type, conversationId: id, userId: user.id, name: user.displayName });
    };
    socket.on(ClientEvents.typing, relay('typing'));
    socket.on(ClientEvents.viewing, relay('viewing'));
  });

  // Repassa os eventos de domínio; quem decide as salas são os serviços.
  const unsubscribe = s.bus.subscribe((p) => void io.to(p.rooms).emit(p.event, p.payload));

  return {
    async close() {
      unsubscribe();
      await io.close();
    },
  };
}
