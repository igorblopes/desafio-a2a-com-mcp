// Demonstração de terminal do cliente MCP (Passo 8). Não é o agente A2A:
// aqui a "escolha do usuário" vem do teclado (ou de --escolha/--recusar/--cancelar).
//
//   npm run demo                                   reserva simples (sala-aquario, 24/11 10h–11h)
//   npm run demo -- --exemplo conflito             garagem 03/11 14h–15h (ocupada) → pergunta a alternativa
//   npm run demo -- --exemplo conflito --escolha sala-fusca
//   npm run demo -- --exemplo conflito --recusar   (ou --cancelar)
//   npm run demo -- --sala X --inicio ISO --fim ISO --responsavel Nome
//   ... --traceparent 00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01
//
// MCP_URL troca o endpoint (padrão http://localhost:7301/mcp).
import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';
import { lerConfig } from './config.ts';
import { ClienteMcp } from './mcp/cliente.ts';
import { ErroDeUso, ErroMcp } from './mcp/erros.ts';
import { aceitar, cancelar, recusar, type PedidoDeEntrada, type RespostaDeEntrada } from './mcp/mrtr.ts';
import { fetchObservado } from './mcp/observacao.ts';
import type { ResultadoDaTool } from './mcp/resultado.ts';
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
const op = a.traceparent ? { traceparent: a.traceparent } : {};

const titulo = (t: string) => console.log(`\n== ${t}`);
const curto = (v: string) => (v.length > 24 ? `${v.slice(0, 12)}…(${v.length} caracteres)` : v);

const { url } = lerConfig();
let cliente: ClienteMcp | undefined;

async function perguntar(p: PedidoDeEntrada): Promise<RespostaDeEntrada> {
  const campo = p.campos.find((c) => c.opcoes);
  if (a.recusar) return recusar();
  if (a.cancelar) return cancelar();
  if (!campo) throw new ErroDeUso(`a demo só sabe responder formulários com um campo enum (chave ${p.chave})`);
  if (a.escolha) return aceitar(p, { [campo.nome]: a.escolha });
  // Iterador de linhas (e não rl.question): funciona também com a entrada vinda de um pipe.
  const rl = createInterface({ input: process.stdin });
  const linhas = rl[Symbol.asyncIterator]();
  try {
    for (;;) {
      campo.opcoes!.forEach((o, i) => console.log(`   ${i + 1}) ${o}`));
      process.stdout.write(`   Escolha 1-${campo.opcoes!.length}, r = recusar, c = cancelar: `);
      const lida = await linhas.next();
      if (lida.done) throw new ErroDeUso('entrada encerrada sem uma escolha');
      const linha = String(lida.value).trim();
      console.log(linha);
      if (linha === 'r') return recusar();
      if (linha === 'c') return cancelar();
      const valor = campo.opcoes![Number(linha) - 1] ?? linha;
      try {
        return aceitar(p, { [campo.nome]: valor });
      } catch (e) {
        console.log(`   ${(e as Error).message}`);
      }
    }
  } finally {
    rl.close();
  }
}

function mostrar(r: ResultadoDaTool): void {
  console.log(`   tipo=${r.tipo}`);
  if (r.tipo === 'completo') console.log(JSON.stringify(r.estruturado, null, 2).replace(/^/gm, '   '));
  if (r.tipo === 'erro_execucao') console.log(`   isError: ${r.mensagem}`);
}

try {
  cliente = await ClienteMcp.conectar({
    url,
    // Mostra cada request no fio: id JSON-RPC, método, headers espelho e traceparent.
    fetch: fetchObservado((r) => {
      const tp = (r.params?._meta as Record<string, unknown> | undefined)?.traceparent ?? '-';
      console.log(`   → id=${JSON.stringify(r.id)} ${r.metodo} Mcp-Method=${r.headers['mcp-method']} Mcp-Name=${r.headers['mcp-name'] ?? '-'} MCP-Protocol-Version=${r.headers['mcp-protocol-version']} traceparent=${tp} http=${r.status}`);
    }),
  });

  console.log(`MCP: ${url.href}${a.traceparent ? `  trace-id: ${analisarTraceparent(a.traceparent)!.traceId}` : '  (sem traceparent)'}`);

  titulo('1. Descoberta (tools/list)');
  for (const t of await cliente.descobrir(op)) {
    console.log(`   ${t.name}(${Object.keys(t.inputSchema.properties ?? {}).join(', ')})${t.outputSchema ? ' → outputSchema' : ''}`);
  }

  titulo('2. Política (resources/read politica://uso)');
  const politica = await cliente.lerPolitica(op);
  console.log(`   versão extraída: ${politica.versao}  (${politica.texto.length} caracteres de Markdown preservados)`);

  titulo(`3. tools/call reservar_sala ${JSON.stringify(pedido)}`);
  let resultado = await cliente.chamarTool('reservar_sala', pedido, op);
  mostrar(resultado);

  while (resultado.tipo === 'input_required') {
    const pausa = resultado;
    titulo('4. input_required');
    for (const p of pausa.pedidos) {
      console.log(`   chave=${p.chave} método=${p.metodo} modo=${p.modo}`);
      console.log(`   mensagem: ${p.mensagem}`);
      for (const c of p.campos) console.log(`   campo ${c.nome} (${c.tipo}${c.obrigatorio ? ', obrigatório' : ''}) opções: ${c.opcoes?.join(', ') ?? '-'}`);
    }
    console.log(`   requestState: ${pausa.requestState ? curto(pausa.requestState) : '-'} (opaco: guardado e reenviado sem leitura)`);
    const respostas: Record<string, RespostaDeEntrada> = {};
    for (const p of pausa.pedidos) respostas[p.chave] = await perguntar(p);
    titulo(`5. Retry (tools/call novo) inputResponses=${JSON.stringify(respostas)}`);
    resultado = await cliente.continuar(pausa, respostas, op);
    mostrar(resultado);
    if (resultado.tipo === 'input_required' && (a.escolha || a.recusar || a.cancelar)) {
      console.log('   o servidor perguntou de novo (a sala escolhida foi ocupada nesse meio tempo)');
      break;
    }
  }
  if (resultado.tipo === 'completo') {
    const sc = resultado.estruturado as { politica?: string };
    if (sc.politica && sc.politica !== politica.versao) console.log(`   ATENÇÃO: versão no resultado (${sc.politica}) ≠ versão lida (${politica.versao})`);
  }
  process.exitCode = resultado.tipo === 'completo' ? 0 : 1;
} catch (e) {
  if (e instanceof ErroMcp) console.error(`ErroMcp categoria=${e.categoria} código=${e.codigo ?? '-'}: ${e.message}`);
  else if (e instanceof ErroDeUso) console.error(`ErroDeUso (nada foi enviado): ${e.message}`);
  else console.error(e);
  process.exitCode = 2;
} finally {
  await cliente?.fechar();
}
