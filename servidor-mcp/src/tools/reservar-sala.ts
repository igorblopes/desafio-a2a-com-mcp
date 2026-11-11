// Tool reservar_sala: o único COMANDO do servidor (as outras tools só leem).
// Mesmo pipeline de consultar_disponibilidade, com uma etapa a mais:
//   validarPedido (sala → intervalo → janela → duração)  → isError se falhar
//   conflitos(reservasDaSala)                             → ocupada? ver abaixo
//   adicionarReserva                                      → reserva criada
// Não há `await` entre a checagem de conflito e a gravação: no Node, isso
// torna a sequência atômica dentro do processo.
import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod';
import { DataIso, adicionarReserva, listarSalas, reservasDaSala, type Reserva } from '../dominio/agenda.ts';
import { conflitos, validarPedido } from '../dominio/regras.ts';
import { versaoDaPolitica } from '../recursos/politica.ts';

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

function resultadoReservado(r: Reserva) {
  const sc: ReservaOut = {
    reserva: r.id,
    reservado: true,
    sala: r.sala,
    inicio: r.inicio,
    fim: r.fim,
    responsavel: r.responsavel,
    politica: versaoDaPolitica,
    motivo: null,
  };
  return { content: [{ type: 'text' as const, text: JSON.stringify(sc, null, 2) }], structuredContent: sc, isError: false };
}

/**
 * PROVISÓRIO (Passo 6). Substituído no Passo 7 pelo MRTR: lá, o conflito vira
 * `input_required` com a elicitation das alternativas (ou "Sem alternativas
 * disponiveis no intervalo" quando o cálculo real não achar nenhuma).
 * Até lá, recusamos de forma explícita, sem criar nada e sem fingir MRTR.
 */
function respostaProvisoriaDeConflito(sala: string, emConflito: readonly Reserva[]) {
  const ids = emConflito.map((r) => r.id).join(', ');
  return {
    content: [{ type: 'text' as const, text: `Conflito de horario: ${sala} ja reservada no intervalo (${ids}). [provisorio: MRTR no Passo 7]` }],
    isError: true,
  };
}

export function registrarReservarSala(servidor: McpServer): void {
  servidor.registerTool(
    'reservar_sala',
    {
      description: 'Reserva uma sala. Se o intervalo estiver ocupado, pergunta qual alternativa usar.',
      inputSchema: z.object({ sala: z.string(), inicio: DataIso, fim: DataIso, responsavel: z.string() }),
      outputSchema: ReservaOut,
    },
    async ({ sala, inicio, fim, responsavel }) => {
      const pedido = validarPedido(listarSalas(), sala, inicio, fim);
      if (!pedido.ok) {
        return { content: [{ type: 'text', text: pedido.mensagem }], isError: true };
      }
      const emConflito = conflitos(reservasDaSala(sala), pedido.valor.intervalo);
      if (emConflito.length > 0) return respostaProvisoriaDeConflito(sala, emConflito);

      return resultadoReservado(adicionarReserva({ sala, inicio, fim, responsavel }));
    },
  );
}
