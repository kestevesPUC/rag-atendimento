import { useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import type { ConversationDTO } from '@rag/shared';
import { Message, Modal } from '../components';
import { api, errMsg } from '../lib/api';
import { CONVERSATIONS_KEY } from '../lib/realtime';
import { useUI } from '../lib/ui-store';

/** RF10 / RN07: inicia contato ativo; a IA fica desativada nessa conversa. */
export function NewConversationDialog({ open, onClose }: { open: boolean; onClose(): void }) {
  const qc = useQueryClient();
  const [phone, setPhone] = useState('');
  const [name, setName] = useState('');
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const conv = await api<ConversationDTO>('/conversations', { body: { phone, text, name: name || undefined } });
      qc.setQueryData<ConversationDTO[]>(CONVERSATIONS_KEY, (old = []) => [conv, ...old.filter((c) => c.id !== conv.id)]);
      useUI.getState().select(conv.id);
      setPhone(''); setName(''); setText('');
      onClose();
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Nova conversa">
      <form onSubmit={submit} noValidate>
        <Message kind="info">Nesta conversa a IA fica desligada: apenas você responde ao cliente.</Message>
        {error && <Message kind="err">{error}</Message>}
        <div className="form-grid">
          <label>Telefone com DDD
            <input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="(11) 99999-0000" inputMode="tel" required autoFocus />
            <span className="hint">Sem o código do país, será usado +55 (Brasil).</span>
          </label>
          <label>Nome (opcional)
            <input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} />
          </label>
          <label className="wide">Primeira mensagem
            <textarea value={text} onChange={(e) => setText(e.target.value)} maxLength={4000} required />
            <span className="hint">Sai assinada com o seu nome. Evite envios em massa: o WhatsApp pode bloquear o número.</span>
          </label>
        </div>
        <div className="foot">
          <button type="button" className="btn alt" onClick={onClose}>Cancelar</button>
          <button className="btn" disabled={busy || !phone.trim() || !text.trim()}>{busy ? 'Enviando…' : 'Iniciar conversa'}</button>
        </div>
      </form>
    </Modal>
  );
}
