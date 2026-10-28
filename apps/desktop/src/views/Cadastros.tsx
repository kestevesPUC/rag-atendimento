import { DAY_KEYS, type BusinessHours, type DayKey, type SectorDTO, type UserDTO } from '@rag/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { ConfirmDialog, Message, Modal, Tag } from '../components';
import { api, errMsg } from '../lib/api';
import { ROLE_LABEL } from '../lib/format';
import { Icon } from '../lib/icons';
import type { QuickReply } from '../lib/queries';
import { useQuickReplies, useSectors } from '../lib/queries';
import { useSession } from '../lib/session';
import { useUI } from '../lib/ui-store';

const DAY_LABEL: Record<DayKey, string> = { mon: 'Segunda', tue: 'Terça', wed: 'Quarta', thu: 'Quinta', fri: 'Sexta', sat: 'Sábado', sun: 'Domingo' };
const DAY_ORDER: DayKey[] = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

// ---------------------------------------------------------------- Setores
type HoursDraft = Record<DayKey, { on: boolean; from: string; to: string }>;
const emptyHours = (): HoursDraft =>
  Object.fromEntries(DAY_KEYS.map((d) => [d, { on: false, from: '08:00', to: '18:00' }])) as HoursDraft;
const toDraft = (h: BusinessHours | null): HoursDraft => {
  const d = emptyHours();
  if (h) for (const k of DAY_KEYS) { const r = h.days[k]?.[0]; if (r) d[k] = { on: true, from: r[0], to: r[1] }; }
  return d;
};
const fromDraft = (enabled: boolean, tz: string, d: HoursDraft): BusinessHours | null =>
  enabled ? { tz, days: Object.fromEntries(DAY_KEYS.filter((k) => d[k].on).map((k) => [k, [[d[k].from, d[k].to]]])) as BusinessHours['days'] } : null;

function SectorForm({ sector, onClose }: { sector: SectorDTO | null; onClose(): void }) {
  const qc = useQueryClient();
  const [f, setF] = useState({
    name: sector?.name ?? '', description: sector?.description ?? '', inactivityMinutes: sector?.inactivityMinutes ?? 30,
    queueTimeoutMin: sector?.queueTimeoutMin ?? null as number | null, welcomeMessage: sector?.welcomeMessage ?? '', closingMessage: sector?.closingMessage ?? '',
  });
  const [useHours, setUseHours] = useState(!!sector?.businessHours);
  const [tz, setTz] = useState(sector?.businessHours?.tz ?? 'America/Sao_Paulo');
  const [hours, setHours] = useState(toDraft(sector?.businessHours ?? null));
  const [error, setError] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: () => {
      const body = { ...f, welcomeMessage: f.welcomeMessage || null, closingMessage: f.closingMessage || null, businessHours: fromDraft(useHours, tz, hours) };
      return sector ? api(`/sectors/${sector.id}`, { method: 'PATCH', body }) : api('/sectors', { body });
    },
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['sectors'] }); onClose(); },
    onError: (e) => setError(errMsg(e)),
  });
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((p) => ({ ...p, [k]: v }));

  return (
    <Modal open onClose={onClose} title={sector ? 'Editar setor' : 'Novo setor'}>
      <form onSubmit={(e: FormEvent) => { e.preventDefault(); save.mutate(); }}>
        {error && <Message kind="err">{error}</Message>}
        <div className="form-grid">
          <label>Nome<input value={f.name} onChange={(e) => set('name', e.target.value)} required maxLength={60} /></label>
          <label>Encerrar por inatividade após (min)
            <input type="number" min={1} value={f.inactivityMinutes} onChange={(e) => set('inactivityMinutes', Number(e.target.value))} />
          </label>
          <label className="wide">Descrição para a IA
            <textarea value={f.description} onChange={(e) => set('description', e.target.value)} required maxLength={500} />
            <span className="hint">A IA usa este texto para decidir se uma pergunta pertence ao setor. Cite os assuntos tratados.</span>
          </label>
          <label>Encerrar na fila após (min)
            <input type="number" min={1} value={f.queueTimeoutMin ?? ''} placeholder="Nunca" onChange={(e) => set('queueTimeoutMin', e.target.value ? Number(e.target.value) : null)} />
            <span className="hint">Vazio = clientes aguardando na fila nunca são encerrados.</span>
          </label>
          <span />
          <label className="wide">Mensagem de boas-vindas (opcional)<textarea value={f.welcomeMessage} onChange={(e) => set('welcomeMessage', e.target.value)} maxLength={1000} /></label>
          <label className="wide">Mensagem de encerramento (opcional)<textarea value={f.closingMessage} onChange={(e) => set('closingMessage', e.target.value)} maxLength={1000} /></label>
        </div>
        <h3 style={{ fontSize: 13, color: 'var(--mute)', textTransform: 'uppercase', letterSpacing: '.05em' }}>Horário de atendimento</h3>
        <label className="check"><input type="checkbox" checked={useHours} onChange={(e) => setUseHours(e.target.checked)} /> Definir horário (fora dele a IA avisa o cliente ao transferir)</label>
        {useHours && (
          <>
            <label style={{ maxWidth: 280 }}>Fuso horário<input value={tz} onChange={(e) => setTz(e.target.value)} /></label>
            <div style={{ display: 'grid', gap: 6, marginTop: 10 }}>
              {DAY_ORDER.map((d) => (
                <div key={d} className="row" style={{ margin: 0, alignItems: 'center' }}>
                  <label className="check" style={{ minWidth: 120 }}><input type="checkbox" checked={hours[d].on} onChange={(e) => setHours({ ...hours, [d]: { ...hours[d], on: e.target.checked } })} /> {DAY_LABEL[d]}</label>
                  <input type="time" aria-label={`${DAY_LABEL[d]} — abre`} disabled={!hours[d].on} value={hours[d].from} onChange={(e) => setHours({ ...hours, [d]: { ...hours[d], from: e.target.value } })} style={{ maxWidth: 130 }} />
                  <span>até</span>
                  <input type="time" aria-label={`${DAY_LABEL[d]} — fecha`} disabled={!hours[d].on} value={hours[d].to} onChange={(e) => setHours({ ...hours, [d]: { ...hours[d], to: e.target.value } })} style={{ maxWidth: 130 }} />
                </div>
              ))}
            </div>
          </>
        )}
        <div className="foot">
          <button type="button" className="btn alt" onClick={onClose}>Cancelar</button>
          <button className="btn" disabled={save.isPending}>Salvar</button>
        </div>
      </form>
    </Modal>
  );
}

