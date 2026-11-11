// Cliente MCP independente: fala com o servidor SÓ por HTTP (Streamable HTTP,
// revisão 2026-07-28), com o SDK oficial. Não importa nada de servidor-mcp/.
//
// Quem faz o quê:
//   SDK        transporte, ids JSON-RPC (um novo por request), headers
//              MCP-Protocol-Version / Mcp-Method / Mcp-Name derivados do corpo,
//              e o _meta de cada request (protocolVersion, clientInfo,
//              clientCapabilities). Nada disso é escrito à mão aqui.
//   este módulo  descoberta, leitura de resource, tools/call genérico em modo
//              MRTR manual, traceparent em _meta e classificação dos resultados.
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
import { ErroDeUso, ErroMcp, traduzirErro } from './erros.ts';
import { continuacao as montarContinuacao, type Continuacao, type RespostasDeEntrada } from './mrtr.ts';
import { extrairVersao, URI_DA_POLITICA } from './politica.ts';
import { classificar, type ResultadoDaTool, type ResultadoInputRequired } from './resultado.ts';

export interface OpcoesDoCliente {
  url: URL;
  /** fetch alternativo (ex.: fetchObservado, nos testes e na demo). Padrão: o fetch global. */
  fetch?: FetchLike;
}

export interface OpcoesDaOperacao {
  /** traceparent W3C de quem pediu a operação. Ausente = nenhum traceparent é enviado. */
  traceparent?: string;
}

export interface Politica {
  texto: string;
  versao: string;
  bruto: ReadResourceResult;
}

/** _meta do NOSSO lado. O SDK mescla com o envelope obrigatório (versão, clientInfo, capabilities). */
function meta(op: OpcoesDaOperacao | undefined): { _meta?: { traceparent: string } } {
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
  /** Resultado da última descoberta. Vazio até descobrir() ser chamado. */
  #ferramentas = new Map<string, Tool>();

  private constructor(private readonly sdk: Client) {}

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
    await protegido(() => sdk.connect(transporte));
    return new ClienteMcp(sdk);
  }

  get ferramentas(): ReadonlyMap<string, Tool> {
    return this.#ferramentas;
  }

  /** tools/list (sempre vai ao servidor) e substitui o catálogo conhecido. */
  async descobrir(op?: OpcoesDaOperacao): Promise<Tool[]> {
    const { tools } = await protegido(() => this.sdk.listTools({ ...meta(op) }, { cacheMode: 'refresh' }));
    this.#ferramentas = new Map(tools.map((t) => [t.name, t]));
    return tools;
  }

  /** resources/read de qualquer URI anunciada pelo servidor. */
  async lerRecurso(uri: string, op?: OpcoesDaOperacao): Promise<ReadResourceResult> {
    return protegido(() => this.sdk.readResource({ uri, ...meta(op) }, { cacheMode: 'bypass' }));
  }

  /** Lê politica://uso e extrai a versão da primeira linha. O texto é devolvido intacto. */
  async lerPolitica(op?: OpcoesDaOperacao): Promise<Politica> {
    const bruto = await this.lerRecurso(URI_DA_POLITICA, op);
    const conteudo = bruto.contents.find((c) => c.uri === URI_DA_POLITICA && 'text' in c);
    const texto = conteudo && 'text' in conteudo ? conteudo.text : undefined;
    if (texto === undefined) throw new ErroMcp('resposta', `${URI_DA_POLITICA} veio sem conteúdo de texto`);
    const versao = extrairVersao(texto);
    if (versao === undefined) throw new ErroMcp('resposta', `${URI_DA_POLITICA}: primeira linha sem "versao: ..."`);
    return { texto, versao, bruto };
  }

  /**
   * tools/call genérico. `continuacao` (só no retry) vai em params, ao lado
   * de `arguments`, nunca dentro dele. Cada chamada é um request novo, com id
   * novo gerado pelo SDK.
   */
  async chamarTool(
    nome: string,
    argumentos: Record<string, unknown>,
    op?: OpcoesDaOperacao & { continuacao?: Continuacao },
  ): Promise<ResultadoDaTool> {
    const ferramenta = this.#ferramentas.get(nome);
    if (!ferramenta) {
      throw new ErroDeUso(
        this.#ferramentas.size === 0
          ? `ferramenta '${nome}' ainda não descoberta: chame descobrir() antes`
          : `o servidor não oferece a ferramenta '${nome}' (oferece: ${[...this.#ferramentas.keys()].join(', ')})`,
      );
    }
    const faltando = (ferramenta.inputSchema.required ?? []).filter((k) => !(k in argumentos));
    if (faltando.length) throw new ErroDeUso(`argumentos obrigatórios ausentes em ${nome}: ${faltando.join(', ')}`);

    const params: Record<string, unknown> = { name: nome, arguments: argumentos, ...meta(op) };
    if (op?.continuacao) {
      params.inputResponses = op.continuacao.inputResponses;
      if (op.continuacao.requestState !== undefined) params.requestState = op.continuacao.requestState;
    }
    // client.request + withInputRequired, e não client.callTool: em 2.4.0 o
    // callTool confere o outputSchema mesmo quando a resposta é
    // input_required (que não tem structuredContent) e lança erro. O caminho
    // de schema explícito é o indicado pelo SDK para o modo manual.
    const resposta = await protegido(() =>
      this.sdk.request({ method: 'tools/call', params }, withInputRequired(specTypeSchemas.CallToolResult), { allowInputRequired: true }),
    );
    return classificar({ nome, argumentos }, resposta as CallToolResult | InputRequiredResult);
  }

  /**
   * Retry de um input_required: mesma tool, mesmos argumentos, as respostas
   * do usuário e o requestState recebido, ecoado sem alteração.
   */
  async continuar(pausa: ResultadoInputRequired, respostas: RespostasDeEntrada, op?: OpcoesDaOperacao): Promise<ResultadoDaTool> {
    const continuacao = montarContinuacao(pausa.pedidos, pausa.requestState, respostas);
    return this.chamarTool(pausa.chamada.nome, pausa.chamada.argumentos, { ...op, continuacao });
  }

  async fechar(): Promise<void> {
    await this.sdk.close();
  }
}
