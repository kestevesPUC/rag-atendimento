# Registro de Decisões

Cada decisão tomada durante o desenvolvimento entra aqui, com o motivo. Formato: **ID · data · decisão · motivo · impacto**. Decisões que alteram o que está nos docs 01–04 são marcadas como **desvio**.

## Processo (regras permanentes do projeto)

| Regra | Origem |
|-------|--------|
| Toda nova decisão é registrada neste arquivo no momento em que é adotada. | Solicitação do responsável pelo projeto |
| Arquivos de lixo (testes de fumaça, rascunhos, logs, temporários) são removidos assim que deixam de ser úteis; nada disso permanece no projeto. | Solicitação do responsável pelo projeto |

## Decisões

### D-001 · 2026-10-28 · Gerenciador de pacotes: pnpm via `npx`
Usar pnpm 10 sem instalação global (`npx pnpm@10`). **Motivo:** o doc 02 pede pnpm workspaces; evita alterar a máquina. **Impacto:** nenhum no código.

### D-002 · 2026-10-28 · Pacotes consumidos pelo código-fonte TypeScript (sem build por pacote)
Cada pacote exporta `./src/index.ts`; `tsx`, Vitest e Vite resolvem direto. **Motivo:** menos etapas de build e menos pontos de falha. O build de produção do Host usará bundle (esbuild) na fase de empacotamento. **Impacto:** `moduleResolution: Bundler`, imports sem extensão.

### D-003 · 2026-10-28 · **Desvio:** `better-sqlite3` direto, sem Prisma
Camada fina de repositórios com SQL explícito sobre `better-sqlite3`. **Motivo:** Prisma exige download de engines e geração de client, pontos de falha em máquinas corporativas; o servidor já precisa de `better-sqlite3` para o banco vetorial. O esquema segue o doc 04. **Impacto:** migrações por SQL versionado (`PRAGMA user_version`); migrar para PostgreSQL (doc 02) exigirá reescrever os repositórios.

### D-004 · 2026-10-28 · Binários nativos validados no ambiente
`better-sqlite3` instala por binário pré-compilado e `sqlite-vec` (v0.1.9) carrega com `vec0` (cosine) e FTS5 no Node 24 / Windows. **Motivo:** era o maior risco técnico do banco vetorial local. **Impacto:** nenhum.

### D-005 · 2026-10-28 · Chromium do Puppeteer não é baixado; gateway usa Edge/Chrome do sistema
Instalação com `PUPPETEER_SKIP_DOWNLOAD=1`; caminho configurável por `WA_CHROME_PATH`, com detecção de Edge/Chrome no Windows. **Motivo:** evita download grande e o Edge existe em todo Windows 11. **Impacto:** não verificado com WhatsApp real (exige QR Code).

### D-006 · 2026-10-28 · Visibilidade e ação por papel
Todos os usuários do setor **leem** as conversas do setor (RN03, salas Socket.IO por setor). **Agir** (responder, encerrar, transferir) exige conversa na fila/IA ou atribuída ao próprio atendente; supervisor e admin agem em qualquer conversa do seu escopo. **Motivo:** o doc é ambíguo sobre o que o atendente comum vê; esta regra é consistente entre REST e Socket.IO e evita vazamento entre setores. **Impacto:** reversível se o responsável preferir restringir a leitura.

### D-007 · 2026-10-28 · "N respostas sem resolução" = N consecutivas
O contador `failedAiAttempts` zera quando a IA marca `resolved=true`. **Motivo:** o doc 01 (RN11c) não diz se acumula; consecutivas evita transferir conversas longas e saudáveis. **Impacto:** configurável por `maxFailedAttempts`.

### D-008 · 2026-10-28 · Rerank lexical leve
Rerank dos 20 candidatos por sobreposição de termos com a consulta, sem modelo de reranking. **Motivo:** o doc pede rerank mas não há modelo local; manter o app leve (doc 02). **Impacto:** interface `Reranker` permite trocar depois.

### D-009 · 2026-10-28 · Embeddings: Transformers.js em produção, hash determinístico só em testes
`EmbeddingProvider` com `multilingual-e5-small` como padrão (baixa o modelo na 1ª execução, exige rede) e provedor por hash apenas para testes/dev offline. **Motivo:** testes rápidos e determinísticos sem baixar modelo. **Impacto:** o provedor por hash **não** tem qualidade semântica e não deve ser usado em produção.

