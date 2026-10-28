import { buildApp } from './app';
import { createServices, type ServerOptions, type Services } from './context';
import { attachRealtime } from './realtime';

export interface RunningServer {
  services: Services;
  url: string;
  port: number;
  close(): Promise<void>;
}

/** Sobe API + Socket.IO + jobs + canal do WhatsApp. Usado por `main.ts` e pelo modo Host do Electron. */
export async function startServer(opts: ServerOptions & { port?: number; host?: string; logger?: boolean }): Promise<RunningServer> {
  const services = createServices(opts);
  const app = await buildApp(services, { logger: opts.logger });
  const realtime = attachRealtime(app.server, services);
  await app.listen({ port: opts.port ?? 3333, host: opts.host ?? '127.0.0.1' });
  await services.start();
  const addr = app.server.address();
  const port = typeof addr === 'object' && addr ? addr.port : (opts.port ?? 3333);
  return {
    services,
    port,
    url: `http://${opts.host ?? '127.0.0.1'}:${port}`,
    async close() {
      await realtime.close();
      await app.close();
      await services.close();
    },
  };
}

export { buildApp, createServices, attachRealtime };
export type { ServerOptions, Services };
