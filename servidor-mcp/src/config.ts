// Configuração do processo, lida do ambiente.
// REQUEST_STATE_SECRET é o único segredo: nunca aparece em log, resposta ou
// mensagem de erro (os erros dizem o que está errado, nunca o valor).
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const raizDoPacote = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function porta(valor: string | undefined, padrao: number): number {
  if (valor === undefined || valor === '') return padrao;
  const n = Number(valor);
  if (!Number.isInteger(n) || n <= 0 || n > 65535) {
    throw new Error(`MCP_PORT inválida: ${valor}`);
  }
  return n;
}

function ttl(valor: string | undefined): number {
  if (valor === undefined || valor === '') return 900; // 15 minutos
  const n = Number(valor);
  if (!Number.isInteger(n) || n < 300 || n > 1800) {
    throw new Error(`REQUEST_STATE_TTL_SECONDS inválido: ${valor} (use um inteiro entre 300 e 1800)`);
  }
  return n;
}

/**
 * Chave HMAC do requestState, em bytes. Exige hex com pelo menos 64 dígitos
 * (= 32 bytes de aleatoriedade, o mínimo do SDK), como sai de
 *   python -c "import secrets; print(secrets.token_hex(32))"
 * Lida sob demanda (e não na importação) para que os testes unitários do
 * domínio não precisem do segredo; main.ts chama no boot para falhar cedo.
 */
export function segredoDoRequestState(env: NodeJS.ProcessEnv = process.env): Uint8Array {
  const valor = env.REQUEST_STATE_SECRET;
  const dica = 'gere com: python -c "import secrets; print(secrets.token_hex(32))"';
  if (valor === undefined || valor.trim() === '') {
    throw new Error(`REQUEST_STATE_SECRET não definida; ${dica}`);
  }
  const hex = valor.trim();
  if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length % 2 !== 0 || hex.length < 64) {
    // Só o tamanho entra na mensagem, nunca o conteúdo.
    throw new Error(`REQUEST_STATE_SECRET inválida: esperado hex com >= 64 dígitos (32 bytes), recebido ${hex.length} caracteres; ${dica}`);
  }
  return Uint8Array.from(Buffer.from(hex, 'hex'));
}

export const config = {
  porta: porta(process.env.MCP_PORT, 7301),
  caminho: '/mcp',
  // Padrão: a pasta dados/ do starter, irmã de servidor-mcp/.
  dadosDir: path.resolve(raizDoPacote, process.env.DADOS_DIR ?? '../dados'),
  // Validade de um requestState emitido (segundos).
  ttlDoRequestState: ttl(process.env.REQUEST_STATE_TTL_SECONDS),
} as const;
