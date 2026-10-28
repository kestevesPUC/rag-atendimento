import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Message } from '../components';
import { api, errMsg } from '../lib/api';
import { fmtDate, fmtDuration, fmtPercent } from '../lib/format';
import { useSectors } from '../lib/queries';
import { useSession } from '../lib/session';

interface Report {
  period: { from: string; to: string };
  totals: { conversations: number; closed: number; customerOrigin: number; agentOrigin: number };
  aiResolutionRate: number | null; transfers: number; avgFirstResponseSeconds: number | null; avgHandlingSeconds: number | null;
  bySector: { sectorId: string | null; name: string; conversations: number }[];
  byAgent: { userId: string; name: string; conversations: number; messages: number }[];
  gaps: { conversationId: string; question: string; topScore: number | null; at: string }[];
  feedback: { up: number; down: number };
}

function Bars({ rows }: { rows: { label: string; value: number }[] }) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  if (!rows.length) return <small>Sem dados no período.</small>;
  return (
    <div className="bars">
      {rows.map((r) => (
        <div className="bar" key={r.label}>
          <span title={r.label} style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.label}</span>
          <span className="track"><i style={{ width: `${(r.value / max) * 100}%` }} /></span>
          <b style={{ textAlign: 'right' }}>{r.value}</b>
        </div>
      ))}
    </div>
  );
}

export function Relatorios() {
  const me = useSession((s) => s.user)!;
  const { data: sectors = [] } = useSectors();
  const [days, setDays] = useState(30);
  const [sectorId, setSectorId] = useState('');
  const from = new Date(Date.now() - days * 86400_000).toISOString();
  const { data: r, isLoading, isError, error } = useQuery({
    queryKey: ['report', days, sectorId],
    queryFn: () => api<Report>('/reports/summary', { query: { from, sectorId: sectorId || undefined } }),
  });

  return (
    <>
      <div className="row" style={{ alignItems: 'end' }}>
        <label style={{ flex: '0 1 200px' }}>Período
          <select value={days} onChange={(e) => setDays(Number(e.target.value))}>
            <option value={7}>Últimos 7 dias</option><option value={30}>Últimos 30 dias</option><option value={90}>Últimos 90 dias</option>
          </select>
        </label>
        {me.role === 'ADMIN' && (
          <label style={{ flex: '0 1 240px' }}>Setor
            <select value={sectorId} onChange={(e) => setSectorId(e.target.value)}>
              <option value="">Todos</option>
              {sectors.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </label>
        )}
        {r && <small>De {fmtDate(r.period.from)} a {fmtDate(r.period.to)}</small>}
      </div>
      {isError && <Message kind="err">{errMsg(error)}</Message>}
      {isLoading && <small>Carregando…</small>}
      {r && (
        <>
          <div className="stats">
            <div className="stat"><b>{r.totals.conversations}</b><span>Conversas no período</span></div>
            <div className="stat"><b>{fmtPercent(r.aiResolutionRate)}</b><span>Resolvidas só pela IA (das encerradas)</span></div>
            <div className="stat"><b>{r.transfers}</b><span>Transferências da IA para humano</span></div>
            <div className="stat"><b>{fmtDuration(r.avgFirstResponseSeconds)}</b><span>Tempo médio até a 1ª resposta</span></div>
            <div className="stat"><b>{fmtDuration(r.avgHandlingSeconds)}</b><span>Tempo médio de atendimento humano</span></div>
            <div className="stat"><b>{r.feedback.up} / {r.feedback.down}</b><span>Avaliações da IA: positivas / negativas</span></div>
          </div>
          <Message kind="info">“Resolvida pela IA” significa: encerrada sem nunca passar por um humano. É uma aproximação — não mede a satisfação do cliente.</Message>
          <div className="form-grid" style={{ alignItems: 'start' }}>
            <div className="card"><h2>Volume por setor</h2><Bars rows={r.bySector.map((s) => ({ label: s.name, value: s.conversations }))} /></div>
            <div className="card"><h2>Volume por atendente</h2><Bars rows={r.byAgent.map((a) => ({ label: a.name, value: a.conversations }))} /></div>
          </div>
          <div className="card">
            <h2>Perguntas sem resposta na base</h2>
            <p className="hint" style={{ marginTop: -8 }}>Perguntas que a IA não soube responder e transferiu. São boas candidatas a novos documentos ou FAQs.</p>
            <div className="wrap">
              <table>
                <thead><tr><th>Pergunta do cliente</th><th className="n">Melhor relevância</th><th>Data</th></tr></thead>
                <tbody>
                  {r.gaps.length === 0 && <tr><td colSpan={3} className="empty">Nenhuma lacuna registrada no período.</td></tr>}
                  {r.gaps.map((g) => (
                    <tr key={g.conversationId + g.at}><td style={{ maxWidth: 520 }}>{g.question}</td><td className="n">{g.topScore === null ? '—' : fmtPercent(g.topScore)}</td><td>{fmtDate(g.at)}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </>
  );
}
