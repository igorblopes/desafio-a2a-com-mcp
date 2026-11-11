// Tratamento de resultados e erros de tools/call.
//
// Quatro desfechos possíveis, que o consumidor PRECISA distinguir:
//
//   completo        a tool rodou e concluiu      → result.structuredContent
//   erro_execucao   a tool rodou e recusou       → result.isError: true (ex.: sala inexistente)
//   input_required  a tool precisa de uma escolha → result.resultType: "input_required" (MRTR)
//   ErroMcp         (lançado, ver erros.ts) a chamada nem chegou a ser uma execução:
//                   o servidor respondeu com erro JSON-RPC, ou o HTTP falhou
//
// input_required NÃO é erro: é uma pausa. E nenhum desfecho descarta o
// resultado original (`bruto`), para que o Host MCP tenha tudo que o
// protocolo mandou.
import { isInputRequiredResult, type CallToolResult, type InputRequiredResult } from '@modelcontextprotocol/client';
import { lerPedidos, type PedidoDeEntrada } from './mrtr.ts';

/** O que foi chamado. Fica junto do resultado para o retry repetir exatamente a mesma chamada. */
export interface Chamada {
  nome: string;
  argumentos: Record<string, unknown>;
}

export type ResultadoDaTool =
  | { tipo: 'completo'; chamada: Chamada; estruturado: unknown; bruto: CallToolResult }
  | { tipo: 'erro_execucao'; chamada: Chamada; mensagem: string; bruto: CallToolResult }
  | { tipo: 'input_required'; chamada: Chamada; pedidos: PedidoDeEntrada[]; requestState: string | undefined; bruto: InputRequiredResult };

export type ResultadoInputRequired = Extract<ResultadoDaTool, { tipo: 'input_required' }>;

function textoDe(resultado: CallToolResult): string {
  return resultado.content
    .filter((c): c is Extract<typeof c, { type: 'text' }> => c.type === 'text')
    .map((c) => c.text)
    .join('\n');
}

export function classificar(chamada: Chamada, resposta: CallToolResult | InputRequiredResult): ResultadoDaTool {
  if (isInputRequiredResult(resposta)) {
    // requestState é guardado como veio: string opaca, sem decodificar.
    return { tipo: 'input_required', chamada, pedidos: lerPedidos(resposta), requestState: resposta.requestState, bruto: resposta };
  }
  const resultado = resposta as CallToolResult;
  if (resultado.isError) return { tipo: 'erro_execucao', chamada, mensagem: textoDe(resultado), bruto: resultado };
  return { tipo: 'completo', chamada, estruturado: resultado.structuredContent, bruto: resultado };
}
