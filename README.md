# RAG Atendimento

Atendimento ao cliente via **WhatsApp** com IA baseada em **RAG**. A empresa cadastra sua base de conhecimento; a IA responde só com base nela e, quando não consegue resolver, transfere para um atendente humano do setor correto. A equipe usa um **app desktop (Electron)** ligado a um servidor que roda numa máquina "Host" da empresa.

> **Estado: MVP (fases 0–3) implementado e testado em simulação. Não está pronto para produção.** Leia [Limitações](#limitações-e-o-que-não-foi-verificado) antes de usar com clientes reais.

## Documentação

| Documento | Conteúdo |
|-----------|----------|
| [docs/01-visao-geral.md](docs/01-visao-geral.md) | Propósito, atores, regras de negócio (RN), requisitos, riscos |
| [docs/02-arquitetura.md](docs/02-arquitetura.md) | Host/Cliente, componentes, ciclo da conversa, autorização por setor |
| [docs/03-pipeline-rag.md](docs/03-pipeline-rag.md) | Ingestão, busca híbrida, atendimento da IA, prompts |
| [docs/04-dados-api-roadmap.md](docs/04-dados-api-roadmap.md) | Modelo de dados, API, eventos, telas, roadmap, critérios de aceite |
| [docs/05-decisoes.md](docs/05-decisoes.md) | **Registro de decisões e desvios** (D-001 a D-031), atualizado a cada decisão |

## Estrutura

```
apps/desktop/      Electron + React (renderer validado; shell Electron não verificado)
packages/shared/   Tipos, schemas Zod, eventos
packages/rag/      Chunking, embeddings, SQLite + sqlite-vec + FTS5, busca híbrida, extração, cliente LLM
packages/wa-gateway/  Contrato ChannelAdapter, whatsapp-web.js, canal falso, IPC e supervisor
packages/server/   Fastify + Socket.IO, conversas, fila de jobs, pipeline de IA, relatórios
```

## Como rodar (desenvolvimento)

Requisitos: Node 20+ (testado no 24, Windows). O pnpm não precisa estar instalado: use sempre `npx -y pnpm@10` (o `-y` evita a pergunta "Ok to proceed?", que deixa o terminal esperando).

**1. Instalar (uma vez)** — no PowerShell:

```powershell
$env:PUPPETEER_SKIP_DOWNLOAD=1; npx -y pnpm@10 install
```

(no Git Bash: `PUPPETEER_SKIP_DOWNLOAD=1 npx -y pnpm@10 install`)

**2. Servidor** (terminal 1; canal de WhatsApp **falso** por padrão — nenhuma mensagem real):

```bash
npx -y pnpm@10 dev:server
```

**3. Interface — duas opções** (terminal 2):

```bash
# a) no navegador (abra http://localhost:5290)
npx -y pnpm@10 --filter @rag/desktop dev

# b) na janela desktop (Electron); o 1º comando baixa o binário, uma vez
npx -y pnpm@10 --filter @rag/desktop electron:install
npx -y pnpm@10 --filter @rag/desktop dev:electron
```

Na primeira abertura do Electron aparece "Esta máquina será o Host?". Responda **"Não, sou Cliente"**: o modo Host embutido ainda não é utilizável (veja Limitações). Se errar, apague o `config.json` da pasta de dados do app em `%APPDATA%`.

No primeiro acesso o app cria o administrador. A IA só responde com uma chave de API configurada em *Configurações da IA* (ou `ANTHROPIC_API_KEY`); sem chave, tudo vai para a fila humana. Com o canal falso, nenhuma mensagem de cliente chega: para simular clientes use os testes.

A interface usa a porta **5290** (e o servidor, 3333). Se alguma estiver ocupada, o Vite avisa e não sobe.

Variáveis do servidor: `PORT` (3333), `HOST` (127.0.0.1), `DATA_DIR`, `WA_MODE=real|fake`, `LOG_LEVEL`.

Testes e tipos:

```bash
npx -y pnpm@10 typecheck
npx -y pnpm@10 test
```

## O que foi verificado

- **93 testes automatizados** (rag 11, gateway 6, servidor 72, desktop 4) cobrem as regras RN03–RN13 e os 6 critérios de aceite do MVP **via API HTTP e Socket.IO reais**: isolamento por setor, assinatura `*Nome*` só nas mensagens humanas, IA desligada em conversa ativa, encerramento por inatividade, transferência com resumo e assunção concorrente (um vence, outro recebe 409).
- Servidor real iniciado e consultado; interface inspecionada no navegador; contraste WCAG AA calculado nos dois temas.
- `typecheck`, `test` e `build` rodaram limpos em todos os pacotes na última verificação (2026-10-28).

## Limitações e o que não foi verificado

**Segurança (prioridade alta):** a API usa **HTTP sem TLS** (D-027). Mantenha `HOST=127.0.0.1` ou use VPN/túnel; nunca exponha na rede compartilhada.

**Nunca executado de verdade:** conexão com WhatsApp real (`whatsapp-web.js`, exige QR e é **não oficial** — risco de bloqueio do número), chamadas ao LLM real, modo Host embutido e instalador (a janela Electron abre em modo Cliente e carrega a interface; só isso foi conferido).

**Não implementado:** descoberta por mDNS, auto-update, backup e restauração, rotinas de LGPD, reindexação ao trocar o modelo de embeddings, fine-tuning, envio de mídia e transcrição de áudio (D-028).

**Atenção a desvios do doc:** SQLite direto em vez de Prisma (D-003); rerank lexical simples (D-008); o embedding por hash existe só para testes (D-009) e o de produção baixa um modelo na 1ª execução.

## Segurança e privacidade

Isolamento por setor aplicado no servidor (REST e salas Socket.IO); senhas com bcrypt; JWT com revogação imediata ao mudar papel/setor/desativar; chave de IA só de escrita, nunca devolvida; importação de URL bloqueia destinos internos; mídia com nome gerado. Não versione `.env`, `data/` nem a sessão do WhatsApp.

## Licença

MIT — ver [LICENSE](LICENSE).
