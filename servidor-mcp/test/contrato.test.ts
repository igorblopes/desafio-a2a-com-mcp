// Testes de contrato do servidor MCP: sobem o processo real (src/main.ts) numa
// porta livre e conversam com ele por HTTP, exatamente como o validador e o
// agente farão. Nada é simulado; o stderr do processo é capturado para
// conferir os logs. Executar: npm test
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const raiz = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dados = path.resolve(raiz, '..', 'dados');
const SALAS = JSON.parse(readFileSync(path.join(dados, 'salas.json'), 'utf8'));
const RESERVAS = JSON.parse(readFileSync(path.join(dados, 'reservas.json'), 'utf8'));
const POLITICA = readFileSync(path.join(dados, 'politica-de-uso.md'), 'utf8');
const PROTOCOLO = '2026-07-28';
const TRACEPARENT = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01';

let processo: ChildProcess;
let url = '';
let proximoId = 1;

function portaLivre(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, () => {
      const { port } = s.address() as { port: number };
      s.close(() => resolve(port));
    });
  });
}

/** Sobe src/main.ts numa porta livre e espera o "[mcp] pronto". */
async function subirServidor(env: Record<string, string> = {}) {
  const porta = await portaLivre();
  const filho = spawn(process.execPath, ['--import', 'tsx', 'src/main.ts'], {
    cwd: raiz,
    env: { ...process.env, MCP_PORT: String(porta), ...env },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  const saida = { texto: '' };
  await new Promise<void>((resolve, reject) => {
    const limite = setTimeout(() => reject(new Error(`servidor não subiu:\n${saida.texto}`)), 15000);
    filho.stderr!.on('data', (parte: Buffer) => {
      saida.texto += parte.toString('utf8');
      if (saida.texto.includes('[mcp] pronto')) {
        clearTimeout(limite);
        resolve();
      }
    });
    filho.once('exit', (codigo) => reject(new Error(`servidor saiu (${codigo}):\n${saida.texto}`)));
  });
  return { url: `http://localhost:${porta}/mcp`, processo: filho, saida };
}

let saidaPrincipal = { texto: '' };
before(async () => {
  const s = await subirServidor();
  processo = s.processo;
  url = s.url;
  saidaPrincipal = s.saida;
});

after(() => {
  processo?.kill();
});

type Opcoes = {
  url?: string;
  nome?: string;
  omitir?: 'protocolVersion' | 'clientCapabilities';
  traceparent?: string;
  headers?: Record<string, string>;
};

async function mcp(metodo: string, params: Record<string, unknown> = {}, op: Opcoes = {}) {
  const meta: Record<string, unknown> = {
    'io.modelcontextprotocol/protocolVersion': PROTOCOLO,
    'io.modelcontextprotocol/clientCapabilities': { elicitation: { form: {} } },
  };
  if (op.omitir) delete meta[`io.modelcontextprotocol/${op.omitir}`];
  if (op.traceparent) meta.traceparent = op.traceparent;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    'MCP-Protocol-Version': PROTOCOLO,
    'Mcp-Method': metodo,
    ...(op.nome ? { 'Mcp-Name': op.nome } : {}),
    ...op.headers,
  };
  const id = proximoId++;
  const r = await fetch(op.url ?? url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', id, method: metodo, params: { ...params, _meta: meta } }),
  });
  return { id, status: r.status, corpo: (await r.json()) as any };
}

// ---------- descoberta de capabilities ----------

test('server/discover anuncia tools e resources, e nada além', async () => {
  const { status, corpo } = await mcp('server/discover');
  assert.equal(status, 200);
  assert.deepEqual(Object.keys(corpo.result.capabilities).sort(), ['resources', 'tools']);
  assert.deepEqual(corpo.result.supportedVersions, [PROTOCOLO]);
});

test('prompts não são oferecidos (-32601)', async () => {
  const { corpo } = await mcp('prompts/list');
  assert.equal(corpo.error?.code, -32601);
});

// ---------- listar_salas ----------

