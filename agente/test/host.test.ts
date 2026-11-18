// Testes de integração do HOST MCP contra o servidor MCP REAL, por HTTP, em
// dois processos. Cobrem os cenários do Passo 8 (agora pela interface do
// Host) e os do Passo 9: catálogo, política com origem, seis tipos de
// resultado, continuação como valor, isolamento entre operações, trace
// preservado no retry, reinício do Host e do servidor.
//
// Um servidor para o arquivo; cada cenário que grava usa um DIA próprio
// (05 a 28/11/2026), para não mudar a agenda de outro.
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { HostMcp } from '../src/host/host.ts';
import type { Continuacao } from '../src/host/continuacao.ts';
import type { ResultadoDaOperacao } from '../src/host/resultado.ts';
import { ErroDeUso, ErroMcp } from '../src/mcp/erros.ts';
import type { RequestObservado } from '../src/mcp/observacao.ts';
import { analisarTraceparent } from '../src/trace.ts';
import { DIR_DO_SERVIDOR, em, iniciarHost, logDoId, portaLivre, subirServidor, TRACE_ID, TRACEPARENT, type ServidorDeTeste } from './apoio.ts';

const PROTOCOLO = '2026-07-28';
const META_VERSAO = 'io.modelcontextprotocol/protocolVersion';
const META_CAPS = 'io.modelcontextprotocol/clientCapabilities';
const TRACE_B = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-00';

let srv: ServidorDeTeste;
let host: HostMcp;
let fio: RequestObservado[];

before(async () => {
  srv = await subirServidor();
  ({ host, fio } = await iniciarHost(srv.url));
});
after(async () => {
  await host?.encerrar();
  await srv?.parar();
});

function marcar(): () => RequestObservado[] {
  const inicio = fio.length;
  return () => fio.slice(inicio);
}

type De<T extends ResultadoDaOperacao['tipo']> = Extract<ResultadoDaOperacao, { tipo: T }>;
function esperar<T extends ResultadoDaOperacao['tipo']>(r: ResultadoDaOperacao, tipo: T): De<T> {
  const { bruto: _b, ...semBruto } = r as { bruto?: unknown };
  assert.equal(r.tipo, tipo, JSON.stringify(semBruto));
  return r as De<T>;
}
const completo = (r: ResultadoDaOperacao) => esperar(r, 'completo').estruturado as Record<string, unknown>;
const pausa = (r: ResultadoDaOperacao) => esperar(r, 'input_required').continuacao;

const garagem = (dia: string, responsavel: string) => ({ sala: 'sala-garagem', inicio: em(dia, '14:00'), fim: em(dia, '15:00'), responsavel });

/** Ocupa a garagem às 14h do dia e pede de novo: devolve o resultado input_required. */
async function conflito(dia: string, ctx = {}): Promise<De<'input_required'>> {
  completo(await host.executar('reservar_sala', garagem(dia, 'Ocupante')));
  return esperar(await host.executar('reservar_sala', garagem(dia, 'Marty'), ctx), 'input_required');
}

async function livre(sala: string, dia: string, inicio = '14:00', fim = '15:00'): Promise<boolean> {
  return completo(await host.executar('consultar_disponibilidade', { sala, inicio: em(dia, inicio), fim: em(dia, fim) })).livre as boolean;
}

const aceitarSala = (sala: string) => ({ action: 'accept' as const, content: { sala } });

