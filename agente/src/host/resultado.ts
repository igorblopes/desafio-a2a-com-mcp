// Resultado de uma operação do Host. Seis desfechos, que a camada de cima
// (terminal hoje, A2A no Passo 10) PRECISA distinguir e que não são
// reduzidos a "sucesso/erro":
//
//   completo           a tool concluiu                         → estruturado (structuredContent)
//   erro_execucao      a tool rodou e recusou (isError: true)  → mensagem da tool
//   input_required     a tool pausou e pergunta algo (MRTR)    → continuacao (NÃO é erro)
//   erro_protocolo     o servidor respondeu erro JSON-RPC      → codigo (-32602, -32020, -32021...)
//   falha_transporte   não houve resposta MCP                  → servidor fora, timeout, HTTP inesperado
//   resposta_invalida  (só na retomada) a resposta da elicitation não serve
//                      para o formulário recebido; NADA foi enviado e a
//                      continuação segue válida para outra tentativa
//
// Erros de uso do próprio Host (tool não descoberta, argumento obrigatório
// ausente, continuação de outra operação) são bugs de quem chama e são
// LANÇADOS como ErroDeUso, sem request.
import type { CallToolResult, InputRequiredResult } from '@modelcontextprotocol/client';
import type { Continuacao } from './continuacao.ts';

interface Base {
  operacao: string | undefined;
  ferramenta: string;
}

export type ResultadoDaOperacao =
  | (Base & { tipo: 'completo'; estruturado: unknown; bruto: CallToolResult })
  | (Base & { tipo: 'erro_execucao'; mensagem: string; bruto: CallToolResult })
  | (Base & { tipo: 'input_required'; continuacao: Continuacao; bruto: InputRequiredResult })
  | (Base & { tipo: 'erro_protocolo'; codigo: number | string | undefined; mensagem: string; dados: unknown })
  | (Base & { tipo: 'falha_transporte'; codigo: number | string | undefined; mensagem: string })
  | (Base & { tipo: 'resposta_invalida'; problemas: string[]; continuacao: Continuacao });

export type TipoDeResultado = ResultadoDaOperacao['tipo'];
