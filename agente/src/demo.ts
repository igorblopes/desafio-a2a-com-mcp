// Demonstração de terminal do Host MCP (Passos 8 e 9). Não é o agente A2A:
// aqui quem decide a resposta da elicitation é a pessoa no teclado (ou
// --escolha/--recusar/--cancelar). O script só CONSOME o Host: não fala MCP
// diretamente, não monta request nem guarda requestState.
//
//   npm run demo                                   reserva simples (sala-aquario, 24/11 10h–11h)
//   npm run demo -- --exemplo conflito             garagem 03/11 14h–15h (ocupada) → pergunta a alternativa
//   npm run demo -- --exemplo conflito --escolha sala-fusca
//   npm run demo -- --exemplo conflito --recusar   (ou --cancelar)
//   npm run demo -- --sala X --inicio ISO --fim ISO --responsavel Nome
//   ... --traceparent 00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01
//
// MCP_URL troca o endpoint (padrão http://localhost:7301/mcp).
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';
import { lerConfig } from './config.ts';
import { HostMcp } from './host/host.ts';
import { resumir } from './host/continuacao.ts';
import type { ContextoDeExecucao } from './host/contexto.ts';
import type { ResultadoDaOperacao } from './host/resultado.ts';
import { ErroDeUso, ErroMcp } from './mcp/erros.ts';
import type { PedidoDeEntrada, RespostaDeEntrada } from './mcp/mrtr.ts';
import { fetchObservado } from './mcp/observacao.ts';
import { analisarTraceparent } from './trace.ts';

const EXEMPLOS = {
  simples: { sala: 'sala-aquario', inicio: '2026-11-24T10:00:00-03:00', fim: '2026-11-24T11:00:00-03:00', responsavel: 'Igor' },
  conflito: { sala: 'sala-garagem', inicio: '2026-11-03T14:00:00-03:00', fim: '2026-11-03T15:00:00-03:00', responsavel: 'Marty' },
} as const;

const { values: a } = parseArgs({
  options: {
    exemplo: { type: 'string', default: 'simples' },
    sala: { type: 'string' },
    inicio: { type: 'string' },
    fim: { type: 'string' },
    responsavel: { type: 'string' },
    escolha: { type: 'string' },
    recusar: { type: 'boolean', default: false },
    cancelar: { type: 'boolean', default: false },
    traceparent: { type: 'string' },
  },
});

const exemplo = EXEMPLOS[a.exemplo as keyof typeof EXEMPLOS];
if (!exemplo) throw new Error(`--exemplo deve ser ${Object.keys(EXEMPLOS).join(' ou ')}`);
const pedido = {
  sala: a.sala ?? exemplo.sala,
  inicio: a.inicio ?? exemplo.inicio,
  fim: a.fim ?? exemplo.fim,
  responsavel: a.responsavel ?? exemplo.responsavel,
};
if (a.traceparent && !analisarTraceparent(a.traceparent)) throw new Error(`--traceparent inválido: ${a.traceparent}`);
const respostaPorArgumento = a.escolha !== undefined || a.recusar || a.cancelar;

// Contexto desta operação: um id lógico (no A2A será o taskId) e o trace, se informado.
const ctx: ContextoDeExecucao = { operacao: `demo-${randomUUID().slice(0, 8)}`, ...(a.traceparent ? { traceparent: a.traceparent } : {}) };

const titulo = (t: string) => console.log(`\n== ${t}`);

// Iterador de linhas (e não rl.question): funciona também com a entrada vinda de um pipe.
let linhas: AsyncIterator<string> | undefined;
let rl: ReturnType<typeof createInterface> | undefined;
async function lerLinha(prompt: string): Promise<string> {
  rl ??= createInterface({ input: process.stdin });
  linhas ??= rl[Symbol.asyncIterator]();
  process.stdout.write(prompt);
  const lida = await linhas.next();
  if (lida.done) throw new ErroDeUso('entrada encerrada sem uma escolha');
  const linha = String(lida.value).trim();
  console.log(linha);
  return linha;
}

/** A DECISÃO, fora do Host: argumento de linha de comando ou teclado. A validação fica com o Host. */
async function decidir(p: PedidoDeEntrada): Promise<RespostaDeEntrada> {
  if (a.recusar) return { action: 'decline' };
  if (a.cancelar) return { action: 'cancel' };
  const campo = p.campos.find((c) => c.opcoes) ?? p.campos[0];
  if (!campo) throw new ErroDeUso(`a demo não sabe responder ao pedido ${p.chave}`);
  if (a.escolha !== undefined) return { action: 'accept', content: { [campo.nome]: a.escolha } };
  campo.opcoes?.forEach((o, i) => console.log(`   ${i + 1}) ${o}`));
  const linha = await lerLinha(`   Escolha ${campo.opcoes ? `1-${campo.opcoes.length}` : campo.nome}, r = recusar, c = cancelar: `);
  if (linha === 'r') return { action: 'decline' };
  if (linha === 'c') return { action: 'cancel' };
  return { action: 'accept', content: { [campo.nome]: campo.opcoes?.[Number(linha) - 1] ?? linha } };
}

