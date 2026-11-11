// Testes de integração: cliente MCP × servidor MCP REAL, por HTTP, em dois
// processos. Cenários A–J do Passo 8 + protocolo (_meta, headers, ids).
//
// Um servidor novo para o arquivo; cada cenário que grava usa um DIA próprio
// (13 a 21/11/2026), para que um não mude a agenda do outro.
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ClienteMcp } from '../src/mcp/cliente.ts';
import { ErroDeUso, ErroMcp } from '../src/mcp/erros.ts';
import { aceitar, cancelar, recusar } from '../src/mcp/mrtr.ts';
import type { RequestObservado } from '../src/mcp/observacao.ts';
import type { ResultadoDaTool, ResultadoInputRequired } from '../src/mcp/resultado.ts';
import { analisarTraceparent } from '../src/trace.ts';
import { conectar, DIR_DO_SERVIDOR, em, logDoId, portaLivre, subirServidor, TRACE_ID, TRACEPARENT, type ServidorDeTeste } from './apoio.ts';

const PROTOCOLO = '2026-07-28';
const META_VERSAO = 'io.modelcontextprotocol/protocolVersion';
const META_CAPS = 'io.modelcontextprotocol/clientCapabilities';

let srv: ServidorDeTeste;
let cliente: ClienteMcp;
let fio: RequestObservado[];

before(async () => {
  srv = await subirServidor();
  ({ cliente, fio } = await conectar(srv.url));
  await cliente.descobrir();
});
after(async () => {
  await cliente?.fechar();
  await srv?.parar();
});

/** Requests enviados a partir de agora. */
function marcar(): () => RequestObservado[] {
  const inicio = fio.length;
  return () => fio.slice(inicio);
}

function completo(r: ResultadoDaTool): Record<string, unknown> {
  assert.equal(r.tipo, 'completo', JSON.stringify(r.bruto));
  return (r as Extract<ResultadoDaTool, { tipo: 'completo' }>).estruturado as Record<string, unknown>;
}

function pausa(r: ResultadoDaTool): ResultadoInputRequired {
  assert.equal(r.tipo, 'input_required', JSON.stringify(r.bruto));
  return r as ResultadoInputRequired;
}

/** Ocupa a garagem às 14h do dia e pede de novo: devolve o input_required. */
async function conflito(dia: string, op = {}): Promise<ResultadoInputRequired> {
  completo(await cliente.chamarTool('reservar_sala', { sala: 'sala-garagem', inicio: em(dia, '14:00'), fim: em(dia, '15:00'), responsavel: 'Ocupante' }));
  return pausa(await cliente.chamarTool('reservar_sala', { sala: 'sala-garagem', inicio: em(dia, '14:00'), fim: em(dia, '15:00'), responsavel: 'Marty' }, op));
}

async function livre(sala: string, dia: string): Promise<boolean> {
  const r = await cliente.chamarTool('consultar_disponibilidade', { sala, inicio: em(dia, '14:00'), fim: em(dia, '15:00') });
  return completo(r).livre as boolean;
}

describe('A. descoberta (tools/list)', () => {
  test('descobre as três tools, com schemas, a partir do servidor', async () => {
    const enviados = marcar();
    const tools = await cliente.descobrir();
    assert.deepEqual(tools.map((t) => t.name).sort(), ['consultar_disponibilidade', 'listar_salas', 'reservar_sala']);
    const reservar = tools.find((t) => t.name === 'reservar_sala')!;
    assert.deepEqual([...(reservar.inputSchema.required ?? [])].sort(), ['fim', 'inicio', 'responsavel', 'sala']);
    assert.ok(reservar.outputSchema, 'outputSchema recebido');
    assert.deepEqual(enviados().map((r) => r.metodo), ['tools/list'], 'foi ao servidor, sem cache');
    assert.deepEqual([...cliente.ferramentas.keys()].sort(), tools.map((t) => t.name).sort());
  });

  test('sem descoberta, tools/call é recusado ANTES de ir ao fio', async () => {
    const { cliente: novo, fio: fioNovo } = await conectar(srv.url);
    try {
      await assert.rejects(novo.chamarTool('listar_salas', {}), (e: Error) => e instanceof ErroDeUso && /descobrir\(\)/.test(e.message));
      assert.deepEqual(fioNovo.map((r) => r.metodo), ['server/discover'], 'nenhum tools/call enviado');
    } finally {
      await novo.fechar();
    }
  });

  test('tool que o servidor não oferece é recusada sem enviar nada', async () => {
    const enviados = marcar();
    await assert.rejects(cliente.chamarTool('apagar_tudo', {}), /não oferece a ferramenta 'apagar_tudo'/);
    await assert.rejects(cliente.chamarTool('reservar_sala', { sala: 'sala-porao' }), /obrigatórios ausentes.*inicio/);
    assert.equal(enviados().length, 0);
  });

  test('o log do servidor tem tools/list antes do primeiro tools/call', async () => {
    completo(await cliente.chamarTool('listar_salas', {}));
    const linhas = srv.saida.texto.split('\n');
    const lista = linhas.findIndex((l) => l.includes('recv method=tools/list'));
    const chamada = linhas.findIndex((l) => l.includes('recv method=tools/call'));
    assert.ok(lista >= 0 && chamada > lista, `tools/list na linha ${lista}, tools/call na ${chamada}`);
  });
});

