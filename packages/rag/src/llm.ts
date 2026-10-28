export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface JsonRequest {
  model: string;
  /** Parte fixa do system prompt (elegível a cache) e parte variável. */
  systemStable: string;
  systemDynamic?: string;
  messages: ChatMessage[];
  toolName: string;
  toolDescription: string;
  schema: Record<string, unknown>;
  maxTokens?: number;
}

/** Abstração do provedor de LLM (doc 03 §3). Saída sempre estruturada via JSON schema. */
export interface LLMProvider {
  completeJson(req: JsonRequest): Promise<unknown>;
}

export class LLMUnavailableError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = 'LLMUnavailableError';
  }
}

export interface AnthropicOptions {
  apiKey: () => string | null;
  baseUrl?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/** Cliente HTTP da API Messages da Anthropic: tool use forçado + prompt caching + timeout + 1 retry. */
export class AnthropicProvider implements LLMProvider {
  constructor(private readonly opts: AnthropicOptions) {}

  async completeJson(req: JsonRequest): Promise<unknown> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return await this.once(req);
      } catch (err) {
        lastError = err;
        if (err instanceof LLMUnavailableError && /\b(401|403|400)\b/.test(err.message)) break; // retry não ajuda
      }
    }
    throw lastError instanceof LLMUnavailableError ? lastError : new LLMUnavailableError('Falha ao consultar o modelo de IA.', lastError);
  }

  private async once(req: JsonRequest): Promise<unknown> {
    const key = this.opts.apiKey();
    if (!key) throw new LLMUnavailableError('Chave da API de IA não configurada.');
    const doFetch = this.opts.fetchImpl ?? fetch;
    const system: Record<string, unknown>[] = [{ type: 'text', text: req.systemStable, cache_control: { type: 'ephemeral' } }];
    if (req.systemDynamic) system.push({ type: 'text', text: req.systemDynamic });

    let res: Response;
    try {
      res = await doFetch(`${this.opts.baseUrl ?? 'https://api.anthropic.com'}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({
          model: req.model,
          max_tokens: req.maxTokens ?? 1024,
          system,
          messages: req.messages,
          tools: [{ name: req.toolName, description: req.toolDescription, input_schema: req.schema }],
          tool_choice: { type: 'tool', name: req.toolName },
        }),
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? 20_000),
      });
    } catch (err) {
      throw new LLMUnavailableError('Sem resposta do provedor de IA (rede ou tempo esgotado).', err);
    }
    if (!res.ok) throw new LLMUnavailableError(`O provedor de IA respondeu ${res.status}.`);
    const data = (await res.json()) as { content?: { type: string; name?: string; input?: unknown }[] };
    const block = data.content?.find((b) => b.type === 'tool_use' && b.name === req.toolName);
    if (!block) throw new LLMUnavailableError('Resposta do modelo sem saída estruturada.');
    return block.input;
  }
}
