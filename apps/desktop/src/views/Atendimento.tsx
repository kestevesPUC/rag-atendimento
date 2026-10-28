import type { ConversationDTO } from '@rag/shared';
import { useMemo, useState } from 'react';
import { Empty, StatusTag, Tag } from '../components';
import { contactName, fmtAgo, initials } from '../lib/format';
import { Icon } from '../lib/icons';
import { useConversations, useSectors } from '../lib/queries';
import { useSession } from '../lib/session';
import { useUI } from '../lib/ui-store';
import { Chat } from './Chat';
import { NewConversationDialog } from './NewConversation';

type Tab = 'queue' | 'mine' | 'team' | 'bot' | 'closed';

export function Atendimento() {
  const user = useSession((s) => s.user)!;
  const { data: convs = [], isLoading, isError } = useConversations();
  const { data: sectors = [] } = useSectors();
  const { selectedId, select, unread } = useUI();
  const [tab, setTab] = useState<Tab>('queue');
  const [q, setQ] = useState('');
  const [newOpen, setNewOpen] = useState(false);
  const canSeeTeam = user.role !== 'AGENT';

  const buckets = useMemo(() => {
    const mine = (c: ConversationDTO) => c.status === 'HUMAN' && c.assignedUserId === user.id;
    return {
      queue: convs.filter((c) => c.status === 'QUEUED'),
      mine: convs.filter(mine),
      team: convs.filter((c) => c.status === 'HUMAN' && !mine(c)),
      bot: convs.filter((c) => c.status === 'BOT'),
      closed: convs.filter((c) => c.status === 'CLOSED').slice(0, 60),
    };
  }, [convs, user.id]);

  const tabs: { id: Tab; label: string; icon: 'inbox' | 'user' | 'users' | 'bot' | 'check' }[] = [
    { id: 'queue', label: 'Fila', icon: 'inbox' },
    { id: 'mine', label: 'Minhas', icon: 'user' },
    ...(canSeeTeam ? [{ id: 'team' as const, label: 'Equipe', icon: 'users' as const }] : []),
    { id: 'bot', label: 'IA', icon: 'bot' },
    { id: 'closed', label: 'Finalizadas', icon: 'check' },
  ];

  const term = q.trim().toLowerCase();
  const list = buckets[tab].filter(
    (c) => !term || contactName(c.contact).toLowerCase().includes(term) || c.contact.phone.includes(term.replace(/\D/g, '') || '§') || (c.lastMessagePreview ?? '').toLowerCase().includes(term),
  );
  const sectorName = (id: string | null) => sectors.find((s) => s.id === id)?.name ?? 'Sem setor';
  const selected = convs.find((c) => c.id === selectedId) ?? null;

  return (
    <div className="atend">
      <section className="list-col" data-hide={!!selected}>
        <div className="list-head">
          <div className="grid-toolbar" style={{ margin: 0 }}>
            <label className="grid-search" style={{ flex: 1 }}>
              <span className="sr-only">Buscar conversa</span>
              <Icon name="search" />
              <input id="search" type="search" placeholder="Buscar nome, telefone ou mensagem" value={q} onChange={(e) => setQ(e.target.value)} />
            </label>
            <button className="btn icon" onClick={() => setNewOpen(true)} aria-label="Nova conversa (iniciar contato)" title="Nova conversa"><Icon name="plus" /></button>
          </div>
          <div className="tabs" role="tablist" aria-label="Filtro de conversas">
            {tabs.map((t) => (
              <button key={t.id} role="tab" aria-selected={tab === t.id} onClick={() => setTab(t.id)}>
                <Icon name={t.icon} /> {t.label}
                {t.id !== 'closed' && buckets[t.id].length > 0 && <span className="badge">{buckets[t.id].length}</span>}
              </button>
            ))}
          </div>
        </div>
        {isLoading ? (
          <Empty icon="clock">Carregando conversas…</Empty>
        ) : isError ? (
          <Empty icon="alert">Não foi possível carregar as conversas.</Empty>
        ) : list.length === 0 ? (
          <Empty icon="inbox">{term ? 'Nenhuma conversa encontrada.' : 'Nenhuma conversa aqui por enquanto.'}</Empty>
        ) : (
          <ul className="conv-list">
            {list.map((c) => (
              <li key={c.id}>
                <button className="conv-item" aria-current={c.id === selectedId} onClick={() => select(c.id)}>
                  <span className="avatar" aria-hidden="true">{initials(contactName(c.contact))}</span>
                  <span className="meta">
                    <span className="top">
                      <b>{contactName(c.contact)}</b>
                      <time dateTime={c.lastInteractionAt}>{fmtAgo(c.lastInteractionAt)}</time>
                    </span>
                    <p>{c.lastMessagePreview || 'Sem texto'}</p>
                    <span style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                      {user.role === 'ADMIN' && <Tag icon="building">{sectorName(c.sectorId)}</Tag>}
                      {tab === 'closed' ? <StatusTag status={c.status} /> : c.origin === 'AGENT' && <Tag icon="user">Ativa</Tag>}
                      {(unread[c.id] ?? 0) > 0 && <span className="badge unread" aria-label={`${unread[c.id]} mensagens novas`}>{unread[c.id]}</span>}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {selected ? (
        <Chat conv={selected} onBack={() => select(null)} />
      ) : (
        <>
          <section className="chat-col"><Empty icon="chat">Selecione uma conversa para começar.</Empty></section>
          <section className="info-col"><Empty icon="info">Os dados do contato aparecem aqui.</Empty></section>
        </>
      )}
      <NewConversationDialog open={newOpen} onClose={() => setNewOpen(false)} />
    </div>
  );
}
