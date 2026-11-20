// Cliente MCP: fala com o servidor SÓ por HTTP (Streamable HTTP, revisão
// 2026-07-28), com o SDK oficial. Não importa nada de servidor-mcp/.
//
// Passo 9: este módulo ficou só com o PROTOCOLO. Quem decide o que chamar,
// guarda o catálogo, lê a política e retoma operações é o Host (src/host/).
//
// Quem faz o quê aqui:
//   SDK        transporte, ids JSON-RPC (um novo por request), headers
//              MCP-Protocol-Version / Mcp-Method / Mcp-Name derivados do corpo,
//              e o _meta de cada request (protocolVersion, clientInfo,
//              clientCapabilities). Nada disso é escrito à mão aqui.
//   este módulo  monta os params (inclusive inputResponses/requestState do
//              retry, fora de arguments), põe o traceparent em _meta, traduz
//              erros e classifica o resultado de tools/call.
import {
  Client,
  StreamableHTTPClientTransport,
  specTypeSchemas,
  withInputRequired,
  type CallToolResult,
  type FetchLike,
  type InputRequiredResult,
  type ReadResourceResult,
  type Tool,
} from '@modelcontextprotocol/client';
import { CAPACIDADES_DO_CLIENTE, IDENTIDADE_DO_CLIENTE, PROTOCOLO_MCP } from '../config.ts';
import { traceparentFilho } from '../trace.ts';
import { traduzirErro } from './erros.ts';
import type { RespostasDeEntrada } from './mrtr.ts';
import { classificar, type ResultadoDaTool } from './resultado.ts';

export interface OpcoesDoCliente {
  url: URL;
  /** fetch alternativo (ex.: fetchObservado, nos testes e na demo). Padrão: o fetch global. */
  fetch?: FetchLike;
  /** Espera máxima por cada resposta, em ms. Ausente: o padrão do SDK (60 s). Estourou → ErroMcp transporte (REQUEST_TIMEOUT). */
  timeoutMs?: number;
}

export interface OpcoesDoRequest {
  /** traceparent W3C da operação. Ausente = nenhum traceparent é enviado. */
  traceparent?: string;
}

/** O que vai em params, ao lado de arguments, no retry de um input_required. */
export interface DadosDeRetry {
  inputResponses: RespostasDeEntrada;
  requestState: string | undefined;
}

/** _meta do NOSSO lado. O SDK mescla com o envelope obrigatório (versão, clientInfo, capabilities). */
function meta(op: OpcoesDoRequest | undefined): { _meta?: { traceparent: string } } {
  return op?.traceparent ? { _meta: { traceparent: traceparentFilho(op.traceparent) } } : {};
}

async function protegido<T>(operacao: () => Promise<T>): Promise<T> {
  try {
    return await operacao();
  } catch (erro) {
    throw traduzirErro(erro);
  }
}

export class ClienteMcp {
  private constructor(
    private readonly sdk: Client,
    private readonly espera: { timeout?: number },
  ) {}

  /**
   * Cria o Client do SDK e conecta. O connect() manda um server/discover
   * (confirma que o servidor fala 2026-07-28; não abre sessão). Daí em
   * diante, todo request leva o próprio _meta completo.
   */
  static async conectar(opcoes: OpcoesDoCliente): Promise<ClienteMcp> {
    const sdk = new Client(IDENTIDADE_DO_CLIENTE, {
      capabilities: CAPACIDADES_DO_CLIENTE,
      versionNegotiation: { mode: { pin: PROTOCOLO_MCP } },
      // Modo manual: o SDK nunca responde a uma elicitation sozinho. Também
      // não registramos handler de elicitation/create.
      inputRequired: { autoFulfill: false },
    });
    const transporte = new StreamableHTTPClientTransport(opcoes.url, opcoes.fetch ? { fetch: opcoes.fetch } : undefined);
    const espera = opcoes.timeoutMs === undefined ? {} : { timeout: opcoes.timeoutMs };
    await protegido(() => sdk.connect(transporte, espera));
    return new ClienteMcp(sdk, espera);
  }

  /** tools/list, sempre no fio (sem cache do SDK). */
  async listarTools(op?: OpcoesDoRequest): Promise<Tool[]> {
    const { tools } = await protegido(() => this.sdk.listTools({ ...meta(op) }, { cacheMode: 'refresh', ...this.espera }));
    return tools;
  }

  /** resources/read de uma URI. */
  async lerRecurso(uri: string, op?: OpcoesDoRequest): Promise<ReadResourceResult> {
    return protegido(() => this.sdk.readResource({ uri, ...meta(op) }, { cacheMode: 'bypass', ...this.espera }));
  }

  /**
   * tools/call. `retry` (só na continuação) vai em params, ao lado de
   * `arguments`, nunca dentro dele. Cada chamada é um request novo, com id
   * novo gerado pelo SDK. Não confere catálogo: isso é papel do Host.
   */
  async chamarTool(nome: string, argumentos: Record<string, unknown>, op?: OpcoesDoRequest & { retry?: DadosDeRetry }): Promise<ResultadoDaTool> {
    const params: Record<string, unknown> = { name: nome, arguments: argumentos, ...meta(op) };
    if (op?.retry) {
      params.inputResponses = op.retry.inputResponses;
      if (op.retry.requestState !== undefined) params.requestState = op.retry.requestState;
    }
    // client.request + withInputRequired, e não client.callTool: em 2.4.0 o
    // callTool confere o outputSchema mesmo quando a resposta é
    // input_required (que não tem structuredContent) e lança erro. O caminho
    // de schema explícito é o indicado pelo SDK para o modo manual.
    const resposta = await protegido(() =>
      this.sdk.request({ method: 'tools/call', params }, withInputRequired(specTypeSchemas.CallToolResult), { allowInputRequired: true, ...this.espera }),
    );
    return classificar({ nome, argumentos }, resposta as CallToolResult | InputRequiredResult);
  }

  async fechar(): Promise<void> {
    await this.sdk.close();
  }
}
