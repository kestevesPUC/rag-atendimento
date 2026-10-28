import { describe, expect, it } from 'vitest';
import { FakeChannel, IpcChannelClient, SerialThrottle, serveChannel, type Port } from '../src';

/** Par de portas ligadas em memória, imitando o canal IPC entre dois processos. */
function linkedPorts(): [Port, Port] {
  const handlers: [((m: unknown) => void)[], ((m: unknown) => void)[]] = [[], []];
  const make = (me: 0 | 1): Port => ({
    send: (msg) => void queueMicrotask(() => handlers[me === 0 ? 1 : 0].forEach((h) => h(structuredClone(msg)))),
    on: (_e, cb) => void handlers[me].push(cb),
  });
  return [make(0), make(1)];
}

describe('SerialThrottle', () => {
  it('executa em série respeitando o intervalo mínimo', async () => {
    let clock = 1000;
    const sleeps: number[] = [];
    const t = new SerialThrottle(1000, 0, async (ms) => void (sleeps.push(ms), (clock += ms)), () => clock, () => 0);
    const order: number[] = [];
    await Promise.all([1, 2, 3].map((n) => t.run(async () => void order.push(n))));
    expect(order).toEqual([1, 2, 3]);
    expect(sleeps).toEqual([1000, 1000]); // o primeiro envio sai sem espera
  });

  it('um envio com erro não trava a fila', async () => {
    const t = new SerialThrottle(0, 0, async () => undefined);
    await expect(t.run(async () => Promise.reject(new Error('falhou')))).rejects.toThrow('falhou');
    await expect(t.run(async () => 'ok')).resolves.toBe('ok');
  });
});

describe('IPC entre servidor e gateway', () => {
  const setup = () => {
    const fake = new FakeChannel();
    const [serverSide, workerSide] = linkedPorts();
    serveChannel(fake, workerSide);
    const client = new IpcChannelClient(2000);
    client.attach(serverSide);
    return { fake, client };
  };

  it('repassa mensagens recebidas, status e confirmações', async () => {
    const { fake, client } = setup();
    const got: string[] = [];
    client.onMessage((m) => got.push(m.body));
    const acks: [string, number][] = [];
    client.onAck((id, ack) => acks.push([id, ack]));

    await client.start();
    expect(client.getStatus().state).toBe('READY');
    fake.receive('5511999990000', 'olá');
    fake.ack('x1', 3);
    await new Promise((r) => setTimeout(r, 10));
    expect(got).toEqual(['olá']);
    expect(acks).toEqual([['x1', 3]]);
  });

  it('envia texto e devolve o id da mensagem', async () => {
    const { fake, client } = setup();
    const res = await client.sendText('5511999990000@c.us', '*Maria*\noi');
    expect(res.waMessageId).toMatch(/^fake-out-/);
    expect(fake.sent[0]).toMatchObject({ waId: '5511999990000@c.us', text: '*Maria*\noi' });
  });

  it('propaga o erro do canal ao servidor', async () => {
    const { fake, client } = setup();
    fake.failNextSend = new Error('WhatsApp não está conectado.');
    await expect(client.sendText('1@c.us', 'x')).rejects.toThrow('WhatsApp não está conectado.');
  });

  it('sem processo anexado, envios falham de forma clara; detach rejeita pendências', async () => {
    const client = new IpcChannelClient(2000);
    await expect(client.sendText('1@c.us', 'x')).rejects.toThrow(/indisponível/);

    const [serverSide] = linkedPorts(); // ninguém responde do outro lado
    client.attach(serverSide);
    const pending = client.sendText('1@c.us', 'x');
    client.detach('caiu');
    await expect(pending).rejects.toThrow('caiu');
    expect(client.getStatus().state).toBe('DISCONNECTED');
  });
});
