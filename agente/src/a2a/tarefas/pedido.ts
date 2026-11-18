// Parser do pedido em texto fixo do contrato:
//   reservar sala=<id> inicio=<iso8601> fim=<iso8601> responsavel=<nome>
//
// Determinístico (regex), sem LLM. Só separa os campos: não confere se a
// sala existe, se o horário é válido nem nada de regra de domínio. Isso é do
// servidor MCP, que devolve a mensagem certa (ex.: "Sala inexistente: x").
// `responsavel` pode ter espaços: vai até a próxima chave ou o fim.

export interface PedidoDeReserva {
  sala: string;
  inicio: string;
  fim: string;
  responsavel: string;
}

const CAMPOS = ['sala', 'inicio', 'fim', 'responsavel'] as const;
export const FORMATO_DO_PEDIDO = 'reservar sala=<id> inicio=<iso8601> fim=<iso8601> responsavel=<nome>';

export type Leitura = { ok: true; pedido: PedidoDeReserva } | { ok: false; erro: string };

export function lerPedido(texto: string): Leitura {
  const m = /^\s*reservar\s+(.+?)\s*$/s.exec(texto);
  if (!m) return { ok: false, erro: `Pedido não reconhecido. Formato: ${FORMATO_DO_PEDIDO}` };
  const valores = new Map<string, string>();
  for (const trecho of m[1]!.split(/\s+(?=[a-z]+=)/)) {
    const igual = trecho.indexOf('=');
    const chave = igual > 0 ? trecho.slice(0, igual) : trecho;
    const valor = igual > 0 ? trecho.slice(igual + 1).trim() : '';
    if (!(CAMPOS as readonly string[]).includes(chave)) return { ok: false, erro: `Campo desconhecido: ${chave}. Formato: ${FORMATO_DO_PEDIDO}` };
    if (valores.has(chave)) return { ok: false, erro: `Campo repetido: ${chave}` };
    if (!valor) return { ok: false, erro: `Campo vazio: ${chave}` };
    valores.set(chave, valor);
  }
  const faltando = CAMPOS.filter((c) => !valores.has(c));
  if (faltando.length) return { ok: false, erro: `Campos ausentes: ${faltando.join(', ')}. Formato: ${FORMATO_DO_PEDIDO}` };
  return { ok: true, pedido: { sala: valores.get('sala')!, inicio: valores.get('inicio')!, fim: valores.get('fim')!, responsavel: valores.get('responsavel')! } };
}
