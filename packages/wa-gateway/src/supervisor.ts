import { fork, type ChildProcess } from 'node:child_process';
import type { IpcChannelClient } from './ipc';

export interface SuperviseOptions {
  /** Arquivo do worker (src/worker.ts em desenvolvimento; arquivo empacotado em produção). */
  entry: string;
  /** Ex.: ['--import', 'tsx'] para executar TypeScript em desenvolvimento. */
  execArgv?: string[];
  env?: NodeJS.ProcessEnv;
  client: IpcChannelClient;
  log?: (msg: string) => void;
}

const MAX_BACKOFF_MS = 30_000;
const STABLE_AFTER_MS = 60_000;

/**
 * Mantém o gateway (Chromium pesado) em um processo separado e o reinicia se cair,
 * sem derrubar o servidor (doc 02 §3). Reinício com espera crescente.
 */
export function superviseGateway(opts: SuperviseOptions): { stop(): void } {
  const log = opts.log ?? (() => undefined);
  let child: ChildProcess | null = null;
  let stopped = false;
  let failures = 0;
  let timer: NodeJS.Timeout | undefined;

  const spawn = () => {
    const startedAt = Date.now();
    child = fork(opts.entry, [], {
      execArgv: opts.execArgv ?? [],
      env: { ...process.env, ...opts.env },
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    });
    opts.client.attach(child);
    child.on('exit', (code, signal) => {
      opts.client.detach(`Gateway do WhatsApp encerrou (código ${code ?? signal}).`);
      child = null;
      if (stopped) return;
      failures = Date.now() - startedAt > STABLE_AFTER_MS ? 1 : failures + 1;
      const delay = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** (failures - 1));
      log(`gateway caiu; reiniciando em ${delay} ms`);
      timer = setTimeout(spawn, delay);
    });
  };
  spawn();

  return {
    stop() {
      stopped = true;
      clearTimeout(timer);
      child?.kill();
    },
  };
}
