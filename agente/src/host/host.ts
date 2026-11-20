// Host MCP: a peça que a APLICAÇÃO usa para consumir o servidor MCP.
//
//   aplicação (terminal hoje, A2A no Passo 10)
//        │  iniciar / ferramentas / lerPolitica / executar / continuar
//        ▼
//   HostMcp      catálogo, política, contexto de execução, continuação MRTR,
//        │       validação da resposta contra o formulário recebido
//        ▼
//   ClienteMcp   protocolo: transporte, _meta, headers, ids, erros
//        │ Streamable HTTP
//        ▼
//   servidor MCP (outro processo)
//
// O Host não conhece salas, horários nem alternativas: trabalha com nomes de
// tools, argumentos, schemas e resultados de protocolo. As regras são do
// servidor. E o Host não decide a resposta de uma elicitation: devolve a
// pergunta (input_required) para quem chamou e só transforma a resposta que
// recebe de volta num retry válido.
//
// Nenhum estado de operação fica no Host: a continuação é devolvida como
// valor e volta como argumento. Por isso várias operações podem estar
// pausadas ao mesmo tempo sem se misturar.
import type { FetchLike, Tool } from '@modelcontextprotocol/client';
import { ErroDeUso, ErroMcp } from '../mcp/erros.ts';
import { ClienteMcp, type DadosDeRetry } from '../mcp/cliente.ts';
import { problemasDasRespostas, type RespostaDeEntrada, type RespostasDeEntrada } from '../mcp/mrtr.ts';
import { extrairVersao, URI_DA_POLITICA } from '../mcp/politica.ts';
import { CatalogoDeFerramentas } from './catalogo.ts';
import type { ContextoDeExecucao } from './contexto.ts';
import { criarContinuacao, type Continuacao } from './continuacao.ts';
import type { ResultadoDaOperacao } from './resultado.ts';

export interface OpcoesDoHost {
  url: URL;
  /** fetch alternativo (testes e demo observam o tráfego por aqui). */
  fetch?: FetchLike;
  /** Espera máxima por cada resposta MCP, em ms (padrão do SDK se ausente). */
  timeoutMs?: number;
}

export interface Politica {
  versao: string;
  /** Markdown exatamente como veio do servidor. */
  texto: string;
  /** De onde a informação veio: sempre o servidor MCP, nunca um arquivo local. */
  origem: { uri: string; mimeType: string | undefined; servidor: { name?: string; version?: string } | undefined; lidaEm: Date };
}

export class HostMcp {
  readonly #catalogo = new CatalogoDeFerramentas();
  #cliente: ClienteMcp | undefined;
  #politica: Politica | undefined;

  private constructor(private readonly opcoes: OpcoesDoHost) {}

  /** Conecta (server/discover) e descobre as ferramentas (tools/list). Só então o Host está pronto. */
  static async iniciar(opcoes: OpcoesDoHost, ctx: ContextoDeExecucao = {}): Promise<HostMcp> {
    const host = new HostMcp(opcoes);
    await host.#conectar(ctx);
    return host;
  }

