// Configuração do cliente MCP, lida do ambiente.
// Nada aqui depende de uma conversa anterior com o servidor: versão e
// capabilities são declaradas pelo cliente e vão em TODO request.

export const PROTOCOLO_MCP = '2026-07-28';

/** Identidade do cliente, que o SDK coloca em _meta["io.modelcontextprotocol/clientInfo"]. */
export const IDENTIDADE_DO_CLIENTE = { name: 'agente-central-de-salas', version: '1.0.0' } as const;

/**
 * Capabilities que o cliente declara em _meta["io.modelcontextprotocol/clientCapabilities"].
 * `form: {}` explícito: o cliente sabe mostrar um formulário (elicitation em form mode)
 * e não sabe abrir URL. Sem isto, o conflito de reserva vira -32021.
 */
export const CAPACIDADES_DO_CLIENTE = { elicitation: { form: {} } };

export const URL_MCP_PADRAO = 'http://localhost:7301/mcp';

/**
 * Tempo máximo de espera por UMA resposta MCP (ms). Sem isto vale o padrão do
 * SDK (60 s), maior que o tempo que um cliente A2A costuma esperar (o
 * validador desiste em 30 s). Um servidor que aceita a conexão e não responde
 * (ou responde com outro id) prenderia o SendMessage até lá.
 */
export const TIMEOUT_MCP_PADRAO_MS = 20_000;

export interface ConfigDoCliente {
  url: URL;
  timeoutMs: number;
}

/** MCP_TIMEOUT_MS (opcional): inteiro entre 1000 e 120000. */
function lerTimeout(bruto: string | undefined): number {
  const valor = bruto?.trim();
  if (!valor) return TIMEOUT_MCP_PADRAO_MS;
  const n = Number(valor);
  if (!Number.isInteger(n) || n < 1000 || n > 120_000) throw new Error(`MCP_TIMEOUT_MS inválido: ${valor} (use um inteiro entre 1000 e 120000)`);
  return n;
}

/** MCP_URL e MCP_TIMEOUT_MS (opcionais). Falha cedo, com mensagem clara, se forem inválidos. */
export function lerConfig(env: NodeJS.ProcessEnv = process.env): ConfigDoCliente {
  const bruto = env.MCP_URL?.trim() || URL_MCP_PADRAO;
  let url: URL;
  try {
    url = new URL(bruto);
  } catch {
    throw new Error(`MCP_URL inválida: ${bruto}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`MCP_URL precisa ser http(s): ${bruto}`);
  }
  return { url, timeoutMs: lerTimeout(env.MCP_TIMEOUT_MS) };
}
