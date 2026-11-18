// Contexto de continuação de uma operação interrompida (input_required).
//
// É um objeto de DADOS, autossuficiente e serializável em JSON: tudo o que é
// preciso para o retry, sem depender de conexão aberta, de variável global
// ou do processo que o criou. No Passo 10, o gerenciador de Tasks A2A vai
// guardá-lo junto da Task (e nunca devolvê-lo ao cliente A2A).
//
// O requestState vai aqui DENTRO, intacto e opaco. Para log, use resumir().
import type { PedidoDeEntrada } from '../mcp/mrtr.ts';

export interface Continuacao {
  readonly formato: 1;
  /** Operação lógica que criou a continuação (ContextoDeExecucao.operacao), se houver. */
  readonly operacao: string | undefined;
  /** Tool chamada e argumentos ORIGINAIS: o retry repete os dois exatamente. */
  readonly ferramenta: string;
  readonly argumentos: Readonly<Record<string, unknown>>;
  /** O que o servidor perguntou: chave, schema, opções (lido de inputRequests). */
  readonly pedidos: readonly PedidoDeEntrada[];
  /** Estado opaco do servidor, exatamente como veio. O Host não o lê. */
  readonly requestState: string | undefined;
  /** traceparent da operação, para o retry continuar no mesmo trace mesmo se quem retoma não o reenviar. */
  readonly traceparent: string | undefined;
  /** 1 na primeira pausa; soma 1 se um retry gerar nova pausa (sala escolhida ocupada nesse meio tempo). */
  readonly rodada: number;
}

export function criarContinuacao(dados: Omit<Continuacao, 'formato'>): Continuacao {
  // Cópia profunda e congelada: a continuação de uma operação não pode ser
  // alterada por quem a recebeu, nem compartilhar objetos com outra.
  const copia = structuredClone({ formato: 1 as const, ...dados });
  return Object.freeze({ ...copia, argumentos: Object.freeze(copia.argumentos), pedidos: Object.freeze(copia.pedidos) });
}

/** Versão para log/tela: tudo, menos o conteúdo do requestState. */
export function resumir(c: Continuacao): Record<string, unknown> {
  return {
    operacao: c.operacao,
    ferramenta: c.ferramenta,
    argumentos: c.argumentos,
    rodada: c.rodada,
    pedidos: c.pedidos.map((p) => ({ chave: p.chave, metodo: p.metodo, modo: p.modo, opcoes: p.campos.find((x) => x.opcoes)?.opcoes })),
    requestState: c.requestState === undefined ? undefined : `<opaco, ${c.requestState.length} caracteres>`,
  };
}
