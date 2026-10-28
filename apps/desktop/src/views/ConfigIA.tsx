import type { AiSettings } from '@rag/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Message } from '../components';
import { api, errMsg } from '../lib/api';
import { Icon } from '../lib/icons';
import { useSectors } from '../lib/queries';
import { useUI } from '../lib/ui-store';

type Loaded = AiSettings & { apiKeyConfigured: boolean };

function ApiKeyCard({ configured }: { configured: boolean }) {
  const qc = useQueryClient();
  const toast = useUI((s) => s.toast);
  const [key, setKey] = useState('');
  const [error, setError] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: (apiKey: string | null) => api('/settings/ai-key', { method: 'PUT', body: { apiKey } }),
    onSuccess: () => { setKey(''); setError(null); toast('ok', 'Chave atualizada.'); return qc.invalidateQueries({ queryKey: ['ai-settings'] }); },
    onError: (e) => setError(errMsg(e)),
  });
  return (
    <div className="card">
      <h2>Chave de API do modelo de IA</h2>
      {configured ? <Message kind="ok">Chave configurada. Por segurança ela não é exibida novamente.</Message>
        : <Message kind="warn">Sem chave configurada: a IA não consegue responder e todas as conversas vão para a fila humana.</Message>}
      {error && <Message kind="err">{error}</Message>}
      <div className="row">
        <label style={{ flex: '3 1 320px' }}>{configured ? 'Substituir chave' : 'Chave de API'}
          <input type="password" value={key} onChange={(e) => setKey(e.target.value)} autoComplete="off" placeholder="sk-ant-…" />
          <span className="hint">Fica guardada criptografada no computador Host e nunca é enviada aos demais computadores.</span>
        </label>
        <button className="btn" disabled={save.isPending || key.trim().length < 20} onClick={() => save.mutate(key.trim())}>Salvar chave</button>
        {configured && <button className="btn alt" disabled={save.isPending} onClick={() => save.mutate(null)}>Remover</button>}
      </div>
    </div>
  );
}

export function ConfigIA() {
  const qc = useQueryClient();
  const toast = useUI((s) => s.toast);
  const { data: sectors = [] } = useSectors();
  const { data, isError, error } = useQuery({ queryKey: ['ai-settings'], queryFn: () => api<Loaded>('/settings/ai') });
  const [f, setF] = useState<AiSettings | null>(null);
  const [keywords, setKeywords] = useState('');
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    if (!data) return;
    const { apiKeyConfigured: _k, ...rest } = data;
    setF(rest);
    setKeywords(rest.alwaysHumanKeywords.join('\n'));
  }, [data]);

  const save = useMutation({
    mutationFn: (body: AiSettings) => api('/settings/ai', { method: 'PUT', body }),
    onSuccess: () => { setErr(null); toast('ok', 'Configurações salvas.'); return qc.invalidateQueries({ queryKey: ['ai-settings'] }); },
    onError: (e) => setErr(errMsg(e)),
  });

  if (isError) return <Message kind="err">{errMsg(error)}</Message>;
  if (!f || !data) return <small>Carregando…</small>;
  const set = <K extends keyof AiSettings>(k: K, v: AiSettings[K]) => setF({ ...f, [k]: v });
  const submit = () => save.mutate({ ...f, alwaysHumanKeywords: keywords.split('\n').map((k) => k.trim()).filter(Boolean) });

  return (
    <>
      <ApiKeyCard configured={data.apiKeyConfigured} />
      <div className="card">
        <h2>Comportamento da IA</h2>
        {err && <Message kind="err">{err}</Message>}
        <div className="form-grid">
          <label>Nome da empresa<input value={f.companyName} onChange={(e) => set('companyName', e.target.value)} maxLength={80} /></label>
          <label>Nome do assistente<input value={f.assistantName} onChange={(e) => set('assistantName', e.target.value)} maxLength={40} /></label>
          <label className="wide">Tom de voz<textarea value={f.tone} onChange={(e) => set('tone', e.target.value)} maxLength={600} />
            <span className="hint">As regras de segurança (responder só com a base, não inventar valores/prazos, não pedir senhas) são fixas e não podem ser alteradas aqui.</span>
          </label>
          <label>Relevância mínima ({Math.round(f.relevanceThreshold * 100)}%)
            <input type="range" min={0} max={1} step={0.01} value={f.relevanceThreshold} onChange={(e) => set('relevanceThreshold', Number(e.target.value))} />
            <span className="hint">Abaixo disso a IA transfere em vez de responder. Ajuste no Playground.</span>
          </label>
          <label>Transferir após respostas sem resolver
            <input type="number" min={1} max={10} value={f.maxFailedAttempts} onChange={(e) => set('maxFailedAttempts', Number(e.target.value))} />
          </label>
          <label>Agrupar mensagens seguidas por (segundos)
            <input type="number" min={0} max={30} value={f.debounceSeconds} onChange={(e) => set('debounceSeconds', Number(e.target.value))} />
          </label>
          <label>Setor padrão para transferências sem setor
            <select value={f.defaultSectorId ?? ''} onChange={(e) => set('defaultSectorId', e.target.value || null)}>
              <option value="">Primeiro setor (ordem alfabética)</option>
              {sectors.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </label>
          <label className="wide">Assuntos sempre atendidos por humano (um por linha)
            <textarea value={keywords} onChange={(e) => setKeywords(e.target.value)} placeholder={'cancelamento\nprocon\nadvogado'} />
            <span className="hint">Se a mensagem do cliente contiver uma destas palavras, a IA transfere imediatamente.</span>
          </label>
          <label className="check wide"><input type="checkbox" checked={f.inactivityWarning} onChange={(e) => set('inactivityWarning', e.target.checked)} /> Avisar “Ainda está por aí?” quando faltar 20% do tempo de inatividade</label>
          <label>Modelo de triagem e resumo<input value={f.triageModel} onChange={(e) => set('triageModel', e.target.value)} /></label>
          <label>Modelo de resposta<input value={f.answerModel} onChange={(e) => set('answerModel', e.target.value)} /></label>
        </div>
        <div className="foot" style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 18 }}>
          <button className="btn" disabled={save.isPending} onClick={submit}><Icon name="check" /> {save.isPending ? 'Salvando…' : 'Salvar configurações'}</button>
        </div>
      </div>
    </>
  );
}