function mostrar(r: ResultadoDaOperacao): void {
  console.log(`   tipo=${r.tipo} operacao=${r.operacao}`);
  switch (r.tipo) {
    case 'completo':
      console.log(JSON.stringify(r.estruturado, null, 2).replace(/^/gm, '   '));
      break;
    case 'erro_execucao':
      console.log(`   isError: ${r.mensagem}`);
      break;
    case 'erro_protocolo':
    case 'falha_transporte':
      console.log(`   código=${r.codigo ?? '-'}: ${r.mensagem}`);
      break;
    case 'resposta_invalida':
      console.log(`   nada foi enviado: ${r.problemas.join('; ')}`);
      break;
    case 'input_required':
      for (const p of r.continuacao.pedidos) {
        console.log(`   chave=${p.chave} método=${p.metodo} modo=${p.modo}`);
        console.log(`   mensagem: ${p.mensagem}`);
        for (const c of p.campos) console.log(`   campo ${c.nome} (${c.tipo}${c.obrigatorio ? ', obrigatório' : ''}) opções: ${c.opcoes?.join(', ') ?? '-'}`);
      }
      console.log(`   continuação: ${JSON.stringify(resumir(r.continuacao))}`);
      break;
  }
}

let host: HostMcp | undefined;
try {
  console.log(`MCP: ${lerConfig().url.href}  operação: ${ctx.operacao}  ${ctx.traceparent ? `trace-id: ${analisarTraceparent(ctx.traceparent)!.traceId}` : '(sem traceparent)'}`);

  titulo('1. Iniciar o Host (server/discover + tools/list)');
  host = await HostMcp.iniciar(
    {
      url: lerConfig().url,
      timeoutMs: lerConfig().timeoutMs,
      // Mostra cada request no fio: id JSON-RPC, método, headers espelho e traceparent.
      fetch: fetchObservado((r) => {
        const tp = (r.params?._meta as Record<string, unknown> | undefined)?.traceparent ?? '-';
        console.log(`   → id=${JSON.stringify(r.id)} ${r.metodo} Mcp-Method=${r.headers['mcp-method']} Mcp-Name=${r.headers['mcp-name'] ?? '-'} MCP-Protocol-Version=${r.headers['mcp-protocol-version']} traceparent=${tp} http=${r.status}`);
      }),
    },
    ctx,
  );
  for (const t of host.ferramentas()) {
    console.log(`   catálogo: ${t.name}(${Object.keys(t.inputSchema.properties ?? {}).join(', ')})${t.outputSchema ? ' → outputSchema' : ''}`);
  }

  titulo('2. Política (resources/read politica://uso)');
  const politica = await host.lerPolitica(ctx);
  console.log(`   versão: ${politica.versao}  origem: ${politica.origem.uri} (${politica.origem.mimeType}, servidor ${politica.origem.servidor?.name ?? '-'})`);

  titulo(`3. executar reservar_sala ${JSON.stringify(pedido)}`);
  let resultado = await host.executar('reservar_sala', pedido, ctx);
  mostrar(resultado);

  let passo = 4;
  while (resultado.tipo === 'input_required' || resultado.tipo === 'resposta_invalida') {
    if (resultado.tipo === 'resposta_invalida' && respostaPorArgumento) break;
    const continuacao = resultado.continuacao;
    const respostas: Record<string, RespostaDeEntrada> = {};
    for (const p of continuacao.pedidos) respostas[p.chave] = await decidir(p);
    titulo(`${passo++}. host.continuar com inputResponses=${JSON.stringify(respostas)}`);
    resultado = await host.continuar(continuacao, respostas, ctx);
    mostrar(resultado);
    if (resultado.tipo === 'input_required' && respostaPorArgumento) {
      console.log('   o servidor perguntou de novo (a sala escolhida foi ocupada nesse meio tempo)');
      break;
    }
  }
  if (resultado.tipo === 'completo') {
    const sc = resultado.estruturado as { politica?: string };
    if (sc.politica && sc.politica !== politica.versao) console.log(`   ATENÇÃO: versão no resultado (${sc.politica}) ≠ versão lida (${politica.versao})`);
  }
  process.exitCode = resultado.tipo === 'completo' ? 0 : resultado.tipo === 'erro_execucao' ? 1 : 2;
} catch (e) {
  if (e instanceof ErroMcp) console.error(`ErroMcp categoria=${e.categoria} código=${e.codigo ?? '-'}: ${e.message}`);
  else if (e instanceof ErroDeUso) console.error(`ErroDeUso (nada foi enviado): ${e.message}`);
  else console.error(e);
  process.exitCode = 2;
} finally {
  rl?.close();
  await host?.encerrar();
}