### D-010 · 2026-10-28 · Design system do app desktop
Reutilizar a linguagem visual do projeto "PDV Restaurante" (referência indicada pelo responsável): menu lateral azul-escuro `#0b1f44`, conteúdo claro, cartões de 12 px, tokens `--brand/--ok/--bad/--warn`, tema claro/escuro, ícones SVG estilo Lucide, selos sempre com ícone + texto, foco visível, alvos ≥ 40 px, `prefers-reduced-motion`. **Motivo:** pedido explícito de design profissional inspirado nessa referência; o sistema já atende AA. **Evitado:** gradientes roxos, emojis como ícones, status só por cor. **Impacto:** `apps/desktop` usa CSS próprio (sem biblioteca de componentes).

### D-011 · 2026-10-28 · Escopo desta entrega: MVP (fases 0–3)
Fine-tuning (4b), transcrição de áudio e envio de mídia pelo atendente ficam fora; recebimento de mídia entra. **Motivo:** doc 04 define MVP = fases 0–3. **Impacto:** listado como limitação no README.

### D-012 · 2026-10-28 · Importação de URL bloqueia destinos internos
`extractFromUrl` só aceita http(s), resolve o DNS antes de buscar e recusa endereços de loopback, rede privada e link-local (inclui o endpoint de metadados de nuvem `169.254.169.254`); redirecionamentos são recusados; limite de 5 MB e 15 s. **Motivo:** o servidor roda dentro da rede da empresa, então importar URL sem filtro permitiria a um usuário com acesso de admin alcançar serviços internos (SSRF). **Impacto:** não é possível importar páginas de intranet. Se for necessário no futuro, será uma opção explícita do admin. **Limitação conhecida:** a checagem de DNS e a requisição são passos separados, então um domínio malicioso que troque de IP entre os dois (DNS rebinding) não é coberto.

### D-013 · 2026-10-28 · O limiar de relevância fica na camada de IA, não no banco vetorial
`SqliteVectorStore.search` sempre devolve os melhores candidatos visíveis ao setor (KNN nunca volta vazio se houver dados); a decisão "relevante o bastante?" usa `vectorScore` (similaridade de cosseno) contra `relevanceThreshold` (padrão 0,55, doc 03 §5) no pipeline de atendimento. **Motivo:** o limiar é configurável por empresa/setor e ajustado no playground; o banco não deve embutir essa política. **Impacto:** quem consumir o store diretamente precisa aplicar o limiar. O valor 0,55 foi pensado para `multilingual-e5-small`; com outro modelo de embeddings será preciso recalibrar.

### D-014 · 2026-10-28 · Reaproveitamento de chunks por hash e trava de modelo de embeddings
`replaceDocument` mantém chunks com o mesmo hash de conteúdo e só gera embeddings do que mudou (doc 03 §1). O banco grava o ID do modelo de embeddings e **recusa abrir** com outro (`EmbeddingModelMismatchError`) em vez de misturar vetores incompatíveis. **Impacto:** trocar de modelo exige reindexar tudo; ainda não existe a rotina de reindexação (pendente).

### D-015 · 2026-10-28 · Gateway: processo separado, IPC próprio, supervisor com reinício
O gateway do WhatsApp roda em processo-filho (`worker.ts`) que expõe um `ChannelAdapter` por IPC (`serveChannel` / `IpcChannelClient`); `superviseGateway` o reinicia com espera crescente (1 s até 30 s) se cair, e o filho encerra sozinho se o servidor morrer (evita Chromium órfão). Envios passam por uma fila serial com intervalo mínimo de ~1,2 s + variação aleatória (`SerialThrottle`) para imitar ritmo humano (mitigação do risco de banimento, doc 01). **Motivo:** isolar o Chromium e respeitar o doc 02 §3. **Impacto:** o Electron usará o mesmo mecanismo (`utilityProcess` ou `fork`) no empacotamento — ainda não verificado.

### D-016 · 2026-10-28 · Limites conhecidos do canal real (não verificados)
`WhatsAppWebChannel` **nunca foi executado contra um WhatsApp real**; só o contrato (IPC, fila, canal falso) é testado. Contas novas podem entregar o chat como `@lid`; o código tenta normalizar para `<número>@c.us` usando `contact.number`, mas isso precisa ser confirmado em campo. Mensagens enviadas pelo celular do operador (`fromMe`) são ignoradas (não geram assunção automática). A fixação da versão do WhatsApp Web (mitigação do doc 01) **não foi implementada**. **Impacto:** primeiro teste real deve ser feito com um número de homologação, nunca o de produção.

