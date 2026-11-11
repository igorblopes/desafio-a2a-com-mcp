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

export interface ConfigDoCliente {
  url: URL;
}

/** MCP_URL (opcional) → URL do endpoint MCP. Falha cedo, com mensagem clara, se não for http(s). */
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
  return { url };
}
