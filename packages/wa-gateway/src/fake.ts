import type { WhatsAppStatus } from '@rag/shared';
import {
  Emitter,
  type AckLevel,
  type ChannelAdapter,
  type ChannelEvents,
  type InboundMessage,
  type MediaPayload,
} from './types';

export interface SentRecord {
  waId: string;
  text: string;
  media?: MediaPayload;
  waMessageId: string;
}

/**
 * Canal em memória para testes e desenvolvimento sem número de WhatsApp.
 * Registra o que foi "enviado" e permite simular mensagens recebidas e confirmações.
 */
export class FakeChannel implements ChannelAdapter {
  readonly sent: SentRecord[] = [];
  /** Se definido, o próximo envio rejeita com este erro (simula WhatsApp desconectado). */
  failNextSend: Error | null = null;
  private readonly events = new Emitter<ChannelEvents>();
  private status: WhatsAppStatus = { state: 'STOPPED' };
  private seq = 0;

  async start() {
    this.setStatus({ state: 'READY' });
  }
  async stop() {
    this.setStatus({ state: 'STOPPED' });
  }
  getStatus() {
    return this.status;
  }
  getQr() {
    return null;
  }
  setStatus(s: WhatsAppStatus) {
    this.status = s;
    this.events.emit('status', s);
  }

  onMessage(cb: (m: InboundMessage) => void) {
    return this.events.on('message', cb);
  }
  onAck(cb: (id: string, ack: AckLevel) => void) {
    return this.events.on('ack', cb);
  }
  onStatus(cb: (s: WhatsAppStatus) => void) {
    return this.events.on('status', cb);
  }
  onQr(cb: (qr: string | null) => void) {
    return this.events.on('qr', cb);
  }

  private record(waId: string, text: string, media?: MediaPayload) {
    if (this.failNextSend) {
      const err = this.failNextSend;
      this.failNextSend = null;
      throw err;
    }
    const waMessageId = `fake-out-${++this.seq}`;
    this.sent.push({ waId, text, media, waMessageId });
    return { waMessageId };
  }
  async sendText(waId: string, text: string) {
    return this.record(waId, text);
  }
  async sendMedia(waId: string, media: MediaPayload, caption = '') {
    return this.record(waId, caption, media);
  }

  /** Simula o cliente enviando uma mensagem. */
  receive(phone: string, body: string, extra: Partial<InboundMessage> = {}): InboundMessage {
    const msg: InboundMessage = {
      waMessageId: `fake-in-${++this.seq}`,
      waId: `${phone}@c.us`,
      phone,
      body,
      timestamp: Math.floor(Date.now() / 1000),
      ...extra,
    };
    this.events.emit('message', msg);
    return msg;
  }
  /** Simula a confirmação de entrega/leitura de uma mensagem enviada. */
  ack(waMessageId: string, level: AckLevel) {
    this.events.emit('ack', waMessageId, level);
  }
}
