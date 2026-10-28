import type { WhatsAppStatus } from '@rag/shared';

export interface MediaPayload {
  mimetype: string;
  filename?: string;
  dataBase64: string;
}

export interface InboundMessage {
  waMessageId: string;
  /** Identificador do chat, sempre normalizado para `<número>@c.us` quando possível. */
  waId: string;
  phone: string;
  name?: string;
  body: string;
  /** Segundos desde a época (como o WhatsApp entrega). */
  timestamp: number;
  media?: MediaPayload;
}

/** -1 erro · 0 pendente · 1 enviado · 2 entregue · 3 lido · 4 reproduzido */
export type AckLevel = -1 | 0 | 1 | 2 | 3 | 4;

export type Unsubscribe = () => void;

/**
 * Contrato do canal com o cliente (doc 02 §3). A implementação atual usa whatsapp-web.js; a futura
 * pode ser a WhatsApp Cloud API sem mudar o servidor.
 */
export interface ChannelAdapter {
  start(): Promise<void>;
  stop(): Promise<void>;
  getStatus(): WhatsAppStatus;
  getQr(): string | null;
  onMessage(cb: (m: InboundMessage) => void): Unsubscribe;
  onAck(cb: (waMessageId: string, ack: AckLevel) => void): Unsubscribe;
  onStatus(cb: (s: WhatsAppStatus) => void): Unsubscribe;
  onQr(cb: (qr: string | null) => void): Unsubscribe;
  sendText(waId: string, text: string): Promise<{ waMessageId: string }>;
  sendMedia(waId: string, media: MediaPayload, caption?: string): Promise<{ waMessageId: string }>;
}

/** Emissor simples tipado, compartilhado pelas implementações. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- a tipagem forte fica na assinatura pública
type AnyHandler = (...a: any[]) => void;

export class Emitter<T extends Record<string, unknown[]>> {
  private readonly handlers = new Map<keyof T, Set<AnyHandler>>();
  on<K extends keyof T>(event: K, cb: (...a: T[K]) => void): Unsubscribe {
    const set = this.handlers.get(event) ?? new Set<AnyHandler>();
    set.add(cb);
    this.handlers.set(event, set);
    return () => void set.delete(cb);
  }
  emit<K extends keyof T>(event: K, ...args: T[K]): void {
    for (const cb of this.handlers.get(event) ?? []) {
      try {
        cb(...args);
      } catch {
        /* um ouvinte com erro não pode derrubar o canal */
      }
    }
  }
}

export type ChannelEvents = {
  message: [InboundMessage];
  ack: [string, AckLevel];
  status: [WhatsAppStatus];
  qr: [string | null];
};
