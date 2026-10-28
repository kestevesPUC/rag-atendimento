import type { ConvStatus, ConversationDTO, WhatsAppState } from '@rag/shared';

const timeFmt = new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit' });
const dateFmt = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' });

export const fmtTime = (iso: string) => timeFmt.format(new Date(iso));
export const fmtDate = (iso: string) => dateFmt.format(new Date(iso));

/** "agora", "5 min", "2 h", "3 d" — curto, para a lista de conversas. */
export function fmtAgo(iso: string, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (s < 60) return 'agora';
  if (s < 3600) return `${Math.floor(s / 60)} min`;
  if (s < 86400) return `${Math.floor(s / 3600)} h`;
  return `${Math.floor(s / 86400)} d`;
}

export function fmtDuration(seconds: number | null): string {
  if (seconds === null) return '—';
  if (seconds < 60) return `${Math.round(seconds)} s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} min`;
  return `${(seconds / 3600).toFixed(1).replace('.', ',')} h`;
}

export const fmtPercent = (v: number | null) => (v === null ? '—' : `${Math.round(v * 100)}%`);

/** 5511999990000 → +55 (11) 99999-0000 */
export function fmtPhone(phone: string): string {
  const d = phone.replace(/\D/g, '');
  const m = /^55(\d{2})(\d{4,5})(\d{4})$/.exec(d);
  return m ? `+55 (${m[1]}) ${m[2]}-${m[3]}` : phone;
}

export const contactName = (c: ConversationDTO['contact']) => c.name?.trim() || fmtPhone(c.phone);
export const initials = (name: string) =>
  name.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]!.toUpperCase()).join('') || '?';

export const STATUS_LABEL: Record<ConvStatus, string> = {
  BOT: 'IA atendendo', QUEUED: 'Na fila', HUMAN: 'Em atendimento', CLOSED: 'Finalizada',
};
export const WA_LABEL: Record<WhatsAppState, string> = {
  STOPPED: 'Desconectado', STARTING: 'Iniciando…', QR: 'Aguardando QR Code', AUTHENTICATING: 'Autenticando…',
  READY: 'Conectado', DISCONNECTED: 'Desconectado',
};
export const ROLE_LABEL = { ADMIN: 'Administrador', SUPERVISOR: 'Supervisor', AGENT: 'Atendente' } as const;
export const CLOSE_LABEL: Record<string, string> = {
  RESOLVED_AI: 'Resolvida pela IA', RESOLVED_AGENT: 'Resolvida pelo atendente', INACTIVITY: 'Inatividade', MANUAL: 'Encerrada manualmente',
};
export const REASON_LABEL: Record<string, string> = {
  LOW_CONFIDENCE: 'Pergunta fora da base', MODEL_NEEDS_HUMAN: 'IA pediu um humano', CUSTOMER_REQUEST: 'Cliente pediu atendente',
  NEGATIVE_SENTIMENT: 'Cliente insatisfeito', ALWAYS_HUMAN_TOPIC: 'Assunto sempre humano', MAX_ATTEMPTS: 'Várias respostas sem resolver',
  LLM_UNAVAILABLE: 'IA indisponível', SECTOR_UNKNOWN: 'Setor não identificado', MEDIA_ONLY: 'Mensagem sem texto',
};
