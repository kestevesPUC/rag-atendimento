# Arquitetura

## 1. Visão macro

Tudo roda **nas máquinas do usuário** — não há servidor em nuvem próprio. A única dependência externa é a **API do modelo de IA** (LLM remoto).

Como vários atendentes usam o app ao mesmo tempo e existe **um único número de WhatsApp**, o mesmo instalador funciona em dois modos:

| Modo | Onde | O que roda |
|------|------|-----------|
| **Host** | Uma máquina da empresa (fica ligada no horário de atendimento) | Interface + servidor embutido (API, Socket.IO), sessão do WhatsApp, bancos SQLite, embeddings, chamadas ao LLM. |
| **Cliente** | Máquinas dos demais atendentes | Só a interface; conecta ao Host pela rede local (descoberta automática via mDNS/Bonjour ou IP informado). |

Uma empresa pequena pode usar apenas o Host (um único atendente/admin).

```
 Cliente (WhatsApp)                                      ☁ API do modelo de IA
        │                                                  (LLM remoto, HTTPS)
        ▼                                                          ▲
┌──────────────────────────── MÁQUINA HOST (Electron) ────────────┼──────────┐
│                                                                  │          │
│  ┌────────────────────┐  IPC   ┌───────────────────────────┐    │          │
│  │ WhatsApp Gateway   │◀──────▶│ Servidor embutido          │────┘          │
│  │ whatsapp-web.js    │        │ Fastify + Socket.IO        │               │
│  │ (utility process)  │        │ regras de conversa, RAG,   │               │
│  └────────────────────┘        │ fila de jobs, embeddings   │               │
│                                └──────┬──────────────┬──────┘               │
│  ┌──────────────┐                     │              │                      │
│  │ UI (React)   │◀── localhost ───────┘              ▼                      │
│  └──────────────┘                     data/app.db · data/knowledge.db       │
└───────────────────────────────────────┬────────────────────────────────────┘
                                        │ rede local (HTTPS/WSS + JWT)
                 ┌──────────────────────┼──────────────────────┐
                 ▼                      ▼                      ▼
          App (modo Cliente)     App (modo Cliente)     App (modo Cliente)
          atendente setor A      atendente setor B      supervisor
```

**Acesso fora da rede local** (atendentes remotos): opcional, via VPN da empresa ou túnel (ex.: Tailscale). Não exige servidor próprio.

## 2. Componentes

| Componente | Tecnologia | Responsabilidade |
|------------|-----------|------------------|
| **apps/desktop** | Electron, React, Vite, TanStack Query, Zustand, socket.io-client | Instalador único. UI sempre fala com o servidor por HTTP/WS (mesmo no Host, via localhost) — sem acesso direto ao banco. |
| **packages/server** | Fastify, Socket.IO, Prisma, Zod | Servidor embutido, iniciado apenas no modo Host (processo principal do Electron ou `utilityProcess`). |
| **packages/wa-gateway** | whatsapp-web.js (Puppeteer), `LocalAuth` | Roda em `utilityProcess` separado no Host; mantém a sessão, publica mensagens recebidas, executa envios. |
| **packages/jobs** | Fila persistida em SQLite (ex.: tabela `jobs` + loop) | Jobs: `ai-reply`, `ingest-document`, `inactivity-check`, `send-message`. Sem Redis. |
| **packages/rag** | Transformers.js (embeddings locais), better-sqlite3 + sqlite-vec, cliente HTTP do LLM | Chunking, embeddings, banco vetorial SQLite, busca híbrida, chamada ao modelo remoto. |
| **packages/finetune** | Cliente da API de fine-tuning do provedor | Exporta dataset, envia job de fine-tuning, acompanha status, registra versão (ver doc 03, seção 6). |
| Banco vetorial | SQLite + sqlite-vec (`data/knowledge.db`) | Chunks e embeddings da base de conhecimento. |
| **packages/shared** | TypeScript | Tipos, schemas Zod, constantes de eventos. |
| Banco relacional | SQLite (`data/app.db`, via Prisma) no início; PostgreSQL quando escalar | Setores, usuários, conversas, mensagens. |
| Arquivos | Pasta `data/files` no Host | Documentos e mídias. |
| Modelo de IA | API remota (configurável) | Geração de respostas, triagem e resumo. Chave de API guardada criptografada no Host (`safeStorage` do Electron), nunca enviada aos Clientes. |

Estrutura: monorepo **pnpm workspaces** + Turborepo. Todos os dados ficam em `%APPDATA%/RagAtendimento/data` no Host.

## 3. Por que o gateway é um processo separado

- whatsapp-web.js roda um Chromium (Puppeteer): pesado e pode travar. Isolado em `utilityProcess`, pode reiniciar sem derrubar o servidor.
- Só **uma** instância pode controlar a sessão — por isso ela vive exclusivamente no Host.
- Implementa a interface `ChannelAdapter` (`onMessage`, `sendText`, `sendMedia`, `onAck`), permitindo trocar por WhatsApp Cloud API no futuro.

## 4. Ciclo de vida da conversa (máquina de estados)

