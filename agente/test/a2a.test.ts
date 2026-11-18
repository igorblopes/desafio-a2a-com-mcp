// Testes de integração do AGENTE A2A: dois processos reais (servidor MCP e
// agente, cada um com o seu `src/main.ts`), conversando só por HTTP, como o
// validador. Cada cenário que grava usa um dia próprio (03 a 12/12/2026) e
// um trace-id próprio, para ler no log do MCP só os próprios requests.
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { em as emNov, novoTraceparent, portaLivre, rpc, subirAgente, subirServidor, type ServidorDeTeste } from './apoio.ts';

const em = (dia: string, hora: string) => emNov(dia, hora).replace('2026-11-', '2026-12-');
const pedido = (sala: string, dia: string, inicio: string, fim: string, responsavel: string) => `reservar sala=${sala} inicio=${em(dia, inicio)} fim=${em(dia, fim)} responsavel=${responsavel}`;

let mcp: ServidorDeTeste;
let agente: ServidorDeTeste;

before(async () => {
  mcp = await subirServidor();
  agente = await subirAgente(mcp.url);
});
after(async () => {
  await agente?.parar();
  await mcp?.parar();
});

let seq = 0;
function enviar(texto: string, opcoes: { taskId?: string; traceparent?: string; id?: string | number } = {}) {
  const message: Record<string, unknown> = { messageId: `msg-teste-${++seq}`, role: 'ROLE_USER', parts: [{ text: texto }] };
  if (opcoes.taskId) message.taskId = opcoes.taskId;
  return rpc(agente.url, { jsonrpc: '2.0', id: opcoes.id ?? `req-${seq}`, method: 'SendMessage', params: { message } }, opcoes.traceparent ? { traceparent: opcoes.traceparent } : {});
}
const getTask = (id: unknown, rid: string | number = `get-${++seq}`) => rpc(agente.url, { jsonrpc: '2.0', id: rid, method: 'GetTask', params: { id } });
const linhasDoMcp = (traceId: string) => mcp.saida.texto.split(/\r?\n/).filter((l) => l.startsWith('[mcp] recv') && l.includes(traceId));
const textoDe = (m: { parts?: { text?: string }[] } | undefined) => (m?.parts ?? []).map((p) => p.text ?? '').join('');
const conteudoDoArtifact = (t: { artifacts?: { parts: { text: string }[] }[] }) => JSON.parse(t.artifacts![0]!.parts.map((p) => p.text).join(''));

describe('Agent Card', () => {
  test('GET /.well-known/agent-card.json: 200, JSON, v1.0, JSON-RPC em /a2a, skill reservar-sala', async () => {
    const r = await fetch(new URL('/.well-known/agent-card.json', agente.url));
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type') ?? '', /application\/json/);
    const card = await r.json();
    assert.deepEqual(card.supportedInterfaces, [{ url: `http://localhost:${agente.porta}/a2a`, protocolBinding: 'JSONRPC', protocolVersion: '1.0' }]);
    assert.deepEqual(card.capabilities, { streaming: false, pushNotifications: false, extendedAgentCard: false });
    assert.deepEqual(card.skills.map((s: { id: string }) => s.id), ['reservar-sala']);
    for (const campo of ['url', 'preferredTransport', 'additionalInterfaces', 'interfaces']) assert.ok(!(campo in card), `campo da v0.x: ${campo}`);
  });

  test('opacidade: o card não cita MCP, tools, requestState nem a porta 7301', async () => {
    const texto = await (await fetch(new URL('/.well-known/agent-card.json', agente.url))).text();
    for (const proibido of ['mcp', 'reservar_sala', 'requestState', 'consultar_disponibilidade', String(mcp.porta)]) {
      assert.ok(!texto.toLowerCase().includes(proibido.toLowerCase()), proibido);
    }
  });
});

