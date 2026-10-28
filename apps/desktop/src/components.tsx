import type { ConvStatus, WhatsAppState } from '@rag/shared';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { fetchBlobUrl } from './lib/api';
import { STATUS_LABEL, WA_LABEL } from './lib/format';
import { Icon, type IconName } from './lib/icons';
import { useUI } from './lib/ui-store';

const STATUS_VIEW: Record<ConvStatus, { icon: IconName; cls: string }> = {
  BOT: { icon: 'bot', cls: 'info' },
  QUEUED: { icon: 'clock', cls: 'warn' },
  HUMAN: { icon: 'user', cls: 'ok' },
  CLOSED: { icon: 'check', cls: '' },
};

/** Situação sempre com ícone + texto (nunca só cor). */
export function StatusTag({ status }: { status: ConvStatus }) {
  const v = STATUS_VIEW[status];
  return (
    <span className={`tag ${v.cls}`}>
      <Icon name={v.icon} />
      {STATUS_LABEL[status]}
    </span>
  );
}

export function WaTag({ state }: { state: WhatsAppState }) {
  const cls = state === 'READY' ? 'ok' : state === 'STOPPED' || state === 'DISCONNECTED' ? 'bad' : 'warn';
  return (
    <span className={`tag ${cls}`}>
      <Icon name={state === 'READY' ? 'check' : state === 'QR' ? 'alert' : 'x'} />
      WhatsApp: {WA_LABEL[state]}
    </span>
  );
}

export function Tag({ icon, children, kind = '' }: { icon?: IconName; children: ReactNode; kind?: '' | 'ok' | 'bad' | 'warn' | 'info' }) {
  return (
    <span className={`tag ${kind}`}>
      {icon && <Icon name={icon} />}
      {children}
    </span>
  );
}

export function Message({ kind, children }: { kind: 'err' | 'ok' | 'warn' | 'info'; children: ReactNode }) {
  return (
    <div className={`msg ${kind}`} role={kind === 'err' ? 'alert' : 'status'}>
      <Icon name={kind === 'ok' ? 'check' : kind === 'info' ? 'info' : 'alert'} />
      <span>{children}</span>
    </div>
  );
}

/** <dialog> nativo: foco preso, Esc fecha, fundo inerte. */
export function Modal({ open, onClose, title, children, confirm = false }: { open: boolean; onClose(): void; title: string; children: ReactNode; confirm?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog ref={ref} className={confirm ? 'confirm' : ''} onClose={onClose} onCancel={onClose} aria-labelledby="dlg-title">
      {open && (
        <>
          <h2 id="dlg-title">{title}</h2>
          {children}
        </>
      )}
    </dialog>
  );
}

export function ConfirmDialog({ open, title, text, confirmLabel, danger, onConfirm, onClose }: {
  open: boolean; title: string; text: string; confirmLabel: string; danger?: boolean; onConfirm(): void; onClose(): void;
}) {
  return (
    <Modal open={open} onClose={onClose} title={title} confirm>
      <p>{text}</p>
      <div className="foot">
        <button className="btn alt" onClick={onClose}>Cancelar</button>
        <button className={`btn ${danger ? 'danger' : ''}`} onClick={() => { onConfirm(); onClose(); }}>{confirmLabel}</button>
      </div>
    </Modal>
  );
}

export function Toasts() {
  const toasts = useUI((s) => s.toasts);
  const dismiss = useUI((s) => s.dismiss);
  return (
    <div className="toasts" aria-live="polite" aria-atomic="false">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`} role={t.kind === 'err' ? 'alert' : 'status'}>
          <span style={{ flex: 1 }}>{t.text}</span>
          <button className="btn alt sm icon" aria-label="Fechar aviso" onClick={() => dismiss(t.id)}><Icon name="x" /></button>
        </div>
      ))}
    </div>
  );
}

/** Mídia protegida: baixada com o token e exibida por URL local. */
export function AuthMedia({ path, type }: { path: string; type: string | null }) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let revoked: string | null = null;
    let alive = true;
    fetchBlobUrl(path).then((u) => (alive ? ((revoked = u), setUrl(u)) : URL.revokeObjectURL(u))).catch(() => alive && setFailed(true));
    return () => {
      alive = false;
      if (revoked) URL.revokeObjectURL(revoked);
    };
  }, [path]);
  if (failed) return <small>Não foi possível carregar o arquivo.</small>;
  if (!url) return <small>Carregando arquivo…</small>;
  if (type?.startsWith('image/')) return <img src={url} alt="Imagem enviada pelo cliente" />;
  if (type?.startsWith('audio/')) return <audio controls src={url} />;
  return <a href={url} download className="btn alt sm"><Icon name="file" /> Baixar arquivo</a>;
}

export function Empty({ icon, children }: { icon: IconName; children: ReactNode }) {
  return (
    <div className="placeholder">
      <Icon name={icon} />
      <div>{children}</div>
    </div>
  );
}
