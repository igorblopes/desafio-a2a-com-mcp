// Ponte MCP/A2A vista DO FIO MCP: o ServicoDeReserva (a peça que o executor
// usa) contra o servidor MCP REAL, com o fetch observado. Aqui se confere o
// que o teste HTTP do agente não enxerga: o corpo exato do retry
// (inputResponses na chave original, requestState byte a byte, argumentos
// originais, id JSON-RPC novo, traceparent da Task).
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { ConexaoMcp, MENSAGEM_DE_RECUSA, ServicoDeReserva, type Desfecho } from '../src/a2a/reserva.ts';
import type { Pendente } from '../src/a2a/tarefas/retomadas.ts';
import { fetchObservado, type RequestObservado } from '../src/mcp/observacao.ts';
import { novoTraceparent, subirServidor, type ServidorDeTeste } from './apoio.ts';

let mcp: ServidorDeTeste;
let fio: RequestObservado[];
let servico: ServicoDeReserva;
let conexao: ConexaoMcp;

before(async () => {
  mcp = await subirServidor();
  fio = [];
  conexao = new ConexaoMcp({ url: mcp.url, fetch: fetchObservado((r) => fio.push(r)) });
  servico = new ServicoDeReserva(conexao, () => {});
});
after(async () => {
  await conexao?.descartar();
  await mcp?.parar();
});

const em = (dia: string, hora: string) => `2026-12-${dia}T${hora}:00-03:00`;
const pedido = (sala: string, dia: string, hi: string, hf: string, responsavel: string) => ({ sala, inicio: em(dia, hi), fim: em(dia, hf), responsavel });
const chamadas = () => fio.filter((r) => r.metodo === 'tools/call');
function pausada(d: Desfecho): Pendente {
  assert.equal(d.tipo, 'pausada', JSON.stringify(d));
  return (d as { pendente: Pendente }).pendente;
}

/** Ocupa a sala e pede o mesmo intervalo de novo: o servidor responde input_required. */
async function pausar(sala: string, dia: string, hi: string, hf: string, responsavel: string, traceparent?: string) {
  const ocupar = await servico.reservar(pedido(sala, dia, hi, hf, 'Ocupante'), { operacao: `ocupa-${responsavel}` });
  assert.equal(ocupar.tipo, 'concluida');
  const operacao = `task-${responsavel}`;
  const p = pausada(await servico.reservar(pedido(sala, dia, hi, hf, responsavel), { operacao, traceparent }));
  return { p, operacao, inicial: chamadas().at(-1)! };
}

describe('pausa', () => {
  test('input_required vira "pausada" com a pergunta do formulário e o requestState guardado, sem resposta automática', async () => {
    const antes = chamadas().length;
    const { p, inicial } = await pausar('sala-garagem', '01', '10:00', '11:00', 'Marty');
    assert.equal(chamadas().length, antes + 2, 'só a reserva que ocupa e a que pausa; nenhum retry automático');
    assert.equal(inicial.params!.inputResponses, undefined);
    assert.equal(p.campo, 'sala');
    assert.ok(p.alternativas.length >= 1);
    assert.equal(p.mensagem, `alternativas: ${p.alternativas.join(', ')}`);
    assert.match(p.continuacao.requestState ?? '', /^v1\./, 'o requestState do servidor, intacto');
    assert.equal(p.politica, '2026-11-01');
    assert.equal(p.continuacao.pedidos.length, 1);
  });
});

describe('retomada', () => {
  test('accept: retry com id novo, argumentos originais, chave original e requestState byte a byte', async () => {
    const { traceparent, traceId } = novoTraceparent();
    const { p, operacao, inicial } = await pausar('sala-garagem', '02', '10:00', '11:00', 'Lorraine', traceparent);
    const escolhida = p.alternativas[0]!;
    const d = await servico.retomar(p, { action: 'accept', content: { sala: escolhida } }, { operacao, traceparent });
    assert.equal(d.tipo, 'concluida', JSON.stringify(d));
    const retry = chamadas().at(-1)!;
    assert.notEqual(retry.id, inicial.id, 'id JSON-RPC novo');
    assert.deepEqual(retry.params!.arguments, inicial.params!.arguments, 'argumentos originais, não reconstruídos');
    assert.deepEqual(Object.keys(retry.params!.inputResponses as object), [p.continuacao.pedidos[0]!.chave], 'mesma chave de inputRequests');
    assert.deepEqual(retry.params!.inputResponses, { [p.continuacao.pedidos[0]!.chave]: { action: 'accept', content: { sala: escolhida } } });
    assert.equal(retry.params!.requestState, p.continuacao.requestState, 'requestState sem alteração');
    assert.ok(!('inputResponses' in (retry.params!.arguments as object)) && !('requestState' in (retry.params!.arguments as object)), 'nada disso dentro de arguments');
    assert.ok(String((retry.params!._meta as Record<string, unknown>).traceparent).includes(traceId), 'mesmo trace da Task');
    const r = (d as unknown as { reserva: Record<string, string> }).reserva;
    assert.deepEqual([r.sala, r.inicio, r.fim, r.responsavel, r.politica], [escolhida, em('02', '10:00'), em('02', '11:00'), 'Lorraine', '2026-11-01']);
  });

  test('decline: { action: decline } e desfecho "recusada", sem reserva', async () => {
    const { p, operacao } = await pausar('sala-garagem', '03', '10:00', '11:00', 'Biff');
    const d = await servico.retomar(p, { action: 'decline' }, { operacao });
    assert.deepEqual(d, { tipo: 'recusada', mensagem: MENSAGEM_DE_RECUSA });
    const retry = chamadas().at(-1)!;
    assert.deepEqual(retry.params!.inputResponses, { [p.continuacao.pedidos[0]!.chave]: { action: 'decline' } });
    assert.equal(retry.params!.requestState, p.continuacao.requestState);
  });

  test('duas pausas ao mesmo tempo: cada retry leva o próprio requestState e os próprios argumentos', async () => {
    const a = await pausar('sala-garagem', '04', '10:00', '11:00', 'George');
    const b = await pausar('sala-garagem', '04', '14:00', '15:00', 'Jennifer');
    assert.notEqual(a.p.continuacao.requestState, b.p.continuacao.requestState);
    // retoma B primeiro
    const db = await servico.retomar(b.p, { action: 'accept', content: { sala: b.p.alternativas[0]! } }, { operacao: b.operacao });
    const rb = chamadas().at(-1)!;
    const da = await servico.retomar(a.p, { action: 'accept', content: { sala: a.p.alternativas[0]! } }, { operacao: a.operacao });
    const ra = chamadas().at(-1)!;
    assert.equal(rb.params!.requestState, b.p.continuacao.requestState);
    assert.equal(ra.params!.requestState, a.p.continuacao.requestState);
    assert.equal((rb.params!.arguments as Record<string, string>).responsavel, 'Jennifer');
    assert.equal((ra.params!.arguments as Record<string, string>).responsavel, 'George');
    const [xa, xb] = [da, db].map((d) => (d as unknown as { reserva: Record<string, string> }).reserva);
    assert.deepEqual([xa!.responsavel, xa!.inicio, xb!.responsavel, xb!.inicio], ['George', em('04', '10:00'), 'Jennifer', em('04', '14:00')]);
    assert.notEqual(xa!.reserva, xb!.reserva);
  });
});
