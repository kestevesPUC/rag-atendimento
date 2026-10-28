import { describe, expect, it } from 'vitest';
import { contactName, fmtAgo, fmtDuration, fmtPercent, fmtPhone, initials } from '../src/lib/format';

describe('formatação', () => {
  it('telefone brasileiro com DDI vira +55 (DD) NNNNN-NNNN; outros formatos ficam como vieram', () => {
    expect(fmtPhone('5511999990000')).toBe('+55 (11) 99999-0000');
    expect(fmtPhone('551133334444')).toBe('+55 (11) 3333-4444');
    expect(fmtPhone('14155550123')).toBe('14155550123');
  });

  it('tempo relativo curto para a lista de conversas', () => {
    const now = Date.parse('2026-03-02T12:00:00Z');
    const ago = (s: number) => new Date(now - s * 1000).toISOString();
    expect(fmtAgo(ago(10), now)).toBe('agora');
    expect(fmtAgo(ago(5 * 60), now)).toBe('5 min');
    expect(fmtAgo(ago(3 * 3600), now)).toBe('3 h');
    expect(fmtAgo(ago(2 * 86400), now)).toBe('2 d');
    expect(fmtAgo(new Date(now + 60_000).toISOString(), now)).toBe('agora'); // relógio do servidor adiantado
  });

  it('durações e percentuais, com traço quando não há dado', () => {
    expect(fmtDuration(null)).toBe('—');
    expect(fmtDuration(42)).toBe('42 s');
    expect(fmtDuration(300)).toBe('5 min');
    expect(fmtDuration(5400)).toBe('1,5 h');
    expect(fmtPercent(null)).toBe('—');
    expect(fmtPercent(0.756)).toBe('76%');
  });

  it('nome do contato cai para o telefone; iniciais usam no máximo duas palavras', () => {
    expect(contactName({ id: '1', waId: 'x', name: '  Maria Souza ', phone: '5511999990000' })).toBe('Maria Souza');
    expect(contactName({ id: '1', waId: 'x', name: null, phone: '5511999990000' })).toBe('+55 (11) 99999-0000');
    expect(initials('Maria da Silva Souza')).toBe('MD');
    expect(initials('   ')).toBe('?');
  });
});
