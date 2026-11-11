// MRTR (multi round-trip request) do lado do cliente, em modo MANUAL.
//
// Quando um tools/call volta com resultType "input_required", o resultado traz:
//   inputRequests  { <chave escolhida pelo servidor>: { method, params } }
//   requestState   string opaca, assinada pelo servidor
//
// O cliente: (1) lê os pedidos, (2) mostra ao usuário, (3) valida a resposta
// contra o requestedSchema recebido, (4) monta inputResponses com a MESMA
// chave e (5) refaz o tools/call num request novo, ecoando o requestState
// byte a byte. Nada aqui decodifica, altera ou valida o requestState: a
// integridade e a interpretação são do servidor.
import type { InputRequiredResult } from '@modelcontextprotocol/client';
import { ErroDeUso } from './erros.ts';

export interface CampoDeFormulario {
  nome: string;
  tipo: string | undefined;
  titulo: string | undefined;
  obrigatorio: boolean;
  /** Valores permitidos (enum), quando o schema restringe. */
  opcoes: string[] | undefined;
}

export interface PedidoDeEntrada {
  /** Chave de inputRequests, atribuída pelo servidor. É devolvida igual em inputResponses. */
  chave: string;
  metodo: string;
  /** true só para elicitation/create em form mode: o único tipo que este cliente sabe responder. */
  suportado: boolean;
  modo: string | undefined;
  mensagem: string | undefined;
  requestedSchema: Record<string, unknown> | undefined;
  campos: CampoDeFormulario[];
}

export type RespostaDeEntrada =
  | { action: 'accept'; content: Record<string, string | number | boolean> }
  | { action: 'decline' }
  | { action: 'cancel' };

export type RespostasDeEntrada = Record<string, RespostaDeEntrada>;

/** O que vai em params (fora de arguments) no retry. */
export interface Continuacao {
  inputResponses: RespostasDeEntrada;
  requestState: string | undefined;
}

type Objeto = Record<string, unknown>;
const objeto = (v: unknown): v is Objeto => typeof v === 'object' && v !== null && !Array.isArray(v);

function campos(schema: Objeto | undefined): CampoDeFormulario[] {
  const props = objeto(schema?.properties) ? schema.properties : {};
  const obrigatorios = Array.isArray(schema?.required) ? (schema.required as unknown[]) : [];
  return Object.entries(props).map(([nome, def]) => {
    const d = objeto(def) ? def : {};
    return {
      nome,
      tipo: typeof d.type === 'string' ? d.type : undefined,
      titulo: typeof d.title === 'string' ? d.title : undefined,
      obrigatorio: obrigatorios.includes(nome),
      opcoes: Array.isArray(d.enum) ? d.enum.map(String) : undefined,
    };
  });
}

export function lerPedidos(resultado: InputRequiredResult): PedidoDeEntrada[] {
  return Object.entries(resultado.inputRequests ?? {}).map(([chave, pedido]) => {
    const p = pedido as { method?: unknown; params?: unknown };
    const params = objeto(p.params) ? p.params : {};
    const metodo = typeof p.method === 'string' ? p.method : '';
    // form é o modo padrão de elicitation quando o servidor não declara mode.
    const modo = typeof params.mode === 'string' ? params.mode : metodo === 'elicitation/create' ? 'form' : undefined;
    const schema = objeto(params.requestedSchema) ? params.requestedSchema : undefined;
    return {
      chave,
      metodo,
      suportado: metodo === 'elicitation/create' && modo === 'form',
      modo,
      mensagem: typeof params.message === 'string' ? params.message : undefined,
      requestedSchema: schema,
      campos: campos(schema),
    };
  });
}

/**
 * Confere `conteudo` contra o formulário pedido: campos obrigatórios,
 * campos desconhecidos, tipo primitivo e enum. Devolve a lista de problemas
 * (vazia = válido). É conformidade de protocolo, não regra de domínio: quem
 * decide se a sala serve continua sendo o servidor.
 */
export function problemasDoConteudo(pedido: PedidoDeEntrada, conteudo: Objeto): string[] {
  const problemas: string[] = [];
  const conhecidos = new Map(pedido.campos.map((c) => [c.nome, c]));
  for (const nome of Object.keys(conteudo)) {
    if (!conhecidos.has(nome)) problemas.push(`campo não pedido: ${nome}`);
  }
  for (const campo of pedido.campos) {
    const valor = conteudo[campo.nome];
    if (valor === undefined) {
      if (campo.obrigatorio) problemas.push(`campo obrigatório ausente: ${campo.nome}`);
      continue;
    }
    const tipo = campo.tipo === 'integer' ? 'number' : campo.tipo;
    if (tipo && typeof valor !== tipo) problemas.push(`${campo.nome} deve ser ${campo.tipo}`);
    if (campo.opcoes && !campo.opcoes.includes(String(valor))) {
      problemas.push(`${campo.nome} fora das opções: ${campo.opcoes.join(', ')}`);
    }
  }
  return problemas;
}

function exigirSuportado(pedido: PedidoDeEntrada): void {
  if (!pedido.suportado) {
    throw new ErroDeUso(`pedido '${pedido.chave}' não suportado: ${pedido.metodo} modo=${pedido.modo ?? '-'}`);
  }
}

export function aceitar(pedido: PedidoDeEntrada, conteudo: Record<string, string | number | boolean>): RespostaDeEntrada {
  exigirSuportado(pedido);
  const problemas = problemasDoConteudo(pedido, conteudo);
  if (problemas.length) throw new ErroDeUso(`resposta inválida para '${pedido.chave}': ${problemas.join('; ')}`);
  return { action: 'accept', content: conteudo };
}

export const recusar = (): RespostaDeEntrada => ({ action: 'decline' });
export const cancelar = (): RespostaDeEntrada => ({ action: 'cancel' });

/**
 * Junta as respostas ao requestState recebido. Exige uma resposta para cada
 * chave pedida e nenhuma chave a mais. O requestState segue intacto.
 */
export function continuacao(pedidos: PedidoDeEntrada[], requestState: string | undefined, respostas: RespostasDeEntrada): Continuacao {
  const pedidas = new Set(pedidos.map((p) => p.chave));
  const faltando = [...pedidas].filter((k) => !(k in respostas));
  const sobrando = Object.keys(respostas).filter((k) => !pedidas.has(k));
  if (faltando.length || sobrando.length) {
    throw new ErroDeUso(`inputResponses não corresponde a inputRequests (faltando: ${faltando.join(',') || '-'}; sobrando: ${sobrando.join(',') || '-'})`);
  }
  return { inputResponses: respostas, requestState };
}
