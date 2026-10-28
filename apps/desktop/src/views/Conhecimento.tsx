import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { ConfirmDialog, Message, Modal, Tag } from '../components';
import { api, errMsg } from '../lib/api';
import { Icon } from '../lib/icons';
import { useSectors } from '../lib/queries';
import { useUI } from '../lib/ui-store';

interface Doc { id: string; title: string; type: string; sectorIds: string[]; status: 'PENDING' | 'PROCESSING' | 'READY' | 'FAILED'; error: string | null; chunkCount: number; updatedAt: string }
interface PlaygroundResult {
  threshold: number; topScore: number; belowThreshold: boolean; wouldTransfer: boolean; answer: string; resolved: boolean;
  sources: { position: number; chunkId: number; title: string; score: number; content: string }[];
}

const TYPE_ICON = { pdf: 'file', docx: 'file', txt: 'file', md: 'file', faq: 'faq', url: 'link' } as const;

function DocStatus({ d }: { d: Doc }) {
  if (d.status === 'READY') return <Tag icon="check" kind="ok">Pronto</Tag>;
  if (d.status === 'FAILED') return <Tag icon="alert" kind="bad">Falhou</Tag>;
  return <Tag icon="clock" kind="warn">{d.status === 'PENDING' ? 'Na fila' : 'Processando'}</Tag>;
}

function SectorPicker({ value, onChange }: { value: string[]; onChange(v: string[]): void }) {
  const { data: sectors = [] } = useSectors();
  return (
    <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
      <legend style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--mute)', marginBottom: 6 }}>Quem pode usar este conteúdo</legend>
      <label className="check"><input type="checkbox" checked={value.length === 0} onChange={() => onChange([])} /> Todos os setores (global)</label>
      {sectors.map((s) => (
        <label className="check" key={s.id}>
          <input type="checkbox" checked={value.includes(s.id)} onChange={(e) => onChange(e.target.checked ? [...value, s.id] : value.filter((x) => x !== s.id))} />
          {s.name}
        </label>
      ))}
    </fieldset>
  );
}

type AddKind = 'file' | 'faq' | 'url';

function AddDialog({ open, onClose }: { open: boolean; onClose(): void }) {
  const qc = useQueryClient();
  const toast = useUI((s) => s.toast);
  const [kind, setKind] = useState<AddKind>('file');
  const [sectorIds, setSectorIds] = useState<string[]>([]);
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState('');
  const [url, setUrl] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: async () => {
      if (kind === 'file') {
        if (!file) throw new Error('Escolha um arquivo.');
        return api('/knowledge/documents/file', { binary: file, query: { filename: file.name, sectorIds: sectorIds.join(',') || undefined } });
      }
      if (kind === 'faq') return api('/knowledge/documents/faq', { body: { question, answer, sectorIds } });
      return api('/knowledge/documents/url', { body: { url, sectorIds } });
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['documents'] });
      toast('ok', 'Enviado. A indexação acontece em segundo plano.');
      setQuestion(''); setAnswer(''); setUrl(''); setFile(null); setError(null);
      onClose();
    },
    onError: (e) => setError(errMsg(e)),
  });

  return (
    <Modal open={open} onClose={onClose} title="Adicionar à base de conhecimento">
      {error && <Message kind="err">{error}</Message>}
      <div className="tabs" role="tablist" aria-label="Tipo de conteúdo">
        {([['file', 'Arquivo', 'upload'], ['faq', 'Pergunta e resposta', 'faq'], ['url', 'Página da web', 'link']] as const).map(([k, label, icon]) => (
          <button key={k} role="tab" aria-selected={kind === k} onClick={() => setKind(k)}><Icon name={icon} /> {label}</button>
        ))}
      </div>
      <div style={{ margin: '16px 0', display: 'grid', gap: 14 }}>
        {kind === 'file' && (
          <label>Arquivo (PDF, DOCX, TXT ou MD — até 20 MB)
            <input type="file" accept=".pdf,.docx,.txt,.md" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          </label>
        )}
        {kind === 'faq' && (
          <>
            <label>Pergunta<input value={question} onChange={(e) => setQuestion(e.target.value)} maxLength={500} /></label>
            <label>Resposta<textarea value={answer} onChange={(e) => setAnswer(e.target.value)} maxLength={4000} /></label>
          </>
        )}
        {kind === 'url' && (
          <label>Endereço da página<input type="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…" />
            <span className="hint">Somente páginas públicas. Endereços da rede interna são bloqueados por segurança.</span>
          </label>
        )}
        <SectorPicker value={sectorIds} onChange={setSectorIds} />
      </div>
      <div className="foot">
        <button className="btn alt" onClick={onClose}>Cancelar</button>
        <button className="btn" disabled={save.isPending} onClick={() => save.mutate()}>{save.isPending ? 'Enviando…' : 'Adicionar'}</button>
      </div>
    </Modal>
  );
}

