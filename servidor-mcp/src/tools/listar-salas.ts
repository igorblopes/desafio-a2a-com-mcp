// Tool listar_salas: adaptador fino entre o protocolo e o domínio.
// Devolve structuredContent (conforme outputSchema) e o MESMO JSON em um
// bloco de texto, por compatibilidade com clientes que só leem content.
import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod';
import { SalaSchema, listarSalas } from '../dominio/agenda.ts';

// Forma do contrato: exemplos/wire/01-tools-list.json (ListaDeSalas).
const ListaDeSalas = z.object({ salas: z.array(SalaSchema) });

export function registrarListarSalas(servidor: McpServer): void {
  servidor.registerTool(
    'listar_salas',
    {
      description: 'Lista todas as salas com capacidade e recursos.',
      inputSchema: z.object({}),
      outputSchema: ListaDeSalas,
    },
    async () => {
      const resultado = { salas: [...listarSalas()] };
      return {
        content: [{ type: 'text', text: JSON.stringify(resultado, null, 2) }],
        structuredContent: resultado,
      };
    },
  );
}
