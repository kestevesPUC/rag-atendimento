import type { ConversationDTO, MessageDTO } from '@rag/shared';
import { ClientEvents } from '@rag/shared';
import { useQueryClient } from '@tanstack/react-query';
import { Fragment, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { ConfirmDialog, Empty, Message, Modal, StatusTag, Tag } from '../components';
import { api, errMsg } from '../lib/api';
import { CLOSE_LABEL, REASON_LABEL, contactName, fmtDate, fmtPhone, initials } from '../lib/format';
import { Icon } from '../lib/icons';
import { useDirectory, useMessages, useQuickReplies, useSectors } from '../lib/queries';
import { CONVERSATIONS_KEY, getSocket, messagesKey } from '../lib/realtime';
import { useSession } from '../lib/session';
import { useUI } from '../lib/ui-store';
import { Bubble } from './Bubble';
import { TransferDialog } from './TransferDialog';

const TYPING_MS = 2500;

export function Chat({ conv, onBack }: { conv: ConversationDTO; onBack(): void }) {
  const me = useSession((s) => s.user)!;
  const qc = useQueryClient();
  const toast = useUI((s) => s.toast);
  const presence = useUI((s) => s.presence[conv.id]);
  const { data: messages = [], isLoading, isError } = useMessages(conv.id);
  const { data: sectors = [] } = useSectors();
  const { data: people = [] } = useDirectory();
  const { data: quick = [] } = useQuickReplies();

  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [transferOpen, setTransferOpen] = useState(false);
  const [closeOpen, setCloseOpen] = useState(false);
  const [baseMsg, setBaseMsg] = useState<MessageDTO | null>(null);
  const [qIdx, setQIdx] = useState(0);
  const bodyRef = useRef<HTMLDivElement>(null);
  const lastTyping = useRef(0);

  const closed = conv.status === 'CLOSED';
  const takenByOther = conv.status === 'HUMAN' && conv.assignedUserId !== me.id && me.role === 'AGENT';
  const canAddToBase = me.role !== 'AGENT' || !!me.sectorId;
  const assignee = people.find((p) => p.id === conv.assignedUserId)?.displayName;
  const sectorName = sectors.find((s) => s.id === conv.sectorId)?.name ?? 'Sem setor';
  const transferMsg = [...messages].reverse().find((m) => m.aiMeta?.kind === 'transfer');

  // Presença: avisa os colegas que estou olhando esta conversa.
  useEffect(() => {
    getSocket()?.emit(ClientEvents.viewing, { conversationId: conv.id });
  }, [conv.id]);

  // Rola para o fim quando chegam mensagens.
  useEffect(() => {
    const el = bodyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length, conv.id]);

  const quickMatches = useMemo(() => {
    if (!text.startsWith('/') || /\s/.test(text)) return [];
    const term = text.slice(1).toLowerCase();
    return quick.filter((r) => r.shortcut.startsWith(term)).slice(0, 8);
  }, [text, quick]);
  useEffect(() => setQIdx(0), [quickMatches.length]);

  const patchConv = (c: ConversationDTO) =>
    qc.setQueryData<ConversationDTO[]>(CONVERSATIONS_KEY, (old = []) => old.map((x) => (x.id === c.id ? c : x)));

  async function claim() {
    try {
      patchConv(await api<ConversationDTO>(`/conversations/${conv.id}/claim`, { method: 'POST' }));
      toast('ok', 'Você assumiu a conversa.');
    } catch (e) {
      toast('err', errMsg(e));
      void qc.invalidateQueries({ queryKey: CONVERSATIONS_KEY });
    }
  }

  async function send() {
    const body = text.trim();
    if (!body || sending) return;
    setSending(true);
    try {
      const msg = await api<MessageDTO>(`/conversations/${conv.id}/messages`, { body: { text: body } });
      qc.setQueryData<MessageDTO[]>(messagesKey(conv.id), (old = []) => (old.some((m) => m.id === msg.id) ? old : [...old, msg]));
      setText('');
    } catch (e) {
      toast('err', errMsg(e));
    } finally {
      setSending(false);
    }
  }

  async function finish() {
    try {
      patchConv(await api<ConversationDTO>(`/conversations/${conv.id}/close`, { method: 'POST' }));
      toast('ok', 'Conversa finalizada.');
    } catch (e) {
      toast('err', errMsg(e));
    }
  }

  async function feedback(m: MessageDTO, value: 1 | -1 | null) {
    try {
      const updated = await api<MessageDTO>(`/messages/${m.id}/feedback`, { body: { value } });
      qc.setQueryData<MessageDTO[]>(messagesKey(conv.id), (old) => old?.map((x) => (x.id === m.id ? updated : x)));
    } catch (e) {
      toast('err', errMsg(e));
    }
  }

  function onKey(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (quickMatches.length) {
      if (e.key === 'ArrowDown') return (e.preventDefault(), setQIdx((i) => (i + 1) % quickMatches.length));
      if (e.key === 'ArrowUp') return (e.preventDefault(), setQIdx((i) => (i - 1 + quickMatches.length) % quickMatches.length));
      if (e.key === 'Enter' || e.key === 'Tab') return (e.preventDefault(), setText(quickMatches[qIdx]!.body));
      if (e.key === 'Escape') return setText('');
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void send();
    }
  }

  function onChange(v: string) {
    setText(v);
    const now = Date.now();
    if (v && now - lastTyping.current > TYPING_MS) {
      lastTyping.current = now;
      getSocket()?.emit(ClientEvents.typing, { conversationId: conv.id });
    }
  }

  const typingNow = presence && presence.type === 'typing' && Date.now() - presence.at < 4000 ? presence : null;
  const days = useMemo(() => {
    const out: { day: string; items: MessageDTO[] }[] = [];
    for (const m of messages) {
      const d = fmtDate(m.createdAt);
      if (out.at(-1)?.day !== d) out.push({ day: d, items: [] });
      out.at(-1)!.items.push(m);
    }
    return out;
  }, [messages]);

  return (
    <>
      <section className="chat-col" aria-label={`Conversa com ${contactName(conv.contact)}`}>
        <header className="chat-head">
          <button className="btn alt icon" onClick={onBack} aria-label="Voltar para a lista" title="Voltar"><Icon name="inbox" /></button>
          <span className="avatar" style={{ background: 'var(--brand-soft)', color: 'var(--brand)' }} aria-hidden="true">{initials(contactName(conv.contact))}</span>
          <div className="who">
            <b>{contactName(conv.contact)}</b>
            <small>{fmtPhone(conv.contact.phone)} · {sectorName}{assignee ? ` · ${assignee}` : ''}</small>
          </div>
          <StatusTag status={conv.status} />
          {conv.status === 'QUEUED' && <button className="btn" onClick={claim}><Icon name="check" /> Assumir</button>}
          {!closed && !takenByOther && <button className="btn alt" onClick={() => setTransferOpen(true)}><Icon name="swap" /> Transferir</button>}
          {!closed && !takenByOther && <button className="btn alt" onClick={() => setCloseOpen(true)}><Icon name="check" /> Finalizar</button>}
        </header>

        <div className="chat-body" ref={bodyRef} tabIndex={0} aria-live="polite" aria-label="Mensagens">
          {conv.summary && (
            <div className="summary"><b><Icon name="bot" /> Resumo da IA para o atendente</b>{conv.summary}</div>
          )}
          {isLoading ? <Empty icon="clock">Carregando mensagens…</Empty> : isError ? <Message kind="err">Não foi possível carregar as mensagens.</Message> : (
            days.map((g) => (
              <Fragment key={g.day}>
                <div className="day">{g.day}</div>
                {g.items.map((m) => <Bubble key={m.id} m={m} canAddToBase={canAddToBase} onFeedback={feedback} onAddToBase={setBaseMsg} />)}
              </Fragment>
            ))
          )}
        </div>
        <div className="typing" aria-live="polite">{typingNow ? `${typingNow.name} está digitando…` : ''}</div>

        {closed ? (
          <div className="composer"><Message kind="info">Conversa finalizada{conv.closeReason ? ` (${CLOSE_LABEL[conv.closeReason]})` : ''}. Uma nova mensagem do cliente abrirá um novo atendimento.</Message></div>
        ) : takenByOther ? (
          <div className="composer"><Message kind="warn">Esta conversa está com {assignee ?? 'outro atendente'}. Peça a transferência para responder.</Message></div>
        ) : (
          <div className="composer">
            {conv.status !== 'HUMAN' && (
              <small><Icon name="info" /> {conv.status === 'BOT' ? 'A IA está atendendo.' : 'Cliente na fila.'} Ao enviar, você assume a conversa e a IA para de responder.</small>
            )}
            {quickMatches.length > 0 && (
              <div className="quick" role="listbox" aria-label="Respostas rápidas">
                {quickMatches.map((r, i) => (
                  <button key={r.id} role="option" aria-selected={i === qIdx} onMouseDown={(e) => (e.preventDefault(), setText(r.body))}>
                    <b>/{r.shortcut}</b><small>{r.body.slice(0, 90)}</small>
                  </button>
                ))}
              </div>
            )}
            <label className="sr-only" htmlFor="composer">Mensagem</label>
            <textarea id="composer" value={text} onChange={(e) => onChange(e.target.value)} onKeyDown={onKey} maxLength={4000}
              placeholder={`Digite a mensagem — vai assinada como “${me.displayName}”. Use / para respostas rápidas.`} />
            <div className="row2">
              <small>Enter envia · Shift+Enter quebra linha</small>
              <button className="btn" onClick={send} disabled={sending || !text.trim()}><Icon name="send" /> {sending ? 'Enviando…' : 'Enviar'}</button>
            </div>
          </div>
        )}
      </section>

      <section className="info-col contact" aria-label="Dados do contato">
        <h3 style={{ marginTop: 0 }}>Contato</h3>
        <dl>
          <dt>Nome</dt><dd>{conv.contact.name ?? '—'}</dd>
          <dt>Telefone</dt><dd>{fmtPhone(conv.contact.phone)}</dd>
          <dt>Setor</dt><dd>{sectorName}</dd>
          <dt>Origem</dt><dd>{conv.origin === 'CUSTOMER' ? 'Iniciada pelo cliente' : 'Iniciada pelo atendente'}</dd>
          <dt>IA</dt>
          <dd>{conv.aiEnabled ? <Tag icon="bot" kind="info">Ligada</Tag> : <Tag icon="lock">Desligada</Tag>}</dd>
          {conv.status === 'BOT' && <><dt>Sem resolver</dt><dd>{conv.failedAiAttempts}</dd></>}
          {conv.closedAt && <><dt>Encerrada</dt><dd>{fmtDate(conv.closedAt)} · {conv.closeReason ? CLOSE_LABEL[conv.closeReason] : ''}</dd></>}
        </dl>
        {transferMsg?.aiMeta?.reason && (
          <>
            <h3>Motivo da transferência</h3>
            <p style={{ margin: 0 }}>{REASON_LABEL[transferMsg.aiMeta.reason] ?? transferMsg.aiMeta.reason}</p>
            {transferMsg.aiMeta.topScore !== undefined && <small>Melhor relevância na base: {Math.round(transferMsg.aiMeta.topScore * 100)}%</small>}
          </>
        )}
        <h3>Atalhos</h3>
        <small><kbd>/</kbd> busca na lista · <kbd>Enter</kbd> envia · <kbd>Esc</kbd> fecha janelas</small>
      </section>

      <TransferDialog conv={conv} open={transferOpen} onClose={() => setTransferOpen(false)} />
      <ConfirmDialog open={closeOpen} onClose={() => setCloseOpen(false)} onConfirm={finish} title="Finalizar conversa?"
        text="O cliente poderá abrir um novo atendimento enviando outra mensagem." confirmLabel="Finalizar" />
      {baseMsg && <AddToBase msg={baseMsg} messages={messages} onClose={() => setBaseMsg(null)} />}
    </>
  );
}

/** RF18: transforma uma resposta humana em FAQ do setor. */
function AddToBase({ msg, messages, onClose }: { msg: MessageDTO; messages: MessageDTO[]; onClose(): void }) {
  const toast = useUI((s) => s.toast);
  const idx = messages.findIndex((m) => m.id === msg.id);
  const prevQuestion = [...messages.slice(0, idx)].reverse().find((m) => m.senderType === 'CUSTOMER' && m.body.trim())?.body ?? '';
  const [question, setQuestion] = useState(prevQuestion);
  const [answer, setAnswer] = useState(msg.body);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await api('/knowledge/from-message', { body: { messageId: msg.id, question, answer } });
      toast('ok', 'Adicionado à base de conhecimento. Ficará disponível para a IA em instantes.');
      onClose();
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal open onClose={onClose} title="Adicionar à base de conhecimento">
      <Message kind="info">Confira com atenção: a IA passará a usar este texto para responder outros clientes do setor.</Message>
      {error && <Message kind="err">{error}</Message>}
      <div className="form-grid">
        <label className="wide">Pergunta do cliente<textarea value={question} onChange={(e) => setQuestion(e.target.value)} /></label>
        <label className="wide">Resposta correta<textarea value={answer} onChange={(e) => setAnswer(e.target.value)} /></label>
      </div>
      <div className="foot">
        <button className="btn alt" onClick={onClose}>Cancelar</button>
        <button className="btn" onClick={save} disabled={busy || question.trim().length < 3 || answer.trim().length < 3}>{busy ? 'Salvando…' : 'Adicionar à base'}</button>
      </div>
    </Modal>
  );
}
