// Tool reservar_sala: o único COMANDO do servidor e o único ponto com MRTR.
//
// Primeira rodada (sem requestState):
//   validarPedido (sala → intervalo → janela → duração)  → isError se falhar
//   conflitos(reservasDaSala)                             → livre? reserva e conclui
//   alternativas(...)                                     → nenhuma? isError "Sem alternativas..."
//   selar(pedido + alternativas)                          → input_required + elicitation
//
// Retry (com requestState, já verificado pelo SDK):
//   o pedido vem do SELO, nunca de `arguments` (que o cliente pode ter mudado);
//   inputResponses[chave do selo] → accept / decline / cancel.
//
// Nenhuma conexão fica aberta esperando a escolha: a primeira rodada termina
// devolvendo input_required, e a escolha chega num tools/call NOVO (id novo).
// Não há `await` entre a checagem de conflito e a gravação: no Node, isso
// torna a sequência atômica dentro do processo.
import { inputRequired, inputResponse, type McpServer, type ServerContext } from '@modelcontextprotocol/server';
import * as z from 'zod';
import { DataIso, adicionarReserva, listarSalas, reservasDaSala, type Reserva } from '../dominio/agenda.ts';
import { alternativas, conflitos, MENSAGENS, validarPedido } from '../dominio/regras.ts';
import { versaoDaPolitica } from '../recursos/politica.ts';
import { selar, type SeloReserva } from '../estado-mrtr.ts';
import { log } from '../log.ts';

// Forma do contrato: exemplos/wire/01 (ReservaOut), 02/04 (reservado) e 11 (recusa).
// As oito chaves vêm sempre; as que não se aplicam vão como null.
const ReservaOut = z.object({
  reserva: z.string().nullable(),
  reservado: z.boolean(),
  sala: z.string().nullable(),
  inicio: z.string().nullable(),
  fim: z.string().nullable(),
  responsavel: z.string().nullable(),
  politica: z.string().nullable(),
  motivo: z.string().nullable(),
});
type ReservaOut = z.infer<typeof ReservaOut>;
type Pedido = SeloReserva['pedido'];

/**
 * Chave da entrada em inputRequests. O SDK TypeScript não gera chaves: o mapa
 * inputRequests é montado pelo handler, e a spec só exige que a chave seja
 * única no request e devolvida igual em inputResponses. (O SDK Python deriva
 * "__main__:escolha_de_sala" do nome do resolver; o cliente não deve presumir
 * nenhuma das duas, e sim ler a chave da resposta.) A chave também vai no selo.
 */
export const CHAVE_DA_ESCOLHA = 'escolha_de_sala';
export const MENSAGEM_DA_ESCOLHA = 'A sala pedida esta ocupada nesse intervalo. Escolha uma alternativa.';

function concluido(sc: ReservaOut) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(sc, null, 2) }], structuredContent: sc, isError: false };
}

function resultadoReservado(r: Reserva) {
  return concluido({
    reserva: r.id,
    reservado: true,
    sala: r.sala,
    inicio: r.inicio,
    fim: r.fim,
    responsavel: r.responsavel,
    politica: versaoDaPolitica,
    motivo: null,
  });
}

/** Recusa (decline) ou cancelamento (cancel): conclui SEM reservar e SEM isError, como em wire/11. */
function resultadoNaoReservado(motivo: 'recusado' | 'cancelado') {
  return concluido({ reserva: null, reservado: false, sala: null, inicio: null, fim: null, responsavel: null, politica: null, motivo });
}

function erroDeExecucao(mensagem: string) {
  return { content: [{ type: 'text' as const, text: mensagem }], isError: true };
}

/**
 * Retry com resposta que não autoriza nada (chave errada, escolha fora do
 * enum). O requestState em si é válido (o SDK já conferiu), então isto não é
 * erro de protocolo: é a execução da tool que recusa, com isError e nada
 * gravado. (E nem daria para ser -32602: o McpServer converte qualquer throw
 * do handler de tool em resultado isError.)
 */
const retryInvalido = erroDeExecucao;

/**
 * Tenta reservar `pedido` em `salaId`. Se a sala está livre, grava e conclui.
 * Se está ocupada, calcula alternativas PARA O PEDIDO ORIGINAL e devolve
 * input_required (ou "Sem alternativas..." quando não há nenhuma).
 */
