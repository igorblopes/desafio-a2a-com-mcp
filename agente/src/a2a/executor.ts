// AgentExecutor do SDK A2A: o que acontece quando chega um SendMessage. O
// SDK cuida do JSON-RPC, dos ids da Task e do contexto, de gravar no
// repositório e de montar a resposta; aqui só publicamos os eventos da Task,
// na ordem da máquina de estados.
//
// Pedido novo (sem taskId):
//   task(SUBMITTED, history=[pedido]) → WORKING → [artifact] → COMPLETED | FAILED
//                                               └→ INPUT_REQUIRED "alternativas: ..." (pausa)
// Continuação (taskId de Task em INPUT_REQUIRED):
//   task(como está, history+=[escolha]) →
//     escolha inválida → INPUT_REQUIRED com a MESMA mensagem (nada vai ao MCP)
//     escolha válida   → WORKING → retry MCP → COMPLETED | CANCELED | FAILED | nova pausa
//
// A pausa não segura conexão nenhuma: o request A2A termina com a Task em
// INPUT_REQUIRED, e a continuação fica guardada por taskId (RetomadasPendentes).
// Quem fala com o Host é o ServicoDeReserva. O executor não fala MCP.
import { TaskState } from '@a2a-js/sdk';
import { AgentEvent, STATE_HEADERS_KEY, type AgentExecutor, type ExecutionEventBus, type RequestContext } from '@a2a-js/sdk/server';
import type { ContextoDeExecucao } from '../host/contexto.ts';
import { analisarTraceparent } from '../trace.ts';
import { artifactDaReserva, mensagemDoAgente, status, textoDe } from './mensagens.ts';
import { lerEscolha } from './ponte.ts';
import type { Desfecho, ServicoDeReserva } from './reserva.ts';
import { lerPedido } from './tarefas/pedido.ts';
import { RetomadasPendentes } from './tarefas/retomadas.ts';

export type Registro = (linha: string) => void;

export const MENSAGEM_SEM_CONTINUACAO = 'A continuacao desta Task nao esta mais disponivel; a Task foi encerrada sem reserva.';

/** traceparent W3C do header HTTP desta chamada A2A, se vier e for válido. Nunca inventa um. */
export function traceparentDaChamada(rc: RequestContext): string | undefined {
  const headers = rc.context.state.get(STATE_HEADERS_KEY) as Record<string, string | string[] | undefined> | undefined;
  const bruto = headers?.traceparent;
  const valor = Array.isArray(bruto) ? bruto[0] : bruto;
  return valor && analisarTraceparent(valor) ? valor.trim() : undefined;
}

const traceId = (tp: string | undefined) => tp?.split('-')[1];

export class ExecutorDeReservas implements AgentExecutor {
  constructor(
    private readonly reservas: ServicoDeReserva,
    readonly retomadas: RetomadasPendentes = new RetomadasPendentes(),
    private readonly registrar: Registro = (l) => console.error(l),
  ) {}

  async execute(rc: RequestContext, bus: ExecutionEventBus): Promise<void> {
    if (rc.task) await this.#continuar(rc, bus);
    else await this.#iniciar(rc, bus);
    bus.finished();
  }

  async #iniciar(rc: RequestContext, bus: ExecutionEventBus): Promise<void> {
    const { taskId, contextId } = rc;
    const ctx: ContextoDeExecucao = { operacao: taskId, traceparent: traceparentDaChamada(rc) };
    const evento = this.#evento(rc);

    // 1. A Task nasce SUBMITTED, com o pedido no histórico.
    bus.publish(AgentEvent.task({ id: taskId, contextId, status: status(TaskState.TASK_STATE_SUBMITTED), history: [rc.userMessage], artifacts: [], metadata: undefined }));
    // 2. WORKING: começamos a trabalhar.
    bus.publish(evento(TaskState.TASK_STATE_WORKING));
    this.registrar(`[a2a] task=${taskId} trace=${ctx.traceparent ?? '-'} executando`);