describe('JSON-RPC', () => {
  test('id preservado (string e número) e distinto do id da Task', async () => {
    const a = await enviar(pedido('sala-aquario', '03', '10:00', '11:00', 'Igor'), { id: 'abc-123' });
    const b = await getTask(a.corpo.result.task.id, 42);
    assert.equal(a.corpo.id, 'abc-123');
    assert.equal(b.corpo.id, 42);
    assert.notEqual(a.corpo.result.task.id, 'abc-123');
  });

  test('método desconhecido → -32601', async () => {
    const r = await rpc(agente.url, { jsonrpc: '2.0', id: 7, method: 'ReservarDireto', params: {} });
    assert.deepEqual([r.corpo.id, r.corpo.error.code], [7, -32601]);
  });

  test('request inválido → -32600; JSON quebrado → -32700', async () => {
    const semVersao = await rpc(agente.url, { id: 8, method: 'GetTask', params: { id: 'x' } });
    assert.deepEqual([semVersao.corpo.id, semVersao.corpo.error.code], [8, -32600]);
    const lista = await rpc(agente.url, [1, 2]);
    assert.equal(lista.corpo.error.code, -32600);
    const quebrado = await rpc(agente.url, '{"jsonrpc": "2.0", "id": 9,');
    assert.deepEqual([quebrado.corpo.id, quebrado.corpo.error.code], [null, -32700]);
  });

  test('params inválidos → -32602', async () => {
    const r = await rpc(agente.url, { jsonrpc: '2.0', id: 10, method: 'SendMessage', params: {} });
    assert.deepEqual([r.corpo.id, r.corpo.error.code], [10, -32602]);
    const g = await rpc(agente.url, { jsonrpc: '2.0', id: 11, method: 'GetTask', params: {} });
    assert.equal(g.corpo.error.code, -32602);
  });

  test('métodos fora do escopo são recusados (-32004)', async () => {
    for (const method of ['CancelTask', 'ListTasks']) {
      const r = await rpc(agente.url, { jsonrpc: '2.0', id: method, method, params: { id: 'x' } });
      assert.equal(r.corpo.error.code, -32004, method);
    }
  });
});

describe('SendMessage e GetTask: caminho feliz', () => {
  test('sala livre: COMPLETED, ids próprios, histórico e artifact reserva com dados do MCP', async () => {
    const { traceparent } = novoTraceparent();
    const texto = pedido('sala-porao', '04', '09:00', '10:00', 'Doc Brown');
    const r = await enviar(texto, { traceparent });
    assert.equal(r.http, 200);
    const t = r.corpo.result.task;
    assert.equal(t.status.state, 'TASK_STATE_COMPLETED');
    assert.ok(t.id && t.contextId && t.id !== t.contextId);
    assert.match(textoDe(t.status.message), /^Reserva res-\d{4} confirmada na sala-porao\.$/);
    assert.deepEqual(t.history.map((m: { role: string }) => m.role), ['ROLE_USER', 'ROLE_AGENT']);
    assert.equal(textoDe(t.history[0]), texto);
    assert.equal(t.artifacts.length, 1);
    assert.equal(t.artifacts[0].name, 'reserva');
    const reserva = conteudoDoArtifact(t);
    assert.deepEqual(Object.keys(reserva), ['reserva', 'sala', 'inicio', 'fim', 'responsavel', 'politica']);
    assert.deepEqual([reserva.sala, reserva.inicio, reserva.fim, reserva.responsavel], ['sala-porao', em('04', '09:00'), em('04', '10:00'), 'Doc Brown']);
    assert.ok(textoDe(t.status.message).includes(reserva.reserva), 'mesmo id de reserva na mensagem e no artifact');

    // A versão da política é a do resource, lida pelo próprio MCP.
    const politica = await fetch(mcp.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2026-07-28', 'mcp-method': 'resources/read', 'mcp-name': 'politica://uso' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'resources/read', params: { uri: 'politica://uso', _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {} } } }),
    }).then((x) => x.json());
    assert.equal(reserva.politica, /^versao: (\S+)/.exec(politica.result.contents[0].text)![1]);

    // GetTask devolve a mesma Task, sem executar nada de novo no MCP.
    const chamadasAntes = mcp.saida.texto.split('recv method=tools/call').length;
    const g = await getTask(t.id);
    const tg = g.corpo.result.task ?? g.corpo.result;
    assert.deepEqual([tg.id, tg.contextId, tg.status.state], [t.id, t.contextId, 'TASK_STATE_COMPLETED']);
    assert.deepEqual(tg.artifacts, t.artifacts);
    assert.deepEqual(tg.history, t.history);
    assert.equal(mcp.saida.texto.split('recv method=tools/call').length, chamadasAntes, 'GetTask não chama o MCP');
  });

  test('cada SendMessage sem taskId cria Task e contextId novos', async () => {
    const a = (await enviar(pedido('sala-aquario', '05', '10:00', '11:00', 'A'))).corpo.result.task;
    const b = (await enviar(pedido('sala-aquario', '05', '11:00', '12:00', 'B'))).corpo.result.task;
    assert.notEqual(a.id, b.id);
    assert.notEqual(a.contextId, b.contextId);
  });

  test('Task inexistente → -32001', async () => {
    const r = await getTask('task-que-nao-existe');
    assert.equal(r.corpo.error.code, -32001);
  });
});

