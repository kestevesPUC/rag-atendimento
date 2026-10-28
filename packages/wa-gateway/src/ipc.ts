import type { WhatsAppStatus } from '@rag/shared';
import {
  Emitter,
  type AckLevel,
  type ChannelAdapter,
  type ChannelEvents,
  type InboundMessage,
  type MediaPayload,
} from './types';

/** Subconjunto de `process`/`ChildProcess` usado pelo protocolo, para permitir testes em memória. */
export interface Port {
  send(msg: unknown): unknown;
  on(event: 'message', cb: (msg: unknown) => void): unknown;
}

type Command = { t: 'cmd'; id: number; method: CommandName; args: unknown[] };
type Response = { t: 'res'; id: number; ok: boolean; value?: unknown; error?: string };
type Event = { t: 'evt'; name: keyof ChannelEvents; args: unknown[] };
type CommandName = 'start' | 'stop' | 'sendText' | 'sendMedia' | 'snapshot';

interface Snapshot {
  status: WhatsAppStatus;
  qr: string | null;
}

/** Lado do processo-filho: expõe um `ChannelAdapter` real pela porta IPC. */
export function serveChannel(adapter: ChannelAdapter, port: Port): void {
  adapter.onMessage((m) => port.send({ t: 'evt', name: 'message', args: [m] } satisfies Event));
  adapter.onAck((id, ack) => port.send({ t: 'evt', name: 'ack', args: [id, ack] } satisfies Event));
  adapter.onStatus((s) => port.send({ t: 'evt', name: 'status', args: [s] } satisfies Event));
  adapter.onQr((qr) => port.send({ t: 'evt', name: 'qr', args: [qr] } satisfies Event));

  port.on('message', async (raw) => {
    const cmd = raw as Command;
    if (cmd?.t !== 'cmd') return;
    try {
      let value: unknown;
      switch (cmd.method) {
        case 'start':
          await adapter.start();
          break;
        case 'stop':
          await adapter.stop();
          break;
        case 'sendText':
          value = await adapter.sendText(cmd.args[0] as string, cmd.args[1] as string);
          break;
        case 'sendMedia':
          value = await adapter.sendMedia(cmd.args[0] as string, cmd.args[1] as MediaPayload, cmd.args[2] as string | undefined);
          break;
        case 'snapshot':
          value = { status: adapter.getStatus(), qr: adapter.getQr() } satisfies Snapshot;
          break;
      }
      port.send({ t: 'res', id: cmd.id, ok: true, value } satisfies Response);
    } catch (err) {
      port.send({ t: 'res', id: cmd.id, ok: false, error: err instanceof Error ? err.message : String(err) } satisfies Response);
    }
  });
}

/**
 * Lado do servidor: um `ChannelAdapter` que fala com o gateway por IPC. A porta pode ser trocada
 * (`attach`) quando o supervisor reinicia o processo-filho.
 */
export class IpcChannelClient implements ChannelAdapter {
  private readonly events = new Emitter<ChannelEvents>();
  private port: Port | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private status: WhatsAppStatus = { state: 'STOPPED' };
  private qr: string | null = null;
  private wanted = false;

  constructor(private readonly timeoutMs = 60_000) {}

  attach(port: Port): void {
    this.port = port;
    port.on('message', (raw) => this.handle(raw));
    if (this.wanted) void this.start().catch(() => undefined); // reinício do filho: reconecta sozinho
  }

  /** O processo-filho caiu: falha o que estava pendente e marca como desconectado. */
  detach(reason = 'Processo do WhatsApp encerrou.'): void {
    this.port = null;
    for (const p of this.pending.values()) p.reject(new Error(reason));
    this.pending.clear();
    this.status = { state: 'DISCONNECTED', detail: reason };
    this.events.emit('status', this.status);
  }

  private handle(raw: unknown): void {
    const msg = raw as Response | Event;
    if (msg?.t === 'res') {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      msg.ok ? p.resolve(msg.value) : p.reject(new Error(msg.error));
    } else if (msg?.t === 'evt') {
      if (msg.name === 'status') this.status = msg.args[0] as WhatsAppStatus;
      if (msg.name === 'qr') this.qr = msg.args[0] as string | null;
      (this.events.emit as (n: string, ...a: unknown[]) => void)(msg.name, ...msg.args);
    }
  }

  private call<T>(method: CommandName, ...args: unknown[]): Promise<T> {
    const port = this.port;
    if (!port) return Promise.reject(new Error('Gateway do WhatsApp indisponível.'));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Tempo esgotado no gateway (${method}).`));
      }, this.timeoutMs);
      this.pending.set(id, {
        resolve: (v) => (clearTimeout(timer), resolve(v as T)),
        reject: (e) => (clearTimeout(timer), reject(e)),
      });
      port.send({ t: 'cmd', id, method, args } satisfies Command);
    });
  }

  async start() {
    this.wanted = true;
    await this.call('start');
    const snap = await this.call<Snapshot>('snapshot');
    this.status = snap.status;
    this.qr = snap.qr;
  }
  async stop() {
    this.wanted = false;
    await this.call('stop');
  }
  getStatus() {
    return this.status;
  }
  getQr() {
    return this.qr;
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
  sendText(waId: string, text: string) {
    return this.call<{ waMessageId: string }>('sendText', waId, text);
  }
  sendMedia(waId: string, media: MediaPayload, caption?: string) {
    return this.call<{ waMessageId: string }>('sendMedia', waId, media, caption);
  }
}