test('tools/list descobre listar_salas com inputSchema e outputSchema', async () => {
  const { status, corpo } = await mcp('tools/list');
  assert.equal(status, 200);
  assert.equal(corpo.result.resultType, 'complete');
  const tool = corpo.result.tools.find((t: any) => t.name === 'listar_salas');
  assert.ok(tool, 'listar_salas ausente');
  assert.equal(tool.inputSchema.type, 'object');
  assert.deepEqual(tool.inputSchema.properties, {});

  const out = tool.outputSchema;
  assert.equal(out.type, 'object');
  assert.deepEqual(out.required, ['salas']);
  assert.equal(out.properties.salas.type, 'array');
  const sala = out.properties.salas.items;
  assert.deepEqual([...sala.required].sort(), ['capacidade', 'id', 'nome', 'recursos']);
  assert.equal(sala.properties.id.type, 'string');
  assert.equal(sala.properties.nome.type, 'string');
  assert.equal(sala.properties.capacidade.type, 'integer');
  assert.equal(sala.properties.recursos.type, 'array');
  assert.equal(sala.properties.recursos.items.type, 'string');
});

test('tools/call listar_salas devolve as 5 salas do arquivo, estruturado e em texto', async () => {
  const { status, corpo } = await mcp('tools/call', { name: 'listar_salas', arguments: {} }, { nome: 'listar_salas' });
  assert.equal(status, 200);
  const r = corpo.result;
  assert.equal(r.resultType, 'complete');
  assert.notEqual(r.isError, true);
  assert.deepEqual(r.structuredContent, { salas: SALAS });
  assert.equal(r.structuredContent.salas.length, 5);
  for (const s of r.structuredContent.salas) {
    assert.equal(typeof s.id, 'string');
    assert.equal(typeof s.nome, 'string');
    assert.ok(Number.isInteger(s.capacidade));
    assert.ok(Array.isArray(s.recursos) && s.recursos.every((x: unknown) => typeof x === 'string'));
  }
  const textos = r.content.filter((c: any) => c.type === 'text');
  assert.equal(textos.length, 1);
  assert.deepEqual(JSON.parse(textos[0].text), r.structuredContent);
});

test('tool inexistente é recusada com -32602', async () => {
  const { corpo } = await mcp('tools/call', { name: 'voar_delorean', arguments: {} }, { nome: 'voar_delorean' });
  assert.equal(corpo.error?.code, -32602);
  assert.equal(corpo.result, undefined);
});

// ---------- consultar_disponibilidade ----------

const DIA = (hora: string) => `2026-11-03T${hora}:00-03:00`;

async function consultar(sala: string, inicio: string, fim: string, op: Opcoes = {}) {
  return mcp('tools/call', { name: 'consultar_disponibilidade', arguments: { sala, inicio, fim } }, { nome: 'consultar_disponibilidade', ...op });
}

test('tools/list descobre consultar_disponibilidade com sala, inicio e fim obrigatórios', async () => {
  const { corpo } = await mcp('tools/list');
  const tool = corpo.result.tools.find((t: any) => t.name === 'consultar_disponibilidade');
  assert.ok(tool, 'consultar_disponibilidade ausente');
  assert.equal(tool.inputSchema.type, 'object');
  assert.deepEqual([...tool.inputSchema.required].sort(), ['fim', 'inicio', 'sala']);
  for (const campo of ['sala', 'inicio', 'fim']) assert.equal(tool.inputSchema.properties[campo].type, 'string');
  const out = tool.outputSchema;
  assert.deepEqual([...out.required].sort(), ['conflitos', 'livre', 'sala']);
  assert.equal(out.properties.livre.type, 'boolean');
  assert.deepEqual([...out.properties.conflitos.items.required].sort(), ['fim', 'id', 'inicio', 'responsavel']);
});

test('A: sala livre → livre: true, sem conflitos, texto igual ao structuredContent', async () => {
  const { status, corpo } = await consultar('sala-aquario', DIA('09:00'), DIA('10:00'));
  assert.equal(status, 200);
  const r = corpo.result;
  assert.equal(r.resultType, 'complete');
  assert.notEqual(r.isError, true);
  assert.deepEqual(r.structuredContent, { sala: 'sala-aquario', livre: true, conflitos: [] });
  assert.deepEqual(JSON.parse(r.content[0].text), r.structuredContent);
});

test('B: sala-garagem 14:00–15:00 → ocupada, com res-0001 (como em dados/reservas.json)', async () => {
  const { corpo } = await consultar('sala-garagem', DIA('14:00'), DIA('15:00'));
  const r = corpo.result;
  assert.notEqual(r.isError, true);
  assert.deepEqual(r.structuredContent, {
    sala: 'sala-garagem',
    livre: false,
    conflitos: [RESERVAS.find((x: any) => x.id === 'res-0001')].map(({ id, inicio, fim, responsavel }: any) => ({ id, inicio, fim, responsavel })),
  });
  assert.deepEqual(JSON.parse(r.content[0].text), r.structuredContent);
});