async function reservarOuPerguntar(pedido: Pedido, salaId: string, ctx: ServerContext) {
  const salas = listarSalas();
  const valido = validarPedido(salas, salaId, pedido.inicio, pedido.fim);
  if (!valido.ok) return erroDeExecucao(valido.mensagem);
  const { intervalo } = valido.valor;

  if (conflitos(reservasDaSala(salaId), intervalo).length === 0) {
    return resultadoReservado(adicionarReserva({ sala: salaId, inicio: pedido.inicio, fim: pedido.fim, responsavel: pedido.responsavel }));
  }

  // Ocupada. As alternativas são sempre relativas à sala ORIGINALMENTE pedida
  // (capacidade mínima e exclusão), mesmo quando quem está ocupada é a escolhida.
  const original = salas.find((s) => s.id === pedido.sala)!;
  const opcoes = alternativas(salas, reservasDaSala, original, intervalo).map((s) => s.id);
  if (opcoes.length === 0) return erroDeExecucao(MENSAGENS.semAlternativas);

  const requestState = await selar({ pedido, alternativas: opcoes, chave: CHAVE_DA_ESCOLHA });
  // "conflito", e não "input_required": se o cliente não declarou
  // elicitation.form, o SDK troca este retorno por -32021 logo depois.
  log('mrtr', { evento: 'conflito', id: idDoRequest(ctx), chave: CHAVE_DA_ESCOLHA, alternativas: opcoes.join(',') });
  return inputRequired({
    inputRequests: {
      [CHAVE_DA_ESCOLHA]: inputRequired.elicit({
        mode: 'form',
        message: MENSAGEM_DA_ESCOLHA,
        requestedSchema: {
          type: 'object',
          properties: {
            sala: { type: 'string', title: 'Sala', description: 'Sala alternativa escolhida', enum: opcoes },
          },
          required: ['sala'],
        },
      }),
    },
    requestState,
  });
}

/** Retry: o pedido sai do selo verificado; a escolha precisa ser uma das alternativas seladas. */
async function retomar(selo: SeloReserva, ctx: ServerContext) {
  const resposta = inputResponse(ctx.mcpReq.inputResponses, selo.chave);
  if (resposta.kind !== 'elicit') {
    log('mrtr', { evento: 'retry', id: idDoRequest(ctx), resultado: 'sem-resposta', chave: selo.chave });
    return retryInvalido(`Resposta ausente: inputResponses precisa da chave '${selo.chave}'`);
  }
  if (resposta.action === 'decline' || resposta.action === 'cancel') {
    log('mrtr', { evento: 'retry', id: idDoRequest(ctx), resultado: resposta.action });
    return resultadoNaoReservado(resposta.action === 'decline' ? 'recusado' : 'cancelado');
  }
  const escolha = resposta.content?.sala;
  if (typeof escolha !== 'string' || !selo.alternativas.includes(escolha)) {
    log('mrtr', { evento: 'retry', id: idDoRequest(ctx), resultado: 'escolha-invalida' });
    return retryInvalido(`Escolha fora das alternativas oferecidas: ${selo.alternativas.join(', ')}`);
  }
  log('mrtr', { evento: 'retry', id: idDoRequest(ctx), resultado: 'accept', escolha });
  // A disponibilidade é conferida de novo: entre a pergunta e a resposta, a
  // sala escolhida pode ter sido ocupada. Nesse caso, nova pergunta.
  return reservarOuPerguntar(selo.pedido, escolha, ctx);
}

function idDoRequest(ctx: ServerContext): string {
  return JSON.stringify(ctx.mcpReq.id);
}

export function registrarReservarSala(servidor: McpServer): void {
  servidor.registerTool(
    'reservar_sala',
    {
      description: 'Reserva uma sala. Se o intervalo estiver ocupado, pergunta qual alternativa usar.',
      inputSchema: z.object({ sala: z.string(), inicio: DataIso, fim: DataIso, responsavel: z.string() }),
      outputSchema: ReservaOut,
    },
    async ({ sala, inicio, fim, responsavel }, ctx) => {
      // Presente só no retry, e só depois de o SDK verificar MAC, validade e forma.
      const selo = ctx.mcpReq.requestState<SeloReserva>();
      if (selo !== undefined) return retomar(selo, ctx);
      return reservarOuPerguntar({ sala, inicio, fim, responsavel }, sala, ctx);
    },
  );
}
