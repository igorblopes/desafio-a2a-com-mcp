// Continuações MCP pendentes, uma por Task pausada (TASK_STATE_INPUT_REQUIRED).
//
// Fica AO LADO do repositório de Tasks, nunca dentro da Task: a Task é
// devolvida ao cliente A2A (SendMessage, GetTask), e a continuação carrega o
// requestState, que não pode sair do agente. Este mapa não é serializado,
// não é logado e não tem rota HTTP.
//
// Chave = taskId. Cada Task só enxerga a própria entrada; não existe "a
// última continuação". Em memória, como as Tasks: um restart perde as duas.
import type { Continuacao } from '../../host/continuacao.ts';

export interface Pendente {
  /** Valor congelado do Host (tool, argumentos originais, chave, schema, requestState, traceparent). */
  readonly continuacao: Continuacao;
  /** Nome do campo do formulário que recebe a escolha (no contrato, `sala`). */
  readonly campo: string;
  /** Opções do schema (enum ou const), na ordem em que o servidor mandou. */
  readonly alternativas: readonly string[];
  /** Texto exato mostrado ao cliente: repetido igual quando a escolha é inválida. */
  readonly mensagem: string;
  /** Versão da política lida em politica://uso na mesma Task (só para conferir o resultado). */
  readonly politica: string;
}

export class RetomadasPendentes {
  readonly #porTask = new Map<string, Pendente>();

  guardar(taskId: string, pendente: Pendente): void {
    this.#porTask.set(taskId, Object.freeze({ ...pendente, alternativas: Object.freeze([...pendente.alternativas]) }));
  }

  obter(taskId: string): Pendente | undefined {
    return this.#porTask.get(taskId);
  }

  /** Remove e devolve: a continuação é consumida por uma única retomada. */
  tomar(taskId: string): Pendente | undefined {
    const p = this.#porTask.get(taskId);
    this.#porTask.delete(taskId);
    return p;
  }

  get tamanho(): number {
    return this.#porTask.size;
  }

  /** Nunca exponha o conteúdo: JSON.stringify/inspect não mostram nada. */
  toJSON(): string {
    return `[${this.#porTask.size} continuacao(oes) pendente(s)]`;
  }
}
