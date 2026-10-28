import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FakeChannel, IpcChannelClient, superviseGateway, type ChannelAdapter } from '@rag/wa-gateway';
import pino from 'pino';
import { startServer } from './server';

/**
 * Execução independente do servidor (desenvolvimento e testes manuais).
 * Variáveis: PORT, HOST, DATA_DIR, WA_MODE=real|fake (padrão fake), ANTHROPIC_API_KEY.
 * O Electron, no modo Host, chama `startServer` diretamente.
 */
const log = pino({ level: process.env.LOG_LEVEL ?? 'info' });
const dataDir = process.env.DATA_DIR ?? join(process.env.APPDATA ?? homedir(), 'RagAtendimento', 'data');
const mode = process.env.WA_MODE ?? 'fake';

let channel: ChannelAdapter;
let stopGateway = () => {};
if (mode === 'real') {
  // O Chromium do WhatsApp roda em outro processo e é reiniciado se cair (doc 02 §3).
  const client = new IpcChannelClient();
  const sup = superviseGateway({
    entry: fileURLToPath(new URL('../../wa-gateway/src/worker.ts', import.meta.url)),
    execArgv: ['--import', 'tsx'],
    env: { WA_MODE: 'real', WA_SESSION_DIR: join(dataDir, 'wa-session') },
    client,
    log: (m) => log.warn(m),
  });
  stopGateway = sup.stop;
  channel = client;
} else {
  channel = new FakeChannel();
  log.warn('WA_MODE=fake: nenhuma mensagem real será enviada ou recebida.');
}

const server = await startServer({
  dataDir, channel, log,
  port: Number(process.env.PORT ?? 3333),
  host: process.env.HOST ?? '127.0.0.1',
});
log.info({ url: server.url, dataDir }, 'servidor iniciado');
if (server.services.users.count() === 0) log.warn('Nenhum usuário cadastrado: crie o administrador pelo assistente do app (POST /setup).');

const shutdown = async () => {
  stopGateway();
  await server.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