```
             msg do cliente (sem conversa aberta)
                          │
                          ▼
                    ┌───────────┐  IA resolve / cliente some
                    │  BOT      │──────────────────────────────┐
                    └─────┬─────┘                              │
       IA não resolve /   │ pede humano                        │
       triagem do setor   ▼                                    │
                    ┌───────────┐                              │
 atendente inicia   │  QUEUED   │ (fila do setor)              │
 conversa ativa     └─────┬─────┘                              │
       │                  │ atendente assume                   │
       │                  ▼                                    ▼
       │            ┌───────────┐  inatividade / manual  ┌───────────┐
       └──────────▶ │  HUMAN    │ ─────────────────────▶ │  CLOSED   │
                    └───────────┘                        └───────────┘
```

| Campo | Significado |
|-------|-------------|
| `origin` | `CUSTOMER` ou `AGENT`. Se `AGENT`, a IA nunca responde (RN07). |
| `status` | `BOT`, `QUEUED`, `HUMAN`, `CLOSED`. |
| `aiEnabled` | `origin = CUSTOMER` e `status = BOT`. Calculado no servidor. |
| `sectorId` | Setor atual; define quem vê a conversa (RN03). |
| `assignedUserId` | Atendente responsável quando `HUMAN`. |
| `lastInteractionAt` | Atualizado a cada mensagem (cliente, atendente ou IA). |

### Fluxo de mensagem recebida

1. Gateway recebe `message` → normaliza → publica `wa.inbound`.
2. Server faz upsert do contato; busca conversa aberta (`status != CLOSED`) — se não houver, cria com `origin=CUSTOMER`, `status=BOT`.
3. Persiste a mensagem; emite `message:new` para a sala Socket.IO do setor (`sector:{id}`).
4. Se `status = BOT` → enfileira `ai-reply` (com debounce de ~3 s para agrupar mensagens picadas).
5. Se `QUEUED`/`HUMAN` → apenas notifica atendentes.

### Envio pelo atendente (assinatura)

```ts
const body = `*${user.displayName}*\n${text}`;   // RN05
```
- Feito no **servidor** (o cliente não pode forjar o nome).
- Se a conversa estava em `BOT`/`QUEUED`, enviar mensagem a coloca em `HUMAN` e atribui ao remetente (RN08).
- Mensagens da IA são enviadas sem prefixo (RN06). No banco: `senderType = AI | AGENT | CUSTOMER | SYSTEM`.

### Conversa ativa (iniciada pelo atendente)
`POST /conversations` com o telefone → cria `origin=AGENT`, `status=HUMAN`, `assignedUserId=atendente`. A IA permanece desligada até o encerramento.

### Encerramento por inatividade (RN09)
- Job recorrente `inactivity-check` a cada 1 min:
  `status IN (BOT, HUMAN, QUEUED) AND lastInteractionAt < now() - sector.inactivityTimeout`.
- Opcional: aviso prévio ("Ainda está aí?") em 80% do tempo.
- Ao encerrar: envia mensagem de encerramento do setor, `status=CLOSED`, `closedReason=INACTIVITY`.
- Na fila (`QUEUED`) o timeout pode ser maior/desativado por setor para não perder clientes aguardando atendente.

## 5. Autorização por setor (RN03)

- JWT contém `userId`, `role`, `sectorId`.
- Toda query de conversa passa por um *scope* Prisma: `where: { sectorId: user.sectorId }` (admin ignora).
- Socket.IO: ao conectar, o usuário entra **apenas** na sala `sector:{sectorId}` (e `user:{id}`).
- Transferência de setor: a conversa sai da sala antiga e é emitida na nova.

## 6. Concorrência entre atendentes

- "Assumir" usa update condicional: `UPDATE ... SET assignedUserId=$1, status='HUMAN' WHERE id=$2 AND status='QUEUED'` — o primeiro vence; os demais recebem `409`.
- Lock em memória por conversa no job `ai-reply` (há um único processo servidor) para não gerar respostas duplicadas.
- SQLite em modo WAL; todas as escritas passam pelo servidor do Host (os Clientes nunca abrem o arquivo).
- Indicador "fulano está digitando/visualizando" via Socket.IO.

## 7. Implantação

- Um único instalador (`electron-builder`, NSIS no Windows) com `electron-updater` para auto-update.
- **Primeira execução**: assistente pergunta "Esta máquina será o Host?" → cria admin, configura chave da API de IA, conecta WhatsApp por QR Code. Nas demais: "Conectar a um Host" (descoberta automática na rede ou IP manual).
- Host: iniciar com o Windows e ficar na bandeja do sistema; aviso se for fechado com atendimentos em andamento; impedir suspensão (`powerSaveBlocker`).
- Rede: servidor escuta na LAN com TLS autoassinado gerado na instalação (os Clientes fixam o certificado no pareamento); porta liberada no firewall pelo instalador.
- **Backup**: cópia diária automática dos SQLite (`VACUUM INTO`) + exportação manual; restauração pelo assistente.
- Requisitos mínimos do Host: 8 GB RAM, SSD, conexão estável (Chromium do WhatsApp + embeddings locais).
- Observabilidade: Pino (logs em arquivo rotativo), estado do WhatsApp e da API de IA visíveis no app, alerta de desconexão.
