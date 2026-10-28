import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Toasts, WaTag } from './components';
import { refreshSession } from './lib/api';
import { ROLE_LABEL, initials } from './lib/format';
import { Icon, type IconName } from './lib/icons';
import { useConversations, useWaStatus } from './lib/queries';
import { useRealtime } from './lib/realtime';
import { applyTheme, useSession } from './lib/session';
import { useUI, type View } from './lib/ui-store';
import { Atendimento } from './views/Atendimento';
import { Auth } from './views/Auth';
import { Respostas, Setores, Usuarios } from './views/Cadastros';
import { ConfigIA } from './views/ConfigIA';
import { Conhecimento } from './views/Conhecimento';
import { Relatorios } from './views/Relatorios';
import { WhatsApp } from './views/WhatsApp';

interface NavItem { view: View; label: string; icon: IconName; roles: ('ADMIN' | 'SUPERVISOR' | 'AGENT')[]; title: string }

const NAV: { group?: string; items: NavItem[] }[] = [
  { items: [{ view: 'atendimento', label: 'Atendimento', icon: 'chat', roles: ['ADMIN', 'SUPERVISOR', 'AGENT'], title: 'Atendimento' }] },
  {
    group: 'Treinamento da IA',
    items: [
      { view: 'conhecimento', label: 'Base de conhecimento', icon: 'book', roles: ['ADMIN'], title: 'Base de conhecimento' },
      { view: 'ia', label: 'Configurações da IA', icon: 'sliders', roles: ['ADMIN'], title: 'Configurações da IA' },
    ],
  },
  {
    group: 'Gestão',
    items: [
      { view: 'respostas', label: 'Respostas rápidas', icon: 'send', roles: ['ADMIN', 'SUPERVISOR'], title: 'Respostas rápidas' },
      { view: 'relatorios', label: 'Relatórios', icon: 'chart', roles: ['ADMIN', 'SUPERVISOR'], title: 'Relatórios' },
      { view: 'setores', label: 'Setores', icon: 'building', roles: ['ADMIN'], title: 'Setores' },
      { view: 'usuarios', label: 'Usuários', icon: 'users', roles: ['ADMIN'], title: 'Usuários' },
      { view: 'whatsapp', label: 'Conexão WhatsApp', icon: 'whatsapp', roles: ['ADMIN'], title: 'Conexão WhatsApp' },
    ],
  },
];

function Shell() {
  const user = useSession((s) => s.user)!;
  const { theme, setTheme, clear, online } = useSession();
  const { view, setView } = useUI();
  const qc = useQueryClient();
  const { data: convs = [] } = useConversations();
  const wa = useWaStatus(user.role !== 'AGENT');
  useRealtime();

  const queued = convs.filter((c) => c.status === 'QUEUED').length;
  const items = NAV.map((g) => ({ ...g, items: g.items.filter((i) => i.roles.includes(user.role)) })).filter((g) => g.items.length);
  const current = items.flatMap((g) => g.items).find((i) => i.view === view) ?? items[0]!.items[0]!;

  // Notificações do sistema para novas conversas na fila (RF12).
  useEffect(() => {
    try {
      if ('Notification' in window && Notification.permission === 'default') void Notification.requestPermission();
    } catch { /* indisponível */ }
  }, []);

  // Atalho "/" foca a busca da tela atual.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable) return;
      const el = document.getElementById('search');
      if (el) { e.preventDefault(); el.focus(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => { document.title = `${queued ? `(${queued}) ` : ''}${current.title} — RAG Atendimento`; }, [queued, current.title]);

  const logout = () => { clear(); qc.clear(); useUI.setState({ selectedId: null, unread: {}, view: 'atendimento' }); };
  // "Sistema" segue o modo do sistema operacional: o botão alterna a partir do tema efetivamente visível.
  const effective = theme === 'system' ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : theme;
  const nextTheme = effective === 'dark' ? 'light' : 'dark';

  return (
    <div className="shell">
      <aside className="side" aria-label="Menu principal">
        <div className="brand">
          <span className="logo"><Icon name="chat" /></span>
          <span><b>RAG Atendimento</b><small>Atendimento com IA</small></span>
        </div>
        <nav>
          {items.map((g, i) => (
            <div key={i} style={{ display: 'contents' }}>
              {g.group && <div className="group">{g.group}</div>}
              {g.items.map((it) => (
                <button key={it.view} className="nav" aria-current={it.view === current.view ? 'page' : undefined} onClick={() => setView(it.view)}>
                  <Icon name={it.icon} /> {it.label}
                  {it.view === 'atendimento' && queued > 0 && <span className="badge count" aria-label={`${queued} na fila`}>{queued}</span>}
                </button>
              ))}
            </div>
          ))}
        </nav>
        <div className="foot">
          <div className="who">
            <span className="avatar" aria-hidden="true">{initials(user.displayName)}</span>
            <span><b>{user.displayName}</b><small>{ROLE_LABEL[user.role]}</small></span>
          </div>
          <button onClick={() => setTheme(nextTheme)}><Icon name={effective === 'dark' ? 'sun' : 'moon'} /> <span>Tema {nextTheme === 'dark' ? 'escuro' : 'claro'}</span></button>
          <button onClick={logout}><Icon name="out" /> <span>Sair</span></button>
        </div>
      </aside>

      <div className="main">
        {!online && <div className="offline" role="alert"><Icon name="wifi" /> Sem conexão com o servidor — tentando reconectar…</div>}
        <header className="topbar">
          <h1>{current.title}</h1>
          <span className="spacer" />
          {wa.data && (user.role === 'ADMIN'
            ? <button className="btn alt sm" onClick={() => setView('whatsapp')} title="Abrir conexão do WhatsApp"><WaTag state={wa.data.state} /></button>
            : <WaTag state={wa.data.state} />)}
        </header>
        <main className={`content ${current.view === 'atendimento' ? 'flush' : ''}`}>
          {current.view === 'atendimento' && <Atendimento />}
          {current.view === 'conhecimento' && <Conhecimento />}
          {current.view === 'ia' && <ConfigIA />}
          {current.view === 'respostas' && <Respostas />}
          {current.view === 'relatorios' && <Relatorios />}
          {current.view === 'setores' && <Setores />}
          {current.view === 'usuarios' && <Usuarios />}
          {current.view === 'whatsapp' && <WhatsApp />}
        </main>
      </div>
      <Toasts />
    </div>
  );
}

export function App() {
  const user = useSession((s) => s.user);
  const refreshToken = useSession((s) => s.refreshToken);
  const theme = useSession((s) => s.theme);
  const [booting, setBooting] = useState(!!refreshToken);

  useEffect(() => applyTheme(theme), [theme]);

  // Ao abrir o app, tenta retomar a sessão com o token de renovação guardado.
  useEffect(() => {
    if (!refreshToken) return setBooting(false);
    void refreshSession().finally(() => setBooting(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- só na abertura
  }, []);

  if (booting) return <div className="placeholder" style={{ height: '100vh' }}><Icon name="clock" /><div>Conectando…</div></div>;
  return user ? <Shell /> : <Auth />;
}