test('B: adjacente (15:00–16:00) e a mesma hora em outra sala ficam livres', async () => {
  assert.equal((await consultar('sala-garagem', DIA('15:00'), DIA('16:00'))).corpo.result.structuredContent.livre, true);
  assert.equal((await consultar('sala-porao', DIA('14:00'), DIA('15:00'))).corpo.result.structuredContent.livre, true);
});

test('B: o mesmo instante em UTC também conflita', async () => {
  const { corpo } = await consultar('sala-garagem', '2026-11-03T17:30:00Z', '2026-11-03T18:30:00Z');
  assert.equal(corpo.result.structuredContent.livre, false);
});

const ERROS: Array<[string, string, string, string, string]> = [
  ['C: sala inexistente', 'sala-inexistente', DIA('09:00'), DIA('10:00'), 'Sala inexistente: sala-inexistente'],
  ['D: antes das 08:00', 'sala-aquario', DIA('07:00'), DIA('08:00'), 'Fora da janela de uso: a politica permite reservas entre 08:00 e 20:00'],
  ['D: depois das 20:00', 'sala-aquario', DIA('19:30'), DIA('20:30'), 'Fora da janela de uso: a politica permite reservas entre 08:00 e 20:00'],
  ['E: mais de 2h', 'sala-aquario', DIA('09:00'), DIA('12:00'), 'Duracao acima do limite: a politica permite no maximo 2 horas'],
  ['F: fim antes do início', 'sala-aquario', DIA('10:00'), DIA('09:00'), 'Intervalo invalido: fim deve ser posterior a inicio'],
  ['F: fim igual ao início', 'sala-aquario', DIA('10:00'), DIA('10:00'), 'Intervalo invalido: fim deve ser posterior a inicio'],
];
for (const [nome, sala, inicio, fim, mensagem] of ERROS) {
  test(`${nome} → isError: true com a mensagem exata (erro de execução, não de protocolo)`, async () => {
    const { status, corpo } = await consultar(sala, inicio, fim);
    assert.equal(status, 200);
    assert.equal(corpo.error, undefined);
    assert.equal(corpo.result.resultType, 'complete');
    assert.equal(corpo.result.isError, true);
    assert.equal(corpo.result.content[0].text, mensagem);
    assert.equal(corpo.result.structuredContent, undefined);
  });
}

test('data sem offset é recusada pelo inputSchema (isError, sem consultar a agenda)', async () => {
  const { corpo } = await consultar('sala-aquario', '2026-11-03T09:00:00', '2026-11-03T10:00:00');
  assert.equal(corpo.result.isError, true);
  assert.match(corpo.result.content[0].text, /Input validation error/);
});

test('G: consultar_disponibilidade sem clientCapabilities → HTTP 400 e -32602', async () => {
  const { status, corpo } = await consultar('sala-aquario', DIA('09:00'), DIA('10:00'), { omitir: 'clientCapabilities' });
  assert.equal(status, 400);
  assert.equal(corpo.error?.code, -32602);
});

// ---------- reservar_sala ----------
// Estes testes ALTERAM a agenda do servidor. Usam o dia 04/11/2026, que não
// aparece em nenhum outro teste nem em dados/reservas.json, para não
// interferir nos cenários de consultar_disponibilidade (dia 03/11).

const DIA4 = (hora: string) => `2026-11-04T${hora}:00-03:00`;
const VERSAO = readFileSync(path.join(dados, 'politica-de-uso.md'), 'utf8').split(/\r?\n/, 1)[0].replace(/^versao:\s*/, '').trim();

async function reservar(sala: string, inicio: string, fim: string, responsavel = 'Doc', op: Opcoes = {}) {
  return mcp('tools/call', { name: 'reservar_sala', arguments: { sala, inicio, fim, responsavel } }, { nome: 'reservar_sala', ...op });
}

test('A: tools/list traz as três tools; reservar_sala com os 4 argumentos obrigatórios', async () => {
  const { corpo } = await mcp('tools/list');
  assert.deepEqual(corpo.result.tools.map((t: any) => t.name).sort(), ['consultar_disponibilidade', 'listar_salas', 'reservar_sala']);
  const tool = corpo.result.tools.find((t: any) => t.name === 'reservar_sala');
  assert.equal(tool.inputSchema.type, 'object');
  assert.deepEqual([...tool.inputSchema.required].sort(), ['fim', 'inicio', 'responsavel', 'sala']);
  for (const campo of ['sala', 'inicio', 'fim', 'responsavel']) assert.equal(tool.inputSchema.properties[campo].type, 'string');
  assert.deepEqual(
    Object.keys(tool.outputSchema.properties).sort(),
    ['fim', 'inicio', 'motivo', 'politica', 'reserva', 'reservado', 'responsavel', 'sala'],
  );
});

