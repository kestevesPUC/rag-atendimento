/**
 * Ponto de entrada do processo-filho do gateway. Variáveis de ambiente:
 *   WA_MODE        "real" (whatsapp-web.js) ou "fake" (canal em memória, desenvolvimento)
 *   WA_SESSION_DIR pasta da sessão do WhatsApp (obrigatória no modo real)
 *   WA_CHROME_PATH caminho do Edge/Chrome (opcional; há detecção automática)
 */
import { FakeChannel } from './fake';
import { serveChannel, type Port } from './ipc';
import type { ChannelAdapter } from './types';
import { WhatsAppWebChannel } from './whatsapp';

if (!process.send) throw new Error('worker.ts deve ser executado como processo-filho com canal IPC.');

let adapter: ChannelAdapter;
if (process.env.WA_MODE === 'fake') {
  adapter = new FakeChannel();
} else {
  const sessionDir = process.env.WA_SESSION_DIR;
  if (!sessionDir) throw new Error('WA_SESSION_DIR é obrigatório no modo real.');
  adapter = new WhatsAppWebChannel({ sessionDir });
}
serveChannel(adapter, process as unknown as Port);
process.on('disconnect', () => process.exit(0)); // o servidor morreu: não deixa Chromium órfão