### D-017 · 2026-10-28 · Chave da API de IA: `SecretStore` com AES-256-GCM em arquivo; Electron deve usar `safeStorage`
A implementação padrão (`FileSecretStore`) criptografa com AES-256-GCM, mas a chave mestra fica em arquivo ao lado (`master.key`, modo 0600 em POSIX). É proteção em repouso **modesta**: quem tem acesso ao disco do Host tem as duas coisas. O doc 02 pede `safeStorage` do Electron; a interface `SecretStore` existe para isso e a implementação com `safeStorage` entra no empacotamento. A chave nunca é devolvida por nenhuma rota. **Pendente.**

### D-018 · 2026-10-28 · Telefone sem DDI recebe 55
Ao iniciar conversa ativa, números com 10 ou 11 dígitos ganham o prefixo `55` (Brasil). **Motivo:** a empresa é brasileira (doc em pt-BR) e atendentes digitam `(11) 99999-0000`. **Risco:** número estrangeiro com 10–11 dígitos seria alterado; nesse caso o atendente deve informar o DDI completo.

### D-019 · 2026-10-28 · Conversa ainda sem setor só aparece para administradores
Enquanto a triagem não define o setor (`sectorId = null`), RN03 não permite que nenhum setor a veja; só administradores. Com **um único setor cadastrado**, ele é atribuído automaticamente na abertura. **Impacto:** em instalações com vários setores, a primeira resposta da IA (ou o menu) acontece antes de qualquer humano poder intervir; admins podem intervir antes. Se isso for um problema, a alternativa é uma fila "Triagem" visível a supervisores. **Contrato com o app:** como `conversation:created` e as primeiras mensagens vão só aos administradores, o app de setor recebe a conversa como `conversation:updated` quando o setor é definido; ele deve tratar `updated` como inserir-ou-atualizar e **carregar o histórico completo pela API ao abrir** a conversa (não depender de ter recebido todos os `message:new`).

### D-020 · 2026-10-28 · Assumir conversa: 409 sempre que ela não está mais na fila
`claim` responde **409** (não 403) quando a conversa já foi assumida ou não está em `QUEUED`; 404 só para outro setor. **Motivo:** corrige divergência com o doc 02 §6 encontrada nos testes — quem perde a corrida chega depois do vencedor e via 403.

### D-021 · 2026-10-28 · Transferir para um atendente leva a conversa ao setor dele
`transfer({ userId })` sem `sectorId` move a conversa para o setor do atendente de destino (que fica com a conversa em `HUMAN`); com `sectorId` explícito, ele precisa bater com o do atendente (senão 400). Transferência por setor devolve a conversa à fila (`QUEUED`). A origem (`CUSTOMER`/`AGENT`) nunca muda, então RN07 vale em qualquer transferência.

### D-022 · 2026-10-28 · Autenticação: papel e setor sempre lidos do banco
O token de acesso (15 min) e o de refresh (7 dias) são JWT; a cada requisição o usuário é relido do banco, então desativar usuário ou mudar papel/setor/senha vale **imediatamente** (campo `token_version` invalida tokens antigos). Limite de 5 falhas de login por e-mail+IP em 10 min (429) e hash fictício para igualar o tempo de resposta quando o e-mail não existe. A limitação de tentativas é em memória (reinicia com o servidor). Senhas com `bcryptjs` (JS puro, custo 10) para evitar módulo nativo adicional. O segredo do JWT é gerado na primeira execução e guardado no `SecretStore`.

### D-023 · 2026-10-28 · Robustez do atendimento pela IA
(a) Uma conversa por vez (trava em memória; há um único processo — doc 02 §6). (b) Antes de agir, a IA reconfere que a conversa ainda é do cliente e está em `BOT`; a checagem e a escrita acontecem sem `await` entre elas. (c) Se o cliente escrever enquanto o modelo gera a resposta, a resposta é **descartada** e refeita com tudo (até 3 rodadas). (d) Falha da API de IA ou saída malformada → aviso de instabilidade + fila humana, sem resumo por LLM. (e) Mensagem só com mídia não é respondida pela IA e vai para a fila. (f) Texto do cliente nunca entra no system prompt; as regras de segurança são fixas.