test('B + C: reserva válida conclui com os 8 campos e a consulta seguinte já a enxerga', async () => {
  const { status, corpo } = await reservar('sala-aquario', DIA4('09:00'), DIA4('10:00'), 'Doc');
  assert.equal(status, 200);
  const r = corpo.result;
  assert.equal(r.resultType, 'complete');
  assert.notEqual(r.isError, true);
  const sc = r.structuredContent;
  assert.match(sc.reserva, /^res-\d{4}$/);
  assert.deepEqual(sc, {
    reserva: sc.reserva,
    reservado: true,
    sala: 'sala-aquario',
    inicio: DIA4('09:00'),
    fim: DIA4('10:00'),
    responsavel: 'Doc',
    politica: VERSAO,
    motivo: null,
  });
  assert.equal(r.content[0].text, JSON.stringify(sc, null, 2));

  const consulta = await consultar('sala-aquario', DIA4('09:00'), DIA4('10:00'));
  assert.deepEqual(consulta.corpo.result.structuredContent, {
    sala: 'sala-aquario',
    livre: false,
    conflitos: [{ id: sc.reserva, inicio: DIA4('09:00'), fim: DIA4('10:00'), responsavel: 'Doc' }],
  });
});

test('D: reservas sequenciais recebem ids distintos e crescentes, e todas continuam na agenda', async () => {
  const a = (await reservar('sala-porao', DIA4('10:00'), DIA4('11:00'), 'Marty')).corpo.result.structuredContent;
  const b = (await reservar('sala-porao', DIA4('11:00'), DIA4('12:00'), 'Jennifer')).corpo.result.structuredContent; // adjacente: não conflita
  assert.equal(a.reservado, true);
  assert.equal(b.reservado, true);
  assert.notEqual(a.reserva, b.reserva);
  assert.equal(Number(b.reserva.slice(4)), Number(a.reserva.slice(4)) + 1);
  const consulta = await consultar('sala-porao', DIA4('10:00'), DIA4('12:00'));
  assert.deepEqual(consulta.corpo.result.structuredContent.conflitos.map((c: any) => c.id), [a.reserva, b.reserva]);
});

const ERROS_RESERVA: Array<[string, string, string, string, string]> = [
  ['E: sala inexistente', 'sala-delorean', DIA4('09:00'), DIA4('10:00'), 'Sala inexistente: sala-delorean'],
  ['F: intervalo invertido', 'sala-mirante', DIA4('10:00'), DIA4('09:00'), 'Intervalo invalido: fim deve ser posterior a inicio'],
  ['G: fora da janela', 'sala-mirante', DIA4('07:00'), DIA4('08:00'), 'Fora da janela de uso: a politica permite reservas entre 08:00 e 20:00'],
  ['H: duração acima de 2h', 'sala-mirante', DIA4('09:00'), DIA4('12:00'), 'Duracao acima do limite: a politica permite no maximo 2 horas'],
];
for (const [nome, sala, inicio, fim, mensagem] of ERROS_RESERVA) {
  test(`${nome} → isError com a mensagem exata e nenhuma reserva criada`, async () => {
    const { status, corpo } = await reservar(sala, inicio, fim);
    assert.equal(status, 200);
    assert.equal(corpo.result.isError, true);
    assert.equal(corpo.result.content[0].text, mensagem);
    assert.equal(corpo.result.structuredContent, undefined);
    if (sala === 'sala-mirante') {
      const c = await consultar('sala-mirante', DIA4('08:00'), DIA4('10:00'));
      assert.deepEqual(c.corpo.result.structuredContent.conflitos, []);
    }
  });
}

