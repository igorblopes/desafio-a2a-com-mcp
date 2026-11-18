// Catálogo das ferramentas que o servidor ofereceu no último tools/list.
// Guardado em memória no Host: é estado da APLICAÇÃO (o que eu sei que posso
// chamar), não sessão de protocolo. Cada request MCP continua levando versão
// e capabilities no próprio _meta.
import type { Tool } from '@modelcontextprotocol/client';
import { ErroDeUso } from '../mcp/erros.ts';

export class CatalogoDeFerramentas {
  #ferramentas = new Map<string, Tool>();
  #atualizadoEm: Date | undefined;

  substituir(tools: Tool[]): void {
    this.#ferramentas = new Map(tools.map((t) => [t.name, structuredClone(t)]));
    this.#atualizadoEm = new Date();
  }

  limpar(): void {
    this.#ferramentas = new Map();
    this.#atualizadoEm = undefined;
  }

  get descoberto(): boolean {
    return this.#atualizadoEm !== undefined;
  }

  get atualizadoEm(): Date | undefined {
    return this.#atualizadoEm;
  }

  /** As tools com os schemas recebidos (cópias: quem lê não altera o catálogo). */
  listar(): Tool[] {
    return [...this.#ferramentas.values()].map((t) => structuredClone(t));
  }

  obter(nome: string): Tool | undefined {
    const t = this.#ferramentas.get(nome);
    return t && structuredClone(t);
  }

  /**
   * Confere, antes de qualquer tools/call, que a tool foi descoberta e que os
   * argumentos `required` do inputSchema recebido estão presentes. Lança
   * ErroDeUso: é erro de quem chama, e nada é enviado ao servidor.
   */
  exigir(nome: string, argumentos: Record<string, unknown>): Tool {
    if (!this.descoberto) throw new ErroDeUso(`ferramenta '${nome}' ainda não descoberta: o Host precisa de tools/list antes`);
    const t = this.#ferramentas.get(nome);
    if (!t) throw new ErroDeUso(`o servidor não oferece a ferramenta '${nome}' (oferece: ${[...this.#ferramentas.keys()].join(', ')})`);
    const faltando = (t.inputSchema.required ?? []).filter((k) => !(k in argumentos));
    if (faltando.length) throw new ErroDeUso(`argumentos obrigatórios ausentes em ${nome}: ${faltando.join(', ')}`);
    return t;
  }
}
