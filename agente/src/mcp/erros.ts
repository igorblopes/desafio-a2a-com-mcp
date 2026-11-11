// Erros do cliente MCP. Resultados de tool (inclusive isError e
// input_required) NÃO passam por aqui: ver resultado.ts.
import { ProtocolError, SdkError, SdkErrorCode } from '@modelcontextprotocol/client';

/**
 * Falha de uma operação MCP que não é resultado de tool.
 *   jsonrpc     o servidor respondeu com `error` (code/message/data do JSON-RPC)
 *   transporte  não houve resposta MCP utilizável (conexão recusada, timeout, HTTP sem JSON-RPC)
 *   resposta    a resposta chegou mas não pôde ser usada (validação local do SDK ou contrato violado)
 */
export class ErroMcp extends Error {
  constructor(
    readonly categoria: 'jsonrpc' | 'transporte' | 'resposta',
    message: string,
    readonly codigo?: number | string,
    readonly dados?: unknown,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'ErroMcp';
  }
}

/** Erro de uso do cliente (bug de quem chama): nada foi enviado ao servidor. */
export class ErroDeUso extends Error {
  override name = 'ErroDeUso';
}

const CODIGOS_DE_TRANSPORTE = new Set<string>([
  SdkErrorCode.NotConnected,
  SdkErrorCode.ConnectionClosed,
  SdkErrorCode.SendFailed,
  SdkErrorCode.RequestTimeout,
]);

/** Procura, na cadeia de causas, uma falha de rede do fetch (conexão recusada, reset, DNS...). */
function falhaDeRede(erro: unknown): boolean {
  for (let atual = erro, n = 0; atual instanceof Error && n < 8; n++) {
    if (atual instanceof TypeError && atual.message === 'fetch failed') return true;
    const dados = (atual as { data?: { cause?: unknown } }).data;
    atual = atual.cause ?? dados?.cause;
  }
  return false;
}

export function traduzirErro(erro: unknown): unknown {
  if (erro instanceof ErroDeUso || erro instanceof ErroMcp) return erro;
  if (erro instanceof ProtocolError) {
    return new ErroMcp('jsonrpc', erro.message, erro.code, erro.data, { cause: erro });
  }
  if (erro instanceof SdkError) {
    const transporte = CODIGOS_DE_TRANSPORTE.has(erro.code) || 'status' in erro || falhaDeRede(erro);
    return new ErroMcp(transporte ? 'transporte' : 'resposta', erro.message, erro.code, erro.data, { cause: erro });
  }
  if (erro instanceof Error && falhaDeRede(erro)) {
    return new ErroMcp('transporte', erro.message, undefined, undefined, { cause: erro });
  }
  return erro;
}
