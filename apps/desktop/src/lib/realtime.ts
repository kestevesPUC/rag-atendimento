import type { ConversationDTO, MessageDTO } from '@rag/shared';
import { ServerEvents } from '@rag/shared';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { io, type Socket } from 'socket.io-client';
import { refreshSession } from './api';
import { contactName } from './format';
import { useSession } from './session';
import { useUI } from './ui-store';

export const CONVERSATIONS_KEY = ['conversations'] as const;
export const messagesKey = (id: string) => ['messages', id] as const;

let socket: Socket | null = null;
export const getSocket = () => socket;

function upsertConversation(qc: QueryClient, conv: ConversationDTO, mySector: string | null, isAdmin: boolean) {
  qc.setQueryData<ConversationDTO[]>(CONVERSATIONS_KEY, (old = []) => {
    const rest = old.filter((c) => c.id !== conv.id);
    // Saiu do meu setor (transferência): remove da lista.
    if (!isAdmin && conv.sectorId !== mySector) return rest;
    return [conv, ...rest].sort((a, b) => b.lastInteractionAt.localeCompare(a.lastInteractionAt));
  });
}

function notifyQueued(conv: ConversationDTO, prev: ConversationDTO | undefined) {
  if (conv.status !== 'QUEUED' || prev?.status === 'QUEUED') return;
  const text = `Nova conversa na fila: ${contactName(conv.contact)}`;
  useUI.getState().toast('info', text);
  try {
    if ('Notification' in window && Notification.permission === 'granted' && document.hidden) new Notification('RAG Atendimento', { body: text });
  } catch {
    /* notificações indisponíveis */
  }
}

/** Mantém o cache do TanStack Query sincronizado com os eventos do servidor (doc 04 §3). */
export function useRealtime() {
  const qc = useQueryClient();
  const accessToken = useSession((s) => s.accessToken);
  const serverUrl = useSession((s) => s.serverUrl);
  const user = useSession((s) => s.user);

  useEffect(() => {
    if (!accessToken || !user) return;
    const isAdmin = user.role === 'ADMIN';
    const s = io(serverUrl, { auth: { token: accessToken }, transports: ['websocket'], reconnectionDelayMax: 8000 });
    socket = s;

    s.on('connect', () => {
      useSession.getState().setOnline(true);
      // Reconexão: eventos perdidos durante a queda são recuperados relendo as listas.
      void qc.invalidateQueries({ queryKey: CONVERSATIONS_KEY });
      void qc.invalidateQueries({ queryKey: ['messages'] });
    });
    s.on('disconnect', () => useSession.getState().setOnline(false));
    s.on('connect_error', async (err) => {
      useSession.getState().setOnline(false);
      if (err.message === 'UNAUTHENTICATED') await refreshSession(); // novo token → o efeito reconecta
    });

    const onConv = (conv: ConversationDTO) => {
      const prev = qc.getQueryData<ConversationDTO[]>(CONVERSATIONS_KEY)?.find((c) => c.id === conv.id);
      upsertConversation(qc, conv, user.sectorId, isAdmin);
      notifyQueued(conv, prev);
    };
    s.on(ServerEvents.conversationCreated, onConv);
    s.on(ServerEvents.conversationUpdated, onConv);
    s.on(ServerEvents.conversationClosed, onConv);
    s.on(ServerEvents.conversationAssigned, (conv: ConversationDTO) => {
      onConv(conv);
      if (conv.assignedUserId === user.id) useUI.getState().toast('ok', `Conversa atribuída a você: ${contactName(conv.contact)}`);
    });

    s.on(ServerEvents.messageNew, (m: MessageDTO) => {
      qc.setQueryData<MessageDTO[]>(messagesKey(m.conversationId), (old) => {
        if (!old) return old; // só atualiza o que já está aberto; o resto carrega ao abrir
        return old.some((x) => x.id === m.id) ? old : [...old, m];
      });
      const ui = useUI.getState();
      if (m.senderType === 'CUSTOMER' && ui.selectedId !== m.conversationId) ui.bumpUnread(m.conversationId);
    });
    s.on(ServerEvents.messageUpdated, (m: MessageDTO) =>
      qc.setQueryData<MessageDTO[]>(messagesKey(m.conversationId), (old) => old?.map((x) => (x.id === m.id ? m : x))));
    s.on(ServerEvents.messageAck, (p: { id: string; conversationId: string; ack: number }) =>
      qc.setQueryData<MessageDTO[]>(messagesKey(p.conversationId), (old) => old?.map((x) => (x.id === p.id ? { ...x, ack: Math.max(x.ack, p.ack) } : x))));

    s.on(ServerEvents.presence, (p: { type: 'typing' | 'viewing'; conversationId: string; name: string }) =>
      useUI.getState().setPresence(p.conversationId, { name: p.name, type: p.type }));
    s.on(ServerEvents.whatsappStatus, (st) => qc.setQueryData(['wa-status'], st));
    s.on(ServerEvents.whatsappQr, (p: { qr: string | null }) => qc.setQueryData(['wa-qr'], p));
    s.on(ServerEvents.documentUpdated, () => void qc.invalidateQueries({ queryKey: ['documents'] }));

    return () => {
      s.close();
      if (socket === s) socket = null;
    };
  }, [accessToken, serverUrl, user, qc]);
}
