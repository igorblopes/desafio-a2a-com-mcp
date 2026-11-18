// Armazenamento de Tasks em memória, por id. Implementa o TaskStore do SDK
// A2A, então é ele que o DefaultRequestHandler usa para guardar e ler Tasks
// (SendMessage grava, GetTask lê).
//
// Toda gravação passa pela máquina de estados: uma Task terminal não muda
// mais de estado, e uma transição fora da tabela é recusada. Cada Task é
// guardada como cópia, então uma não compartilha objetos com outra nem com
// quem a leu.
//
// Em memória de propósito: Tasks não sobrevivem ao restart do agente (o
// contrato não pede). No Passo 11, o contexto de continuação MCP de uma Task
// pausada fica num mapa privado ao lado deste, nunca dentro da Task, porque
// a Task é devolvida ao cliente A2A e o requestState não pode vazar.
import type { Task } from '@a2a-js/sdk';
import type { ServerCallContext, TaskStore } from '@a2a-js/sdk/server';
import { exigirTransicao, nomeDoEstado } from './estados.ts';

type ListTasksRequest = Parameters<TaskStore['list']>[0];
type ListTasksResponse = Awaited<ReturnType<TaskStore['list']>>;

export type Registro = (linha: string) => void;

export class RepositorioDeTasks implements TaskStore {
  readonly #tasks = new Map<string, Task>();

  constructor(private readonly registrar: Registro = (l) => console.error(l)) {}

  async save(task: Task, _context?: ServerCallContext): Promise<void> {
    this.gravar(task);
  }

  async load(taskId: string, _context?: ServerCallContext): Promise<Task | undefined> {
    return this.obter(taskId);
  }

  async list(_params: ListTasksRequest, _context: ServerCallContext): Promise<ListTasksResponse> {
    // ListTasks está fora do escopo; o manipulador recusa o método antes de chegar aqui.
    return { tasks: [], nextPageToken: '', pageSize: 0, totalSize: 0 } as unknown as ListTasksResponse;
  }

  /** Grava (cria ou atualiza) aplicando a máquina de estados. Lança TransicaoInvalida. */
  gravar(task: Task): void {
    const anterior = this.#tasks.get(task.id);
    const de = anterior?.status?.state;
    const para = task.status?.state;
    if (para === undefined) throw new TypeError(`Task ${task.id} sem status`);
    exigirTransicao(task.id, de, para);
    this.#tasks.set(task.id, structuredClone(task));
    if (de !== para) this.registrar(`[a2a] task=${task.id} ${nomeDoEstado(de)} -> ${nomeDoEstado(para)}`);
  }

  obter(taskId: string): Task | undefined {
    const t = this.#tasks.get(taskId);
    return t && structuredClone(t);
  }

  get tamanho(): number {
    return this.#tasks.size;
  }
}
