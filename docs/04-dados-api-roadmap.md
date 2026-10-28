# Modelo de Dados, API e Roadmap

## 1. Modelo de dados (Prisma, resumido)

```prisma
enum Role            { ADMIN SUPERVISOR AGENT }
enum ConvStatus      { BOT QUEUED HUMAN CLOSED }
enum ConvOrigin      { CUSTOMER AGENT }
enum SenderType      { CUSTOMER AI AGENT SYSTEM }
enum CloseReason     { RESOLVED_AI RESOLVED_AGENT INACTIVITY MANUAL }
enum DocStatus       { PENDING PROCESSING READY FAILED }

model Sector {
  id                 String   @id @default(uuid())
  name               String   @unique
  description        String   // usada pela IA na triagem
  inactivityMinutes  Int      @default(30)
  queueTimeoutMin    Int?     // null = não encerra na fila
  welcomeMessage     String?
  closingMessage     String?
  businessHours      Json?
  users              User[]
  conversations      Conversation[]
}

model User {
  id           String  @id @default(uuid())
  name         String
  displayName  String  // usado na assinatura em negrito
  email        String  @unique
  passwordHash String
  role         Role
  sectorId     String?
  sector       Sector? @relation(fields: [sectorId], references: [id])
  active       Boolean @default(true)
}

model Contact {
  id        String @id @default(uuid())
  waId      String @unique   // 5511999999999@c.us
  name      String?
  phone     String
  conversations Conversation[]
}

model Conversation {
  id                String      @id @default(uuid())
  contactId         String
  sectorId          String?
  assignedUserId    String?
  origin            ConvOrigin
  status            ConvStatus
  failedAiAttempts  Int         @default(0)
  summary           String?
  lastInteractionAt DateTime
  closedAt          DateTime?
  closeReason       CloseReason?
  createdAt         DateTime    @default(now())
  messages          Message[]
  @@index([sectorId, status])
  @@index([status, lastInteractionAt])
}

model Message {
  id             String     @id @default(uuid())
  conversationId String
  senderType     SenderType
  senderUserId   String?
  body           String     // texto sem a assinatura
  sentBody       String?    // texto efetivamente enviado ao WhatsApp
  mediaUrl       String?
  waMessageId    String?    @unique
  ack            Int        @default(0)
  aiMeta         Json?      // { usedChunkIds, scores, model, latencyMs }
  createdAt      DateTime   @default(now())
}

model KnowledgeDocument {
  id        String    @id @default(uuid())
  title     String
  type      String    // pdf, docx, faq, url, txt
  sectorIds String[]  // vazio = global
  status    DocStatus
  chunks    KnowledgeChunk[]
}

// Chunks e embeddings ficam no banco vetorial SQLite separado (knowledge.db,
// sqlite-vec) — ver doc 03, seção 1. Prisma não gerencia essas tabelas.

model StyleExample {            // exemplos para few-shot e dataset de fine-tuning
  id        String  @id @default(uuid())
  sectorId  String?
  context   String?
  question  String
  answer    String
  source    String  // MANUAL | CONVERSATION | SYNTHETIC
  approved  Boolean @default(false)
}

model ModelVersion {
  id        String   @id @default(uuid())
  name      String   // ex.: atendimento-v3
  provider  String   // provedor de fine-tuning
  remoteModelId String // ID do modelo ajustado no provedor
  jobId     String?
  datasetSize Int
  metrics   Json
  active    Boolean  @default(false)
  createdAt DateTime @default(now())
}

model AuditLog { id String @id @default(uuid()) userId String? action String data Json createdAt DateTime @default(now()) }
```

## 2. API REST (principais)

| Método | Rota | Acesso |
|--------|------|--------|
| POST | `/auth/login`, `/auth/refresh` | público |
| GET/POST/PATCH/DELETE | `/sectors` | admin |
| GET/POST/PATCH/DELETE | `/users` | admin |
| GET | `/conversations?status=` | escopo do setor |
| GET | `/conversations/:id/messages` | escopo do setor |
| POST | `/conversations` | inicia conversa ativa (`origin=AGENT`) |
| POST | `/conversations/:id/claim` | assumir da fila (409 se já assumida) |
| POST | `/conversations/:id/transfer` | `{ sectorId?, userId? }` |
| POST | `/conversations/:id/close` | finalizar |
| POST | `/conversations/:id/messages` | enviar (assinatura aplicada no servidor) |
| GET/POST/DELETE | `/knowledge/documents` | admin |
| POST | `/knowledge/playground` | admin — testa pergunta |
| GET | `/whatsapp/status`, `/whatsapp/qr` | admin |
| GET | `/reports/*` | supervisor/admin |

