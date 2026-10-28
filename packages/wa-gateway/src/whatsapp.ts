import { existsSync } from 'node:fs';
import type { WhatsAppStatus } from '@rag/shared';
import { SerialThrottle } from './throttle';
import {
  Emitter,
  type AckLevel,
  type ChannelAdapter,
  type ChannelEvents,
  type InboundMessage,
  type MediaPayload,
} from './types';

export interface WhatsAppWebOptions {
  /** Pasta da sessão (LocalAuth). Mantê-la entre execuções evita escanear o QR de novo. */
  sessionDir: string;
  /** Caminho do Edge/Chrome. Padrão: variável WA_CHROME_PATH ou detecção automática. */
  browserPath?: string;
  minSendDelayMs?: number;
}

const BROWSER_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/microsoft-edge',
];

export function findBrowser(explicit?: string): string {
  const fromEnv = process.env.WA_CHROME_PATH;
  const found = [explicit, fromEnv, ...BROWSER_CANDIDATES].find((p) => p && existsSync(p));
  if (!found) {
    throw new Error('Nenhum Edge/Chrome encontrado. Instale um deles ou defina WA_CHROME_PATH com o caminho do executável.');
  }
  return found;
}

const ACCEPTED_TYPES = new Set(['chat', 'image', 'ptt', 'audio', 'document']);

/* eslint-disable @typescript-eslint/no-explicit-any -- a biblioteca não publica tipos utilizáveis */

/**
 * Canal via whatsapp-web.js (não oficial — ver riscos no doc 01).
 * ATENÇÃO: este arquivo não foi exercitado contra um WhatsApp real (exige QR Code).
 */
export class WhatsAppWebChannel implements ChannelAdapter {
  private readonly events = new Emitter<ChannelEvents>();
  private readonly throttle: SerialThrottle;
  private client: any = null;
  private status: WhatsAppStatus = { state: 'STOPPED' };
  private qr: string | null = null;

  constructor(private readonly opts: WhatsAppWebOptions) {
    this.throttle = new SerialThrottle(opts.minSendDelayMs ?? 1200);
  }

  getStatus() {
    return this.status;
  }
  getQr() {
    return this.qr;
  }
  private setStatus(s: WhatsAppStatus) {
    this.status = s;
    this.events.emit('status', s);
  }
  private setQr(qr: string | null) {
    this.qr = qr;
    this.events.emit('qr', qr);
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

  async start(): Promise<void> {
    if (this.client) return;
    this.setStatus({ state: 'STARTING' });
    const mod: any = await import('whatsapp-web.js');
    const { Client, LocalAuth } = mod.default ?? mod;
    const client = new Client({
      authStrategy: new LocalAuth({ dataPath: this.opts.sessionDir }),
      puppeteer: { headless: true, executablePath: findBrowser(this.opts.browserPath), args: ['--no-sandbox', '--disable-gpu'] },
    });
    this.client = client;

    client.on('qr', (qr: string) => {
      this.setQr(qr);
      this.setStatus({ state: 'QR' });
    });
    client.on('authenticated', () => this.setStatus({ state: 'AUTHENTICATING' }));
    client.on('ready', () => {
      this.setQr(null);
      this.setStatus({ state: 'READY' });
    });
    client.on('auth_failure', (m: string) => this.setStatus({ state: 'DISCONNECTED', detail: `Falha de autenticação: ${m}` }));
    client.on('disconnected', (reason: string) => {
      this.setStatus({ state: 'DISCONNECTED', detail: String(reason) });
      this.client = null;
    });
    client.on('message_ack', (msg: any, ack: number) => this.events.emit('ack', msg.id._serialized, ack as AckLevel));
    client.on('message', (msg: any) => void this.handleInbound(msg));

    client.initialize().catch((err: Error) => {
      this.client = null;
      this.setStatus({ state: 'DISCONNECTED', detail: err.message });
    });
  }

  async stop(): Promise<void> {
    const c = this.client;
    this.client = null;
    if (c) await c.destroy().catch(() => undefined);
    this.setQr(null);
    this.setStatus({ state: 'STOPPED' });
  }

  private async handleInbound(msg: any): Promise<void> {
    try {
      if (msg.fromMe || msg.isStatus || msg.from === 'status@broadcast' || String(msg.from).endsWith('@g.us')) return;
      if (!ACCEPTED_TYPES.has(msg.type)) return;
      const contact = await msg.getContact().catch(() => null);
      // Contas novas podem vir como "@lid"; normalizamos para o número real quando disponível.
      const number: string = contact?.number ?? String(msg.from).split('@')[0];
      let media: MediaPayload | undefined;
      if (msg.hasMedia) {
        const m = await msg.downloadMedia().catch(() => null);
        if (m) media = { mimetype: m.mimetype, filename: m.filename ?? undefined, dataBase64: m.data };
      }
      this.events.emit('message', {
        waMessageId: msg.id._serialized,
        waId: `${number}@c.us`,
        phone: number,
        name: contact?.pushname ?? contact?.name ?? undefined,
        body: msg.body ?? '',
        timestamp: msg.timestamp,
        media,
      });
    } catch {
      /* mensagem malformada não pode derrubar o canal */
    }
  }

  private async resolveChat(waId: string): Promise<string> {
    if (this.status.state !== 'READY' || !this.client) throw new Error('WhatsApp não está conectado.');
    if (!waId.endsWith('@c.us')) return waId;
    const id = await this.client.getNumberId(waId.split('@')[0]);
    if (!id) throw new Error('Este número não está registrado no WhatsApp.');
    return id._serialized;
  }

  sendText(waId: string, text: string) {
    return this.throttle.run(async () => {
      const chat = await this.resolveChat(waId);
      const sent = await this.client.sendMessage(chat, text);
      return { waMessageId: sent.id._serialized as string };
    });
  }

  sendMedia(waId: string, media: MediaPayload, caption?: string) {
    return this.throttle.run(async () => {
      const chat = await this.resolveChat(waId);
      const mod: any = await import('whatsapp-web.js');
      const { MessageMedia } = mod.default ?? mod;
      const sent = await this.client.sendMessage(chat, new MessageMedia(media.mimetype, media.dataBase64, media.filename), { caption });
      return { waMessageId: sent.id._serialized as string };
    });
  }
}
