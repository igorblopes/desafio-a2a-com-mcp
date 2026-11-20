// Passo 12: falhas de infraestrutura entre o agente e o servidor MCP.
//
// Um "proxy de falhas" HTTP fica entre o agente e o servidor MCP REAL:
// repassa tudo sem tocar (server/discover, tools/list, resources/read) e, no
// tools/call, injeta UMA falha por vez (HTTP 500 em HTML, corpo que não é
// JSON, JSON que não é JSON-RPC, resposta com outro id, resultado de reserva
// incompleto, silêncio). Não é mock: o fio é HTTP de verdade, o cliente MCP
// e o agente são os de produção, e o servidor real responde o resto.
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { ConexaoMcp, MENSAGEM_SEM_MCP, MENSAGEM_SEM_RESPOSTA, ServicoDeReserva, type Desfecho } from '../src/a2a/reserva.ts';
import { lerConfig, TIMEOUT_MCP_PADRAO_MS } from '../src/config.ts';
import { portaLivre, rpc, subirAgente, subirServidor, type ServidorDeTeste } from './apoio.ts';

type Falha = 'nenhuma' | 'html500' | 'nao-json' | 'nao-jsonrpc' | 'outro-id' | 'incompleto' | 'silencio';

let mcp: ServidorDeTeste;
let proxy: Server;
let urlDoProxy: URL;
let falha: Falha = 'nenhuma';
let chamadasRepassadas = 0;

before(async () => {
  mcp = await subirServidor();
  const porta = await portaLivre();
  proxy = createServer(async (req, res) => {
    const partes: Buffer[] = [];
    for await (const p of req) partes.push(p as Buffer);
    const corpo = Buffer.concat(partes);
    const msg = JSON.parse(corpo.toString('utf8'));
    if (msg.method === 'tools/call' && falha !== 'nenhuma') {
      const json = (x: unknown) => res.writeHead(200, { 'content-type': 'application/json' }).end(typeof x === 'string' ? x : JSON.stringify(x));
      switch (falha) {
        case 'html500':
          return void res.writeHead(500, { 'content-type': 'text/html' }).end('<h1>erro interno</h1>');
        case 'nao-json':
          return void json('{quebrado');
        case 'nao-jsonrpc':
          return void json({ ola: 'mundo' });
        case 'outro-id':
          return void json({ jsonrpc: '2.0', id: 'nao-e-o-seu', result: { content: [] } });
        case 'incompleto':
          return void json({ jsonrpc: '2.0', id: msg.id, result: { resultType: 'complete', content: [{ type: 'text', text: 'ok' }], structuredContent: { reservado: true, reserva: 'res-9999' } } });
        case 'silencio':
          return; // aceita a conexão e nunca responde
      }
    }
    if (msg.method === 'tools/call') chamadasRepassadas++;
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) if (v !== undefined && k !== 'host' && k !== 'content-length') headers[k] = String(v);
    const r = await fetch(mcp.url, { method: 'POST', headers, body: corpo });
    res.writeHead(r.status, Object.fromEntries(r.headers)).end(Buffer.from(await r.arrayBuffer()));
  });
  await new Promise<void>((ok) => proxy.listen(porta, ok));
  urlDoProxy = new URL(`http://localhost:${porta}/mcp`);
});
after(async () => {
  proxy?.closeAllConnections();
  await new Promise((ok) => proxy?.close(ok));
  await mcp?.parar();
});

const em = (dia: string, hora: string) => `2026-12-${dia}T${hora}:00-03:00`;
let dia = 1;
const pedidoLivre = () => {
  const d = String(dia++).padStart(2, '0');
  return { sala: 'sala-porao', inicio: em(d, '10:00'), fim: em(d, '11:00'), responsavel: 'Falhas' };
};

describe('configuração do timeout', () => {
  test('MCP_TIMEOUT_MS: padrão 20 s, aceita 1000..120000, recusa o resto', () => {
    assert.equal(lerConfig({}).timeoutMs, TIMEOUT_MCP_PADRAO_MS);
    assert.equal(TIMEOUT_MCP_PADRAO_MS, 20_000);
    assert.equal(lerConfig({ MCP_TIMEOUT_MS: '1500' }).timeoutMs, 1500);
    for (const ruim of ['0', '999', '120001', 'abc', '1.5']) assert.throws(() => lerConfig({ MCP_TIMEOUT_MS: ruim }), /MCP_TIMEOUT_MS/, ruim);
  });
});