test('I (PROVISÓRIO até o Passo 7): conflito não cria reserva nem corrompe a agenda', async () => {
  // Isto NÃO é o comportamento final: no Passo 7 o conflito vira input_required (MRTR).
  const antes = (await consultar('sala-garagem', '2026-11-03T13:00:00-03:00', '2026-11-03T15:00:00-03:00')).corpo.result.structuredContent;
  const { corpo } = await reservar('sala-garagem', '2026-11-03T14:00:00-03:00', '2026-11-03T15:00:00-03:00', 'Biff');
  assert.equal(corpo.result.isError, true);
  assert.match(corpo.result.content[0].text, /provisorio/);
  assert.notEqual(corpo.result.resultType, 'input_required');
  assert.equal(corpo.result.requestState, undefined);
  const depois = (await consultar('sala-garagem', '2026-11-03T13:00:00-03:00', '2026-11-03T15:00:00-03:00')).corpo.result.structuredContent;
  assert.deepEqual(depois, antes);
});

test('J: reservar_sala sem protocolVersion → HTTP 400 e -32602; Mcp-Name divergente → -32020', async () => {
  const a = await reservar('sala-aquario', DIA4('15:00'), DIA4('16:00'), 'Doc', { omitir: 'protocolVersion' });
  assert.equal(a.status, 400);
  assert.equal(a.corpo.error?.code, -32602);
  const b = await reservar('sala-aquario', DIA4('15:00'), DIA4('16:00'), 'Doc', { nome: 'listar_salas' });
  assert.equal(b.status, 400);
  assert.equal(b.corpo.error?.code, -32020);
  // Nenhuma das duas chegou à tool: o horário continua livre.
  assert.equal((await consultar('sala-aquario', DIA4('15:00'), DIA4('16:00'))).corpo.result.structuredContent.livre, true);
});

test('reinício: um processo novo só conhece as reservas de dados/reservas.json', async () => {
  const criada = (await reservar('sala-fusca', DIA4('16:00'), DIA4('17:00'), 'Doc')).corpo.result.structuredContent;
  assert.equal(criada.reservado, true);
  const outro = await subirServidor();
  try {
    const consulta = await mcp(
      'tools/call',
      { name: 'consultar_disponibilidade', arguments: { sala: 'sala-fusca', inicio: DIA4('16:00'), fim: DIA4('17:00') } },
      { nome: 'consultar_disponibilidade', url: outro.url },
    );
    assert.equal(consulta.corpo.result.structuredContent.livre, true);
    const inicial = await mcp(
      'tools/call',
      { name: 'consultar_disponibilidade', arguments: { sala: 'sala-garagem', inicio: '2026-11-03T14:00:00-03:00', fim: '2026-11-03T15:00:00-03:00' } },
      { nome: 'consultar_disponibilidade', url: outro.url },
    );
    assert.deepEqual(inicial.corpo.result.structuredContent.conflitos.map((c: any) => c.id), ['res-0001']);
    assert.match(outro.saida.texto, /reservas=2 /);
  } finally {
    outro.processo.kill();
  }
});

test('politica vem do arquivo: com outra versão em DADOS_DIR, a reserva traz a outra versão', async () => {
  const pasta = mkdtempSync(path.join(tmpdir(), 'dados-'));
  cpSync(dados, pasta, { recursive: true });
  const original = readFileSync(path.join(pasta, 'politica-de-uso.md'), 'utf8');
  writeFileSync(path.join(pasta, 'politica-de-uso.md'), original.replace(/^versao:[^\r\n]*/, 'versao: 2099-12-31'));
  const outro = await subirServidor({ DADOS_DIR: pasta });
  try {
    const { corpo } = await mcp(
      'tools/call',
      { name: 'reservar_sala', arguments: { sala: 'sala-aquario', inicio: DIA4('09:00'), fim: DIA4('10:00'), responsavel: 'Doc' } },
      { nome: 'reservar_sala', url: outro.url },
    );
    assert.equal(corpo.result.structuredContent.politica, '2099-12-31');
  } finally {
    outro.processo.kill();
    rmSync(pasta, { recursive: true, force: true });
  }
});

// ---------- resources ----------

test('resources/list descobre politica://uso com nome e mimeType', async () => {
  const { status, corpo } = await mcp('resources/list');
  assert.equal(status, 200);
  assert.equal(corpo.result.resources.length, 1);
  const [r] = corpo.result.resources;
  assert.equal(r.uri, 'politica://uso');
  assert.equal(r.name, 'politica-de-uso');
  assert.equal(r.mimeType, 'text/markdown');
});

