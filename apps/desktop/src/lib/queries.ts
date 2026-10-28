import type { ConversationDTO, MessageDTO, SectorDTO, WhatsAppStatus } from '@rag/shared';
import { useQuery } from '@tanstack/react-query';
import { api } from './api';
import { CONVERSATIONS_KEY, messagesKey } from './realtime';

export interface QuickReply { id: string; sectorId: string | null; shortcut: string; body: string }
export interface DirectoryUser { id: string; displayName: string; sectorId: string | null }

export const useConversations = () =>
  useQuery({ queryKey: CONVERSATIONS_KEY, queryFn: () => api<ConversationDTO[]>('/conversations'), refetchInterval: 60_000 });

export const useMessages = (id: string | null) =>
  useQuery({ queryKey: messagesKey(id ?? ''), queryFn: () => api<MessageDTO[]>(`/conversations/${id}/messages`), enabled: !!id, staleTime: 30_000 });

export const useSectors = () => useQuery({ queryKey: ['sectors'], queryFn: () => api<SectorDTO[]>('/sectors'), staleTime: 60_000 });

export const useDirectory = () => useQuery({ queryKey: ['directory'], queryFn: () => api<DirectoryUser[]>('/directory'), staleTime: 60_000 });

export const useQuickReplies = () => useQuery({ queryKey: ['quick-replies'], queryFn: () => api<QuickReply[]>('/quick-replies'), staleTime: 60_000 });

export const useWaStatus = (enabled: boolean) =>
  useQuery({ queryKey: ['wa-status'], queryFn: () => api<WhatsAppStatus>('/whatsapp/status'), enabled, refetchInterval: 15_000 });