  async #conectar(ctx: ContextoDeExecucao): Promise<void> {
    this.#cliente = await ClienteMcp.conectar({ url: this.opcoes.url, fetch: this.opcoes.fetch, timeoutMs: this.opcoes.timeoutMs });
    await this.descobrir(ctx);
  }

  #exigirCliente(): ClienteMcp {
    if (!this.#cliente) throw new ErroDeUso('Host encerrado: chame reiniciar() ou HostMcp.iniciar()');
    return this.#cliente;
  }

  /** Fecha o cliente atual, esquece catálogo e política e conecta de novo do zero. */
  async reiniciar(ctx: ContextoDeExecucao = {}): Promise<void> {
    await this.encerrar();
    await this.#conectar(ctx);
  }

  async encerrar(): Promise<void> {
    const cliente = this.#cliente;
    this.#cliente = undefined;
    this.#catalogo.limpar();
    this.#politica = undefined;
    await cliente?.fechar();
  }

  // ── descoberta ─────────────────────────────────────────────────────────

  /** tools/list no fio e substitui o catálogo. Pode (e deve, por Task) ser chamado de novo, com o trace da operação. */
  async descobrir(ctx: ContextoDeExecucao = {}): Promise<Tool[]> {
    const tools = await this.#exigirCliente().listarTools(ctx);
    this.#catalogo.substituir(tools);
    return this.#catalogo.listar();
  }

  /** Catálogo atual: as tools e os schemas recebidos no último tools/list. */
  ferramentas(): Tool[] {
    return this.#catalogo.listar();
  }

  ferramenta(nome: string): Tool | undefined {
    return this.#catalogo.obter(nome);
  }

  // ── resources ──────────────────────────────────────────────────────────

  lerRecurso(uri: string, ctx: ContextoDeExecucao = {}) {
    return this.#exigirCliente().lerRecurso(uri, ctx);
  }

  /** resources/read politica://uso + versão da 1ª linha. Fica disponível em `politica` até a próxima leitura. */
  async lerPolitica(ctx: ContextoDeExecucao = {}): Promise<Politica> {
    const bruto = await this.lerRecurso(URI_DA_POLITICA, ctx);
    const conteudo = bruto.contents.find((c) => c.uri === URI_DA_POLITICA && 'text' in c);
    const texto = conteudo && 'text' in conteudo ? conteudo.text : undefined;
    if (texto === undefined) throw new ErroMcp('resposta', `${URI_DA_POLITICA} veio sem conteúdo de texto`);
    const versao = extrairVersao(texto);
    if (versao === undefined) throw new ErroMcp('resposta', `${URI_DA_POLITICA}: primeira linha sem "versao: ..."`);
    const servidor = bruto._meta?.['io.modelcontextprotocol/serverInfo'] as { name?: string; version?: string } | undefined;
    this.#politica = { versao, texto, origem: { uri: URI_DA_POLITICA, mimeType: conteudo?.mimeType, servidor, lidaEm: new Date() } };
    return this.#politica;
  }

  /** Última política lida (undefined se ainda não leu). */
  get politica(): Politica | undefined {
    return this.#politica;
  }

  // ── execução ───────────────────────────────────────────────────────────

  /**
   * Executa uma tool DESCOBERTA. Nunca resolve um input_required: devolve a
   * continuação para quem chamou decidir.
   */
  async executar(nome: string, argumentos: Record<string, unknown>, ctx: ContextoDeExecucao = {}): Promise<ResultadoDaOperacao> {
    this.#catalogo.exigir(nome, argumentos);
    return this.#chamar(nome, argumentos, ctx, undefined, 1);
  }

  /**
   * Retoma uma operação pausada com a resposta da elicitation, decidida FORA
   * do Host. `resposta` pode ser o mapa { chave: resposta } ou, quando o
   * servidor fez uma pergunta só, a resposta direta ({ action, content? }).
   *
   * Se a resposta não serve para o formulário recebido, devolve
   * `resposta_invalida` sem enviar nada (a continuação continua valendo).
   */
  async continuar(
    continuacao: Continuacao,
    resposta: RespostaDeEntrada | RespostasDeEntrada,
    ctx: ContextoDeExecucao = {},
  ): Promise<ResultadoDaOperacao> {
    if (ctx.operacao !== undefined && continuacao.operacao !== undefined && ctx.operacao !== continuacao.operacao) {
      throw new ErroDeUso(`continuação da operação '${continuacao.operacao}' não pode ser retomada pela operação '${ctx.operacao}'`);
    }
    const respostas = normalizar(continuacao, resposta);
    const problemas = respostas ? problemasDasRespostas([...continuacao.pedidos], respostas) : ['resposta direta só vale quando há uma única pergunta'];
    if (problemas.length) {
      return { tipo: 'resposta_invalida', operacao: continuacao.operacao, ferramenta: continuacao.ferramenta, problemas, continuacao };
    }
    this.#catalogo.exigir(continuacao.ferramenta, { ...continuacao.argumentos });
    const efetivo: ContextoDeExecucao = {
      operacao: continuacao.operacao,
      // Mesmo trace da operação, mesmo se quem retoma não o reenviar.
      traceparent: ctx.traceparent ?? continuacao.traceparent,
    };
    const retry: DadosDeRetry = { inputResponses: respostas as RespostasDeEntrada, requestState: continuacao.requestState };
    return this.#chamar(continuacao.ferramenta, { ...continuacao.argumentos }, efetivo, retry, continuacao.rodada + 1);
  }

  async #chamar(
    nome: string,
    argumentos: Record<string, unknown>,
    ctx: ContextoDeExecucao,
    retry: DadosDeRetry | undefined,
    rodada: number,
  ): Promise<ResultadoDaOperacao> {
    const base = { operacao: ctx.operacao, ferramenta: nome };
    let r;
    try {
      r = await this.#exigirCliente().chamarTool(nome, argumentos, { traceparent: ctx.traceparent, retry });
    } catch (erro) {
      if (erro instanceof ErroMcp && erro.categoria === 'transporte') {
        return { ...base, tipo: 'falha_transporte', codigo: erro.codigo, mensagem: erro.message };
      }
      if (erro instanceof ErroMcp) {
        return { ...base, tipo: 'erro_protocolo', codigo: erro.codigo, mensagem: erro.message, dados: erro.dados };
      }
      throw erro;
    }
    switch (r.tipo) {
      case 'completo':
        return { ...base, tipo: 'completo', estruturado: r.estruturado, bruto: r.bruto };
      case 'erro_execucao':
        return { ...base, tipo: 'erro_execucao', mensagem: r.mensagem, bruto: r.bruto };
      case 'input_required':
        return {
          ...base,
          tipo: 'input_required',
          bruto: r.bruto,
          continuacao: criarContinuacao({
            operacao: ctx.operacao,
            ferramenta: nome,
            argumentos,
            pedidos: r.pedidos,
            requestState: r.requestState,
            traceparent: ctx.traceparent,
            rodada,
          }),
        };
    }
  }
}

function normalizar(c: Continuacao, resposta: RespostaDeEntrada | RespostasDeEntrada): Record<string, unknown> | undefined {
  if (typeof resposta === 'object' && resposta !== null && 'action' in resposta && typeof resposta.action === 'string') {
    return c.pedidos.length === 1 ? { [c.pedidos[0]!.chave]: resposta } : undefined;
  }
  return resposta as Record<string, unknown>;
}
