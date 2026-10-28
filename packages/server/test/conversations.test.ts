import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeEnv, type Env } from './helpers';

let env: Env;
beforeEach(async () => void (env = await makeEnv()));
afterEach(async () => env.close());

const PHONE = '5511999990000';

/** Cliente escreve e a fila é processada. Devolve o id da conversa. */
async function customerSays(text: string, phone = PHONE) {
  const msg = env.channel.receive(phone, text);
  await env.drain();
  return env.s.convs.openForContact(env.s.contacts.upsert(msg.waId, phone).id)!;
}

describe('assinatura (RN05/RN06)', () => {
  it('mensagem do atendente vai ao WhatsApp com o nome em negrito; a da IA, sem assinatura', async () => {
    const conv = await customerSays('oi'); // IA responde (sem contexto → transfere); o texto da IA não é assinado
    const aiMsg = env.s.msgs.list(conv.id).find((m) => m.senderType === 'AI')!;
    const sentAi = env.channel.sent.find((s) => s.text.includes('transferir'))!;
    expect(sentAi.text).not.toMatch(/^\*/);
    expect(aiMsg.body).toBe(sentAi.text);

    await env.s.conversations.sendByAgent(env.users.maria, conv.id, 'Olá, vou verificar.');
    await env.drain();
    const last = env.channel.sent.at(-1)!;
    expect(last.text).toBe('*Maria Silva*\nOlá, vou verificar.');
    // no banco: `body` sem assinatura, enviado com assinatura
    const stored = env.s.msgs.list(conv.id).find((m) => m.senderType === 'AGENT')!;
    expect(stored.body).toBe('Olá, vou verificar.');
    expect(stored.senderName).toBe('Maria Silva');
  });

  it('o nome não pode ser forjado: asteriscos no nome de exibição são removidos', async () => {
    const conv = await customerSays('oi');
    const evil = { ...env.users.maria, displayName: '*Gerente*' };
    await env.s.conversations.sendByAgent(evil, conv.id, 'texto');
    await env.drain();
    expect(env.channel.sent.at(-1)!.text).toBe('*Gerente*\ntexto');
  });
});

describe('conversa ativa (RN07)', () => {
  it('conversa iniciada pelo atendente nunca recebe resposta da IA, mesmo se o cliente responder', async () => {
    const dto = await env.s.conversations.startActive(env.users.maria, { phone: '(11) 99999-0000'.replace(/\D/g, ''), text: 'Bom dia, sobre seu boleto.' });
    await env.drain();
    expect(dto).toMatchObject({ origin: 'AGENT', status: 'HUMAN', aiEnabled: false, assignedUserId: env.users.maria.id });
    expect(env.channel.sent[0]!.text).toBe('*Maria Silva*\nBom dia, sobre seu boleto.');
    expect(env.channel.sent[0]!.waId).toBe('5511999990000@c.us'); // DDI 55 acrescentado

    env.channel.receive('5511999990000', 'Ok, pode falar.');
    env.channel.receive('5511999990000', 'Alguém aí?');
    await env.drain();
    expect(env.llm.calls).toHaveLength(0);
    expect(env.s.msgs.list(dto.id).some((m) => m.senderType === 'AI')).toBe(false);
  });

  it('mesmo se o atendente devolver a conversa à fila do setor, a IA continua desligada', async () => {
    const dto = await env.s.conversations.startActive(env.users.maria, { phone: PHONE, text: 'Olá' });
    env.s.conversations.transfer(env.users.maria, dto.id, { sectorId: env.sectors.sup.id });
    env.channel.receive(PHONE, 'pergunta');
    await env.drain();
    expect(env.llm.calls).toHaveLength(0);
    expect(env.s.convs.dto(dto.id)).toMatchObject({ status: 'QUEUED', aiEnabled: false, origin: 'AGENT' });
  });

  it('não abre conversa duplicada para um contato que já tem conversa aberta', async () => {
    await env.s.conversations.startActive(env.users.maria, { phone: PHONE, text: 'Olá' });
    await expect(env.s.conversations.startActive(env.users.joao, { phone: PHONE, text: 'Oi' })).rejects.toMatchObject({ status: 409 });
  });
});