## 3. Eventos Socket.IO

| Evento (servidor → app) | Sala |
|-------------------------|------|
| `conversation:created` / `updated` / `closed` | `sector:{id}` |
| `message:new`, `message:ack` | `sector:{id}` |
| `conversation:assigned` | `user:{id}` |
| `whatsapp:status`, `whatsapp:qr` | `admins` |

App → servidor: `typing`, `viewing` (presença).

## 4. Telas do app desktop

1. **Login** (+ configuração da URL do servidor na 1ª execução).
2. **Atendimento**: coluna esquerda com abas *Fila / Minhas / IA / Finalizadas*; centro com o chat (badge "IA" nas mensagens do bot, nome do atendente nas humanas, resumo da IA no topo); direita com dados do contato e histórico.
3. **Base de conhecimento**: documentos, FAQ, status de indexação, playground.
4. **Setores e usuários** (admin).
5. **Conexão WhatsApp** (QR Code e status).
6. **Relatórios**.
7. **Configurações da IA**: tom, limiares, temas "sempre humano".

## 5. Roadmap

| Fase | Entregas | Estimativa |
|------|----------|-----------|
| **0. Fundação** | Monorepo, Electron com modo Host/Cliente, servidor embutido, Prisma (SQLite), sqlite-vec, auth JWT, descoberta na LAN, CI | 1–2 semanas |
| **1. WhatsApp + atendimento humano** | Gateway whatsapp-web.js, setores, usuários, app Electron com lista/chat em tempo real, assinatura, assumir/transferir/finalizar, conversa ativa, encerramento por inatividade | 3 semanas |
| **2. RAG** | Ingestão de documentos/FAQ, busca híbrida, resposta da IA, playground | 2–3 semanas |
| **3. Triagem e transferência** | Classificação de setor, regras de transferência, resumo para o atendente, debounce | 2 semanas |
| **4. Produção** | Relatórios, mídia (imagem/áudio/doc), notificações, auto-update, LGPD, testes de carga | 2–3 semanas |
| **4b. Fine-tuning** | Editor de estilo, exportação JSONL anonimizada, integração com API de fine-tuning do provedor, avaliação, versões | 2 semanas |
| **5. Evoluções** | Transcrição de áudios, respostas sugeridas ao atendente (copiloto), avaliação de satisfação, migração opcional para WhatsApp Cloud API, multi-número | contínuo |

**MVP = fases 0–3** (~8–9 semanas para 1–2 desenvolvedores).

## 6. Critérios de aceite do MVP

- Atendente do setor A não consegue listar, ler nem enviar em conversas do setor B (testado via API, não só UI).
- Mensagem enviada pelo app chega no WhatsApp como `*Nome do Atendente*` + quebra de linha + texto; mensagem da IA chega sem assinatura.
- Conversa iniciada pelo atendente nunca recebe resposta da IA, mesmo se o cliente responder.
- Conversa sem interação pelo tempo configurado é encerrada automaticamente; nova mensagem abre nova conversa com a IA.
- Pergunta fora da base gera transferência para a fila do setor correto, com resumo.
- Dois atendentes clicando "assumir" ao mesmo tempo: apenas um assume.

## 7. Decisões em aberto

1. ~~Hospedagem~~ → definido: app desktop local (Host + Clientes na LAN), IA via API remota.
2. Provedor do modelo de IA e de fine-tuning (ex.: Claude + few-shot no início; OpenAI/Together/Fireworks para o modelo ajustado). Quem paga a API: a empresa usuária (chave própria) ou o fornecedor do software?
3. Atendentes trabalharão fora da rede do Host (home office)? Se sim, definir VPN/túnel.
4. Um atendente poderá pertencer a mais de um setor no futuro?
