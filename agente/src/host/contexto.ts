// Contexto de execução: o que a camada chamadora (terminal hoje, A2A amanhã)
// diz ao Host sobre a operação em curso. Viaja como ARGUMENTO de cada chamada;
// o Host não guarda "a operação atual" em lugar nenhum.
//
// Não é uma Task A2A e não é sessão MCP: é só o que o Host precisa para
// executar ou retomar uma chamada e para correlacionar logs.

export interface ContextoDeExecucao {
  /**
   * Identificador lógico da operação, dado por quem chama (no Passo 10, o
   * taskId). O Host só o carimba nos resultados e na continuação, e confere
   * que uma continuação é retomada pela mesma operação que a criou.
   */
  operacao?: string;
  /** traceparent W3C recebido de quem chama. Ausente = nenhum é enviado (nada é inventado). */
  traceparent?: string;
}
