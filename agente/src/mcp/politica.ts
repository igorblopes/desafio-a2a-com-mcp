// A política de uso é um Resource: o cliente a LÊ por URI (resources/read),
// sem argumentos e sem efeito colateral. Aqui só se extrai a versão.

export const URI_DA_POLITICA = 'politica://uso';

/**
 * Versão declarada na primeira linha: "versao: AAAA-MM-DD".
 * Aceita \n e \r\n (no Windows o arquivo do servidor fica em CRLF).
 * Devolve undefined se a primeira linha não tiver esse formato.
 */
export function extrairVersao(texto: string): string | undefined {
  const primeira = texto.split(/\r?\n/, 1)[0] ?? '';
  return /^versao:\s*(\S+)\s*$/.exec(primeira)?.[1];
}
