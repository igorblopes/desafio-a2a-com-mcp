// Log em uma linha no stderr. Não usamos o logging do protocolo MCP
// (notifications/message): o enunciado pede stderr, e o stdout fica livre.

type Campos = Record<string, string | number | boolean | null | undefined>;

function formatar(valor: Campos[string]): string {
  if (valor === undefined || valor === null || valor === '') return '-';
  const texto = String(valor);
  return /\s/.test(texto) ? JSON.stringify(texto) : texto;
}

export function log(evento: string, campos: Campos = {}): void {
  const pares = Object.entries(campos).map(([k, v]) => `${k}=${formatar(v)}`);
  process.stderr.write(`[mcp] ${evento}${pares.length ? ' ' + pares.join(' ') : ''}\n`);
}