    const leitura = lerPedido(textoDe(rc.userMessage));
    if (!leitura.ok) {
      bus.publish(evento(TaskState.TASK_STATE_FAILED, leitura.erro));
      return;
    }
    // 3. A reserva, pelo Host MCP.
    this.#publicarDesfecho(rc, bus, await this.reservas.reservar(leitura.pedido, ctx));
  }

  async #continuar(rc: RequestContext, bus: ExecutionEventBus): Promise<void> {
    const { taskId } = rc;
    const task = rc.task!;
    const evento = this.#evento(rc);
    // O SDK exige um evento `task` primeiro, também na continuação. A Task
    // vem como está (INPUT_REQUIRED), já com a escolha no histórico.
    bus.publish(AgentEvent.task(task));

    const pendente = this.retomadas.obter(taskId);
    if (task.status?.state !== TaskState.TASK_STATE_INPUT_REQUIRED || !pendente) {
      // O manipulador barra isso antes; aqui é a última defesa (ex.: continuação perdida).
      this.registrar(`[a2a] task=${taskId} continuacao indisponivel`);
      bus.publish(evento(TaskState.TASK_STATE_WORKING));
      bus.publish(evento(TaskState.TASK_STATE_FAILED, MENSAGEM_SEM_CONTINUACAO));
      return;
    }

    const escolha = lerEscolha(textoDe(rc.userMessage), pendente.campo, pendente.alternativas);
    if (escolha.tipo === 'invalida') {
      // Continua pausada, sem request MCP, com a MESMA pergunta e a MESMA continuação.
      this.registrar(`[a2a] task=${taskId} escolha invalida (${escolha.motivo}); continua aguardando`);
      bus.publish(evento(TaskState.TASK_STATE_INPUT_REQUIRED, pendente.mensagem));
      return;
    }

    // A continuação é consumida por esta retomada: um segundo SendMessage
    // concorrente não encontra nada para reenviar.
    this.retomadas.tomar(taskId);
    // Mesmo trace da Task inteira: o da pausa vence; o header da continuação
    // só vale se a pausa não tinha nenhum.
    const doHeader = traceparentDaChamada(rc);
    const traceparent = pendente.continuacao.traceparent ?? doHeader;
    if (doHeader && pendente.continuacao.traceparent && traceId(doHeader) !== traceId(pendente.continuacao.traceparent)) {
      this.registrar(`[a2a] task=${taskId} traceparent da continuacao (${traceId(doHeader)}) difere do da Task; mantido ${traceId(traceparent)}`);
    }
    const ctx: ContextoDeExecucao = { operacao: taskId, traceparent };
    bus.publish(evento(TaskState.TASK_STATE_WORKING));
    this.registrar(`[a2a] task=${taskId} trace=${traceparent ?? '-'} retomando (${escolha.tipo === 'aceitar' ? `accept ${escolha.valor}` : 'decline'})`);
    this.#publicarDesfecho(rc, bus, await this.reservas.retomar(pendente, escolha.resposta, ctx));
  }

  #publicarDesfecho(rc: RequestContext, bus: ExecutionEventBus, desfecho: Desfecho): void {
    const { taskId, contextId } = rc;
    const evento = this.#evento(rc);
    switch (desfecho.tipo) {
      case 'concluida': {
        const r = desfecho.reserva;
        bus.publish(AgentEvent.artifactUpdate({ taskId, contextId, artifact: artifactDaReserva({ ...r }), append: false, lastChunk: true, metadata: undefined }));
        bus.publish(evento(TaskState.TASK_STATE_COMPLETED, `Reserva ${r.reserva} confirmada na ${r.sala}.`));
        return;
      }
      case 'pausada':
        // Guarda ANTES de publicar: quando o cliente vir a pausa, a continuação já existe.
        this.retomadas.guardar(taskId, desfecho.pendente);
        this.registrar(`[a2a] task=${taskId} pausada (rodada ${desfecho.pendente.continuacao.rodada}, ${desfecho.pendente.alternativas.length} alternativa(s))`);
        bus.publish(evento(TaskState.TASK_STATE_INPUT_REQUIRED, desfecho.pendente.mensagem));
        return;
      case 'recusada':
        bus.publish(evento(TaskState.TASK_STATE_CANCELED, desfecho.mensagem));
        return;
      case 'falhou':
        this.registrar(`[a2a] task=${taskId} falha (${desfecho.motivo})`);
        bus.publish(evento(TaskState.TASK_STATE_FAILED, desfecho.mensagem));
        return;
    }
  }

  #evento(rc: RequestContext) {
    const { taskId, contextId } = rc;
    return (state: TaskState, texto?: string) =>
      AgentEvent.statusUpdate({ taskId, contextId, status: status(state, texto === undefined ? undefined : mensagemDoAgente(texto, taskId, contextId)), metadata: undefined });
  }

  async cancelTask(): Promise<void> {
    // CancelTask está fora do escopo; o manipulador recusa o método antes de chegar aqui.
  }
}