describe('B. resource politica://uso', () => {
  test('lê por MCP, preserva o Markdown e extrai a versão da primeira linha', async () => {
    const enviados = marcar();
    const p = await cliente.lerPolitica();
    assert.match(p.versao, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(p.texto.startsWith(`versao: ${p.versao}`));
    assert.equal(p.bruto.contents[0]!.mimeType, 'text/markdown');
    assert.equal((p.bruto.contents[0] as { text: string }).text, p.texto, 'texto intacto');
    assert.deepEqual(enviados().map((r) => [r.metodo, r.headers['mcp-name']]), [['resources/read', 'politica://uso']]);
  });

  test('a versão vem do servidor (outra política, em CRLF → outra versão)', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'dados-'));
    const outro = await (async () => {
      await cp(path.join(DIR_DO_SERVIDOR, '..', 'dados'), dir, { recursive: true });
      const original = await readFile(path.join(dir, 'politica-de-uso.md'), 'utf8');
      const trocada = original.replace(/^versao: .*$/m, 'versao: 2099-12-31').replace(/\r?\n/g, '\r\n');
      await writeFile(path.join(dir, 'politica-de-uso.md'), trocada);
      return subirServidor({ DADOS_DIR: dir });
    })();
    const { cliente: c2 } = await conectar(outro.url);
    try {
      const p = await c2.lerPolitica();
      assert.equal(p.versao, '2099-12-31');
      assert.ok(p.texto.includes('\r\n'), 'CRLF preservado');
      await c2.descobrir();
      const r = completo(await c2.chamarTool('reservar_sala', { sala: 'sala-porao', inicio: em('13', '10:00'), fim: em('13', '11:00'), responsavel: 'Igor' }));
      assert.equal(r.politica, p.versao, 'reserva cita a versão lida');
    } finally {
      await c2.fechar();
      await outro.parar();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('URI não anunciada → erro JSON-RPC -32602', async () => {
    await assert.rejects(cliente.lerRecurso('politica://outra'), (e) => e instanceof ErroMcp && e.categoria === 'jsonrpc' && e.codigo === -32602);
  });
});

describe('C. reserva simples', () => {
  test('complete, reservado, id gerado e dados do pedido', async () => {
    const pedido = { sala: 'sala-aquario', inicio: em('14', '10:00'), fim: em('14', '11:00'), responsavel: 'Igor' };
    const r = await cliente.chamarTool('reservar_sala', pedido);
    const sc = completo(r);
    assert.equal(r.bruto.resultType ?? 'complete', 'complete');
    assert.equal(sc.reservado, true);
    assert.match(String(sc.reserva), /^res-\d{4}$/);
    assert.deepEqual([sc.sala, sc.inicio, sc.fim, sc.responsavel], [pedido.sala, pedido.inicio, pedido.fim, pedido.responsavel]);
    assert.equal(sc.politica, (await cliente.lerPolitica()).versao);
    assert.equal(r.tipo === 'completo' && r.bruto.isError, false);
    assert.equal(await livre('sala-aquario', '14'), true, 'outro horário continua livre');
  });
});

describe('D–G. MRTR', () => {
  test('D. conflito → input_required com elicitation form, enum e requestState', async () => {
    const p = await conflito('15');
    assert.equal(p.bruto.resultType, 'input_required');
    assert.equal(p.pedidos.length, 1);
    const [pedido] = p.pedidos;
    assert.deepEqual(Object.keys(p.bruto.inputRequests ?? {}), [pedido!.chave], 'chave lida da resposta');
    assert.equal(pedido!.metodo, 'elicitation/create');
    assert.equal(pedido!.modo, 'form');
    assert.equal(pedido!.mensagem, 'A sala pedida esta ocupada nesse intervalo. Escolha uma alternativa.');
    assert.deepEqual(pedido!.campos.find((c) => c.nome === 'sala')?.opcoes, ['sala-fusca', 'sala-mirante']);
    assert.equal(typeof p.requestState, 'string');
    assert.equal(p.requestState, p.bruto.requestState, 'guardado sem transformação');
    assert.equal(await livre('sala-fusca', '15'), true, 'nada reservado na pausa');
  });

  test('E. aceitar: retry com id novo, mesma chave, requestState idêntico, fora de arguments', async () => {
    const p = await conflito('16');
    const enviados = marcar();
    const original = fio.at(-1)!;
    const chave = p.pedidos[0]!.chave;
    const r = await cliente.continuar(p, { [chave]: aceitar(p.pedidos[0]!, { sala: 'sala-fusca' }) });
    const sc = completo(r);
    assert.deepEqual([sc.reservado, sc.sala, sc.responsavel, sc.inicio], [true, 'sala-fusca', 'Marty', em('16', '14:00')]);

    const [retry] = enviados();
    assert.notEqual(retry!.id, original.id, 'id JSON-RPC novo');
    assert.deepEqual(retry!.params!.inputResponses, { [chave]: { action: 'accept', content: { sala: 'sala-fusca' } } });
    assert.equal(retry!.params!.requestState, p.requestState, 'byte a byte');
    assert.deepEqual(retry!.params!.arguments, original.params!.arguments, 'mesmos argumentos');
    const args = retry!.params!.arguments as Record<string, unknown>;
    assert.ok(!('inputResponses' in args) && !('requestState' in args), 'nada de MRTR dentro de arguments');
    assert.equal(await livre('sala-fusca', '16'), false);
  });

  test('F. recusar: complete, reservado false, nenhuma reserva nova', async () => {
    const p = await conflito('17');
    const r = await cliente.continuar(p, { [p.pedidos[0]!.chave]: recusar() });
    const sc = completo(r);
    assert.deepEqual([sc.reservado, sc.motivo, sc.reserva], [false, 'recusado', null]);
    assert.equal(r.tipo === 'completo' && r.bruto.isError, false);
    assert.equal(await livre('sala-fusca', '17'), true);
    assert.equal(await livre('sala-mirante', '17'), true);
  });

  test('G. cancelar: complete, reservado false, nenhuma reserva nova', async () => {
    const p = await conflito('18');
    const sc = completo(await cliente.continuar(p, { [p.pedidos[0]!.chave]: cancelar() }));
    assert.deepEqual([sc.reservado, sc.motivo], [false, 'cancelado']);
    assert.equal(await livre('sala-fusca', '18'), true);
    assert.equal(await livre('sala-mirante', '18'), true);
  });

  test('escolha fora do enum é barrada no cliente: nenhum retry enviado', async () => {
    const p = await conflito('19');
    const enviados = marcar();
    assert.throws(() => aceitar(p.pedidos[0]!, { sala: 'sala-porao' }), ErroDeUso);
    await assert.rejects(cliente.continuar(p, {}), /faltando/);
    assert.equal(enviados().length, 0);
  });

  test('o mesmo requestState serve para outro retry (o cliente não o consome)', async () => {
    const p = await conflito('20');
    completo(await cliente.continuar(p, { [p.pedidos[0]!.chave]: recusar() }));
    const sc = completo(await cliente.continuar(p, { [p.pedidos[0]!.chave]: aceitar(p.pedidos[0]!, { sala: 'sala-mirante' }) }));
    assert.equal(sc.sala, 'sala-mirante');
  });
});

describe('H. erros', () => {
  test('erro de execução: sala inexistente → isError com a mensagem exata', async () => {
    const r = await cliente.chamarTool('reservar_sala', { sala: 'sala-delorean', inicio: em('21', '09:00'), fim: em('21', '10:00'), responsavel: 'Doc' });
    assert.equal(r.tipo, 'erro_execucao');
    assert.equal(r.tipo === 'erro_execucao' && r.mensagem, 'Sala inexistente: sala-delorean');
    assert.equal(r.bruto.isError, true);
  });

  test('erro JSON-RPC: requestState adulterado → -32602, sem reserva', async () => {
    const p = await conflito('21');
    const adulterado = { ...p, requestState: p.requestState!.slice(0, -6) + (p.requestState!.endsWith('AAAAAA') ? 'BBBBBB' : 'AAAAAA') };
    await assert.rejects(
      cliente.continuar(adulterado, { [p.pedidos[0]!.chave]: aceitar(p.pedidos[0]!, { sala: 'sala-fusca' }) }),
      (e) => e instanceof ErroMcp && e.categoria === 'jsonrpc' && e.codigo === -32602,
    );
    assert.equal(await livre('sala-fusca', '21'), true);
  });

  test('falha de transporte: servidor fora do ar', async () => {
    const porta = await portaLivre();
    await assert.rejects(ClienteMcp.conectar({ url: new URL(`http://localhost:${porta}/mcp`) }), (e) => e instanceof ErroMcp && e.categoria === 'transporte');
  });

  test('falha de transporte: servidor cai depois da conexão', async () => {
    const outro = await subirServidor();
    const { cliente: c2 } = await conectar(outro.url);
    try {
      await c2.descobrir();
      await outro.parar();
      await assert.rejects(c2.chamarTool('listar_salas', {}), (e) => e instanceof ErroMcp && e.categoria === 'transporte');
    } finally {
      await c2.fechar();
    }
  });
});

describe('I–J. trace e protocolo', () => {
  test('I. traceparent em tools/list, resources/read, tools/call e retry, com o mesmo trace-id', async () => {
    const enviados = marcar();
    const op = { traceparent: TRACEPARENT };
    await cliente.descobrir(op);
    await cliente.lerPolitica(op);
    completo(await cliente.chamarTool('reservar_sala', { sala: 'sala-garagem', inicio: em('22', '14:00'), fim: em('22', '15:00'), responsavel: 'Ocupante' }));
    const p = pausa(await cliente.chamarTool('reservar_sala', { sala: 'sala-garagem', inicio: em('22', '14:00'), fim: em('22', '15:00'), responsavel: 'Marty' }, op));
    completo(await cliente.continuar(p, { [p.pedidos[0]!.chave]: aceitar(p.pedidos[0]!, { sala: 'sala-fusca' }) }, op));

    const comTrace = enviados().filter((r) => (r.params?._meta as Record<string, unknown>)?.traceparent);
    assert.deepEqual(comTrace.map((r) => r.metodo), ['tools/list', 'resources/read', 'tools/call', 'tools/call']);
    const spans = new Set<string>();
    for (const r of comTrace) {
      const ctx = analisarTraceparent(String((r.params!._meta as Record<string, unknown>).traceparent))!;
      assert.equal(ctx.traceId, TRACE_ID);
      assert.equal(ctx.flags, '01');
      spans.add(ctx.parentId);
      assert.match(logDoId(srv.saida.texto, r.id) ?? '', new RegExp(`traceparent=00-${TRACE_ID}-`), `log do servidor para id=${r.id}`);
    }
    assert.equal(spans.size, 4, 'um span por request');
  });

  test('sem traceparent informado, nenhum é inventado', async () => {
    const enviados = marcar();
    await cliente.descobrir();
    const [r] = enviados();
    assert.equal((r!.params!._meta as Record<string, unknown>).traceparent, undefined);
    assert.match(logDoId(srv.saida.texto, r!.id) ?? '', /traceparent=-/);
  });

  test('J. todos os ids JSON-RPC enviados são distintos', () => {
    const ids = fio.map((r) => JSON.stringify(r.id));
    assert.equal(new Set(ids).size, ids.length, ids.join(' '));
  });

  test('todo request leva _meta com protocolVersion e elicitation.form', () => {
    assert.ok(fio.length > 20);
    for (const r of fio) {
      const meta = r.params?._meta as Record<string, unknown>;
      assert.equal(meta?.[META_VERSAO], PROTOCOLO, `${r.metodo} id=${r.id}`);
      assert.deepEqual(meta?.[META_CAPS], { elicitation: { form: {} } }, `${r.metodo} id=${r.id}`);
    }
  });

  test('headers espelham o corpo em todo request', () => {
    for (const r of fio) {
      assert.equal(r.headers['mcp-protocol-version'], PROTOCOLO);
      assert.equal(r.headers['mcp-method'], r.metodo);
      const nome = r.metodo === 'tools/call' ? r.params?.name : r.metodo === 'resources/read' ? r.params?.uri : undefined;
      assert.equal(r.headers['mcp-name'], nome, `${r.metodo} id=${r.id}`);
      assert.ok(r.status! < 500);
    }
  });
});
