// Trace context W3C (https://www.w3.org/TR/trace-context/), só o necessário:
//   traceparent = <versão 2 hex>-<trace-id 32 hex>-<parent-id 16 hex>-<flags 2 hex>
//   ex.: 00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01
//
// trace-id: identifica a OPERAÇÃO inteira (a Task A2A, no futuro). Atravessa
//           todos os processos sem mudar.
// parent-id: identifica o span de QUEM fez a chamada. Cada salto cria o seu.
//
// O cliente nunca inventa um traceparent: se ninguém informou, nada é enviado.
import { randomBytes } from 'node:crypto';

const FORMATO = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;

export interface ContextoDeTrace {
  traceId: string;
  parentId: string;
  flags: string;
}

/** Valida e decompõe. Devolve null se o valor não for um traceparent W3C válido. */
export function analisarTraceparent(valor: string): ContextoDeTrace | null {
  const m = FORMATO.exec(valor.trim());
  if (!m) return null;
  const [, versao, traceId, parentId, flags] = m;
  if (versao === 'ff') return null; // versão proibida pela spec
  if (/^0+$/.test(traceId!) || /^0+$/.test(parentId!)) return null; // ids todos zero são inválidos
  return { traceId: traceId!, parentId: parentId!, flags: flags! };
}

/**
 * traceparent para UM request de saída: mesmo trace-id e mesmas flags,
 * parent-id novo (o span deste request). Assim o servidor vê de qual
 * operação veio a chamada, e cada request continua distinguível.
 */
export function traceparentFilho(valor: string): string {
  const ctx = analisarTraceparent(valor);
  if (!ctx) throw new TypeError(`traceparent inválido: ${JSON.stringify(valor)}`);
  let span: string;
  do span = randomBytes(8).toString('hex');
  while (/^0+$/.test(span));
  return `00-${ctx.traceId}-${span}-${ctx.flags}`;
}

export function traceIdDe(valor: string): string | undefined {
  return analisarTraceparent(valor)?.traceId;
}
