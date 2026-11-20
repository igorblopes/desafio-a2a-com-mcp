// Manipulador das requisições A2A: o DefaultRequestHandler do SDK, que já
// implementa SendMessage e GetTask conforme a v1.0 (Task inexistente → -32001,
// Task terminal → -32004), com os métodos fora do escopo do desafio
// recusados explicitamente.
//
// Toda mensagem do cliente precisa vir com role ROLE_USER (o SDK aceitaria
// ROLE_AGENT ou role ausente e trataria como pedido). -32602 antes de tudo.
//
// Continuação (SendMessage com taskId), além do que o SDK confere: a Task
// precisa estar em INPUT_REQUIRED (uma Task ainda em WORKING não recebe
// escolha) e só um SendMessage por Task é processado de cada vez. Node é
// single-thread, então conferir e marcar no mesmo tick é atômico.
//
// Fora do escopo: streaming, resubscribe, CancelTask, ListTasks, push
// notifications e card estendido. O card declara streaming e push como false.
import { Role, TaskState, type AgentCard, type SendMessageRequest } from '@a2a-js/sdk';
import { RequestMalformedError, UnsupportedOperationError } from '@a2a-js/sdk/errors';
import { DefaultRequestHandler, type AgentExecutor, type ServerCallContext, type TaskStore } from '@a2a-js/sdk/server';
import { ehTerminal, nomeDoEstado } from './tarefas/estados.ts';

const foraDoEscopo = (metodo: string) => new UnsupportedOperationError(`${metodo} nao e suportado por este agente.`);

export class ManipuladorDaCentral extends DefaultRequestHandler {
  readonly #emAndamento = new Set<string>();

  constructor(
    card: AgentCard,
    private readonly tasks: TaskStore,
    executor: AgentExecutor,
  ) {
    super(card, tasks, executor);
  }

  override async sendMessage(params: SendMessageRequest, context: ServerCallContext): ReturnType<DefaultRequestHandler['sendMessage']> {
    if (params.message && params.message.role !== Role.ROLE_USER) {
      throw new RequestMalformedError('A mensagem do cliente precisa ter role ROLE_USER.');
    }
    const taskId = params.message?.taskId;
    if (!taskId) return super.sendMessage(params, context);
    // Inexistente ou terminal: o SDK responde (-32001 / -32004) sem tocar na Task.
    const task = await this.tasks.load(taskId, context);
    const estado = task?.status?.state;
    if (!task || ehTerminal(estado)) return super.sendMessage(params, context);
    if (this.#emAndamento.has(taskId) || estado !== TaskState.TASK_STATE_INPUT_REQUIRED) {
      throw new UnsupportedOperationError(`Task ${taskId} nao esta aguardando resposta (estado ${nomeDoEstado(estado)}).`);
    }
    this.#emAndamento.add(taskId);
    try {
      return await super.sendMessage(params, context);
    } finally {
      this.#emAndamento.delete(taskId);
    }
  }

  override async cancelTask(): Promise<never> {
    throw foraDoEscopo('CancelTask');
  }
  override async listTasks(): Promise<never> {
    throw foraDoEscopo('ListTasks');
  }
  // eslint-disable-next-line require-yield
  override async *sendMessageStream(): AsyncGenerator<never, void, undefined> {
    throw foraDoEscopo('SendStreamingMessage');
  }
  // eslint-disable-next-line require-yield
  override async *resubscribe(): AsyncGenerator<never, void, undefined> {
    throw foraDoEscopo('SubscribeToTask');
  }
  override async createTaskPushNotificationConfig(): Promise<never> {
    throw foraDoEscopo('CreateTaskPushNotificationConfig');
  }
  override async getTaskPushNotificationConfig(): Promise<never> {
    throw foraDoEscopo('GetTaskPushNotificationConfig');
  }
  override async listTaskPushNotificationConfigs(): Promise<never> {
    throw foraDoEscopo('ListTaskPushNotificationConfigs');
  }
  override async deleteTaskPushNotificationConfig(): Promise<never> {
    throw foraDoEscopo('DeleteTaskPushNotificationConfig');
  }
  override async getAuthenticatedExtendedAgentCard(): Promise<never> {
    throw foraDoEscopo('GetExtendedAgentCard');
  }
}
