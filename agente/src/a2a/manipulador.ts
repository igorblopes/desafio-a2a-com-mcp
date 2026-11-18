// Manipulador das requisições A2A: o DefaultRequestHandler do SDK, que já
// implementa SendMessage e GetTask conforme a v1.0 (Task inexistente → -32001,
// Task terminal → -32004), com os métodos fora do escopo do desafio
// recusados explicitamente.
//
// Fora do escopo: streaming, resubscribe, CancelTask, ListTasks, push
// notifications e card estendido. O card declara streaming e push como false.
import { UnsupportedOperationError } from '@a2a-js/sdk/errors';
import { DefaultRequestHandler } from '@a2a-js/sdk/server';

const foraDoEscopo = (metodo: string) => new UnsupportedOperationError(`${metodo} nao e suportado por este agente.`);

export class ManipuladorDaCentral extends DefaultRequestHandler {
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
