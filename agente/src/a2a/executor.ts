// AgentExecutor do SDK A2A: o que acontece quando chega um SendMessage que
// cria uma Task. O SDK cuida do JSON-RPC, dos ids da Task e do contexto, de
// gravar no repositório e de montar a resposta; aqui só publicamos os eventos
// da Task, na ordem da máquina de estados:
//
//   task(SUBMITTED, history=[pedido]) → WORKING → [artifact] → COMPLETED | FAILED
//
// Quem faz a reserva é o ServicoDeReserva (Host MCP). O executor não fala MCP.
import { TaskState } from '@a2a-js/sdk';
import { AgentEvent, STATE_HEADERS_KEY, type AgentExecutor, type ExecutionEventBus, type RequestContext } from '@a2a-js/sdk/server';
import type { ContextoDeExecucao } from '../host/contexto.ts';
import { analisarTraceparent } from '../trace.ts';
import { artifactDaReserva, mensagemDoAgente, status, textoDe } from './mensagens.ts';
import type { ServicoDeReserva } from './reserva.ts';
import { lerPedido } from './tarefas/pedido.ts';

export type Registro = (linha: string) => void;

/** traceparent W3C do header HTTP desta chamada A2A, se vier e for válido. Nunca inventa um. */
export function traceparentDaChamada(rc: RequestContext): string | undefined {
  const headers = rc.context.state.get(STATE_HEADERS_KEY) as Record<string, string | string[] | undefined> | undefined;
  const bruto = headers?.traceparent;
  const valor = Array.isArray(bruto) ? bruto[0] : bruto;
  return valor && analisarTraceparent(valor) ? valor.trim() : undefined;
}

export class ExecutorDeReservas implements AgentExecutor {
  constructor(
    private readonly reservas: ServicoDeReserva,
    private readonly registrar: Registro = (l) => console.error(l),
  ) {}

  async execute(rc: RequestContext, bus: ExecutionEventBus): Promise<void> {
    const { taskId, contextId } = rc;
    const ctx: ContextoDeExecucao = { operacao: taskId, traceparent: traceparentDaChamada(rc) };
    const evento = (state: TaskState, texto?: string) =>
      AgentEvent.statusUpdate({ taskId, contextId, status: status(state, texto === undefined ? undefined : mensagemDoAgente(texto, taskId, contextId)), metadata: undefined });

    // 1. A Task nasce SUBMITTED, com o pedido no histórico.
    bus.publish(AgentEvent.task({ id: taskId, contextId, status: status(TaskState.TASK_STATE_SUBMITTED), history: [rc.userMessage], artifacts: [], metadata: undefined }));
    // 2. WORKING: começamos a trabalhar.
    bus.publish(evento(TaskState.TASK_STATE_WORKING));
    this.registrar(`[a2a] task=${taskId} trace=${ctx.traceparent ?? '-'} executando`);

    const leitura = lerPedido(textoDe(rc.userMessage));
    if (!leitura.ok) {
      bus.publish(evento(TaskState.TASK_STATE_FAILED, leitura.erro));
      bus.finished();
      return;
    }

    // 3. A reserva, pelo Host MCP.
    const desfecho = await this.reservas.reservar(leitura.pedido, ctx);
    if (desfecho.tipo === 'concluida') {
      const r = desfecho.reserva;
      bus.publish(AgentEvent.artifactUpdate({ taskId, contextId, artifact: artifactDaReserva({ ...r }), append: false, lastChunk: true, metadata: undefined }));
      bus.publish(evento(TaskState.TASK_STATE_COMPLETED, `Reserva ${r.reserva} confirmada na ${r.sala}.`));
    } else {
      this.registrar(`[a2a] task=${taskId} falha (${desfecho.motivo})`);
      bus.publish(evento(TaskState.TASK_STATE_FAILED, desfecho.mensagem));
    }
    bus.finished();
  }

  async cancelTask(): Promise<void> {
    // CancelTask está fora do escopo; o manipulador recusa o método antes de chegar aqui.
  }
}
