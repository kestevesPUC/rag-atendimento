# Pipeline RAG e Comportamento da IA

## 1. Ingestão ("treinar a IA")

```
Upload (PDF/DOCX/TXT/MD/URL/FAQ) → extração de texto → limpeza → chunking
   → embeddings → INSERT em knowledge_chunks (pgvector) → status READY
```

| Etapa | Detalhe |
|-------|---------|
| Extração | `pdf-parse`, `mammoth` (DOCX), `@mozilla/readability` (URL). |
| Chunking | Por títulos/parágrafos, ~500–800 tokens, sobreposição ~80. FAQ = 1 chunk por par pergunta/resposta. |
| Metadados | `documentId`, `sectorIds[]` (vazio = global), título, seção, página. |
| Embeddings | Gerados **localmente** a cada inserção/edição de conteúdo, via `EmbeddingProvider`: padrão `@huggingface/transformers` (Transformers.js, ONNX, roda em Node sem GPU) com `Xenova/multilingual-e5-small` (384 dim, bom em português); alternativa `bge-m3` via Ollama. |
| Banco vetorial | **SQLite local** com a extensão **sqlite-vec** (`better-sqlite3` + `sqlite-vec`), arquivo `data/knowledge.db`. |
| Índice | Tabela virtual `vec0` (cosine) + tabela **FTS5** (texto) para busca híbrida. |

Executado no worker (fila `ingest-document`); o admin vê o progresso no app. Ao editar/excluir um documento, seus chunks e vetores são removidos e regerados (hash de conteúdo evita reprocessar o que não mudou).

### Esquema do banco vetorial (SQLite)

```sql
CREATE TABLE chunks (
  id INTEGER PRIMARY KEY,
  document_id TEXT NOT NULL,
  sector_ids TEXT NOT NULL DEFAULT '[]',   -- JSON; '[]' = global
  content TEXT NOT NULL,
  metadata TEXT,                           -- JSON (título, seção, página)
  content_hash TEXT NOT NULL
);
CREATE VIRTUAL TABLE chunks_vec USING vec0(
  chunk_id INTEGER PRIMARY KEY,
  embedding float[384] distance_metric=cosine
);
CREATE VIRTUAL TABLE chunks_fts USING fts5(content, content='chunks', content_rowid='id');
```

Busca: `SELECT chunk_id, distance FROM chunks_vec WHERE embedding MATCH ? AND k = 20`, combinada com `chunks_fts` por *Reciprocal Rank Fusion*, depois filtro por setor.

**Escala e migração:** sqlite-vec atende bem até centenas de milhares de chunks. A camada `VectorStore` (`upsert`, `delete`, `search`) isola o SQLite; migrar para pgvector/Qdrant no futuro é trocar a implementação e reindexar.

## 2. Atendimento de uma mensagem (fila `ai-reply`)

```
1. Carregar contexto: últimas ~10 mensagens + setor atual + resumo da conversa
2. Triagem (modelo rápido) → JSON:
     { intent, sectorId, wantsHuman, sentiment, standaloneQuery }
3. Se ainda sem setor e intenção clara → define sectorId
   Se ambíguo → pergunta/oferece menu de setores
4. Regras de transferência imediata (pedido humano, tema "sempre humano", sentimento crítico)
5. Retrieval híbrido: vetor + full-text, filtrado por (setor ∪ global), top 20
   → rerank → top 5
6. Se melhor score < limiar → transferir
7. Geração (modelo principal) com prompt restrito → JSON:
     { answer, resolved: bool, needsHuman: bool, usedChunkIds[] }
8. Persistir resposta, fontes e métricas; enviar via gateway (sem assinatura)
9. Incrementar contador de tentativas sem resolução; se ≥ N → transferir
```

### Transferência
- `status = QUEUED`, `sectorId` definido, mensagem ao cliente: *"Vou te transferir para um atendente do setor Financeiro. Aguarde um momento."*
- Gera **resumo automático** da conversa para o atendente (exibido no topo do chat no app).

## 3. Modelos

| Uso | Modelo sugerido |
|-----|-----------------|
| Triagem / classificação / resumo | modelo remoto rápido e barato (ex.: `claude-haiku-5-5`) |
| Resposta ao cliente | modelo remoto **com fine-tuning** (seção 6) ou `claude-sonnet-5-5` + few-shot |

O app só faz chamadas HTTPS ao provedor; nenhum modelo de linguagem roda na máquina (apenas o modelo pequeno de embeddings). Timeout + 1 retry; se a API estiver indisponível, a conversa vai para a fila humana com aviso ao cliente.

Configurável via interface `LLMProvider`. Usar *prompt caching* para o system prompt fixo e saída estruturada (tool use / JSON schema).

## 4. System prompt (base)

```
Você é o assistente de atendimento da {empresa} no WhatsApp.
Regras:
- Responda APENAS com base no CONTEXTO abaixo. Se a informação não estiver no
  contexto, não invente: marque needsHuman=true.
- Seja objetivo: no máximo 3 parágrafos curtos, linguagem simples, português do Brasil.
- Formatação do WhatsApp: *negrito*, listas com "-". Sem markdown de títulos.
- Nunca prometa prazos, valores ou exceções que não estejam no contexto.
- Não peça senhas ou dados de cartão.
- Se o cliente pedir um atendente, marque needsHuman=true.
Setor atual: {setor} — {descrição do setor}
CONTEXTO:
{chunks numerados}
```
O texto de instrução é editável pelo admin (tom de voz, nome do assistente), mas as regras de segurança ficam fixas.

