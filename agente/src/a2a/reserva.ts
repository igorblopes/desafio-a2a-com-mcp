// A ÚNICA peça do lado A2A que fala com o Host MCP. Recebe um pedido já
// lido do texto (ou a resposta a uma pausa) e devolve um desfecho em termos
// do agente: concluída, pausada (com o que perguntar), recusada ou falha.
// Não conhece Tasks, JSON-RPC nem HTTP; não conhece transporte MCP nem
// regras de salas.
//
// Por operação (uma Task): tools/list e politica://uso com o trace da Task,
// depois tools/call reservar_sala. Assim cada Task vê o catálogo e a versão
// da política atuais, e todos os requests MCP ficam no mesmo trace. A
// retomada (Passo 11) é um tools/call novo com a continuação guardada.
import type { FetchLike } from '@modelcontextprotocol/client';
import { HostMcp } from '../host/host.ts';
import type { ContextoDeExecucao } from '../host/contexto.ts';
import type { ResultadoDaOperacao } from '../host/resultado.ts';
import { ErroDeUso, ErroMcp } from '../mcp/erros.ts';
import type { RespostaDeEntrada } from '../mcp/mrtr.ts';
import { perguntaDe } from './ponte.ts';
import type { Pendente } from './tarefas/retomadas.ts';
import type { PedidoDeReserva } from './tarefas/pedido.ts';

/** Nome da tool no servidor MCP. Fica aqui, longe do card e das Tasks. */
const TOOL_DE_RESERVA = 'reservar_sala';

export interface Reserva {
  reserva: string;
  sala: string;
  inicio: string;
  fim: string;
  responsavel: string;
  politica: string;
}

export type Desfecho =
  | { tipo: 'concluida'; reserva: Reserva }
  | { tipo: 'pausada'; pendente: Pendente }
  | { tipo: 'recusada'; mensagem: string }
  | { tipo: 'falhou'; motivo: 'execucao' | 'conflito' | 'protocolo' | 'transporte' | 'uso' | 'resposta'; mensagem: string };

export const MENSAGEM_DE_RECUSA = 'Reserva recusada: nenhuma sala foi reservada.';
export const MENSAGEM_PERGUNTA_NAO_SUPORTADA = 'O servidor de reservas pediu uma informacao que este agente nao sabe responder.';
export const MENSAGEM_SEM_MCP = 'Servidor de reservas indisponivel no momento.';
/**
 * O tools/call foi enviado e a resposta não veio a tempo. Diferente de
 * "indisponível": o servidor pode ter gravado a reserva, então o agente não
 * afirma nada e não reenvia (a operação escreve).
 */
export const MENSAGEM_SEM_RESPOSTA = 'O servidor de reservas nao respondeu a tempo; nao e possivel confirmar se a reserva foi registrada.';
/** O servidor recusou a continuação (-32602): requestState vencido, adulterado ou de outro segredo. */
export const MENSAGEM_CONTINUACAO_RECUSADA = 'O servidor de reservas recusou a continuacao (prazo vencido ou estado invalido); nenhuma sala foi reservada. Faca um novo pedido.';
/** Código do SDK para timeout de request (SdkErrorCode.RequestTimeout). */
const TIMEOUT_DO_SDK = 'REQUEST_TIMEOUT';
/** Campos que um resultado com reservado: true precisa trazer, todos texto. */
const CAMPOS_DA_RESERVA = ['reserva', 'sala', 'inicio', 'fim', 'responsavel', 'politica'] as const;

export type Registro = (linha: string) => void;

/** Mantém um Host MCP por processo, criado sob demanda e refeito depois de uma falha de transporte. */
export class ConexaoMcp {
  #host: Promise<HostMcp> | undefined;

  constructor(private readonly opcoes: { url: URL; fetch?: FetchLike; timeoutMs?: number }) {}

  host(ctx: ContextoDeExecucao): Promise<HostMcp> {
    this.#host ??= HostMcp.iniciar(this.opcoes, ctx).catch((e: unknown) => {
      this.#host = undefined;
      throw e;
    });
    return this.#host;
  }

  async descartar(): Promise<void> {
    const h = this.#host;
    this.#host = undefined;
    await h?.then((x) => x.encerrar()).catch(() => undefined);
  }
}

export class ServicoDeReserva {
  constructor(
    private readonly conexao: ConexaoMcp,
    private readonly registrar: Registro = (l) => console.error(l),
  ) {}

  async reservar(pedido: PedidoDeReserva, ctx: ContextoDeExecucao): Promise<Desfecho> {
    try {
      const host = await this.conexao.host(ctx);
      await host.descobrir(ctx);
      const politica = await host.lerPolitica(ctx);
      const r = await host.executar(TOOL_DE_RESERVA, { ...pedido }, ctx);
      return this.#traduzir(r, { politica: politica.versao, retomada: false, recusou: false });
    } catch (e) {
      return this.#falhaInesperada(e);
    }
  }

  /**
   * Retomada de uma Task pausada: UM tools/call novo (id JSON-RPC novo, dado
   * pelo cliente MCP) com os argumentos originais, inputResponses na chave
   * original e o requestState intacto, tudo lido da continuação. Sem retry
   * automático: a chamada pode ter efeito de escrita.
   */
  async retomar(pendente: Pendente, resposta: RespostaDeEntrada, ctx: ContextoDeExecucao): Promise<Desfecho> {
    try {
      const host = await this.conexao.host(ctx);
      const r = await host.continuar(pendente.continuacao, resposta, ctx);
      return this.#traduzir(r, { politica: pendente.politica, retomada: true, recusou: resposta.action === 'decline' });
    } catch (e) {
      return this.#falhaInesperada(e);
    }
  }