### D-024 · 2026-10-28 · Motivo de encerramento por inatividade
Encerramento por inatividade de conversa em `BOT`, sem humano e com ao menos uma resposta da IA, é registrado como `RESOLVED_AI` (o cliente parou após a resposta); os demais casos, `INACTIVITY`. Encerramento manual por quem atendeu = `RESOLVED_AGENT`; sem atendimento humano = `MANUAL`. **Premissa:** "cliente parou de responder" ≈ "resolvido" é uma aproximação para a métrica de resolução (RF19), não uma medição de satisfação.

### D-025 · 2026-10-28 · Mídia recebida
Recebimento de imagem/áudio/documento é salvo em `data/files` com nome gerado (`uuid.ext`); o nome enviado pelo remetente nunca vira caminho. Só tipos conhecidos recebem extensão (demais viram `.bin`); limite de 16 MB. **Fora do MVP:** envio de mídia pelo atendente e transcrição de áudio.

### D-026 · 2026-10-28 · Fila de jobs: entrega "pelo menos uma vez"
Jobs persistem em SQLite; os que ficaram `RUNNING` após queda voltam à fila na inicialização. O envio é idempotente por mensagem, mas existe uma **janela pequena**: se o processo cair entre o envio ao WhatsApp e a gravação do id, a mensagem pode ser reenviada. Envio tem 5 tentativas com espera crescente; depois a mensagem fica `FAILED` e visível ao atendente.

### D-027 · 2026-10-28 · **Lacuna de segurança conhecida:** a API ainda usa HTTP, sem TLS
O servidor escuta em HTTP puro (padrão `127.0.0.1`). O doc 02 §7 e o RNF05 pedem HTTPS/WSS com certificado autoassinado gerado na instalação e fixado pelos Clientes no pareamento. **Isso não foi implementado.** Enquanto isso, o servidor só aceita conexões locais por padrão; abrir `HOST=0.0.0.0` para a LAN expõe tokens e conversas em texto claro. Não usar em rede compartilhada sem uma VPN/túnel (ex.: Tailscale) ou sem implementar o TLS. **Pendente, prioridade alta antes de qualquer uso em produção.**

### D-028 · 2026-10-28 · Itens do doc ainda não implementados (honestidade de escopo)
Descoberta automática do Host por mDNS (hoje: URL/IP informado manualmente); auto-update (`electron-updater` não faz sentido sem local de publicação definido); backup diário com `VACUUM INTO` e restauração; rotinas de LGPD (retenção, exportação, anonimização, logs de acesso); reindexação ao trocar o modelo de embeddings; fine-tuning (fase 4b); envio de mídia e transcrição de áudio; fixação da versão do WhatsApp Web. Cada um precisa de decisão e entrada própria neste registro quando for tratado.

### D-029 · 2026-10-28 · App desktop: desenvolvimento como "Cliente" de um servidor Node separado
Em desenvolvimento, o servidor roda com Node (`pnpm dev:server`) e o app se conecta a ele como Cliente. O modo Host do Electron (servidor embutido) exige recompilar `better-sqlite3` para a ABI do Electron (`electron-builder` faz isso no empacotamento) e **não foi verificado**. A interface (renderer) também funciona em um navegador comum apontando para o servidor, o que permitiu validá-la visualmente.

### D-030 · 2026-10-28 · Sem setor definido, a IA pergunta o assunto antes de consultar a base
Seguindo o doc 03 §2 (passo 3), com vários setores e sem setor identificado a IA oferece o menu de setores, **mesmo que a pergunta seja respondível por conteúdo global**. Observado na demonstração: "qual o prazo de entrega?" (FAQ global) recebeu o menu. **Possível melhoria, não aplicada:** tentar a base global antes de perguntar. Fica a critério do responsável.

### D-031 · 2026-10-28 · Interface desktop: verificações feitas
Renderer compilado (`vite build`) e checado por `tsc`; telas inspecionadas no navegador com dados fictícios (login, atendimento, base, relatórios, configurações da IA, WhatsApp) e o isolamento conferido na UI (atendente do Suporte vê só o Suporte). Contraste WCAG AA calculado para os pares de cores críticos nos dois temas: todos ≥ 4,5:1 (menor: 4,86:1, selo de aviso no tema claro). Bug de CSS achado e corrigido na inspeção (classe `.info` colidia com o selo). **Não verificado:** janela Electron, modo Host, Setores/Usuários/Respostas rápidas na tela, fluxo de envio e notificações.
