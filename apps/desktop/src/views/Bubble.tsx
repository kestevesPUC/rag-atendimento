import type { MessageDTO } from '@rag/shared';
import { AuthMedia, Tag } from '../components';
import { fmtTime } from '../lib/format';
import { Icon } from '../lib/icons';

/** Situação de envio com ícone + texto acessível (nunca só cor). */
function Delivery({ m }: { m: MessageDTO }) {
  if (m.sendStatus === 'FAILED') return <span className="tag bad" title="O envio falhou após várias tentativas"><Icon name="alert" /> Falhou</span>;
  if (m.sendStatus === 'PENDING') return <span title="Enviando"><Icon name="clock" /><span className="sr-only">Enviando</span></span>;
  if (m.ack >= 3) return <span title="Lido" style={{ color: 'var(--brand)' }}><Icon name="delivered" /><span className="sr-only">Lido</span></span>;
  if (m.ack === 2) return <span title="Entregue"><Icon name="delivered" /><span className="sr-only">Entregue</span></span>;
  return <span title="Enviado"><Icon name="sent" /><span className="sr-only">Enviado</span></span>;
}

export interface BubbleProps {
  m: MessageDTO;
  canAddToBase: boolean;
  onFeedback(m: MessageDTO, value: 1 | -1 | null): void;
  onAddToBase(m: MessageDTO): void;
}

export function Bubble({ m, canAddToBase, onFeedback, onAddToBase }: BubbleProps) {
  // Anotações internas (ex.: "Maria assumiu a conversa") não vão ao WhatsApp.
  if (m.senderType === 'SYSTEM' && m.aiMeta?.kind === 'note') return <div className="note">{m.body}</div>;

  const isCustomer = m.senderType === 'CUSTOMER';
  const isAi = m.senderType === 'AI';
  const cls = isCustomer ? '' : isAi ? 'ai' : 'out';
  const sources = m.aiMeta?.sources ?? [];

  return (
    <article className={`bubble ${cls} ${m.sendStatus === 'FAILED' ? 'failed' : ''}`} aria-label={`Mensagem de ${isCustomer ? 'cliente' : isAi ? 'IA' : (m.senderName ?? 'sistema')}`}>
      {!isCustomer && (
        <div className="who">
          {isAi ? <Tag icon="bot" kind="info">IA</Tag> : m.senderType === 'AGENT' ? <><Icon name="user" /> {m.senderName}</> : <Tag icon="info">Sistema</Tag>}
          {m.aiMeta?.kind === 'transfer' && <Tag icon="swap" kind="warn">Transferência</Tag>}
          {m.aiMeta?.kind === 'menu' && <Tag icon="info">Menu de setores</Tag>}
        </div>
      )}
      {m.mediaUrl && <AuthMedia path={m.mediaUrl} type={m.mediaType} />}
      {m.body && <div>{m.body}</div>}

      {isAi && sources.length > 0 && (
        <details className="sources">
          <summary>Fontes usadas ({sources.length})</summary>
          <ol>
            {sources.map((s) => (
              <li key={s.chunkId}>
                <b>{s.title}</b> — relevância {Math.round(s.score * 100)}%<br />
                <span>{s.excerpt}{s.excerpt.length >= 200 ? '…' : ''}</span>
              </li>
            ))}
          </ol>
        </details>
      )}

      <footer>
        {m.senderType !== 'CUSTOMER' && <Delivery m={m} />}
        <time dateTime={m.createdAt}>{fmtTime(m.createdAt)}</time>
      </footer>

      {(isAi && m.aiMeta?.kind === 'answer') && (
        <div className="tools" role="group" aria-label="Avaliar resposta da IA">
          <button className="btn alt sm" aria-pressed={m.feedback === 1} onClick={() => onFeedback(m, m.feedback === 1 ? null : 1)} title="Boa resposta"><Icon name="thumbUp" /><span className="sr-only">Boa resposta</span></button>
          <button className="btn alt sm" aria-pressed={m.feedback === -1} onClick={() => onFeedback(m, m.feedback === -1 ? null : -1)} title="Resposta ruim"><Icon name="thumbDown" /><span className="sr-only">Resposta ruim</span></button>
        </div>
      )}
      {m.senderType === 'AGENT' && canAddToBase && (
        <div className="tools">
          <button className="btn alt sm" onClick={() => onAddToBase(m)}><Icon name="book2" /> Adicionar à base</button>
        </div>
      )}
    </article>
  );
}
