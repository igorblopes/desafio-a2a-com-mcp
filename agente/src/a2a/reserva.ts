// A ÚNICA peça do lado A2A que fala com o Host MCP. Recebe um pedido já
// lido do texto e devolve um desfecho em termos do agente: reserva concluída
// ou falha com mensagem. Não conhece Tasks, JSON-RPC nem HTTP; não conhece
// transporte MCP nem regras de salas.
//
// Por operação (uma Task): tools/list e politica://uso com o trace da Task,
// depois tools/call reservar_sala. Assim cada Task vê o catálogo e a versão
// da política atuais, e todos os requests MCP ficam no mesmo trace.
import type { FetchLike } from '@modelcontextprotocol/client';
import { HostMcp } from '../host/host.ts';
import type { ContextoDeExecucao } from '../host/contexto.ts';
import type { ResultadoDaOperacao } from '../host/resultado.ts';
import { ErroDeUso, ErroMcp } from '../mcp/erros.ts';
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
  | { tipo: 'falhou'; motivo: 'execucao' | 'conflito' | 'protocolo' | 'transporte' | 'uso' | 'resposta'; mensagem: string };

export const MENSAGEM_DE_CONFLITO =
  'A sala pedida esta ocupada nesse intervalo. Este agente ainda nao permite escolher uma alternativa; a Task foi encerrada sem reserva.';
export const MENSAGEM_SEM_MCP = 'Servidor de reservas indisponivel no momento.';

export type Registro = (linha: string) => void;

/** Mantém um Host MCP por processo, criado sob demanda e refeito depois de uma falha de transporte. */
export class ConexaoMcp {
  #host: Promise<HostMcp> | undefined;

  constructor(private readonly opcoes: { url: URL; fetch?: FetchLike }) {}

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
      return this.#traduzir(r, politica.versao);
    } catch (e) {
      return this.#falhaInesperada(e);
    }
  }

  #traduzir(r: ResultadoDaOperacao, versaoLida: string): Desfecho {
    switch (r.tipo) {
      case 'completo': {
        const sc = (r.estruturado ?? {}) as Partial<Reserva> & { reservado?: boolean; motivo?: string | null };
        if (sc.reservado !== true || typeof sc.reserva !== 'string') {
          return { tipo: 'falhou', motivo: 'resposta', mensagem: `O servidor de reservas nao confirmou a reserva${sc.motivo ? ` (${sc.motivo})` : ''}.` };
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
      case 'input_required':
        // Passo 10: sem ponte. Nada é respondido ao servidor e nada do
        // requestState é guardado. O Passo 11 troca isto por INPUT_REQUIRED.
        return { tipo: 'falhou', motivo: 'conflito', mensagem: MENSAGEM_DE_CONFLITO };
      case 'erro_protocolo':
        return { tipo: 'falhou', motivo: 'protocolo', mensagem: `Erro de protocolo no servidor de reservas (codigo ${r.codigo ?? '-'}).` };
      case 'falha_transporte':
        void this.conexao.descartar();
        return { tipo: 'falhou', motivo: 'transporte', mensagem: MENSAGEM_SEM_MCP };
      case 'resposta_invalida':
        return { tipo: 'falhou', motivo: 'uso', mensagem: 'Resposta invalida para o servidor de reservas.' };
    }
  }

  #falhaInesperada(e: unknown): Desfecho {
    if (e instanceof ErroMcp && e.categoria === 'transporte') {
      void this.conexao.descartar();
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
    this.registrar(`[a2a] falha inesperada: ${e instanceof Error ? e.message : String(e)}`);
    return { tipo: 'falhou', motivo: 'resposta', mensagem: 'Falha inesperada ao falar com o servidor de reservas.' };
  }
}