describe('inicialização e descoberta', () => {
  test('iniciar faz server/discover e tools/list, nessa ordem, antes de qualquer tools/call', () => {
    assert.deepEqual(fio.slice(0, 2).map((r) => r.metodo), ['server/discover', 'tools/list']);
  });

  test('catálogo com as três tools e os schemas recebidos', () => {
    const tools = host.ferramentas();
    assert.deepEqual(tools.map((t) => t.name).sort(), ['consultar_disponibilidade', 'listar_salas', 'reservar_sala']);
    const reservar = host.ferramenta('reservar_sala')!;
    assert.deepEqual([...(reservar.inputSchema.required ?? [])].sort(), ['fim', 'inicio', 'responsavel', 'sala']);
    assert.ok(reservar.outputSchema, 'outputSchema preservado');
  });

  test('descobrir() de novo vai ao fio e substitui o catálogo', async () => {
    const enviados = marcar();
    await host.descobrir();
    assert.deepEqual(enviados().map((r) => r.metodo), ['tools/list']);
  });

  test('tool fora do catálogo ou sem argumento obrigatório: ErroDeUso, nada no fio', async () => {
    const enviados = marcar();
    await assert.rejects(host.executar('apagar_tudo', {}), /não oferece a ferramenta 'apagar_tudo'/);
    await assert.rejects(host.executar('reservar_sala', { sala: 'sala-porao' }), (e) => e instanceof ErroDeUso && /inicio/.test(e.message));
    assert.equal(enviados().length, 0);
  });

  test('log do servidor: tools/list antes do primeiro tools/call', async () => {
    completo(await host.executar('listar_salas', {}));
    const linhas = srv.saida.texto.split('\n');
    const lista = linhas.findIndex((l) => l.includes('recv method=tools/list'));
    const chamada = linhas.findIndex((l) => l.includes('recv method=tools/call'));
    assert.ok(lista >= 0 && chamada > lista, `tools/list na linha ${lista}, tools/call na ${chamada}`);
  });
});