describe('humano assume (RN08)', () => {
  it('ao enviar mensagem a conversa vai para HUMAN e um ai-reply já agendado não gera resposta', async () => {
    env.s.settings.setAi({ debounceSeconds: 3 });
    const msg = env.channel.receive(PHONE, 'preciso de ajuda');
    const conv = env.s.convs.openForContact(env.s.contacts.upsert(msg.waId, PHONE).id)!;
    expect(env.s.jobs.pending('ai-reply')).toBe(1); // aguardando o debounce
    // Conversas ainda sem setor só aparecem para administradores (D-019); simulamos a triagem já feita.
    env.s.convs.patch(conv.id, { sector_id: env.sectors.fin.id });

    await env.s.conversations.sendByAgent(env.users.maria, conv.id, 'Já te atendo!');
    expect(env.s.convs.row(conv.id)).toMatchObject({ status: 'HUMAN', assigned_user_id: env.users.maria.id });

    env.clock.advance(5000);
    await env.drain();
    expect(env.llm.calls).toHaveLength(0);
    expect(env.s.msgs.list(conv.id).filter((m) => m.senderType === 'AI')).toHaveLength(0);
  });

  it('debounce: várias mensagens picadas geram um único ai-reply', async () => {
    env.s.settings.setAi({ debounceSeconds: 3 });
    env.channel.receive(PHONE, 'oi');
    env.clock.advance(1000);
    env.channel.receive(PHONE, 'tudo bem?');
    env.clock.advance(1000);
    env.channel.receive(PHONE, 'queria saber do boleto');
    expect(env.s.jobs.pending('ai-reply')).toBe(1);
  });
});

describe('inatividade (RN09/RN10)', () => {
  it('encerra após o tempo do setor e a próxima mensagem abre uma nova conversa com a IA', async () => {
    env.s.db.prepare(`UPDATE sectors SET closing_message = 'Atendimento encerrado. Obrigado!' WHERE id = ?`).run(env.sectors.fin.id);
    const conv = await customerSays('oi');
    await env.s.conversations.sendByAgent(env.users.maria, conv.id, 'Olá!');
    await env.drain();

    env.clock.minutes(29);
    expect(env.s.conversations.runInactivityCheck()).toEqual({ closed: 0, warned: 0 });
    env.clock.minutes(2);
    expect(env.s.conversations.runInactivityCheck().closed).toBe(1);
    await env.drain();

    const closed = env.s.convs.dto(conv.id)!;
    expect(closed).toMatchObject({ status: 'CLOSED', closeReason: 'INACTIVITY' });
    expect(env.channel.sent.at(-1)!.text).toBe('Atendimento encerrado. Obrigado!');

    const fresh = await customerSays('voltei');
    expect(fresh.id).not.toBe(conv.id);
    expect(env.s.convs.dto(fresh.id)).toMatchObject({ origin: 'CUSTOMER', aiEnabled: expect.any(Boolean) });
    expect(env.llm.count('classificar')).toBeGreaterThan(1); // a IA voltou a atender
  });

  it('qualquer mensagem (cliente, atendente ou IA) renova o prazo', async () => {
    const conv = await customerSays('oi');
    await env.s.conversations.sendByAgent(env.users.maria, conv.id, 'um momento');
    env.clock.minutes(25);
    env.channel.receive(PHONE, 'ainda aqui');
    env.clock.minutes(25);
    expect(env.s.conversations.runInactivityCheck().closed).toBe(0);
  });

  it('na fila, usa o prazo da fila; sem prazo configurado, não encerra', async () => {
    const conv = await customerSays('oi'); // sem contexto → vai para a fila
    expect(env.s.convs.row(conv.id)!.status).toBe('QUEUED');
    env.clock.minutes(600);
    expect(env.s.conversations.runInactivityCheck().closed).toBe(0);
    env.s.db.prepare(`UPDATE sectors SET queue_timeout_min = 120 WHERE id = ?`).run(env.sectors.fin.id);
    expect(env.s.conversations.runInactivityCheck().closed).toBe(1);
  });

  it('aviso prévio a 80% do prazo, uma única vez, sem renovar o prazo', async () => {
    env.s.settings.setAi({ inactivityWarning: true });
    const conv = await customerSays('oi');
    await env.s.conversations.sendByAgent(env.users.maria, conv.id, 'oi');
    await env.drain();
    env.clock.minutes(25); // 25 >= 24 (80% de 30)
    expect(env.s.conversations.runInactivityCheck()).toEqual({ closed: 0, warned: 1 });
    expect(env.s.conversations.runInactivityCheck().warned).toBe(0);
    await env.drain();
    expect(env.channel.sent.at(-1)!.text).toMatch(/Ainda está por aí/);
    env.clock.minutes(6);
    expect(env.s.conversations.runInactivityCheck().closed).toBe(1);
  });
});