describe('falhas', () => {
  test('isError do MCP → FAILED com a mensagem original no status e no histórico', async () => {
    const r = await enviar(pedido('sala-delorean', '06', '09:00', '10:00', 'Doc'));
    const t = r.corpo.result.task;
    assert.equal(t.status.state, 'TASK_STATE_FAILED');
    assert.equal(textoDe(t.status.message), 'Sala inexistente: sala-delorean');
    assert.equal(textoDe(t.history.at(-1)), 'Sala inexistente: sala-delorean');
    assert.deepEqual(t.artifacts ?? [], []);
    const g = (await getTask(t.id)).corpo.result;
    assert.equal((g.task ?? g).status.state, 'TASK_STATE_FAILED');
  });

  test('regra de domínio é do MCP: horário fora da janela vem com a mensagem do servidor', async () => {
    const t = (await enviar(pedido('sala-aquario', '06', '06:00', '07:00', 'Doc'))).corpo.result.task;
    assert.equal(t.status.state, 'TASK_STATE_FAILED');
    assert.ok(textoDe(t.status.message).length > 0);
    assert.ok(!/agente/i.test(textoDe(t.status.message)), 'mensagem do servidor, não do agente');
  });

  test('texto fora do formato → FAILED sem nenhum request MCP', async () => {
    const { traceparent, traceId } = novoTraceparent();
    const t = (await enviar('quero a sala do porao amanha', { traceparent })).corpo.result.task;
    assert.equal(t.status.state, 'TASK_STATE_FAILED');
    assert.match(textoDe(t.status.message), /Formato: reservar sala=/);
    assert.deepEqual(linhasDoMcp(traceId), []);
  });

  test('conflito (input_required) → FAILED explícito, sem retry, sem artifact e sem requestState', async () => {
    const { traceparent, traceId } = novoTraceparent();
    (await enviar(pedido('sala-garagem', '07', '14:00', '15:00', 'Ocupante'))).corpo.result.task;
    const r = await enviar(pedido('sala-garagem', '07', '14:00', '15:00', 'Marty'), { traceparent });
    const t = r.corpo.result.task;
    assert.equal(t.status.state, 'TASK_STATE_FAILED');
    assert.match(textoDe(t.status.message), /ainda nao permite escolher uma alternativa/);
    assert.deepEqual(t.artifacts ?? [], []);
    assert.equal(linhasDoMcp(traceId).filter((l) => l.includes('method=tools/call')).length, 1, 'nenhuma resposta automática à elicitation');
    assert.ok(!r.texto.includes('requestState') && !r.texto.includes('v1.'), 'nada do requestState na resposta A2A');
  });
});

describe('Task terminal', () => {
  test('SendMessage com taskId de Task concluída é recusado e nada muda', async () => {
    const t = (await enviar(pedido('sala-mirante', '08', '10:00', '11:00', 'Lorraine'))).corpo.result.task;
    assert.equal(t.status.state, 'TASK_STATE_COMPLETED');
    const chamadasAntes = mcp.saida.texto.split('recv method=tools/call').length;
    const r = await enviar(pedido('sala-mirante', '08', '11:00', '12:00', 'Lorraine'), { taskId: t.id });
    assert.equal(r.corpo.error.code, -32004);
    assert.equal(mcp.saida.texto.split('recv method=tools/call').length, chamadasAntes, 'nenhuma segunda reserva');
    const g = (await getTask(t.id)).corpo.result;
    const tg = g.task ?? g;
    assert.deepEqual([tg.status.state, tg.history.length, tg.artifacts.length], ['TASK_STATE_COMPLETED', 2, 1]);
  });

  test('o mesmo vale para Task em FAILED', async () => {
    const t = (await enviar(pedido('sala-delorean', '08', '09:00', '10:00', 'Doc'))).corpo.result.task;
    const r = await enviar('escolha=sala-fusca', { taskId: t.id });
    assert.equal(r.corpo.error.code, -32004);
  });
});