export function Setores() {
  const qc = useQueryClient();
  const toast = useUI((s) => s.toast);
  const { data: sectors = [], isLoading, isError, error } = useSectors();
  const [editing, setEditing] = useState<SectorDTO | 'new' | null>(null);
  const [removing, setRemoving] = useState<SectorDTO | null>(null);
  const remove = useMutation({
    mutationFn: (id: string) => api(`/sectors/${id}`, { method: 'DELETE' }),
    onSuccess: () => { toast('ok', 'Setor excluído.'); return qc.invalidateQueries({ queryKey: ['sectors'] }); },
    onError: (e) => toast('err', errMsg(e)),
  });
  return (
    <>
      <div className="grid-toolbar"><div className="grid-actions"><button className="btn" onClick={() => setEditing('new')}><Icon name="plus" /> Novo setor</button></div></div>
      {isError && <Message kind="err">{errMsg(error)}</Message>}
      <div className="wrap">
        <table>
          <thead><tr><th>Setor</th><th>Descrição para a IA</th><th>Horário</th><th className="n">Inatividade</th><th aria-label="Ações" /></tr></thead>
          <tbody>
            {isLoading && <tr><td colSpan={5} className="empty">Carregando…</td></tr>}
            {!isLoading && sectors.length === 0 && <tr><td colSpan={5} className="empty">Cadastre o primeiro setor (ex.: Financeiro, Suporte Técnico, Comercial).</td></tr>}
            {sectors.map((s) => (
              <tr key={s.id}>
                <td><b>{s.name}</b></td>
                <td style={{ maxWidth: 380 }}>{s.description}</td>
                <td>{s.businessHours ? <Tag icon="clock">Definido</Tag> : <Tag icon="check" kind="ok">Sempre aberto</Tag>}</td>
                <td className="n">{s.inactivityMinutes} min</td>
                <td><div className="actions">
                  <button className="btn alt sm" onClick={() => setEditing(s)}><Icon name="pencil" /> Editar</button>
                  <button className="btn alt sm" onClick={() => setRemoving(s)} aria-label={`Excluir ${s.name}`}><Icon name="trash" /></button>
                </div></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {editing && <SectorForm sector={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
      <ConfirmDialog open={!!removing} onClose={() => setRemoving(null)} danger title="Excluir setor?" confirmLabel="Excluir"
        text={`“${removing?.name ?? ''}” só pode ser excluído se não tiver usuários nem conversas.`} onConfirm={() => removing && remove.mutate(removing.id)} />
    </>
  );
}

// ---------------------------------------------------------------- Usuários
function UserForm({ user, onClose }: { user: UserDTO | null; onClose(): void }) {
  const qc = useQueryClient();
  const { data: sectors = [] } = useSectors();
  const [f, setF] = useState({
    name: user?.name ?? '', displayName: user?.displayName ?? '', email: user?.email ?? '', password: '',
    role: user?.role ?? 'AGENT' as UserDTO['role'], sectorId: user?.sectorId ?? '', active: user?.active ?? true,
  });
  const [error, setError] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: () => {
      const body = { ...f, sectorId: f.role === 'ADMIN' ? null : f.sectorId || null, password: f.password || undefined };
      return user ? api(`/users/${user.id}`, { method: 'PATCH', body }) : api('/users', { body });
    },
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['users'] }); void qc.invalidateQueries({ queryKey: ['directory'] }); onClose(); },
    onError: (e) => setError(errMsg(e)),
  });
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((p) => ({ ...p, [k]: v }));
  return (
    <Modal open onClose={onClose} title={user ? 'Editar usuário' : 'Novo usuário'}>
      <form onSubmit={(e: FormEvent) => { e.preventDefault(); save.mutate(); }}>
        {error && <Message kind="err">{error}</Message>}
        <div className="form-grid">
          <label>Nome completo<input value={f.name} onChange={(e) => set('name', e.target.value)} required /></label>
          <label>Nome na assinatura
            <input value={f.displayName} onChange={(e) => set('displayName', e.target.value)} required />
            <span className="hint">Aparece em negrito no início das mensagens: <b>*{f.displayName || 'Nome'}*</b></span>
          </label>
          <label>E-mail<input type="email" value={f.email} onChange={(e) => set('email', e.target.value)} required autoComplete="off" /></label>
          <label>{user ? 'Nova senha (deixe vazio para manter)' : 'Senha (mín. 8 caracteres)'}
            <input type="password" value={f.password} onChange={(e) => set('password', e.target.value)} minLength={8} required={!user} autoComplete="new-password" />
          </label>
          <label>Papel
            <select value={f.role} onChange={(e) => set('role', e.target.value as UserDTO['role'])}>
              {(Object.keys(ROLE_LABEL) as UserDTO['role'][]).map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
            </select>
          </label>
          <label>Setor
            <select value={f.sectorId} onChange={(e) => set('sectorId', e.target.value)} disabled={f.role === 'ADMIN'} required={f.role !== 'ADMIN'}>
              <option value="">{f.role === 'ADMIN' ? 'Todos os setores' : 'Selecione…'}</option>
              {sectors.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </label>
          <label className="check wide"><input type="checkbox" checked={f.active} onChange={(e) => set('active', e.target.checked)} /> Usuário ativo</label>
        </div>
        <div className="foot">
          <button type="button" className="btn alt" onClick={onClose}>Cancelar</button>
          <button className="btn" disabled={save.isPending}>Salvar</button>
        </div>
      </form>
    </Modal>
  );
}

export function Usuarios() {
  const qc = useQueryClient();
  const toast = useUI((s) => s.toast);
  const me = useSession((s) => s.user)!;
  const { data: sectors = [] } = useSectors();
  const { data: users = [], isLoading, isError, error } = useQuery({ queryKey: ['users'], queryFn: () => api<UserDTO[]>('/users') });
  const [editing, setEditing] = useState<UserDTO | 'new' | null>(null);
  const [removing, setRemoving] = useState<UserDTO | null>(null);
  const remove = useMutation({
    mutationFn: (id: string) => api(`/users/${id}`, { method: 'DELETE' }),
    onSuccess: () => { toast('ok', 'Usuário excluído.'); return qc.invalidateQueries({ queryKey: ['users'] }); },
    onError: (e) => toast('err', errMsg(e)),
  });
  return (
    <>
      <div className="grid-toolbar"><div className="grid-actions"><button className="btn" onClick={() => setEditing('new')}><Icon name="plus" /> Novo usuário</button></div></div>
      {isError && <Message kind="err">{errMsg(error)}</Message>}
      <div className="wrap">
        <table>
          <thead><tr><th>Nome</th><th>E-mail</th><th>Papel</th><th>Setor</th><th>Situação</th><th aria-label="Ações" /></tr></thead>
          <tbody>
            {isLoading && <tr><td colSpan={6} className="empty">Carregando…</td></tr>}
            {users.map((u) => (
              <tr key={u.id}>
                <td><b>{u.name}</b>{u.displayName !== u.name && <small style={{ display: 'block' }}>Assina: {u.displayName}</small>}</td>
                <td>{u.email}</td>
                <td><Tag icon={u.role === 'ADMIN' ? 'lock' : 'user'}>{ROLE_LABEL[u.role]}</Tag></td>
                <td>{u.sectorId ? sectors.find((s) => s.id === u.sectorId)?.name : 'Todos'}</td>
                <td>{u.active ? <Tag icon="check" kind="ok">Ativo</Tag> : <Tag icon="x" kind="bad">Inativo</Tag>}</td>
                <td><div className="actions">
                  <button className="btn alt sm" onClick={() => setEditing(u)}><Icon name="pencil" /> Editar</button>
                  <button className="btn alt sm" disabled={u.id === me.id} onClick={() => setRemoving(u)} aria-label={`Excluir ${u.name}`}><Icon name="trash" /></button>
                </div></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {editing && <UserForm user={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
      <ConfirmDialog open={!!removing} onClose={() => setRemoving(null)} danger title="Excluir usuário?" confirmLabel="Excluir"
        text={`Quem já atendeu conversas não pode ser excluído — desative o usuário em vez disso. Excluir “${removing?.name ?? ''}”?`} onConfirm={() => removing && remove.mutate(removing.id)} />
    </>
  );
}

// ---------------------------------------------------------------- Respostas rápidas (RF13)
export function Respostas() {
  const qc = useQueryClient();
  const toast = useUI((s) => s.toast);
  const me = useSession((s) => s.user)!;
  const { data: sectors = [] } = useSectors();
  const { data: list = [] } = useQuickReplies();
  const [f, setF] = useState({ shortcut: '', body: '', sectorId: me.role === 'ADMIN' ? '' : (me.sectorId ?? '') });
  const [error, setError] = useState<string | null>(null);
  const add = useMutation({
    mutationFn: () => api('/quick-replies', { body: { shortcut: f.shortcut, body: f.body, sectorId: f.sectorId || null } }),
    onSuccess: () => { setF({ ...f, shortcut: '', body: '' }); setError(null); return qc.invalidateQueries({ queryKey: ['quick-replies'] }); },
    onError: (e) => setError(errMsg(e)),
  });
  const del = useMutation({
    mutationFn: (id: string) => api(`/quick-replies/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['quick-replies'] }),
    onError: (e) => toast('err', errMsg(e)),
  });
  const mayEdit = (r: QuickReply) => me.role === 'ADMIN' || r.sectorId === me.sectorId;
  return (
    <>
      <div className="card">
        <h2>Nova resposta rápida</h2>
        {error && <Message kind="err">{error}</Message>}
        <p className="hint" style={{ marginTop: -8 }}>No chat, digite <kbd>/</kbd> e o atalho para inserir o texto.</p>
        <div className="row">
          <label style={{ flex: '0 1 180px' }}>Atalho (sem “/”)<input value={f.shortcut} onChange={(e) => setF({ ...f, shortcut: e.target.value.replace(/[^a-zA-Z0-9_-]/g, '') })} maxLength={30} placeholder="bomdia" /></label>
          <label style={{ flex: '0 1 220px' }}>Setor
            <select value={f.sectorId} onChange={(e) => setF({ ...f, sectorId: e.target.value })} disabled={me.role !== 'ADMIN'}>
              {me.role === 'ADMIN' && <option value="">Todos os setores</option>}
              {sectors.filter((s) => me.role === 'ADMIN' || s.id === me.sectorId).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </label>
          <label style={{ flex: '3 1 300px' }}>Texto<textarea value={f.body} onChange={(e) => setF({ ...f, body: e.target.value })} maxLength={2000} /></label>
          <button className="btn" disabled={add.isPending || f.shortcut.length < 2 || !f.body.trim()} onClick={() => add.mutate()}><Icon name="plus" /> Adicionar</button>
        </div>
      </div>
      <div className="wrap">
        <table>
          <thead><tr><th>Atalho</th><th>Setor</th><th>Texto</th><th aria-label="Ações" /></tr></thead>
          <tbody>
            {list.length === 0 && <tr><td colSpan={4} className="empty">Nenhuma resposta rápida cadastrada.</td></tr>}
            {list.map((r) => (
              <tr key={r.id}>
                <td><code>/{r.shortcut}</code></td>
                <td>{r.sectorId ? sectors.find((s) => s.id === r.sectorId)?.name : 'Todos'}</td>
                <td style={{ maxWidth: 480 }}>{r.body}</td>
                <td><div className="actions">{mayEdit(r) && <button className="btn alt sm" onClick={() => del.mutate(r.id)} aria-label={`Excluir /${r.shortcut}`}><Icon name="trash" /></button>}</div></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