describe('assumir da fila (concorrência)', () => {
  it('dois atendentes assumindo ao mesmo tempo: apenas um vence, o outro recebe 409', async () => {
    const conv = await customerSays('oi');
    expect(env.s.convs.row(conv.id)!.status).toBe('QUEUED');
    const results = await Promise.allSettled([
      Promise.resolve().then(() => env.s.conversations.claim(env.users.maria, conv.id)),
      Promise.resolve().then(() => env.s.conversations.claim(env.users.joao, conv.id)),
    ]);
    const ok = results.filter((r) => r.status === 'fulfilled');
    const bad = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(ok).toHaveLength(1);
    expect(bad).toHaveLength(1);
    expect(bad[0]!.reason).toMatchObject({ status: 409 });
    const winner = (ok[0] as PromiseFulfilledResult<{ assignedUserId: string }>).value.assignedUserId;
    expect(env.s.convs.row(conv.id)!.assigned_user_id).toBe(winner);
  });

  it('o atendente que perdeu a corrida não consegue mais responder', async () => {
    const conv = await customerSays('oi');
    env.s.conversations.claim(env.users.maria, conv.id);
    await expect(env.s.conversations.sendByAgent(env.users.joao, conv.id, 'oi')).rejects.toMatchObject({ status: 403 });
  });
});

describe('isolamento por setor (RN03/RNF06)', () => {
  it('atendente de outro setor não lista, lê, envia, assume, transfere nem encerra', async () => {
    const conv = await customerSays('oi'); // setor Financeiro
    const ana = env.users.ana; // Suporte
    expect(env.s.conversations.listForUser(ana)).toHaveLength(0);
    expect(() => env.s.conversations.getForUser(ana, conv.id)).toThrowError(/não encontrad/);
    await expect(env.s.conversations.sendByAgent(ana, conv.id, 'x')).rejects.toMatchObject({ status: 404 });
    expect(() => env.s.conversations.claim(ana, conv.id)).toThrowError(/não encontrad/);
    expect(() => env.s.conversations.transfer(ana, conv.id, { sectorId: env.sectors.sup.id })).toThrowError(/não encontrad/);
    expect(() => env.s.conversations.close(ana, conv.id)).toThrowError(/não encontrad/);
    expect(env.channel.sent.some((m) => m.text.includes('x'))).toBe(false);
  });

  it('administrador vê todos os setores; supervisor só o seu', async () => {
    await customerSays('oi');
    expect(env.s.conversations.listForUser(env.users.admin)).toHaveLength(1);
    expect(env.s.conversations.listForUser(env.users.sup)).toHaveLength(1);
    expect(env.s.conversations.listForUser(env.users.ana)).toHaveLength(0);
  });

  it('eventos em tempo real só vão às salas do setor e dos administradores', async () => {
    const seen: string[][] = [];
    env.s.bus.subscribe((p) => seen.push(p.rooms));
    await customerSays('oi');
    const finRoom = `sector:${env.sectors.fin.id}`;
    const supRoom = `sector:${env.sectors.sup.id}`;
    expect(seen.flat()).toContain(finRoom);
    expect(seen.flat()).toContain('admins');
    expect(seen.flat()).not.toContain(supRoom);
  });
});

