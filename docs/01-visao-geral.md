# RAG Atendimento — Visão Geral e Requisitos

## 1. Propósito

Plataforma de atendimento ao cliente via **WhatsApp** com IA baseada em **RAG** (Retrieval-Augmented Generation). A empresa "treina" a IA com sua base de conhecimento (produtos, procedimentos, FAQ, soluções). A IA responde de forma objetiva e, quando não consegue resolver, **transfere para um atendente humano** do setor correto.

A equipe de suporte usa um **aplicativo desktop** (Node.js/Electron), simultaneamente, conectado a um servidor central.

## 2. Atores

| Ator | Descrição |
|------|-----------|
| **Cliente** | Pessoa que conversa pelo WhatsApp. Não usa o app. |
| **Atendente** | Usuário do app, vinculado a **um setor**. Vê e responde apenas conversas do seu setor. |
| **Supervisor** | Atendente com permissão de ver todas as conversas do seu setor, reatribuir e ver métricas. |
| **Administrador** | Gerencia setores, usuários, conexão WhatsApp, base de conhecimento e configurações da IA. |
| **IA (bot)** | Agente RAG que faz a triagem e responde automaticamente. |

## 3. Regras de negócio

| ID | Regra |
|----|-------|
| RN01 | O canal com o cliente é o WhatsApp, via **whatsapp-web.js**. |
| RN02 | O administrador cria **setores** (ex.: Financeiro, Suporte Técnico, Comercial). |
| RN03 | Cada usuário pertence a **exatamente um setor** e só vê conversas atribuídas a esse setor. Administradores veem todos. |
| RN04 | A IA identifica a intenção do cliente e **direciona a conversa ao setor correto** (por classificação ou menu de opções). |
| RN05 | Mensagens enviadas por atendentes pelo app recebem **assinatura com o nome do atendente em negrito** no topo: `*Maria Silva*\n<mensagem>` (negrito do WhatsApp usa `*`). |
| RN06 | Mensagens enviadas pela **IA não são assinadas**. |
| RN07 | A IA **só atende** conversas iniciadas pelo cliente. Se a conversa foi **iniciada por um atendente** (mensagem ativa), a IA fica desativada nela durante todo o ciclo. |
| RN08 | Quando um humano assume a conversa (transferência ou envio manual), a IA para de responder naquela conversa até ela ser finalizada. |
| RN09 | **Encerramento por inatividade**: se não houver interação entre atendente/IA e cliente dentro do tempo configurado (padrão: 30 min, configurável por setor), a conversa é finalizada automaticamente, com mensagem de encerramento opcional. |
| RN10 | Nova mensagem do cliente após o encerramento abre **nova conversa** (novo ciclo, IA volta a atender). |
| RN11 | A IA transfere para humano quando: (a) confiança/relevância da busca abaixo do limiar; (b) cliente pede atendente; (c) N respostas sem resolução (padrão 3); (d) sentimento muito negativo; (e) assunto marcado como "sempre humano" (ex.: cancelamento). |
| RN12 | A IA responde **somente com base no conhecimento cadastrado**; nunca inventa preços, prazos ou políticas. |
| RN13 | Fora do horário de atendimento do setor, a IA continua atendendo; se precisar transferir, informa o horário e deixa a conversa na fila. |

## 4. Requisitos funcionais

**Conexão WhatsApp**
- RF01 Conectar número via QR Code exibido no app (admin).
- RF02 Persistir sessão (LocalAuth/RemoteAuth) e reconectar automaticamente.
- RF03 Receber/enviar texto, imagem, áudio, documento; mostrar status (enviado/entregue/lido).

**Setores e usuários**
- RF04 CRUD de setores (nome, descrição para a IA, horário, timeout de inatividade, mensagem de boas-vindas/encerramento).
- RF05 CRUD de usuários (nome, e-mail, senha, papel, setor).
- RF06 Login no app desktop com JWT.

**Atendimento (app)**
- RF07 Lista de conversas do setor em tempo real: *Fila*, *Em atendimento (minhas)*, *IA atendendo*, *Finalizadas*.
- RF08 Assumir conversa da fila; transferir para outro atendente ou setor; finalizar manualmente.
- RF09 Enviar mensagem com assinatura automática (RN05).
- RF10 Iniciar conversa ativa com um contato (IA desativada — RN07).
- RF11 Visualizar histórico completo, incluindo o que a IA respondeu e os trechos usados (fontes).
- RF12 Notificações desktop para novas conversas na fila do setor.
- RF13 Respostas rápidas (atalhos `/`) por setor.

**Base de conhecimento (treinamento)**
- RF14 Upload de documentos (PDF, DOCX, TXT, MD), cadastro de FAQ (pergunta/resposta) e importação de URL.
- RF15 Vincular documentos a um ou mais setores (ou global).
- RF16 Reprocessar/excluir documentos; ver status da indexação.
- RF17 "Playground" para testar perguntas e ver a resposta + fontes antes de publicar.
- RF18 Aprender com atendimentos: atendente pode marcar uma resposta humana como "adicionar à base".

**Relatórios**
- RF19 Métricas: taxa de resolução pela IA, transferências, tempo de primeira resposta, tempo médio de atendimento, volume por setor/atendente.

## 5. Requisitos não funcionais

| ID | Requisito |
|----|-----------|
| RNF01 | Node.js 20+ (LTS) em todo o stack, TypeScript. |
| RNF02 | Suportar ≥ 30 atendentes simultâneos e ≥ 500 conversas ativas por instância. |
| RNF03 | Atualização em tempo real no app < 1 s (WebSocket). |
| RNF04 | Resposta da IA em < 8 s (p95). |
| RNF05 | Senhas com bcrypt/argon2; JWT com refresh; HTTPS/WSS. |
| RNF06 | Isolamento por setor aplicado **no servidor**, nunca apenas na interface. |
| RNF07 | LGPD: retenção configurável, exportação/anonimização de dados do contato, logs de acesso. |
| RNF08 | App desktop para Windows (prioridade), macOS e Linux, com auto-update. |

## 6. Riscos

| Risco | Mitigação |
|-------|-----------|
| whatsapp-web.js é **não oficial**: risco de banimento do número e quebras após atualizações do WhatsApp Web. | Evitar disparos em massa, respeitar ritmo humano, fixar versão do WA Web, monitorar a lib, abstrair o canal (`ChannelAdapter`) para migrar à **WhatsApp Cloud API** oficial se necessário. |
| Alucinação da IA. | Prompt restrito ao contexto, limiar de relevância, transferência automática, fontes registradas. |
| Puppeteer consome memória. | Um processo dedicado de gateway; monitoramento e restart automático. |