describe('política (resource)', () => {
  test('lida por MCP, versão da 1ª linha, texto intacto e origem registrada', async () => {
    const enviados = marcar();
    const p = await host.lerPolitica();
    assert.match(p.versao, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(p.texto.startsWith(`versao: ${p.versao}`));
    assert.equal(p.origem.uri, 'politica://uso');
    assert.equal(p.origem.mimeType, 'text/markdown');
    assert.equal(p.origem.servidor?.name, 'central-de-salas');
    assert.equal(host.politica, p, 'fica disponível para a aplicação');
    assert.deepEqual(enviados().map((r) => [r.metodo, r.headers['mcp-name']]), [['resources/read', 'politica://uso']]);
  });

  test('a versão vem do servidor (outra política, em CRLF → outra versão)', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'dados-'));
    await cp(path.join(DIR_DO_SERVIDOR, '..', 'dados'), dir, { recursive: true });
    const original = await readFile(path.join(dir, 'politica-de-uso.md'), 'utf8');
    await writeFile(path.join(dir, 'politica-de-uso.md'), original.replace(/^versao: .*$/m, 'versao: 2099-12-31').replace(/\r?\n/g, '\r\n'));
    const outro = await subirServidor({ DADOS_DIR: dir });
    const { host: h2 } = await iniciarHost(outro.url);
    try {
      const p = await h2.lerPolitica();
      assert.equal(p.versao, '2099-12-31');
      assert.ok(p.texto.includes('\r\n'), 'CRLF preservado');
      const r = completo(await h2.executar('reservar_sala', { sala: 'sala-porao', inicio: em('05', '10:00'), fim: em('05', '11:00'), responsavel: 'Igor' }));
      assert.equal(r.politica, p.versao);
    } finally {
      await h2.encerrar();
      await outro.parar();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('URI não anunciada → ErroMcp jsonrpc -32602', async () => {
    await assert.rejects(host.lerRecurso('politica://outra'), (e) => e instanceof ErroMcp && e.categoria === 'jsonrpc' && e.codigo === -32602);
  });
});

describe('execução: tipos de resultado', () => {
  test('completo: reserva simples com os dados do pedido e a operação carimbada', async () => {
    const pedido = { sala: 'sala-aquario', inicio: em('06', '10:00'), fim: em('06', '11:00'), responsavel: 'Igor' };
    const r = esperar(await host.executar('reservar_sala', pedido, { operacao: 'op-simples' }), 'completo');
    const sc = r.estruturado as Record<string, unknown>;
    assert.deepEqual([r.operacao, r.ferramenta, sc.reservado], ['op-simples', 'reservar_sala', true]);
    assert.match(String(sc.reserva), /^res-\d{4}$/);
    assert.deepEqual([sc.sala, sc.inicio, sc.fim, sc.responsavel], [pedido.sala, pedido.inicio, pedido.fim, pedido.responsavel]);
    assert.equal(sc.politica, (await host.lerPolitica()).versao);
  });

  test('erro_execucao: sala inexistente, com a mensagem da tool', async () => {
    const r = esperar(await host.executar('reservar_sala', { sala: 'sala-delorean', inicio: em('06', '09:00'), fim: em('06', '10:00'), responsavel: 'Doc' }), 'erro_execucao');
    assert.equal(r.mensagem, 'Sala inexistente: sala-delorean');
    assert.equal(r.bruto.isError, true);
  });

  test('erro_protocolo: requestState adulterado → -32602, sem reserva e sem o estado na mensagem', async () => {
    const { continuacao: c } = await conflito('07');
    const adulterada = { ...c, requestState: c.requestState!.slice(0, -6) + (c.requestState!.endsWith('AAAAAA') ? 'BBBBBB' : 'AAAAAA') };
    const r = esperar(await host.continuar(adulterada, aceitarSala('sala-fusca')), 'erro_protocolo');
    assert.equal(r.codigo, -32602);
    assert.ok(!JSON.stringify({ m: r.mensagem, d: r.dados }).includes(c.requestState!.slice(3, 40)), 'requestState não vaza no erro');
    assert.equal(await livre('sala-fusca', '07'), true);
  });

  test('falha_transporte: servidor cai depois da inicialização', async () => {
    const outro = await subirServidor();
    const { host: h2 } = await iniciarHost(outro.url);
    try {
      await outro.parar();
      esperar(await h2.executar('listar_salas', {}), 'falha_transporte');
    } finally {
      await h2.encerrar();
    }
  });

  test('servidor fora do ar na inicialização → ErroMcp transporte', async () => {
    const porta = await portaLivre();
    await assert.rejects(HostMcp.iniciar({ url: new URL(`http://localhost:${porta}/mcp`) }), (e) => e instanceof ErroMcp && e.categoria === 'transporte');
  });

  test('Host encerrado não executa nada', async () => {
    const { host: h2 } = await iniciarHost(srv.url);
    await h2.encerrar();
    await assert.rejects(h2.executar('listar_salas', {}), ErroDeUso);
  });
});

describe('MRTR: interrupção e continuação', () => {
  test('input_required vira continuação com tudo para o retry (e nada é reservado)', async () => {
    const r = await conflito('08', { operacao: 'op-08' });
    const c = r.continuacao;
    assert.deepEqual([c.operacao, c.ferramenta, c.rodada], ['op-08', 'reservar_sala', 1]);
    assert.deepEqual(c.argumentos, garagem('08', 'Marty'), 'argumentos originais');
    assert.deepEqual(c.pedidos.map((p) => p.chave), Object.keys(r.bruto.inputRequests ?? {}), 'chave lida da resposta');
    const [p] = c.pedidos;
    assert.deepEqual([p!.metodo, p!.modo], ['elicitation/create', 'form']);
    assert.deepEqual(p!.requestedSchema, (r.bruto.inputRequests as Record<string, { params: { requestedSchema: unknown } }>)[p!.chave]!.params.requestedSchema);
    assert.deepEqual(p!.campos.find((x) => x.nome === 'sala')?.opcoes, ['sala-fusca', 'sala-mirante']);
    assert.equal(c.requestState, r.bruto.requestState, 'requestState idêntico ao recebido');
    assert.equal(await livre('sala-fusca', '08'), true);
  });

  test('aceitar: retry com id novo, mesma chave, requestState idêntico, fora de arguments', async () => {
    const { continuacao: c } = await conflito('09');
    const original = fio.at(-1)!;
    const enviados = marcar();
    const sc = completo(await host.continuar(c, aceitarSala('sala-fusca')));
    assert.deepEqual([sc.reservado, sc.sala, sc.responsavel, sc.inicio], [true, 'sala-fusca', 'Marty', em('09', '14:00')]);
    const [retry] = enviados();
    assert.notEqual(retry!.id, original.id, 'id JSON-RPC novo');
    assert.deepEqual(retry!.params!.inputResponses, { [c.pedidos[0]!.chave]: aceitarSala('sala-fusca') });
    assert.equal(retry!.params!.requestState, c.requestState, 'byte a byte');
    assert.deepEqual(retry!.params!.arguments, original.params!.arguments);
    const args = retry!.params!.arguments as Record<string, unknown>;
    assert.ok(!('inputResponses' in args) && !('requestState' in args));
  });

  test('recusar: complete, reservado false, nenhuma reserva', async () => {
    const { continuacao: c } = await conflito('10');
    const sc = completo(await host.continuar(c, { action: 'decline' }));
    assert.deepEqual([sc.reservado, sc.motivo, sc.reserva], [false, 'recusado', null]);
    assert.equal(await livre('sala-fusca', '10'), true);
    assert.equal(await livre('sala-mirante', '10'), true);
  });

  test('cancelar: complete, reservado false, nenhuma reserva', async () => {
    const { continuacao: c } = await conflito('11');
    const sc = completo(await host.continuar(c, { action: 'cancel' }));
    assert.deepEqual([sc.reservado, sc.motivo], [false, 'cancelado']);
    assert.equal(await livre('sala-fusca', '11'), true);
  });

  test('resposta inválida para o formulário: resposta_invalida, nada no fio, continuação segue válida', async () => {
    const { continuacao: c } = await conflito('12');
    const enviados = marcar();
    const r1 = esperar(await host.continuar(c, aceitarSala('sala-porao')), 'resposta_invalida');
    assert.match(r1.problemas.join(), /fora das opções: sala-fusca, sala-mirante/);
    assert.equal(r1.continuacao, c);
    esperar(await host.continuar(c, { outra_chave: { action: 'decline' } }), 'resposta_invalida');
    esperar(await host.continuar(c, { action: 'accept' } as never), 'resposta_invalida');
    assert.equal(enviados().length, 0);
    assert.equal(completo(await host.continuar(c, aceitarSala('sala-mirante'))).sala, 'sala-mirante');
  });

  test('a continuação sobrevive a JSON (como num armazenamento de Task) e a outro Host', async () => {
    const { continuacao: c } = await conflito('13');
    const guardada = JSON.parse(JSON.stringify(c)) as Continuacao;
    const { host: outroHost } = await iniciarHost(srv.url);
    try {
      assert.equal(completo(await outroHost.continuar(guardada, aceitarSala('sala-fusca'))).sala, 'sala-fusca');
    } finally {
      await outroHost.encerrar();
    }
  });

  test('retomar com outra operação é recusado sem enviar nada', async () => {
    const { continuacao: c } = await conflito('14', { operacao: 'op-A' });
    const enviados = marcar();
    await assert.rejects(host.continuar(c, { action: 'decline' }, { operacao: 'op-B' }), /op-A.*op-B/);
    assert.equal(enviados().length, 0);
  });

  test('sala escolhida ocupada nesse meio tempo → nova pausa, rodada 2', async () => {
    const { continuacao: c } = await conflito('15');
    completo(await host.executar('reservar_sala', { sala: 'sala-fusca', inicio: em('15', '14:00'), fim: em('15', '15:00'), responsavel: 'Outro' }));
    const c2 = pausa(await host.continuar(c, aceitarSala('sala-fusca')));
    assert.equal(c2.rodada, 2);
    assert.deepEqual(c2.argumentos, c.argumentos);
    assert.notEqual(c2.requestState, c.requestState);
  });
});

describe('isolamento entre operações', () => {
  test('duas operações pausadas, retomadas em ordem inversa, sem trocar estado', async () => {
    // A: garagem (cap. 12) → alternativas fusca, mirante. B: porão (cap. 6) às 9h → outras alternativas.
    const a = await conflito('16', { operacao: 'op-A', traceparent: TRACEPARENT });
    completo(await host.executar('reservar_sala', { sala: 'sala-porao', inicio: em('16', '09:00'), fim: em('16', '10:00'), responsavel: 'Ocupante' }));
    const b = esperar(await host.executar('reservar_sala', { sala: 'sala-porao', inicio: em('16', '09:00'), fim: em('16', '10:00'), responsavel: 'Biff' }, { operacao: 'op-B', traceparent: TRACE_B }), 'input_required');
    const ca = a.continuacao;
    const cb = b.continuacao;
    assert.notEqual(ca.requestState, cb.requestState);
    assert.notDeepEqual(ca.pedidos[0]!.campos[0]!.opcoes, cb.pedidos[0]!.campos[0]!.opcoes);

    const enviados = marcar();
    const rb = completo(await host.continuar(cb, aceitarSala('sala-garagem'), { operacao: 'op-B' }));
    const ra = completo(await host.continuar(ca, aceitarSala('sala-mirante'), { operacao: 'op-A' }));
    assert.deepEqual([rb.sala, rb.responsavel, rb.inicio], ['sala-garagem', 'Biff', em('16', '09:00')]);
    assert.deepEqual([ra.sala, ra.responsavel, ra.inicio], ['sala-mirante', 'Marty', em('16', '14:00')]);
    const [retryB, retryA] = enviados();
    assert.equal(retryB!.params!.requestState, cb.requestState);
    assert.equal(retryA!.params!.requestState, ca.requestState);
    assert.equal(analisarTraceparent(String((retryB!.params!._meta as Record<string, unknown>).traceparent))!.traceId, analisarTraceparent(TRACE_B)!.traceId);
    assert.equal(analisarTraceparent(String((retryA!.params!._meta as Record<string, unknown>).traceparent))!.traceId, TRACE_ID);
  });

  test('operações simultâneas (Promise.all) no mesmo Host', async () => {
    const dias = ['17', '18', '19'];
    for (const d of dias) completo(await host.executar('reservar_sala', garagem(d, 'Ocupante')));
    const pausas = await Promise.all(dias.map((d) => host.executar('reservar_sala', garagem(d, `R${d}`), { operacao: `op-${d}` })));
    const conts = pausas.map(pausa);
    assert.equal(new Set(conts.map((c) => c.requestState)).size, 3);
    const finais = await Promise.all(conts.map((c, i) => host.continuar(c, aceitarSala(i === 1 ? 'sala-mirante' : 'sala-fusca'))));
    finais.forEach((f, i) => {
      const sc = completo(f);
      assert.deepEqual([f.operacao, sc.responsavel, sc.inicio, sc.sala], [`op-${dias[i]}`, `R${dias[i]}`, em(dias[i]!, '14:00'), i === 1 ? 'sala-mirante' : 'sala-fusca']);
    });
  });
});

describe('trace context', () => {
  test('mesmo trace-id em tools/list, resources/read, tools/call e retry; um span por request; no log do servidor', async () => {
    const enviados = marcar();
    const ctx = { operacao: 'op-trace', traceparent: TRACEPARENT };
    await host.descobrir(ctx);
    await host.lerPolitica(ctx);
    completo(await host.executar('reservar_sala', garagem('20', 'Ocupante')));
    const c = pausa(await host.executar('reservar_sala', garagem('20', 'Marty'), ctx));
    // Retomada SEM reenviar o traceparent: o Host usa o da continuação.
    completo(await host.continuar(c, aceitarSala('sala-fusca')));

    const comTrace = enviados().filter((r) => (r.params?._meta as Record<string, unknown>)?.traceparent);
    assert.deepEqual(comTrace.map((r) => r.metodo), ['tools/list', 'resources/read', 'tools/call', 'tools/call']);
    const spans = new Set<string>();
    for (const r of comTrace) {
      const tp = analisarTraceparent(String((r.params!._meta as Record<string, unknown>).traceparent))!;
      assert.deepEqual([tp.traceId, tp.flags], [TRACE_ID, '01']);
      spans.add(tp.parentId);
      assert.match(logDoId(srv.saida.texto, r.id) ?? '', new RegExp(`traceparent=00-${TRACE_ID}-`), `log do servidor, id=${r.id}`);
    }
    assert.equal(spans.size, 4);
  });

  test('sem traceparent, nenhum é inventado (nem no retry)', async () => {
    const { continuacao: c } = await conflito('21');
    const enviados = marcar();
    completo(await host.continuar(c, { action: 'decline' }));
    const [r] = enviados();
    assert.equal((r!.params!._meta as Record<string, unknown>).traceparent, undefined);
    assert.match(logDoId(srv.saida.texto, r!.id) ?? '', /traceparent=-/);
  });
});

describe('reinício e ausência de sessão', () => {
  test('reiniciar(): novo cliente, novo server/discover e tools/list, catálogo de volta', async () => {
    const { host: h2, fio: fio2 } = await iniciarHost(srv.url);
    try {
      await h2.reiniciar();
      assert.deepEqual(fio2.map((r) => r.metodo), ['server/discover', 'tools/list', 'server/discover', 'tools/list']);
      assert.equal(h2.ferramentas().length, 3);
      completo(await h2.executar('listar_salas', {}));
    } finally {
      await h2.encerrar();
    }
  });

  test('servidor reiniciado na mesma porta: o Host segue sem reconectar e a continuação anterior ainda vale', async () => {
    const segredo = randomBytes(32).toString('hex');
    const porta = await portaLivre();
    const s1 = await subirServidor({ MCP_PORT: String(porta), REQUEST_STATE_SECRET: segredo });
    assert.equal(s1.porta, porta);
    let h2: HostMcp | undefined;
    try {
      ({ host: h2 } = await iniciarHost(s1.url));
      completo(await h2.executar('reservar_sala', garagem('22', 'Ocupante')));
      const c = pausa(await h2.executar('reservar_sala', garagem('22', 'Marty')));
      await s1.parar();
      const s2 = await subirServidor({ MCP_PORT: String(porta), REQUEST_STATE_SECRET: segredo });
      try {
        // Agenda nova (memória), mas o pedido vem do requestState assinado, não de sessão.
        const sc = completo(await h2.continuar(c, aceitarSala('sala-fusca')));
        assert.deepEqual([sc.sala, sc.responsavel, sc.inicio], ['sala-fusca', 'Marty', em('22', '14:00')]);
      } finally {
        await s2.parar();
      }
    } finally {
      await h2?.encerrar();
      await s1.parar();
    }
  });
});

describe('protocolo em todo o tráfego do Host', () => {
  test('ids JSON-RPC distintos', () => {
    const ids = fio.map((r) => JSON.stringify(r.id));
    assert.equal(new Set(ids).size, ids.length);
  });

  test('todo request leva _meta com protocolVersion e elicitation.form', () => {
    assert.ok(fio.length > 30);
    for (const r of fio) {
      const meta = r.params?._meta as Record<string, unknown>;
      assert.equal(meta?.[META_VERSAO], PROTOCOLO, `${r.metodo} id=${r.id}`);
      assert.deepEqual(meta?.[META_CAPS], { elicitation: { form: {} } }, `${r.metodo} id=${r.id}`);
    }
  });

  test('headers espelham o corpo', () => {
    for (const r of fio) {
      assert.equal(r.headers['mcp-protocol-version'], PROTOCOLO);
      assert.equal(r.headers['mcp-method'], r.metodo);
      const nome = r.metodo === 'tools/call' ? r.params?.name : r.metodo === 'resources/read' ? r.params?.uri : undefined;
      assert.equal(r.headers['mcp-name'], nome, `${r.metodo} id=${r.id}`);
    }
  });
});