describe('transferência e encerramento manual', () => {
  it('transferir para setor: vai à fila do novo setor, sai da visão do antigo e registra nota', async () => {
    const conv = await customerSays('oi');
    env.s.conversations.claim(env.users.maria, conv.id);
    env.s.conversations.transfer(env.users.maria, conv.id, { sectorId: env.sectors.sup.id });
    expect(env.s.convs.row(conv.id)).toMatchObject({ status: 'QUEUED', sector_id: env.sectors.sup.id, assigned_user_id: null });
    expect(() => env.s.conversations.getForUser(env.users.maria, conv.id)).toThrow();
    expect(env.s.conversations.getForUser(env.users.ana, conv.id).id).toBe(conv.id);
    const notes = env.s.msgs.list(conv.id).filter((m) => m.aiMeta?.kind === 'note');
    expect(notes.at(-1)!.body).toMatch(/transferiu a conversa para o setor Suporte Técnico/);
  });

  it('transferir para atendente: o setor informado precisa ser o dele e ele precisa estar ativo', async () => {
    const conv = await customerSays('oi');
    env.s.conversations.claim(env.users.maria, conv.id);
    // setor explícito que não é o da Ana → erro
    expect(() => env.s.conversations.transfer(env.users.maria, conv.id, { userId: env.users.ana.id, sectorId: env.sectors.fin.id })).toThrowError(/não pertence/);
    // atendente inativo → erro
    env.s.users.update(env.users.joao.id, { name: 'joao', displayName: 'João Souza', email: 'joao@x.com', role: 'AGENT', sectorId: env.sectors.fin.id, active: false });
    expect(() => env.s.conversations.transfer(env.users.maria, conv.id, { userId: env.users.joao.id })).toThrowError(/inválido ou inativo/);
    // atendente do mesmo setor e ativo → ok
    const t = env.s.conversations.transfer(env.users.maria, conv.id, { userId: env.users.sup.id });
    expect(t).toMatchObject({ status: 'HUMAN', assignedUserId: env.users.sup.id });
  });

  it('transferir só para um atendente de outro setor leva a conversa ao setor dele', async () => {
    const conv = await customerSays('oi');
    env.s.conversations.claim(env.users.maria, conv.id);
    const t = env.s.conversations.transfer(env.users.maria, conv.id, { userId: env.users.ana.id });
    expect(t).toMatchObject({ status: 'HUMAN', assignedUserId: env.users.ana.id, sectorId: env.sectors.sup.id });
    expect(() => env.s.conversations.getForUser(env.users.maria, conv.id)).toThrow(); // Maria perde a visão
  });

  it('supervisor pode agir em conversa de outro atendente do setor; atendente comum não', async () => {
    const conv = await customerSays('oi');
    env.s.conversations.claim(env.users.maria, conv.id);
    expect(() => env.s.conversations.close(env.users.joao, conv.id)).toThrowError(/permissão/);
    expect(env.s.conversations.close(env.users.sup, conv.id).status).toBe('CLOSED');
  });

  it('mensagens não podem ser enviadas em conversa encerrada', async () => {
    const conv = await customerSays('oi');
    env.s.conversations.claim(env.users.maria, conv.id);
    env.s.conversations.close(env.users.maria, conv.id);
    await expect(env.s.conversations.sendByAgent(env.users.maria, conv.id, 'x')).rejects.toMatchObject({ status: 409 });
  });
});

describe('entrega e confirmações', () => {
  it('mensagem recebida em duplicidade (mesmo id do WhatsApp) é ignorada', async () => {
    const m = env.channel.receive(PHONE, 'oi', { waMessageId: 'dup-1' });
    env.channel.receive(PHONE, 'oi', { waMessageId: m.waMessageId });
    const conv = env.s.convs.openForContact(env.s.contacts.upsert(m.waId, PHONE).id)!;
    expect(env.s.msgs.list(conv.id).filter((x) => x.senderType === 'CUSTOMER')).toHaveLength(1);
  });

  it('falha no envio é retentada com espera; some do estado PENDING quando entrega', async () => {
    const conv = await customerSays('oi');
    await env.s.conversations.sendByAgent(env.users.maria, conv.id, 'tentando');
    env.channel.failNextSend = new Error('WhatsApp não está conectado.');
    await env.drain();
    const pending = env.s.msgs.list(conv.id).find((m) => m.senderType === 'AGENT')!;
    expect(pending.sendStatus).toBe('PENDING');
    env.clock.advance(10_000);
    await env.drain();
    expect(env.s.msgs.get(pending.id)!.sendStatus).toBe('SENT');
  });

  it('depois de 5 falhas a mensagem fica FAILED (visível ao atendente)', async () => {
    const conv = await customerSays('oi');
    await env.s.conversations.sendByAgent(env.users.maria, conv.id, 'nunca vai');
    const id = env.s.msgs.list(conv.id).find((m) => m.senderType === 'AGENT')!.id;
    for (let i = 0; i < 5; i++) {
      env.channel.failNextSend = new Error('offline');
      await env.s.jobs.runDue();
      env.clock.minutes(10);
    }
    expect(env.s.msgs.get(id)!.sendStatus).toBe('FAILED');
  });

  it('confirmação de leitura nunca regride (3 não volta para 2)', async () => {
    const conv = await customerSays('oi');
    await env.s.conversations.sendByAgent(env.users.maria, conv.id, 'x');
    await env.drain();
    const msg = env.s.msgs.list(conv.id).find((m) => m.senderType === 'AGENT')!;
    const waId = env.channel.sent.at(-1)!.waMessageId;
    env.channel.ack(waId, 3);
    env.channel.ack(waId, 2);
    expect(env.s.msgs.get(msg.id)!.ack).toBe(3);
  });
});