describe('falhas no tools/call: nada vira COMPLETED sem confirmação do MCP', () => {
  const linhas: string[] = [];
  const servico = () => new ServicoDeReserva(new ConexaoMcp({ url: urlDoProxy, timeoutMs: 1500 }), (l) => linhas.push(l));
  const casos: [Falha, (d: Desfecho) => void][] = [
    ['html500', (d) => assert.deepEqual(d, { tipo: 'falhou', motivo: 'transporte', mensagem: MENSAGEM_SEM_MCP })],
    ['nao-json', (d) => assert.equal(d.tipo === 'falhou' && d.motivo, 'resposta')],
    ['nao-jsonrpc', (d) => assert.equal(d.tipo === 'falhou' && d.motivo, 'resposta')],
    ['outro-id', (d) => assert.deepEqual(d, { tipo: 'falhou', motivo: 'transporte', mensagem: MENSAGEM_SEM_RESPOSTA })],
    ['incompleto', (d) => assert.deepEqual(d, { tipo: 'falhou', motivo: 'resposta', mensagem: 'O servidor de reservas respondeu sem os dados completos da reserva.' })],
    ['silencio', (d) => assert.deepEqual(d, { tipo: 'falhou', motivo: 'transporte', mensagem: MENSAGEM_SEM_RESPOSTA })],
  ];
  for (const [nome, conferir] of casos) {
    test(`${nome} → falhou`, async () => {
      falha = nome;
      try {
        const inicio = Date.now();
        const d = await servico().reservar(pedidoLivre(), { operacao: `falha-${nome}` });
        conferir(d);
        assert.ok(Date.now() - inicio < 5000, 'não fica pendurado além do timeout');
      } finally {
        falha = 'nenhuma';
      }
    });
  }
  test('o log de cada falha é uma linha curta, sem o corpo inteiro do erro', () => {
    assert.ok(linhas.length >= 6);
    for (const l of linhas) {
      assert.ok(!l.includes('\n'), l);
      assert.ok(l.length < 320, l);
    }
  });
  test('depois das falhas, o mesmo serviço volta a reservar normalmente', async () => {
    const d = await servico().reservar(pedidoLivre(), { operacao: 'depois' });
    assert.equal(d.tipo, 'concluida');
  });
});

describe('agente A2A real atrás do proxy de falhas', () => {
  let agente: ServidorDeTeste;
  before(async () => {
    agente = await subirAgente(urlDoProxy, { MCP_TIMEOUT_MS: '1500' });
  });
  after(async () => {
    await agente?.parar();
  });
  const enviar = (texto: string, taskId?: string) =>
    rpc(agente.url, { jsonrpc: '2.0', id: 'f', method: 'SendMessage', params: { message: { messageId: `m-${Math.random()}`, role: 'ROLE_USER', parts: [{ text: texto }], ...(taskId ? { taskId } : {}) } } });
  const textoDe = (t: { status: { message?: { parts: { text: string }[] } } }) => (t.status.message?.parts ?? []).map((p) => p.text).join('');
  const pedidoA2a = () => {
    const p = pedidoLivre();
    return `reservar sala=${p.sala} inicio=${p.inicio} fim=${p.fim} responsavel=${p.responsavel}`;
  };

  test('silêncio no tools/call: Task FAILED com mensagem honesta em ~1,5 s, agente no ar, GetTask estável', async () => {
    falha = 'silencio';
    try {
      const inicio = Date.now();
      const t = (await enviar(pedidoA2a())).corpo.result.task;
      assert.ok(Date.now() - inicio < 6000);
      assert.equal(t.status.state, 'TASK_STATE_FAILED');
      assert.equal(textoDe(t), MENSAGEM_SEM_RESPOSTA);
      assert.deepEqual(t.artifacts ?? [], []);
      assert.equal(agente.processo.exitCode, null);
      const g = (await rpc(agente.url, { jsonrpc: '2.0', id: 'g', method: 'GetTask', params: { id: t.id } })).corpo.result;
      assert.equal((g.task ?? g).status.state, 'TASK_STATE_FAILED');
    } finally {
      falha = 'nenhuma';
    }
  });

  test('resultado incompleto: FAILED, nunca COMPLETED com artifact pela metade', async () => {
    falha = 'incompleto';
    try {
      const t = (await enviar(pedidoA2a())).corpo.result.task;
      assert.equal(t.status.state, 'TASK_STATE_FAILED');
      assert.deepEqual(t.artifacts ?? [], []);
    } finally {
      falha = 'nenhuma';
    }
  });

  test('silêncio no RETRY: a Task pausada termina FAILED, sem reenvio automático e sem nova retomada', async () => {
    // ocupa e pausa (sem falha)
    const p = pedidoLivre();
    const texto = `reservar sala=sala-garagem inicio=${p.inicio} fim=${p.fim} responsavel=`;
    assert.equal((await enviar(texto + 'Ocupa')).corpo.result.task.status.state, 'TASK_STATE_COMPLETED');
    const pausada = (await enviar(texto + 'Retry')).corpo.result.task;
    assert.equal(pausada.status.state, 'TASK_STATE_INPUT_REQUIRED');
    const alt = textoDe(pausada).replace('alternativas: ', '').split(', ')[0];
    const antes = chamadasRepassadas;
    falha = 'silencio';
    try {
      const r = (await enviar(`escolha=${alt}`, pausada.id)).corpo.result.task;
      assert.equal(r.status.state, 'TASK_STATE_FAILED');
      assert.equal(textoDe(r), MENSAGEM_SEM_RESPOSTA);
    } finally {
      falha = 'nenhuma';
    }
    assert.equal(chamadasRepassadas, antes, 'nenhum tools/call reenviado sozinho');
    assert.equal((await enviar(`escolha=${alt}`, pausada.id)).corpo.error.code, -32004, 'Task terminal não é retomada');
  });

  test('o agente continua atendendo depois de todas as falhas', async () => {
    const t = (await enviar(pedidoA2a())).corpo.result.task;
    assert.equal(t.status.state, 'TASK_STATE_COMPLETED');
  });
});
