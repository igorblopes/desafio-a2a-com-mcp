// Observação do tráfego HTTP do cliente, para testes e para a demo.
// Embrulha o fetch que o transporte do SDK usa: o request segue intacto,
// só se registra o que foi enviado. Não altera headers, corpo nem ids.
import type { FetchLike } from '@modelcontextprotocol/client';

export interface RequestObservado {
  id: string | number | undefined;
  metodo: string | undefined;
  /** Só os headers do MCP (MCP-Protocol-Version, Mcp-Method, Mcp-Name), com nome em minúsculas. */
  headers: Record<string, string>;
  params: Record<string, unknown> | undefined;
  status?: number;
}

export function fetchObservado(aoEnviar: (r: RequestObservado) => void, base: FetchLike = fetch): FetchLike {
  return async (url, init) => {
    let registro: RequestObservado | undefined;
    if (init?.method === 'POST' && typeof init.body === 'string') {
      const corpo = JSON.parse(init.body) as { id?: string | number; method?: string; params?: Record<string, unknown> };
      const headers: Record<string, string> = {};
      new Headers(init.headers).forEach((valor, nome) => {
        if (nome.startsWith('mcp')) headers[nome] = valor;
      });
      registro = { id: corpo.id, metodo: corpo.method, headers, params: corpo.params };
    }
    const resposta = await base(url, init);
    if (registro) {
      registro.status = resposta.status;
      aoEnviar(registro);
    }
    return resposta;
  };
}
