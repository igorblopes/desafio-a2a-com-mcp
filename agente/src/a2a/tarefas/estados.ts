// Máquina de estados da Task A2A, explícita e sem efeitos colaterais.
//
//   SUBMITTED ──► WORKING ──┬──► COMPLETED   (terminal)
//                  ▲        ├──► FAILED      (terminal)
//                  │        ├──► CANCELED    (terminal: recusa confirmada na retomada)
//                  │        └──► INPUT_REQUIRED ──┬──► WORKING (retomada com a escolha)
//                  └──────────────────────────────┘└──► CANCELED (terminal)
//
// Passo 11: um conflito (input_required do MCP) leva WORKING → INPUT_REQUIRED.
// A escolha do cliente leva INPUT_REQUIRED → WORKING, e o retry MCP decide o
// fim: COMPLETED (reservou), CANCELED (o cliente recusou e o servidor
// confirmou sem reservar), FAILED ou de novo INPUT_REQUIRED. A escolha
// inválida não muda o estado (INPUT_REQUIRED → INPUT_REQUIRED).
//
// Repetir o mesmo estado é permitido (a Task ganha artifact ou mensagem sem
// mudar de estado). Sair de um estado terminal, nunca.
import { TaskState } from '@a2a-js/sdk';

const TRANSICOES: ReadonlyMap<TaskState, readonly TaskState[]> = new Map([
  [TaskState.TASK_STATE_SUBMITTED, [TaskState.TASK_STATE_WORKING, TaskState.TASK_STATE_FAILED]],
  [TaskState.TASK_STATE_WORKING, [TaskState.TASK_STATE_COMPLETED, TaskState.TASK_STATE_FAILED, TaskState.TASK_STATE_CANCELED, TaskState.TASK_STATE_INPUT_REQUIRED]],
  [TaskState.TASK_STATE_INPUT_REQUIRED, [TaskState.TASK_STATE_WORKING, TaskState.TASK_STATE_CANCELED]],
  [TaskState.TASK_STATE_COMPLETED, []],
  [TaskState.TASK_STATE_FAILED, []],
  [TaskState.TASK_STATE_CANCELED, []],
]);

export const ESTADOS_TERMINAIS: ReadonlySet<TaskState> = new Set([
  TaskState.TASK_STATE_COMPLETED,
  TaskState.TASK_STATE_FAILED,
  TaskState.TASK_STATE_CANCELED,
]);

/** Nome do contrato (TASK_STATE_*) para logs e mensagens. */
export function nomeDoEstado(estado: TaskState | undefined): string {
  return estado === undefined ? 'nenhum' : (TaskState[estado] ?? String(estado));
}

export function ehTerminal(estado: TaskState | undefined): boolean {
  return estado !== undefined && ESTADOS_TERMINAIS.has(estado);
}

/** `de` undefined = Task nova: só pode nascer em SUBMITTED. */
export function podeTransitar(de: TaskState | undefined, para: TaskState): boolean {
  if (de === undefined) return para === TaskState.TASK_STATE_SUBMITTED;
  if (de === para) return true;
  return TRANSICOES.get(de)?.includes(para) ?? false;
}

export class TransicaoInvalida extends Error {
  constructor(
    readonly taskId: string,
    readonly de: TaskState | undefined,
    readonly para: TaskState,
  ) {
    super(`transição inválida da Task ${taskId}: ${nomeDoEstado(de)} → ${nomeDoEstado(para)}`);
    this.name = 'TransicaoInvalida';
  }
}

export function exigirTransicao(taskId: string, de: TaskState | undefined, para: TaskState): void {
  if (!podeTransitar(de, para)) throw new TransicaoInvalida(taskId, de, para);
}
