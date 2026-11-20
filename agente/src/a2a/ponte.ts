// A ponte MCP ↔ A2A, na parte que é só TRADUÇÃO (funções puras, sem rede):
//
//   input_required (MCP)  →  o que perguntar ao cliente A2A
//     · a chave de inputRequests, o campo e as opções vêm do formulário que o
//       servidor mandou (requestedSchema.properties.sala.enum, ou const);
//     · a mensagem é exatamente "alternativas: a, b", na ordem do servidor.
//   texto do cliente A2A  →  resposta da elicitation (MCP)
//     · "escolha=<opção>"  → { action: accept, content: { sala: <opção> } }
//     · "escolha=recusar"  → { action: decline }
//     · qualquer outra coisa (ou opção fora da lista) → inválida: nada é enviado.
//
// Nada aqui decide QUAIS salas oferecer, nem lê o requestState: isso é do
// servidor MCP. A ponte só interpreta a estrutura do protocolo.
import type { Continuacao } from '../host/continuacao.ts';
import type { RespostaDeEntrada } from '../mcp/mrtr.ts';

/** Campo preferido do formulário de escolha (contrato: requestedSchema.properties.sala). */
const CAMPO_DA_SALA = 'sala';

export type Pergunta = { ok: true; campo: string; alternativas: string[]; mensagem: string } | { ok: false; motivo: string };

/** Lê da continuação o que perguntar. Exige uma única elicitation em form mode com um campo de opções. */
export function perguntaDe(c: Continuacao): Pergunta {
  if (c.pedidos.length !== 1) return { ok: false, motivo: `esperava 1 pedido em inputRequests, veio ${c.pedidos.length}` };
  const pedido = c.pedidos[0]!;
  if (!pedido.suportado) return { ok: false, motivo: `pedido nao suportado: ${pedido.metodo} modo=${pedido.modo ?? '-'}` };
  const comOpcoes = pedido.campos.filter((x) => x.opcoes && x.opcoes.length > 0);
  const campo = comOpcoes.find((x) => x.nome === CAMPO_DA_SALA) ?? (comOpcoes.length === 1 ? comOpcoes[0] : undefined);
  if (!campo) return { ok: false, motivo: 'o formulario nao traz um campo com alternativas' };
  const alternativas = [...campo.opcoes!];
  return { ok: true, campo: campo.nome, alternativas, mensagem: mensagemDeAlternativas(alternativas) };
}

/** "alternativas: sala-fusca, sala-mirante": formato estrito do contrato (verificação 28). */
export function mensagemDeAlternativas(alternativas: readonly string[]): string {
  return `alternativas: ${alternativas.join(', ')}`;
}

export const RECUSA = 'recusar';

export type Escolha = { tipo: 'aceitar'; resposta: RespostaDeEntrada; valor: string } | { tipo: 'recusar'; resposta: RespostaDeEntrada } | { tipo: 'invalida'; motivo: string };

/** Traduz o texto do cliente em resposta da elicitation, validando contra as opções recebidas (sem chamar o MCP). */
export function lerEscolha(texto: string, campo: string, alternativas: readonly string[]): Escolha {
  const m = /^\s*escolha\s*=\s*(\S+)\s*$/.exec(texto);
  if (!m) return { tipo: 'invalida', motivo: 'texto fora do formato escolha=<sala>' };
  const valor = m[1]!;
  if (valor === RECUSA) return { tipo: 'recusar', resposta: { action: 'decline' } };
  if (!alternativas.includes(valor)) return { tipo: 'invalida', motivo: `"${valor}" nao esta entre as alternativas` };
  return { tipo: 'aceitar', valor, resposta: { action: 'accept', content: { [campo]: valor } } };
}