  #traduzir(r: ResultadoDaOperacao, { politica: versaoLida, retomada, recusou }: { politica: string; retomada: boolean; recusou: boolean }): Desfecho {
    switch (r.tipo) {
      case 'completo': {
        const sc = (r.estruturado ?? {}) as Partial<Reserva> & { reservado?: boolean; motivo?: string | null };
        if (recusou && sc.reservado === false) {
          // decline é uma conclusão normal do MCP; o A2A traduz em CANCELED.
          return { tipo: 'recusada', mensagem: MENSAGEM_DE_RECUSA };
        }
        if (sc.reservado !== true || typeof sc.reserva !== 'string') {
          return { tipo: 'falhou', motivo: 'resposta', mensagem: `O servidor de reservas nao confirmou a reserva${sc.motivo ? ` (${sc.motivo})` : ''}.` };
        }
        // Sem os seis campos não há artifact honesto: COMPLETED exige a reserva inteira.
        const faltando = CAMPOS_DA_RESERVA.filter((c) => typeof sc[c] !== 'string' || sc[c] === '');
        if (faltando.length > 0) {
          this.registrar(`[a2a] resultado de reserva incompleto (faltam: ${faltando.join(', ')})`);
          return { tipo: 'falhou', motivo: 'resposta', mensagem: 'O servidor de reservas respondeu sem os dados completos da reserva.' };
        }
        // O MCP é a fonte da verdade: a reserva vem do structuredContent, não do texto do usuário.
        const reserva: Reserva = { reserva: sc.reserva, sala: sc.sala!, inicio: sc.inicio!, fim: sc.fim!, responsavel: sc.responsavel!, politica: sc.politica! };
        if (reserva.politica !== versaoLida) {
          this.registrar(`[a2a] aviso: versao da politica no resultado (${reserva.politica}) difere da lida em politica://uso (${versaoLida})`);
        }
        return { tipo: 'concluida', reserva };
      }
      case 'erro_execucao':
        // A mensagem da tool vai intacta para o histórico (ex.: "Sala inexistente: sala-delorean").
        return { tipo: 'falhou', motivo: 'execucao', mensagem: r.mensagem };
      case 'input_required': {
        // Não é erro: a operação pausou. Nada é respondido automaticamente;
        // a continuação (com o requestState opaco) sobe para ser guardada
        // pela Task, e a pergunta sai do formulário que o servidor mandou.
        const p = perguntaDe(r.continuacao);
        if (!p.ok) {
          this.registrar(`[a2a] input_required nao suportado: ${p.motivo}`);
          return { tipo: 'falhou', motivo: 'conflito', mensagem: MENSAGEM_PERGUNTA_NAO_SUPORTADA };
        }
        return { tipo: 'pausada', pendente: { continuacao: r.continuacao, campo: p.campo, alternativas: p.alternativas, mensagem: p.mensagem, politica: versaoLida } };
      }
      case 'erro_protocolo':
        // Na retomada, os argumentos são os originais (já aceitos na 1ª rodada):
        // um -32602 aqui é o requestState recusado. A ponte não sabe POR QUÊ
        // (não lê o estado); só diz que a continuação não vale mais.
        if (retomada && r.codigo === -32602) return { tipo: 'falhou', motivo: 'protocolo', mensagem: MENSAGEM_CONTINUACAO_RECUSADA };
        return { tipo: 'falhou', motivo: 'protocolo', mensagem: `Erro de protocolo no servidor de reservas (codigo ${r.codigo ?? '-'}).` };
      case 'falha_transporte':
        void this.conexao.descartar();
        this.registrar(`[a2a] falha de transporte no tools/call (${r.codigo ?? '-'}): ${resumo(r.mensagem)}`);
        if (r.codigo === TIMEOUT_DO_SDK) return { tipo: 'falhou', motivo: 'transporte', mensagem: MENSAGEM_SEM_RESPOSTA };
        return { tipo: 'falhou', motivo: 'transporte', mensagem: MENSAGEM_SEM_MCP };
      case 'resposta_invalida':
        // Não acontece pela ponte (a escolha é validada antes), mas se
        // acontecer nada foi enviado ao servidor.
        return { tipo: 'falhou', motivo: 'uso', mensagem: 'Resposta invalida para o servidor de reservas.' };
    }
  }

  #falhaInesperada(e: unknown): Desfecho {
    if (e instanceof ErroMcp && e.categoria === 'transporte') {
      void this.conexao.descartar();
      this.registrar(`[a2a] falha de transporte fora do tools/call (${e.codigo ?? '-'}): ${resumo(e.message)}`);
      return { tipo: 'falhou', motivo: 'transporte', mensagem: MENSAGEM_SEM_MCP };
    }
    if (e instanceof ErroMcp) {
      return { tipo: 'falhou', motivo: 'protocolo', mensagem: `Erro de protocolo no servidor de reservas (codigo ${e.codigo ?? '-'}).` };
    }
    if (e instanceof ErroDeUso) {
      // Ex.: o servidor deixou de oferecer a tool de reserva.
      this.registrar(`[a2a] erro de uso do Host: ${e.message}`);
      return { tipo: 'falhou', motivo: 'uso', mensagem: 'O servidor de reservas nao oferece a operacao de reserva no momento.' };
    }
    this.registrar(`[a2a] falha inesperada: ${resumo(e instanceof Error ? `${e.name}: ${e.message}` : String(e))}`);
    return { tipo: 'falhou', motivo: 'resposta', mensagem: 'Falha inesperada ao falar com o servidor de reservas.' };
  }
}

/** Uma linha só, curta: erros do SDK (ex.: validação zod) podem ter dezenas de linhas. */
function resumo(texto: string): string {
  const linha = texto.replace(/\s+/g, ' ').trim();
  return linha.length > 200 ? `${linha.slice(0, 200)}...` : linha;
}