## 5. Parâmetros configuráveis (por empresa/setor)

| Parâmetro | Padrão |
|-----------|--------|
| Limiar de relevância | 0,55 (cosine, ajustar no playground) |
| Tentativas sem resolução antes de transferir | 3 |
| Debounce de mensagens | 3 s |
| Temas "sempre humano" | lista de palavras-chave/intenções |
| Timeout de inatividade | 30 min |

## 6. Fine-tuning do estilo de conversa

Divisão de responsabilidades:
- **RAG** → *o que* a IA sabe (fatos da empresa, sempre atualizados, sem retreinar).
- **Fine-tuning** → *como* a IA conversa (tom, tamanho das respostas, saudação, empatia, quando transferir, formato WhatsApp).

Fatos **não** devem ser ensinados por fine-tuning: ficariam desatualizados e aumentariam alucinação.

> Observação: os modelos Claude via API não oferecem fine-tuning self-service. Como o app não roda modelos localmente, o fine-tuning é feito **na nuvem, por um provedor que treina e hospeda o modelo ajustado**, e o app só chama o modelo resultante via API. O provedor é configurável (`LLMProvider` + `FineTuneProvider`).

### Abordagem: fine-tuning hospedado (LoRA/SFT)

| Item | Escolha |
|------|---------|
| Provedor | Um serviço com API de fine-tuning e hospedagem do modelo resultante — ex.: OpenAI (fine-tuning de modelos GPT), Together AI ou Fireworks (LoRA sobre Qwen/Llama). A escolha é decisão em aberto. |
| Técnica | **SFT** (supervised fine-tuning) com adaptador LoRA; etapa opcional de **DPO/preferência** com pares "resposta boa × ruim" vindos do 👍/👎 dos atendentes, se o provedor suportar. |
| Execução | Pelo próprio app (admin): **Base de conhecimento → Estilo → Treinar**. O app gera o JSONL, faz upload, cria o job e acompanha o status pela API do provedor. Nada de Python ou GPU na máquina do usuário. |
| Uso | Ao concluir, o provedor devolve o ID do modelo ajustado; o admin ativa a versão e as respostas passam a usá-lo. |

### Dataset

Formato chat (JSONL), **já incluindo o contexto RAG** no prompt, para o modelo aprender a responder *a partir do contexto*:

```json
{"messages":[
 {"role":"system","content":"<system prompt da seção 4>\nCONTEXTO:\n[1] Para trocar a senha acesse Configurações > Segurança..."},
 {"role":"user","content":"oi nao consigo mudar minha senha"},
 {"role":"assistant","content":"Oi! Vou te ajudar 😊\nAcesse *Configurações > Segurança* e toque em *Alterar senha*. Se não aparecer, me avisa que te encaminho ao suporte técnico."}
]}
```

Inclua exemplos negativos: contexto sem a resposta → resposta que transfere ao atendente; cliente irritado → resposta empática e transferência.

Fontes dos exemplos:
1. **Editor de estilo no app** (admin): escreve exemplos de pergunta + resposta ideal e o guia de tom.
2. **Conversas reais aprovadas**: atendimentos bem avaliados, anonimizados (remoção de nomes, telefones, CPF, e-mails) antes de entrar no dataset.
3. **Geração sintética**: um LLM gera variações de perguntas a partir dos documentos; um humano revisa.

Meta inicial: 300–1.000 exemplos revisados.

### Ciclo de treino e publicação

```
Coletar/curar exemplos (app) → anonimizar + gerar JSONL → enviar job ao provedor
  → avaliar modelo ajustado → aprovado? → ativar versão no app
```
- **Avaliação** antes de publicar: conjunto fixo de perguntas comparando versão nova × atual (fidelidade ao contexto, tom, taxa de transferência correta, tamanho). Uso de LLM-juiz + amostra revisada por humano.
- **Versionamento** de modelos (`model_versions`: dataset, data, métricas) com rollback em um clique.
- Retreino sugerido mensalmente ou ao acumular +200 exemplos novos.

### Antes do primeiro fine-tuning

Enquanto não há dados suficientes, o mesmo comportamento é obtido com **few-shot**: os exemplos do editor de estilo entram no system prompt (com cache de prompt). Funciona com qualquer modelo remoto, inclusive Claude, e esses mesmos exemplos viram o dataset inicial.

**Privacidade:** o dataset enviado ao provedor contém trechos da base e conversas. Por isso a anonimização é obrigatória e o admin precisa aceitar explicitamente o envio antes de cada treino.

## 7. Qualidade e melhoria contínua

- Cada resposta da IA armazena chunks usados e scores → auditoria no app.
- Atendente pode marcar resposta da IA como 👍/👎 e transformar respostas humanas em FAQ (RF18).
- Relatório de "perguntas sem resposta" (transferências por baixo score) indica lacunas na base.
- Conjunto de avaliação (perguntas + respostas esperadas) executado a cada mudança de prompt/modelo.
