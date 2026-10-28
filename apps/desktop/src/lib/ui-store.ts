import { create } from 'zustand';

export type View = 'atendimento' | 'conhecimento' | 'setores' | 'usuarios' | 'whatsapp' | 'relatorios' | 'ia' | 'respostas';

export interface Toast {
  id: number;
  kind: 'info' | 'ok' | 'err';
  text: string;
}

interface UIState {
  view: View;
  selectedId: string | null;
  /** Mensagens do cliente ainda não vistas, por conversa. */
  unread: Record<string, number>;
  /** Quem está digitando/visualizando, por conversa (expira sozinho). */
  presence: Record<string, { name: string; type: 'typing' | 'viewing'; at: number }>;
  toasts: Toast[];
  setView(v: View): void;
  select(id: string | null): void;
  bumpUnread(id: string): void;
  setPresence(id: string, p: { name: string; type: 'typing' | 'viewing' }): void;
  toast(kind: Toast['kind'], text: string): void;
  dismiss(id: number): void;
}

let seq = 0;

export const useUI = create<UIState>((set, get) => ({
  view: 'atendimento',
  selectedId: null,
  unread: {},
  presence: {},
  toasts: [],
  setView: (view) => set({ view }),
  select: (selectedId) =>
    set((s) => {
      if (!selectedId) return { selectedId };
      const { [selectedId]: _seen, ...rest } = s.unread;
      return { selectedId, unread: rest };
    }),
  bumpUnread: (id) => set((s) => ({ unread: { ...s.unread, [id]: (s.unread[id] ?? 0) + 1 } })),
  setPresence: (id, p) => set((s) => ({ presence: { ...s.presence, [id]: { ...p, at: Date.now() } } })),
  toast: (kind, text) => {
    const id = ++seq;
    set((s) => ({ toasts: [...s.toasts.slice(-3), { id, kind, text }] }));
    setTimeout(() => get().dismiss(id), kind === 'err' ? 9000 : 5000);
  },
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));
