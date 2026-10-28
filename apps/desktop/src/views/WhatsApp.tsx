import type { WhatsAppStatus } from '@rag/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import QRCode from 'qrcode';
import { useEffect, useState } from 'react';
import { Message, WaTag } from '../components';
import { api, errMsg } from '../lib/api';
import { Icon } from '../lib/icons';
import { useUI } from '../lib/ui-store';

/** RF01/RF02: conectar o número por QR Code. A sessão fica salva no Host e reconecta sozinha. */
export function WhatsApp() {
  const qc = useQueryClient();
  const toast = useUI((s) => s.toast);
  const status = useQuery({ queryKey: ['wa-status'], queryFn: () => api<WhatsAppStatus>('/whatsapp/status'), refetchInterval: 10_000 });
  const qr = useQuery({ queryKey: ['wa-qr'], queryFn: () => api<{ qr: string | null }>('/whatsapp/qr'), refetchInterval: 8_000 });
  const [svg, setSvg] = useState<string | null>(null);
  const state = status.data?.state ?? 'STOPPED';

  useEffect(() => {
    let alive = true;
    if (!qr.data?.qr) return setSvg(null);
    QRCode.toString(qr.data.qr, { type: 'svg', margin: 0, errorCorrectionLevel: 'M' }).then((s) => alive && setSvg(s)).catch(() => alive && setSvg(null));
    return () => { alive = false; };
  }, [qr.data?.qr]);

  const act = useMutation({
    mutationFn: (what: 'start' | 'stop') => api<WhatsAppStatus>(`/whatsapp/${what}`, { method: 'POST' }),
    onSuccess: (s) => qc.setQueryData(['wa-status'], s),
    onError: (e) => toast('err', errMsg(e)),
  });

  return (
    <div className="card" style={{ maxWidth: 760 }}>
      <h2>Conexão do número</h2>
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', marginBottom: 16 }}>
        <WaTag state={state} />
        {status.data?.detail && <small>{status.data.detail}</small>}
        <span style={{ flex: 1 }} />
        {state === 'READY' || state === 'QR' || state === 'STARTING' || state === 'AUTHENTICATING'
          ? <button className="btn alt" onClick={() => act.mutate('stop')} disabled={act.isPending}><Icon name="x" /> Desconectar</button>
          : <button className="btn" onClick={() => act.mutate('start')} disabled={act.isPending}><Icon name="whatsapp" /> {act.isPending ? 'Iniciando…' : 'Conectar'}</button>}
      </div>
      {status.isError && <Message kind="err">{errMsg(status.error)}</Message>}

      {state === 'QR' && svg && (
        <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', alignItems: 'center' }}>
          <div className="qr" role="img" aria-label="QR Code para conectar o WhatsApp" dangerouslySetInnerHTML={{ __html: svg }} />
          <ol style={{ margin: 0, paddingLeft: 20, maxWidth: 340 }}>
            <li>Abra o WhatsApp no celular do número de atendimento.</li>
            <li>Toque em <b>Aparelhos conectados</b> e depois em <b>Conectar um aparelho</b>.</li>
            <li>Aponte a câmera para este código. Ele se renova sozinho.</li>
          </ol>
        </div>
      )}
      {state === 'READY' && <Message kind="ok">Número conectado. As mensagens recebidas já chegam ao sistema.</Message>}
      {(state === 'STOPPED' || state === 'DISCONNECTED') && <Message kind="warn">Sem conexão: nenhuma mensagem será recebida ou enviada até conectar.</Message>}

      <h3 style={{ fontSize: 13, color: 'var(--mute)', textTransform: 'uppercase', letterSpacing: '.05em' }}>Avisos importantes</h3>
      <ul style={{ paddingLeft: 20, color: 'var(--mute)' }}>
        <li>Esta conexão usa uma biblioteca <b>não oficial</b> do WhatsApp Web: o número pode ser bloqueado e a conexão pode quebrar após atualizações do WhatsApp.</li>
        <li>Não use para disparos em massa nem contate quem não pediu atendimento. Prefira testar com um número de homologação.</li>
        <li>O computador Host precisa ficar ligado, com internet, durante o horário de atendimento.</li>
      </ul>
    </div>
  );
}