describe('traceparent', () => {
  test('o trace-id do header chega a todos os requests MCP da Task (stderr do MCP)', async () => {
    const { traceparent, traceId } = novoTraceparent();
    const t = (await enviar(pedido('sala-fusca', '09', '10:00', '11:00', 'Marty'), { traceparent })).corpo.result.task;
    assert.equal(t.status.state, 'TASK_STATE_COMPLETED');
    const linhas = linhasDoMcp(traceId);
    assert.deepEqual(linhas.map((l) => /method=(\S+)/.exec(l)![1]), ['tools/list', 'resources/read', 'tools/call']);
    const spans = linhas.map((l) => new RegExp(`traceparent=00-${traceId}-([0-9a-f]{16})-01`).exec(l)![1]);
    assert.equal(new Set(spans).size, 3, 'um span novo por request');
    assert.ok(!spans.includes(traceparent.split('-')[2]!), 'o span do cliente A2A não é reutilizado');
    assert.match(agente.saida.texto, new RegExp(`recv method=SendMessage .*traceparent=${traceparent}`));
  });

  test('sem header (ou com header inválido), nenhum traceparent é inventado', async () => {
    const dia = '10';
    const antes = mcp.saida.texto.length;
    await rpc(agente.url, { jsonrpc: '2.0', id: 'sem-trace', method: 'SendMessage', params: { message: { messageId: 'msg-sem-trace', role: 'ROLE_USER', parts: [{ text: pedido('sala-fusca', dia, '10:00', '11:00', 'X') }] } } }, { traceparent: 'lixo' });
    const novas = mcp.saida.texto.slice(antes).split(/\r?\n/).filter((l) => l.startsWith('[mcp] recv'));
    assert.ok(novas.length >= 3);
    for (const l of novas) assert.match(l, /traceparent=-$/);
  });
});

describe('isolamento entre Tasks', () => {
  test('duas Tasks simultâneas: ids, contexto, histórico e artifact de cada uma', async () => {
    const [ra, rb] = await Promise.all([
      enviar(pedido('sala-aquario', '11', '14:00', '15:00', 'George')),
      enviar(pedido('sala-porao', '11', '16:00', '17:00', 'Biff')),
    ]);
    const a = ra.corpo.result.task;
    const b = rb.corpo.result.task;
    assert.deepEqual([a.status.state, b.status.state], ['TASK_STATE_COMPLETED', 'TASK_STATE_COMPLETED']);
    assert.notEqual(a.id, b.id);
    assert.notEqual(a.contextId, b.contextId);
    const [xa, xb] = [conteudoDoArtifact(a), conteudoDoArtifact(b)];
    assert.deepEqual([xa.sala, xa.responsavel, xa.inicio], ['sala-aquario', 'George', em('11', '14:00')]);
    assert.deepEqual([xb.sala, xb.responsavel, xb.inicio], ['sala-porao', 'Biff', em('11', '16:00')]);
    assert.notEqual(xa.reserva, xb.reserva);
    assert.ok(textoDe(a.history[0]).includes('George') && !textoDe(a.history[0]).includes('Biff'));
    const ga = (await getTask(a.id)).corpo.result;
    assert.equal((ga.task ?? ga).history.length, 2);
  });
});

describe('MCP indisponível', () => {
  test('o agente sobe sem o MCP, responde o card, falha a Task sem cair e reconecta quando o MCP volta', async () => {
    const porta = await portaLivre();
    const url = new URL(`http://localhost:${porta}/mcp`);
    const sozinho = await subirAgente(url);
    try {
      assert.equal((await fetch(new URL('/.well-known/agent-card.json', sozinho.url))).status, 200);
      const msg = (texto: string) => ({ jsonrpc: '2.0', id: 1, method: 'SendMessage', params: { message: { messageId: `m-${texto}`, role: 'ROLE_USER', parts: [{ text: texto }] } } });
      const r1 = await rpc(sozinho.url, msg(pedido('sala-aquario', '12', '10:00', '11:00', 'Igor')));
      assert.equal(r1.corpo.result.task.status.state, 'TASK_STATE_FAILED');
      assert.equal(textoDe(r1.corpo.result.task.status.message), 'Servidor de reservas indisponivel no momento.');
      assert.equal(sozinho.processo.exitCode, null, 'o processo continua no ar');

      const tardio = await subirServidor({ MCP_PORT: String(porta) });
      try {
        const r2 = await rpc(sozinho.url, msg(pedido('sala-aquario', '12', '11:00', '12:00', 'Igor')));
        assert.equal(r2.corpo.result.task.status.state, 'TASK_STATE_COMPLETED');
      } finally {
        await tardio.parar();
      }
      const r3 = await rpc(sozinho.url, msg(pedido('sala-aquario', '12', '12:00', '13:00', 'Igor')));
      assert.equal(r3.corpo.result.task.status.state, 'TASK_STATE_FAILED', 'MCP caiu de novo: falha de transporte, sem derrubar o agente');
    } finally {
      await sozinho.parar();
    }
  });
});

describe('descoberta', () => {
  test('no log do MCP, tools/list vem antes do primeiro tools/call', () => {
    const linhas = mcp.saida.texto.split(/\r?\n/);
    const lista = linhas.findIndex((l) => l.includes('recv method=tools/list'));
    const chamada = linhas.findIndex((l) => l.includes('recv method=tools/call'));
    assert.ok(lista >= 0 && chamada > lista);
  });
});
