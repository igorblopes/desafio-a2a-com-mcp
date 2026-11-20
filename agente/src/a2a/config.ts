// Configuração do processo A2A (porta 7300), lida do ambiente.
//   A2A_PORT        porta HTTP do agente (padrão 7300)
//   A2A_PUBLIC_URL  URL base anunciada no Agent Card (padrão http://localhost:<porta>)
//   MCP_URL         endpoint do servidor MCP (padrão http://localhost:7301/mcp), via lerConfig()
//   MCP_TIMEOUT_MS  espera máxima por uma resposta MCP (padrão 20000), via lerConfig()
import { lerConfig } from '../config.ts';

export const PORTA_A2A_PADRAO = 7300;

export interface ConfigDoAgente {
  porta: number;
  /** URL base pública (sem barra final): o card anuncia `${urlPublica}/a2a`. */
  urlPublica: string;
  mcp: URL;
  /** Espera máxima por uma resposta MCP, em ms. */
  timeoutMcpMs: number;
}

export function lerConfigDoAgente(env: NodeJS.ProcessEnv = process.env): ConfigDoAgente {
  const bruta = env.A2A_PORT?.trim();
  const porta = bruta ? Number(bruta) : PORTA_A2A_PADRAO;
  if (!Number.isInteger(porta) || porta < 1 || porta > 65535) throw new Error(`A2A_PORT inválida: ${bruta}`);
  const urlPublica = (env.A2A_PUBLIC_URL?.trim() || `http://localhost:${porta}`).replace(/\/+$/, '');
  try {
    new URL(urlPublica);
  } catch {
    throw new Error(`A2A_PUBLIC_URL inválida: ${urlPublica}`);
  }
  const mcp = lerConfig(env);
  return { porta, urlPublica, mcp: mcp.url, timeoutMcpMs: mcp.timeoutMs };
}
