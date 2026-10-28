import { z } from 'zod';

// ---------- Enums (espelham o doc 04) ----------
export const Role = { ADMIN: 'ADMIN', SUPERVISOR: 'SUPERVISOR', AGENT: 'AGENT' } as const;
export type Role = (typeof Role)[keyof typeof Role];

export const ConvStatus = { BOT: 'BOT', QUEUED: 'QUEUED', HUMAN: 'HUMAN', CLOSED: 'CLOSED' } as const;
export type ConvStatus = (typeof ConvStatus)[keyof typeof ConvStatus];

export const ConvOrigin = { CUSTOMER: 'CUSTOMER', AGENT: 'AGENT' } as const;
export type ConvOrigin = (typeof ConvOrigin)[keyof typeof ConvOrigin];

export const SenderType = { CUSTOMER: 'CUSTOMER', AI: 'AI', AGENT: 'AGENT', SYSTEM: 'SYSTEM' } as const;
export type SenderType = (typeof SenderType)[keyof typeof SenderType];

export const CloseReason = {
  RESOLVED_AI: 'RESOLVED_AI',
  RESOLVED_AGENT: 'RESOLVED_AGENT',
  INACTIVITY: 'INACTIVITY',
  MANUAL: 'MANUAL',
} as const;
export type CloseReason = (typeof CloseReason)[keyof typeof CloseReason];

export const DocStatus = { PENDING: 'PENDING', PROCESSING: 'PROCESSING', READY: 'READY', FAILED: 'FAILED' } as const;
export type DocStatus = (typeof DocStatus)[keyof typeof DocStatus];

export type SendStatus = 'PENDING' | 'SENT' | 'FAILED';

// ---------- Entidades expostas pela API ----------
export interface SectorDTO {
  id: string;
  name: string;
  description: string;
  inactivityMinutes: number;
  queueTimeoutMin: number | null;
  welcomeMessage: string | null;
  closingMessage: string | null;
  businessHours: BusinessHours | null;
}

export interface UserDTO {
  id: string;
  name: string;
  displayName: string;
  email: string;
  role: Role;
  sectorId: string | null;
  active: boolean;
}

export interface ContactDTO {
  id: string;
  waId: string;
  name: string | null;
  phone: string;
}

export interface ConversationDTO {
  id: string;
  contact: ContactDTO;
  sectorId: string | null;
  assignedUserId: string | null;
  origin: ConvOrigin;
  status: ConvStatus;
  aiEnabled: boolean;
  failedAiAttempts: number;
  summary: string | null;
  lastInteractionAt: string;
  closedAt: string | null;
  closeReason: CloseReason | null;
  createdAt: string;
  lastMessagePreview: string | null;
}

export interface MessageDTO {
  id: string;
  conversationId: string;
  senderType: SenderType;
  senderUserId: string | null;
  senderName: string | null;
  body: string;
  mediaUrl: string | null;
  mediaType: string | null;
  ack: number;
  sendStatus: SendStatus;
  aiMeta: AiMeta | null;
  feedback: 1 | -1 | null;
  createdAt: string;
}

export interface AiMeta {
  /** `note` = anotação interna (não vai ao WhatsApp); `system` = aviso automático enviado ao cliente. */
  kind?: 'answer' | 'menu' | 'transfer' | 'welcome' | 'note' | 'system';
  usedChunkIds?: number[];
  sources?: { chunkId: number; title: string; score: number; excerpt: string }[];
  topScore?: number;
  model?: string;
  latencyMs?: number;
  reason?: string;
}

// ---------- Horário de atendimento ----------
export const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;
export type DayKey = (typeof DAY_KEYS)[number];
export const businessHoursSchema = z.object({
  tz: z.string().default('America/Sao_Paulo'),
  days: z.record(z.enum(DAY_KEYS), z.array(z.tuple([z.string().regex(/^\d{2}:\d{2}$/), z.string().regex(/^\d{2}:\d{2}$/)]))),
});
export type BusinessHours = z.infer<typeof businessHoursSchema>;

// ---------- Schemas de entrada ----------
export const loginSchema = z.object({ email: z.string().email(), password: z.string().min(1) });
export const refreshSchema = z.object({ refreshToken: z.string().min(10) });

