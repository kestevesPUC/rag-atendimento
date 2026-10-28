import type { UserDTO } from '@rag/shared';
import { useQuery } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Message } from '../components';
import { api, errMsg } from '../lib/api';
import { Icon } from '../lib/icons';
import { useSession } from '../lib/session';

interface Tokens { accessToken: string; refreshToken: string; user: UserDTO }

function Hero() {
  return (
    <div className="hero">
      <div className="logo"><Icon name="chat" /></div>
      <h1>RAG Atendimento</h1>
      <p>Atendimento por WhatsApp com inteligência artificial treinada na sua base de conhecimento — e transferência para a pessoa certa quando for preciso.</p>
      <ul>
        <li><Icon name="bot" /> A IA responde só com o que a empresa cadastrou</li>
        <li><Icon name="swap" /> Transferência para o setor correto, com resumo</li>
        <li><Icon name="lock" /> Cada atendente vê apenas o seu setor</li>
      </ul>
    </div>
  );
}

export function Auth() {
  const { serverUrl, setServerUrl, setSession } = useSession();
  const [url, setUrl] = useState(serverUrl);
  const [editing, setEditing] = useState(false);
  const status = useQuery({
    queryKey: ['setup-status', serverUrl],
    queryFn: () => api<{ needsSetup: boolean }>('/setup/status', { auth: false }),
    retry: false,
  });
  const needsSetup = status.data?.needsSetup === true;

  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const saveUrl = () => {
    setServerUrl(url);
    setEditing(false);
    setError(null);
    void status.refetch();
  };

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (needsSetup && password !== confirm) return setError('As senhas não conferem.');
    setBusy(true);
    try {
      const tokens = needsSetup
        ? await api<Tokens>('/setup', { body: { name, email, password }, auth: false })
        : await api<Tokens>('/auth/login', { body: { email, password }, auth: false });
      setSession(tokens);
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth">
      <Hero />
      <div className="panel">
        <form onSubmit={submit} noValidate>
          <h2>{needsSetup ? 'Configuração inicial' : 'Entrar'}</h2>
          <p>{needsSetup ? 'Crie o administrador desta instalação.' : 'Use o e-mail e a senha cadastrados pelo administrador.'}</p>

          {status.isError && !editing && (
            <Message kind="err">
              {errMsg(status.error)}
            </Message>
          )}
          {error && <Message kind="err">{error}</Message>}

          {needsSetup && (
            <label>Seu nome
              <input value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" required />
            </label>
          )}
          <label>E-mail
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" required />
          </label>
          <label>Senha
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete={needsSetup ? 'new-password' : 'current-password'} required minLength={needsSetup ? 8 : undefined} />
            {needsSetup && <span className="hint">Mínimo de 8 caracteres.</span>}
          </label>
          {needsSetup && (
            <label>Confirmar senha
              <input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" required />
            </label>
          )}
          <button className="btn block" disabled={busy || status.isError}>
            {busy ? 'Aguarde…' : needsSetup ? 'Criar administrador e entrar' : 'Entrar'}
          </button>

          <div style={{ marginTop: 18 }}>
            {editing ? (
              <div className="row" style={{ alignItems: 'end' }}>
                <label>Endereço do servidor (Host)
                  <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="http://192.168.0.10:3333" />
                </label>
                <button type="button" className="btn alt" onClick={saveUrl}>Salvar</button>
              </div>
            ) : (
              <small>
                Servidor: <code>{serverUrl}</code>{' '}
                <button type="button" className="btn alt sm" onClick={() => setEditing(true)}>Alterar</button>
              </small>
            )}
          </div>
        </form>
      </div>
    </div>
  );
}
