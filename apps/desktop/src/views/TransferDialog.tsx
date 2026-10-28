import type { ConversationDTO } from '@rag/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Message, Modal } from '../components';
import { api, errMsg } from '../lib/api';
import { useDirectory, useSectors } from '../lib/queries';
import { CONVERSATIONS_KEY } from '../lib/realtime';
import { useUI } from '../lib/ui-store';

/** RF08: transferir para outro setor (volta à fila dele) ou para um atendente específico. */
export function TransferDialog({ conv, open, onClose }: { conv: ConversationDTO; open: boolean; onClose(): void }) {
  const qc = useQueryClient();
  const { data: sectors = [] } = useSectors();
  const { data: people = [] } = useDirectory();
  const [mode, setMode] = useState<'sector' | 'user'>('sector');
  const [sectorId, setSectorId] = useState('');
  const [userId, setUserId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const updated = await api<ConversationDTO>(`/conversations/${conv.id}/transfer`, { body: mode === 'sector' ? { sectorId } : { userId } });
      qc.setQueryData<ConversationDTO[]>(CONVERSATIONS_KEY, (old = []) => old.map((c) => (c.id === updated.id ? updated : c)));
      useUI.getState().toast('ok', 'Conversa transferida.');
      useUI.getState().select(null);
      onClose();
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy(false);
    }
  }

  const candidates = people.filter((p) => p.id !== conv.assignedUserId);
  const ready = mode === 'sector' ? !!sectorId : !!userId;

  return (
    <Modal open={open} onClose={onClose} title="Transferir conversa">
      <form onSubmit={submit}>
        {error && <Message kind="err">{error}</Message>}
        <div className="tabs" role="tablist" aria-label="Tipo de transferência">
          <button type="button" role="tab" aria-selected={mode === 'sector'} onClick={() => setMode('sector')}>Para um setor</button>
          <button type="button" role="tab" aria-selected={mode === 'user'} onClick={() => setMode('user')}>Para um atendente</button>
        </div>
        <div style={{ marginTop: 16 }}>
          {mode === 'sector' ? (
            <label>Setor de destino
              <select value={sectorId} onChange={(e) => setSectorId(e.target.value)} required>
                <option value="">Selecione…</option>
                {sectors.filter((s) => s.id !== conv.sectorId).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
              <span className="hint">A conversa volta para a fila do setor escolhido.</span>
            </label>
          ) : (
            <label>Atendente
              <select value={userId} onChange={(e) => setUserId(e.target.value)} required>
                <option value="">Selecione…</option>
                {candidates.map((p) => (
                  <option key={p.id} value={p.id}>{p.displayName} — {sectors.find((s) => s.id === p.sectorId)?.name ?? 'Sem setor'}</option>
                ))}
              </select>
              <span className="hint">Se o atendente for de outro setor, a conversa passa a pertencer a esse setor.</span>
            </label>
          )}
        </div>
        <div className="foot">
          <button type="button" className="btn alt" onClick={onClose}>Cancelar</button>
          <button className="btn" disabled={busy || !ready}>{busy ? 'Transferindo…' : 'Transferir'}</button>
        </div>
      </form>
    </Modal>
  );
}
