// Tool consultar_disponibilidade: adaptador fino entre o protocolo e o domínio.
// - Pedido fora das regras → erro de EXECUÇÃO: resultado normal com
//   isError: true e a mensagem exata no texto (nunca um erro JSON-RPC).
// - Pedido válido → { sala, livre, conflitos } em structuredContent e o mesmo
//   JSON em texto, como listar_salas. A consulta não altera a agenda.
import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod';
import { DataIso, listarSalas, reservasDaSala } from '../dominio/agenda.ts';
import { conflitos, validarPedido } from '../dominio/regras.ts';

// Forma do contrato: exemplos/wire/01-tools-list.json (Disponibilidade / ConflitoOut).
const Conflito = z.object({ id: z.string(), inicio: z.string(), fim: z.string(), responsavel: z.string() });
const Disponibilidade = z.object({ sala: z.string(), livre: z.boolean(), conflitos: z.array(Conflito) });

export function registrarConsultarDisponibilidade(servidor: McpServer): void {
  servidor.registerTool(
    'consultar_disponibilidade',
    {
      description: 'Diz se uma sala esta livre no intervalo, e quais reservas conflitam.',
      inputSchema: z.object({ sala: z.string(), inicio: DataIso, fim: DataIso }),
      outputSchema: Disponibilidade,
    },
    async ({ sala, inicio, fim }) => {
      const pedido = validarPedido(listarSalas(), sala, inicio, fim);
      if (!pedido.ok) {
        return { content: [{ type: 'text', text: pedido.mensagem }], isError: true };
      }
      const emConflito = conflitos(reservasDaSala(sala), pedido.valor.intervalo).map(
        ({ id, inicio, fim, responsavel }) => ({ id, inicio, fim, responsavel }),
      );
      const resultado = { sala, livre: emConflito.length === 0, conflitos: emConflito };
      return {
        content: [{ type: 'text', text: JSON.stringify(resultado, null, 2) }],
        structuredContent: resultado,
      };
    },
  );
}
