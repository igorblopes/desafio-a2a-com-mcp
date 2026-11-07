// Configuração do processo, lida uma única vez do ambiente.
// Nada aqui é segredo neste passo; REQUEST_STATE_SECRET entra no passo do MRTR.
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

export const config = {
  porta: porta(process.env.MCP_PORT, 7301),
  caminho: '/mcp',
  // Padrão: a pasta dados/ do starter, irmã de servidor-mcp/.
  dadosDir: path.resolve(raizDoPacote, process.env.DADOS_DIR ?? '../dados'),
} as const;