test('resources/read de politica://uso devolve o arquivo inteiro, byte a byte', async () => {
  const lista = await mcp('resources/list');
  const descoberto = lista.corpo.result.resources[0];
  const { status, corpo } = await mcp('resources/read', { uri: descoberto.uri }, { nome: descoberto.uri });
  assert.equal(status, 200);
  assert.equal(corpo.result.contents.length, 1);
  const [c] = corpo.result.contents;
  assert.equal(c.uri, descoberto.uri);
  assert.equal(c.mimeType, descoberto.mimeType);
  assert.equal(c.text, POLITICA);
  // \r?\n: no Windows com core.autocrlf=true, dados/ fica em CRLF na cópia de trabalho.
  assert.match(c.text.split(/\r?\n/, 1)[0], /^versao: \d{4}-\d{2}-\d{2}$/);
});

test('resources/read de URI inexistente é erro -32602, não contents vazio', async () => {
  const uri = 'politica://inexistente';
  const { corpo } = await mcp('resources/read', { uri }, { nome: uri });
  assert.equal(corpo.error?.code, -32602);
  assert.equal(corpo.result, undefined);
});

// ---------- metadados e headers ----------

for (const metodo of ['tools/list', 'tools/call', 'resources/list', 'resources/read'] as const) {
  const params =
    metodo === 'tools/call' ? { name: 'listar_salas', arguments: {} }
    : metodo === 'resources/read' ? { uri: 'politica://uso' }
    : {};
  const nome = metodo === 'tools/call' ? 'listar_salas' : metodo === 'resources/read' ? 'politica://uso' : undefined;

  for (const omitir of ['protocolVersion', 'clientCapabilities'] as const) {
    test(`${metodo} sem ${omitir} → HTTP 400 e -32602`, async () => {
      const { status, corpo } = await mcp(metodo, params, { nome, omitir });
      assert.equal(status, 400);
      assert.equal(corpo.error?.code, -32602);
    });
  }
}

test('Mcp-Name divergente da URI → HTTP 400 e -32020', async () => {
  const { status, corpo } = await mcp('resources/read', { uri: 'politica://uso' }, { nome: 'politica://outra' });
  assert.equal(status, 400);
  assert.equal(corpo.error?.code, -32020);
});

test('resources/read sem Mcp-Name → HTTP 400 e -32020', async () => {
  const { status, corpo } = await mcp('resources/read', { uri: 'politica://uso' });
  assert.equal(status, 400);
  assert.equal(corpo.error?.code, -32020);
});

test('Mcp-Method divergente do corpo → HTTP 400 e -32020', async () => {
  const { status, corpo } = await mcp('resources/list', {}, { headers: { 'Mcp-Method': 'tools/list' } });
  assert.equal(status, 400);
  assert.equal(corpo.error?.code, -32020);
});

// ---------- logs ----------

test('stderr registra método, id e traceparent de cada operação', async () => {
  const chamadas: Array<[string, Record<string, unknown>, string?]> = [
    ['tools/list', {}],
    ['tools/call', { name: 'listar_salas', arguments: {} }, 'listar_salas'],
    ['resources/list', {}],
    ['resources/read', { uri: 'politica://uso' }, 'politica://uso'],
    ['tools/call', { name: 'consultar_disponibilidade', arguments: { sala: 'sala-garagem', inicio: DIA('14:00'), fim: DIA('15:00') } }, 'consultar_disponibilidade'],
    ['tools/call', { name: 'reservar_sala', arguments: { sala: 'sala-delorean', inicio: DIA('09:00'), fim: DIA('10:00'), responsavel: 'Doc' } }, 'reservar_sala'],
  ];
  for (const [metodo, params, nome] of chamadas) {
    const { id } = await mcp(metodo, params, { nome, traceparent: TRACEPARENT });
    assert.ok(
      saidaPrincipal.texto.includes(`[mcp] recv method=${metodo} id=${id} name=${nome ?? '-'} traceparent=${TRACEPARENT}`),
      `log ausente para ${metodo} id=${id}`,
    );
  }

  // Sem traceparent no _meta: o log mostra "-", nada é inventado.
  const { id } = await mcp('resources/list');
  assert.ok(saidaPrincipal.texto.includes(`[mcp] recv method=resources/list id=${id} name=- traceparent=-`));

  // Request inválido também aparece, seguido da rejeição.
  const invalido = await mcp('resources/read', { uri: 'politica://uso' }, { nome: 'politica://uso', omitir: 'clientCapabilities', traceparent: TRACEPARENT });
  assert.ok(saidaPrincipal.texto.includes(`[mcp] recv method=resources/read id=${invalido.id} name=politica://uso traceparent=${TRACEPARENT}`));
  assert.match(saidaPrincipal.texto, /\[mcp\] rejeitado .*clientCapabilities/);
});
