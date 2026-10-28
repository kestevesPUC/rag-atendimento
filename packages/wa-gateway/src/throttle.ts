/**
 * Fila serial com intervalo mínimo e variação aleatória entre envios, para imitar ritmo humano e
 * reduzir o risco de banimento do número (doc 01, seção de riscos). Uma única fila por conta.
 */
export class SerialThrottle {
  private tail: Promise<unknown> = Promise.resolve();
  private lastRun = 0;

  constructor(
    private readonly minDelayMs = 1200,
    private readonly jitterMs = 800,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
    private readonly now: () => number = Date.now,
    private readonly random: () => number = Math.random,
  ) {}

  run<T>(task: () => Promise<T>): Promise<T> {
    const result = this.tail.then(async () => {
      const wait = this.lastRun + this.minDelayMs + Math.floor(this.random() * this.jitterMs) - this.now();
      if (this.lastRun > 0 && wait > 0) await this.sleep(wait);
      try {
        return await task();
      } finally {
        this.lastRun = this.now();
      }
    });
    this.tail = result.catch(() => undefined); // um envio com erro não trava a fila
    return result;
  }
}