function SectorsDialog({ doc, onClose }: { doc: Doc; onClose(): void }) {
  const qc = useQueryClient();
  const [ids, setIds] = useState(doc.sectorIds);
  const [error, setError] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: () => api(`/knowledge/documents/${doc.id}`, { method: 'PATCH', body: { sectorIds: ids } }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['documents'] }); onClose(); },
    onError: (e) => setError(errMsg(e)),
  });
  return (
    <Modal open onClose={onClose} title={`Setores de “${doc.title}”`}>
      {error && <Message kind="err">{error}</Message>}
      <SectorPicker value={ids} onChange={setIds} />
      <div className="foot">
        <button className="btn alt" onClick={onClose}>Cancelar</button>
        <button className="btn" onClick={() => save.mutate()} disabled={save.isPending}>Salvar</button>
      </div>
    </Modal>
  );
}

function Playground() {
  const { data: sectors = [] } = useSectors();
  const [question, setQuestion] = useState('');
  const [sectorId, setSectorId] = useState('');
  const run = useMutation({
    mutationFn: () => api<PlaygroundResult>('/knowledge/playground', { body: { question, sectorId: sectorId || null } }),
  });
  const r = run.data;
  return (
    <div className="card">
      <h2>Playground</h2>
      <p className="hint" style={{ marginTop: -8 }}>Teste uma pergunta como se fosse um cliente. Nada é enviado ao WhatsApp nem salvo como conversa.</p>
      <div className="row">
        <label style={{ flex: '3 1 300px' }}>Pergunta<textarea value={question} onChange={(e) => setQuestion(e.target.value)} maxLength={1000} /></label>
        <label>Setor
          <select value={sectorId} onChange={(e) => setSectorId(e.target.value)}>
            <option value="">Todos (sem filtro)</option>
            {sectors.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </label>
        <button className="btn" disabled={run.isPending || question.trim().length < 2} onClick={() => run.mutate()}><Icon name="send" /> {run.isPending ? 'Consultando…' : 'Testar'}</button>
      </div>
      {run.isError && <Message kind="err">{errMsg(run.error)}</Message>}
      {r && (
        <>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
            <Tag icon={r.belowThreshold ? 'alert' : 'check'} kind={r.belowThreshold ? 'warn' : 'ok'}>
              Relevância {Math.round(r.topScore * 100)}% (mínimo {Math.round(r.threshold * 100)}%)
            </Tag>
            <Tag icon={r.wouldTransfer ? 'swap' : 'bot'} kind={r.wouldTransfer ? 'warn' : 'info'}>
              {r.wouldTransfer ? 'A IA transferiria para um humano' : 'A IA responderia sozinha'}
            </Tag>
          </div>
          {r.answer ? <div className="summary" style={{ background: 'var(--surface-2)', borderColor: 'var(--line)' }}><b style={{ color: 'var(--mute)' }}><Icon name="bot" /> Resposta</b>{r.answer}</div>
            : <Message kind="warn">Sem resposta: o conteúdo cadastrado não cobre esta pergunta. Adicione um documento ou FAQ.</Message>}
          <h3 style={{ fontSize: 13, color: 'var(--mute)', textTransform: 'uppercase', letterSpacing: '.05em' }}>Trechos encontrados</h3>
          {r.sources.length === 0 ? <small>Nenhum trecho.</small> : (
            <ol className="sources" style={{ paddingLeft: 18 }}>
              {r.sources.map((s) => <li key={s.chunkId}><b>{s.title}</b> — {Math.round(s.score * 100)}%<br /><span style={{ color: 'var(--mute)' }}>{s.content.slice(0, 280)}{s.content.length > 280 ? '…' : ''}</span></li>)}
            </ol>
          )}
        </>
      )}
    </div>
  );
}

export function Conhecimento() {
  const qc = useQueryClient();
  const toast = useUI((s) => s.toast);
  const { data: sectors = [] } = useSectors();
  const { data: docs = [], isLoading, isError, error } = useQuery({
    queryKey: ['documents'],
    queryFn: () => api<Doc[]>('/knowledge/documents'),
    refetchInterval: (q) => (q.state.data?.some((d) => d.status === 'PENDING' || d.status === 'PROCESSING') ? 3000 : false),
  });
  const [tab, setTab] = useState<'docs' | 'play'>('docs');
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<Doc | null>(null);
  const [removing, setRemoving] = useState<Doc | null>(null);
  const [q, setQ] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);

  const reprocess = useMutation({
    mutationFn: (id: string) => api(`/knowledge/documents/${id}/reprocess`, { method: 'POST' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['documents'] }),
    onError: (e) => toast('err', errMsg(e)),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api(`/knowledge/documents/${id}`, { method: 'DELETE' }),
    onSuccess: () => { toast('ok', 'Documento excluído.'); return qc.invalidateQueries({ queryKey: ['documents'] }); },
    onError: (e) => toast('err', errMsg(e)),
  });

  const names = (ids: string[]) => (ids.length === 0 ? 'Global' : ids.map((id) => sectors.find((s) => s.id === id)?.name ?? '?').join(', '));
  const shown = docs.filter((d) => !q || d.title.toLowerCase().includes(q.toLowerCase()));

  return (
    <>
      <div className="page-head"><div><p>A IA responde somente com base no que está cadastrado aqui.</p></div></div>
      <div className="tabs" role="tablist" aria-label="Seções" style={{ marginBottom: 18 }}>
        <button role="tab" aria-selected={tab === 'docs'} onClick={() => setTab('docs')}><Icon name="book" /> Documentos</button>
        <button role="tab" aria-selected={tab === 'play'} onClick={() => setTab('play')}><Icon name="send" /> Playground</button>
      </div>
      {tab === 'play' ? <Playground /> : (
        <>
          <div className="grid-toolbar">
            <label className="grid-search"><span className="sr-only">Buscar documento</span><Icon name="search" />
              <input id="search" ref={searchRef} type="search" placeholder="Buscar documento" value={q} onChange={(e) => setQ(e.target.value)} />
            </label>
            <div className="grid-actions"><button className="btn" onClick={() => setAdding(true)}><Icon name="plus" /> Adicionar</button></div>
          </div>
          {isError && <Message kind="err">{errMsg(error)}</Message>}
          <div className="wrap">
            <table>
              <thead><tr><th>Título</th><th>Tipo</th><th>Setores</th><th>Situação</th><th className="n">Trechos</th><th aria-label="Ações" /></tr></thead>
              <tbody>
                {isLoading && <tr><td colSpan={6} className="empty">Carregando…</td></tr>}
                {!isLoading && shown.length === 0 && <tr><td colSpan={6} className="empty">Nenhum conteúdo cadastrado ainda. Clique em “Adicionar” para treinar a IA.</td></tr>}
                {shown.map((d) => (
                  <tr key={d.id}>
                    <td><b>{d.title}</b>{d.error && <small style={{ display: 'block', color: 'var(--bad)' }}>{d.error}</small>}</td>
                    <td><Tag icon={TYPE_ICON[d.type as keyof typeof TYPE_ICON] ?? 'file'}>{d.type.toUpperCase()}</Tag></td>
                    <td>{names(d.sectorIds)}</td>
                    <td><DocStatus d={d} /></td>
                    <td className="n">{d.chunkCount}</td>
                    <td><div className="actions">
                      <button className="btn alt sm" onClick={() => setEditing(d)} aria-label={`Alterar setores de ${d.title}`} title="Alterar setores"><Icon name="building" /></button>
                      <button className="btn alt sm" onClick={() => reprocess.mutate(d.id)} disabled={d.status === 'PROCESSING'} aria-label={`Reprocessar ${d.title}`} title="Reprocessar"><Icon name="refresh" /></button>
                      <button className="btn alt sm" onClick={() => setRemoving(d)} aria-label={`Excluir ${d.title}`}><Icon name="trash" /></button>
                    </div></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
      <AddDialog open={adding} onClose={() => setAdding(false)} />
      {editing && <SectorsDialog doc={editing} onClose={() => setEditing(null)} />}
      <ConfirmDialog open={!!removing} onClose={() => setRemoving(null)} danger title="Excluir conteúdo?"
        text={`“${removing?.title ?? ''}” deixará de ser usado pela IA. Esta ação não pode ser desfeita.`} confirmLabel="Excluir" onConfirm={() => removing && remove.mutate(removing.id)} />
    </>
  );
}