export const sectorInputSchema = z.object({
  name: z.string().trim().min(2).max(60),
  description: z.string().trim().min(3).max(500),
  inactivityMinutes: z.number().int().min(1).max(24 * 60).default(30),
  queueTimeoutMin: z.number().int().min(1).max(7 * 24 * 60).nullable().default(null),
  welcomeMessage: z.string().max(1000).nullable().default(null),
  closingMessage: z.string().max(1000).nullable().default(null),
  businessHours: businessHoursSchema.nullable().default(null),
});

export const userInputSchema = z.object({
  name: z.string().trim().min(2).max(80),
  displayName: z.string().trim().min(2).max(60),
  email: z.string().email(),
  password: z.string().min(8).max(128),
  role: z.enum(['ADMIN', 'SUPERVISOR', 'AGENT']),
  sectorId: z.string().nullable().default(null),
  active: z.boolean().default(true),
});

export const startConversationSchema = z.object({
  // Aceita "(11) 99999-0000", "+55 11 99999-0000" etc.: remove a formatação antes de validar.
  phone: z
    .string()
    .transform((v) => v.replace(/[\s().-]/g, ''))
    .pipe(z.string().regex(/^\+?\d{10,15}$/, 'Telefone deve ter 10 a 15 dígitos')),
  text: z.string().trim().min(1).max(4000),
  name: z.string().max(80).optional(),
});
export const sendMessageSchema = z.object({ text: z.string().trim().min(1).max(4000) });
export const transferSchema = z
  .object({ sectorId: z.string().optional(), userId: z.string().optional() })
  .refine((v) => v.sectorId || v.userId, 'Informe sectorId ou userId');
export const quickReplySchema = z.object({
  sectorId: z.string().nullable().default(null),
  shortcut: z.string().regex(/^[a-z0-9_-]{2,30}$/i),
  body: z.string().trim().min(1).max(2000),
});

export const aiSettingsSchema = z.object({
  companyName: z.string().trim().min(1).max(80).default('nossa empresa'),
  assistantName: z.string().trim().min(1).max(40).default('Assistente'),
  tone: z.string().max(600).default('Cordial, objetivo e empático.'),
  relevanceThreshold: z.number().min(0).max(1).default(0.55),
  maxFailedAttempts: z.number().int().min(1).max(10).default(3),
  debounceSeconds: z.number().min(0).max(30).default(3),
  alwaysHumanKeywords: z.array(z.string().trim().min(2)).default([]),
  inactivityWarning: z.boolean().default(false),
  defaultSectorId: z.string().nullable().default(null),
  triageModel: z.string().default('claude-haiku-5-5'),
  answerModel: z.string().default('claude-sonnet-5-5'),
});
export type AiSettings = z.infer<typeof aiSettingsSchema>;

export const faqInputSchema = z.object({
  question: z.string().trim().min(3).max(500),
  answer: z.string().trim().min(3).max(4000),
  sectorIds: z.array(z.string()).default([]),
});
export const urlInputSchema = z.object({ url: z.string().url(), sectorIds: z.array(z.string()).default([]) });
export const playgroundSchema = z.object({ question: z.string().trim().min(2).max(1000), sectorId: z.string().nullable().default(null) });

// ---------- Socket.IO ----------
export const ServerEvents = {
  conversationCreated: 'conversation:created',
  conversationUpdated: 'conversation:updated',
  conversationClosed: 'conversation:closed',
  conversationAssigned: 'conversation:assigned',
  messageNew: 'message:new',
  messageAck: 'message:ack',
  messageUpdated: 'message:updated',
  whatsappStatus: 'whatsapp:status',
  whatsappQr: 'whatsapp:qr',
  documentUpdated: 'document:updated',
  presence: 'presence',
} as const;
export const ClientEvents = { typing: 'typing', viewing: 'viewing' } as const;

export type WhatsAppState = 'STOPPED' | 'STARTING' | 'QR' | 'AUTHENTICATING' | 'READY' | 'DISCONNECTED';
export interface WhatsAppStatus { state: WhatsAppState; detail?: string }

// ---------- Utilidades ----------
export const normalizePhone = (raw: string): string => raw.replace(/\D/g, '');
export const phoneToWaId = (raw: string): string => `${normalizePhone(raw)}@c.us`;
export const waIdToPhone = (waId: string): string => waId.split('@')[0] ?? waId;

/** Assinatura em negrito do WhatsApp (RN05). Fonte única da regra, usada pelo servidor. */
export const signAgentMessage = (displayName: string, text: string): string =>
  `*${displayName.replace(/\*/g, '')}*\n${text}`;
