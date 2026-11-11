// Testes do MRTR de reservar_sala contra o PROCESSO REAL, por HTTP, como o
// validador e o agente farão: conflito → input_required → retry (accept,
// decline, cancel), capabilities, requestState adulterado/expirado/forjado,
// argumentos adulterados, escolha inválida e retomada após restart.
//
// Cada cenário usa um DIA próprio (05 a 22/11/2026), porque os testes
// alteram a agenda do servidor e não podem interferir uns nos outros.
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequestStateCodec } from '@modelcontextprotocol/server';

const raiz = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROTOCOLO = '2026-07-28';
const COM_FORM = { elicitation: { form: {} } };
const SEGREDO = randomBytes(32).toString('hex'); // só desta execução
const MENSAGEM = 'A sala pedida esta ocupada nesse intervalo. Escolha uma alternativa.';
const VERSAO_POLITICA = '2026-11-01';

const em = (dia: string, hora: string) => `2026-11-${dia}T${hora}:00-03:00`;

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

type Processo = { url: string; processo: ChildProcess; saida: { texto: string } };

/** Sobe src/main.ts. Resolve no "[mcp] pronto"; se o processo sair antes, resolve com o código de saída. */
async function iniciar(env: Record<string, string>): Promise<Processo & { codigo?: number | null }> {
  const porta = await portaLivre();
  const filho = spawn(process.execPath, ['--import', 'tsx', 'src/main.ts'], {
    cwd: raiz,
    env: { ...process.env, MCP_PORT: String(porta), REQUEST_STATE_TTL_SECONDS: '', ...env },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  const saida = { texto: '' };
  const codigo = await new Promise<number | null | undefined>((resolve, reject) => {
    const limite = setTimeout(() => reject(new Error(`servidor não subiu:\n${saida.texto}`)), 15000);
    filho.stderr!.on('data', (parte: Buffer) => {
      saida.texto += parte.toString('utf8');
      if (saida.texto.includes('[mcp] pronto')) {
        clearTimeout(limite);
        resolve(undefined);
      }
    });
    filho.once('exit', (c) => {
      clearTimeout(limite);
      resolve(c);
    });
  });
  return { url: `http://localhost:${porta}/mcp`, processo: filho, saida, codigo };
}

async function subir(segredo = SEGREDO): Promise<Processo> {
  const p = await iniciar({ REQUEST_STATE_SECRET: segredo });
  if (p.codigo !== undefined) throw new Error(`servidor saiu (${p.codigo}):\n${p.saida.texto}`);
  return p;
}

let proximoId = 1000;

type Chamada = {
  arguments?: Record<string, unknown>;
  inputResponses?: Record<string, unknown>;
  requestState?: string;
  capabilities?: unknown; // undefined = { elicitation: { form: {} } }; null = omitir o campo
  nome?: string;
};

/** tools/call com id JSON-RPC sempre NOVO; devolve também o id usado. */
async function chamar(url: string, ferramenta: string, c: Chamada) {
  const meta: Record<string, unknown> = { 'io.modelcontextprotocol/protocolVersion': PROTOCOLO };
  if (c.capabilities !== null) meta['io.modelcontextprotocol/clientCapabilities'] = c.capabilities ?? COM_FORM;
  const params: Record<string, unknown> = { name: ferramenta, arguments: c.arguments ?? {}, _meta: meta };
  if (c.inputResponses) params.inputResponses = c.inputResponses;
  if (c.requestState !== undefined) params.requestState = c.requestState;
  const id = proximoId++;
  const r = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'MCP-Protocol-Version': PROTOCOLO,
      'Mcp-Method': 'tools/call',
      'Mcp-Name': c.nome ?? ferramenta,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params }),
  });
  return { id, status: r.status, corpo: (await r.json()) as any };
}

const args = (sala: string, inicio: string, fim: string, responsavel = 'Doc') => ({ sala, inicio, fim, responsavel });

function reservar(url: string, sala: string, inicio: string, fim: string, responsavel = 'Doc', extra: Chamada = {}) {
  return chamar(url, 'reservar_sala', { arguments: args(sala, inicio, fim, responsavel), ...extra });
}

/** Retry: mesmos name/arguments + inputResponses + requestState ecoado, id novo. */
function retomar(url: string, original: Record<string, unknown>, chave: string, resposta: unknown, requestState: string, extra: Chamada = {}) {
  return chamar(url, 'reservar_sala', { arguments: original, inputResponses: { [chave]: resposta }, requestState, ...extra });
}

async function idsNaSala(url: string, sala: string, dia: string) {
  const { corpo } = await chamar(url, 'consultar_disponibilidade', { arguments: { sala, inicio: em(dia, '08:00'), fim: em(dia, '10:00') } });
  const a = corpo.result.structuredContent.conflitos.map((c: any) => c.id);
  const { corpo: c2 } = await chamar(url, 'consultar_disponibilidade', { arguments: { sala, inicio: em(dia, '10:00'), fim: em(dia, '12:00') } });
  const b = c2.result.structuredContent.conflitos.map((c: any) => c.id);
  const { corpo: c3 } = await chamar(url, 'consultar_disponibilidade', { arguments: { sala, inicio: em(dia, '12:00'), fim: em(dia, '14:00') } });
  const c = c3.result.structuredContent.conflitos.map((c: any) => c.id);
  return [...a, ...b, ...c];
}

/** Ocupa a sala (caminho feliz) e devolve a pergunta do conflito seguinte, já conferida. */
async function conflito(url: string, sala: string, dia: string, responsavel = 'Doc') {
  const ocupa = await reservar(url, sala, em(dia, '10:00'), em(dia, '11:00'), 'Ocupante');
  assert.equal(ocupa.corpo.result.structuredContent.reservado, true);
  const r = await reservar(url, sala, em(dia, '10:00'), em(dia, '11:00'), responsavel);
  assert.equal(r.corpo.result.resultType, 'input_required', JSON.stringify(r.corpo));
  const chave = Object.keys(r.corpo.result.inputRequests)[0];
  return { r, chave, estado: r.corpo.result.requestState as string, original: args(sala, em(dia, '10:00'), em(dia, '11:00'), responsavel) };
}

function adulterar(estado: string): string {
  const i = Math.floor(estado.length / 2);
  return estado.slice(0, i) + (estado[i] === 'A' ? 'B' : 'A') + estado.slice(i + 1);
}

let s: Processo;
before(async () => {
  s = await subir();
});
after(() => s?.processo.kill());

// ---------- conflito → input_required ----------

describe('conflito → input_required', () => {
  test('garagem 14–15 (dados/reservas.json) → input_required, 1 entrada, elicitation form, enum [fusca, mirante]', async () => {
    const { status, corpo } = await reservar(s.url, 'sala-garagem', '2026-11-03T14:00:00-03:00', '2026-11-03T15:00:00-03:00', 'Marty');
    assert.equal(status, 200);
    const r = corpo.result;
    assert.equal(r.resultType, 'input_required');
    assert.equal(r.isError, undefined);
    assert.equal(r.structuredContent, undefined);
    assert.equal(typeof r.requestState, 'string');
    assert.match(r.requestState, /^v1\./);
    const chaves = Object.keys(r.inputRequests);
    assert.equal(chaves.length, 1);
    const pedido = r.inputRequests[chaves[0]];
    assert.equal(pedido.method, 'elicitation/create');
    assert.equal(pedido.params.mode, 'form');
    assert.equal(pedido.params.message, MENSAGEM);
    assert.deepEqual(pedido.params.requestedSchema, {
      type: 'object',
      properties: { sala: { type: 'string', title: 'Sala', description: 'Sala alternativa escolhida', enum: ['sala-fusca', 'sala-mirante'] } },
      required: ['sala'],
    });
    // Schema PLANO: nenhuma propriedade é objeto ou array.
    for (const p of Object.values<any>(pedido.params.requestedSchema.properties)) assert.ok(!['object', 'array'].includes(p.type));
    // Nada foi gravado: a garagem continua só com res-0001.
    const c = await chamar(s.url, 'consultar_disponibilidade', { arguments: { sala: 'sala-fusca', inicio: '2026-11-03T14:00:00-03:00', fim: '2026-11-03T15:00:00-03:00' } });
    assert.equal(c.corpo.result.structuredContent.livre, true);
  });

  test('limite de 3, ordem por capacidade e id: aquario ocupado → [porao, fusca, garagem]', async () => {
    const { r } = await conflito(s.url, 'sala-aquario', '05');
    const req = Object.values<any>(r.corpo.result.inputRequests)[0];
    assert.deepEqual(req.params.requestedSchema.properties.sala.enum, ['sala-porao', 'sala-fusca', 'sala-garagem']);
  });

  test('uma alternativa só → enum com um item', async () => {
    for (const sala of ['sala-porao', 'sala-fusca', 'sala-garagem']) await reservar(s.url, sala, em('06', '10:00'), em('06', '11:00'), 'Ocupante');
    const { r } = await conflito(s.url, 'sala-aquario', '06');
    const req = Object.values<any>(r.corpo.result.inputRequests)[0];
    assert.deepEqual(req.params.requestedSchema.properties.sala.enum, ['sala-mirante']);
  });

  test('sem alternativa possível → isError "Sem alternativas disponiveis no intervalo", sem elicitation', async () => {
    await reservar(s.url, 'sala-mirante', em('07', '10:00'), em('07', '11:00'), 'Ocupante');
    const { corpo } = await reservar(s.url, 'sala-mirante', em('07', '10:00'), em('07', '11:00'));
    const r = corpo.result;
    assert.equal(r.resultType, 'complete');
    assert.equal(r.isError, true);
    assert.equal(r.content[0].text, 'Sem alternativas disponiveis no intervalo');
    assert.equal(r.inputRequests, undefined);
    assert.equal(r.requestState, undefined);
  });

  test('regras vêm antes do conflito: pedido inválido numa sala ocupada → erro da regra, sem MRTR', async () => {
    const { corpo } = await reservar(s.url, 'sala-garagem', '2026-11-03T14:00:00-03:00', '2026-11-03T17:00:00-03:00');
    assert.equal(corpo.result.isError, true);
    assert.equal(corpo.result.content[0].text, 'Duracao acima do limite: a politica permite no maximo 2 horas');
  });
});

// ---------- capabilities ----------

describe('capabilities (sempre as do PRÓPRIO request)', () => {
  const garagem = () => args('sala-garagem', '2026-11-03T14:00:00-03:00', '2026-11-03T15:00:00-03:00', 'Marty');

  test('sem elicitation ({}) → HTTP 400, -32021, data.requiredCapabilities = { elicitation: { form: {} } }', async () => {
    const { status, corpo } = await chamar(s.url, 'reservar_sala', { arguments: garagem(), capabilities: {} });
    assert.equal(status, 400);
    assert.equal(corpo.error.code, -32021);
    assert.deepEqual(corpo.error.data.requiredCapabilities, { elicitation: { form: {} } });
    assert.equal(corpo.result, undefined);
  });

  test('elicitation só com url → -32021 (form ausente)', async () => {
    const { status, corpo } = await chamar(s.url, 'reservar_sala', { arguments: garagem(), capabilities: { elicitation: { url: {} } } });
    assert.equal(status, 400);
    assert.equal(corpo.error.code, -32021);
    assert.deepEqual(corpo.error.data.requiredCapabilities, { elicitation: { form: {} } });
  });

  test('elicitation: {} sem modo → aceito como form (leitura de compatibilidade da spec, feita pelo SDK)', async () => {
    const { corpo } = await chamar(s.url, 'reservar_sala', { arguments: garagem(), capabilities: { elicitation: {} } });
    assert.equal(corpo.result.resultType, 'input_required');
  });

  test('clientCapabilities ausente no _meta → HTTP 400, -32602 (metadado obrigatório, não capability)', async () => {
    const { status, corpo } = await chamar(s.url, 'reservar_sala', { arguments: garagem(), capabilities: null });
    assert.equal(status, 400);
    assert.equal(corpo.error.code, -32602);
  });

  test('a capability de um request não vale para o seguinte', async () => {
    assert.equal((await chamar(s.url, 'reservar_sala', { arguments: garagem() })).corpo.result.resultType, 'input_required');
    assert.equal((await chamar(s.url, 'reservar_sala', { arguments: garagem(), capabilities: {} })).corpo.error.code, -32021);
  });

  test('sem conflito, a capability não é exigida: reserva conclui com clientCapabilities {}', async () => {
    const { corpo } = await chamar(s.url, 'reservar_sala', { arguments: args('sala-porao', em('08', '15:00'), em('08', '16:00')), capabilities: {} });
    assert.equal(corpo.result.structuredContent.reservado, true);
  });

  test('-32021 não cria reserva', async () => {
    await chamar(s.url, 'reservar_sala', { arguments: args('sala-garagem', em('08', '10:00'), em('08', '11:00'), 'Ocupante') });
    await chamar(s.url, 'reservar_sala', { arguments: args('sala-garagem', em('08', '10:00'), em('08', '11:00')), capabilities: {} });
    assert.equal((await idsNaSala(s.url, 'sala-garagem', '08')).length, 1);
    assert.deepEqual(await idsNaSala(s.url, 'sala-fusca', '08'), []);
  });
});

// ---------- retry ----------

describe('retry', () => {
  test('accept: tools/call NOVO (id diferente) conclui na sala escolhida, com início, fim e responsável originais', async () => {
    const { r, chave, estado, original } = await conflito(s.url, 'sala-garagem', '09', 'Marty');
    const retry = await retomar(s.url, original, chave, { action: 'accept', content: { sala: 'sala-fusca' } }, estado);
    assert.notEqual(retry.id, r.id);
    const res = retry.corpo.result;
    assert.equal(res.resultType, 'complete');
    assert.equal(res.isError, false);
    const sc = res.structuredContent;
    assert.match(sc.reserva, /^res-\d{4}$/);
    assert.deepEqual(sc, {
      reserva: sc.reserva, reservado: true, sala: 'sala-fusca',
      inicio: em('09', '10:00'), fim: em('09', '11:00'), responsavel: 'Marty',
      politica: VERSAO_POLITICA, motivo: null,
    });
    assert.equal(res.content[0].text, JSON.stringify(sc, null, 2));
    assert.deepEqual(await idsNaSala(s.url, 'sala-fusca', '09'), [sc.reserva]);
    // Os logs mostram os dois ids, diferentes, e o evento do retry.
    assert.ok(s.saida.texto.includes(`[mcp] mrtr evento=conflito id=${r.id} `));
    assert.ok(s.saida.texto.includes(`[mcp] mrtr evento=retry id=${retry.id} resultado=accept escolha=sala-fusca`));
  });

  test('decline → complete, sem isError, reservado: false, motivo "recusado", nada gravado', async () => {
    const { chave, estado, original } = await conflito(s.url, 'sala-garagem', '10');
    const { corpo } = await retomar(s.url, original, chave, { action: 'decline' }, estado);
    assert.equal(corpo.result.resultType, 'complete');
    assert.notEqual(corpo.result.isError, true);
    assert.deepEqual(corpo.result.structuredContent, {
      reserva: null, reservado: false, sala: null, inicio: null, fim: null, responsavel: null, politica: null, motivo: 'recusado',
    });
    assert.deepEqual(await idsNaSala(s.url, 'sala-fusca', '10'), []);
    assert.deepEqual(await idsNaSala(s.url, 'sala-mirante', '10'), []);
  });

  test('cancel → complete, reservado: false, motivo "cancelado", nada gravado', async () => {
    const { chave, estado, original } = await conflito(s.url, 'sala-garagem', '11');
    const { corpo } = await retomar(s.url, original, chave, { action: 'cancel' }, estado);
    assert.equal(corpo.result.resultType, 'complete');
    assert.notEqual(corpo.result.isError, true);
    assert.equal(corpo.result.structuredContent.reservado, false);
    assert.equal(corpo.result.structuredContent.motivo, 'cancelado');
    assert.deepEqual(await idsNaSala(s.url, 'sala-fusca', '11'), []);
  });

  test('argumentos adulterados no retry não tomam efeito: vale o pedido selado', async () => {
    const { chave, estado } = await conflito(s.url, 'sala-garagem', '12', 'Doc');
    const adulterados = args('sala-mirante', em('12', '13:00'), em('12', '14:00'), 'Biff');
    const { corpo } = await retomar(s.url, adulterados, chave, { action: 'accept', content: { sala: 'sala-fusca' } }, estado);
    const sc = corpo.result.structuredContent;
    assert.equal(sc.sala, 'sala-fusca');
    assert.equal(sc.inicio, em('12', '10:00'));
    assert.equal(sc.fim, em('12', '11:00'));
    assert.equal(sc.responsavel, 'Doc');
    assert.deepEqual(await idsNaSala(s.url, 'sala-mirante', '12'), []);
  });

  test('escolha fora do enum → isError, nada gravado (nem na sala pedida, nem na escolhida)', async () => {
    const { chave, estado, original } = await conflito(s.url, 'sala-garagem', '13');
    for (const sala of ['sala-aquario', 'sala-garagem', 'sala-delorean']) {
      const { status, corpo } = await retomar(s.url, original, chave, { action: 'accept', content: { sala } }, estado);
      assert.equal(status, 200);
      assert.equal(corpo.result.resultType, 'complete');
      assert.equal(corpo.result.isError, true, `${sala}: ${JSON.stringify(corpo)}`);
      assert.equal(corpo.result.content[0].text, 'Escolha fora das alternativas oferecidas: sala-fusca, sala-mirante');
      assert.equal(corpo.result.structuredContent, undefined);
    }
    const semConteudo = await retomar(s.url, original, chave, { action: 'accept' }, estado);
    assert.equal(semConteudo.corpo.result.isError, true);
    assert.equal((await idsNaSala(s.url, 'sala-garagem', '13')).length, 1);
    assert.deepEqual(await idsNaSala(s.url, 'sala-aquario', '13'), []);
  });

  test('chave de inputResponses diferente da enviada → isError, nada gravado', async () => {
    const { chave, estado, original } = await conflito(s.url, 'sala-garagem', '14');
    const { corpo } = await retomar(s.url, original, `${chave}-outra`, { action: 'accept', content: { sala: 'sala-fusca' } }, estado);
    assert.equal(corpo.result.isError, true);
    assert.equal(corpo.result.content[0].text, `Resposta ausente: inputResponses precisa da chave '${chave}'`);
    const semResposta = await chamar(s.url, 'reservar_sala', { arguments: original, requestState: estado });
    assert.equal(semResposta.corpo.result.isError, true);
    assert.deepEqual(await idsNaSala(s.url, 'sala-fusca', '14'), []);
  });

  test('a sala escolhida foi ocupada entre a pergunta e a resposta → nova pergunta, sem reserva dupla', async () => {
    const { chave, estado, original } = await conflito(s.url, 'sala-garagem', '15');
    await reservar(s.url, 'sala-fusca', em('15', '10:00'), em('15', '11:00'), 'Rapido');
    const { corpo } = await retomar(s.url, original, chave, { action: 'accept', content: { sala: 'sala-fusca' } }, estado);
    assert.equal(corpo.result.resultType, 'input_required');
    assert.deepEqual(Object.values<any>(corpo.result.inputRequests)[0].params.requestedSchema.properties.sala.enum, ['sala-mirante']);
    assert.equal((await idsNaSala(s.url, 'sala-fusca', '15')).length, 1);
  });

  test('o mesmo requestState aceito duas vezes não reserva duas vezes', async () => {
    const { chave, estado, original } = await conflito(s.url, 'sala-garagem', '16');
    const aceite = { action: 'accept', content: { sala: 'sala-fusca' } };
    const a = await retomar(s.url, original, chave, aceite, estado);
    const b = await retomar(s.url, original, chave, aceite, estado);
    assert.equal(a.corpo.result.structuredContent.reservado, true);
    assert.equal(b.corpo.result.resultType, 'input_required'); // fusca já é dele: oferece só o que sobrou
    assert.equal((await idsNaSala(s.url, 'sala-fusca', '16')).length, 1);
  });
});

// ---------- requestState ----------

describe('requestState protegido', () => {
  test('um caractere alterado → -32602 "Invalid or expired requestState", nada gravado', async () => {
    const { chave, estado, original } = await conflito(s.url, 'sala-garagem', '17');
    const { status, corpo } = await retomar(s.url, original, chave, { action: 'accept', content: { sala: 'sala-fusca' } }, adulterar(estado));
    assert.equal(corpo.error?.code, -32602);
    assert.equal(corpo.error?.message, 'Invalid or expired requestState');
    assert.equal(status, 200);
    assert.deepEqual(await idsNaSala(s.url, 'sala-fusca', '17'), []);
    assert.match(s.saida.texto, /\[mcp\] rejeitado .*requestState verification rejected tools\/call: mac/);
  });

  test('expirado (emitido com o mesmo segredo e validade já vencida) → -32602', async () => {
    const { chave, estado, original } = await conflito(s.url, 'sala-garagem', '18');
    const selo = JSON.parse(Buffer.from(estado.split('.')[1], 'base64url').toString('utf8')).p;
    const vencido = await createRequestStateCodec({ key: Buffer.from(SEGREDO, 'hex'), ttlSeconds: -60 }).mint(selo);
    const { corpo } = await retomar(s.url, original, chave, { action: 'accept', content: { sala: 'sala-fusca' } }, vencido);
    assert.equal(corpo.error?.code, -32602);
    assert.match(s.saida.texto, /requestState verification rejected tools\/call: expired/);
    // Controle: o mesmo selo, com validade normal, é aceito. Só a expiração mudou.
    const valido = await createRequestStateCodec({ key: Buffer.from(SEGREDO, 'hex'), ttlSeconds: 900 }).mint(selo);
    const ok = await retomar(s.url, original, chave, { action: 'accept', content: { sala: 'sala-fusca' } }, valido);
    assert.equal(ok.corpo.result.structuredContent.reservado, true);
  });

  test('selo forjado com outra chave (pedido e escolha à vontade) → -32602', async () => {
    const forjado = await createRequestStateCodec({ key: randomBytes(32), ttlSeconds: 900 }).mint({
      v: 1, ferramenta: 'reservar_sala', emitidoEm: 0, chave: 'escolha_de_sala',
      pedido: args('sala-mirante', em('19', '10:00'), em('19', '11:00'), 'Biff'), alternativas: ['sala-mirante'],
    });
    const { corpo } = await retomar(s.url, args('sala-mirante', em('19', '10:00'), em('19', '11:00'), 'Biff'), 'escolha_de_sala',
      { action: 'accept', content: { sala: 'sala-mirante' } }, forjado);
    assert.equal(corpo.error?.code, -32602);
    assert.deepEqual(await idsNaSala(s.url, 'sala-mirante', '19'), []);
  });

  test('o log nunca mostra o segredo nem o requestState', async () => {
    const { estado } = await conflito(s.url, 'sala-garagem', '20');
    assert.ok(!s.saida.texto.includes(SEGREDO));
    assert.ok(!s.saida.texto.includes(estado.split('.')[1]));
  });
});

// ---------- reinício ----------

describe('reinício do servidor', () => {
  test('requestState emitido antes do restart conclui a reserva depois dele (mesmo segredo)', async () => {
    const a = await subir();
    let dados: { chave: string; estado: string; original: Record<string, unknown> };
    try {
      dados = await conflito(a.url, 'sala-garagem', '21', 'Marty');
    } finally {
      a.processo.kill();
    }
    await new Promise((r) => a.processo.once('exit', r));
    const b = await subir(); // processo novo: memória vazia, mesma chave
    try {
      const { corpo } = await retomar(b.url, dados.original, dados.chave, { action: 'accept', content: { sala: 'sala-fusca' } }, dados.estado);
      assert.equal(corpo.result.resultType, 'complete');
      assert.equal(corpo.result.structuredContent.reservado, true);
      assert.equal(corpo.result.structuredContent.sala, 'sala-fusca');
      assert.equal(corpo.result.structuredContent.responsavel, 'Marty');
      // Num processo novo a agenda volta ao arquivo: o "Ocupante" da garagem
      // sumiu com o processo A, e a reserva nova é a primeira deste processo.
      assert.equal(corpo.result.structuredContent.reserva, 'res-0003');
    } finally {
      b.processo.kill();
    }
  });

  test('com OUTRO segredo depois do restart, o mesmo requestState é recusado (-32602)', async () => {
    const { chave, estado, original } = await conflito(s.url, 'sala-garagem', '22');
    const outro = await subir(randomBytes(32).toString('hex'));
    try {
      const { corpo } = await retomar(outro.url, original, chave, { action: 'accept', content: { sala: 'sala-fusca' } }, estado);
      assert.equal(corpo.error?.code, -32602);
    } finally {
      outro.processo.kill();
    }
  });

  test('sem REQUEST_STATE_SECRET, ou com segredo curto, o processo não sobe e não mostra o valor', async () => {
    const curto = 'ab'.repeat(16);
    for (const segredo of ['', curto]) {
      const p = await iniciar({ REQUEST_STATE_SECRET: segredo });
      assert.notEqual(p.codigo, undefined, 'deveria ter saído antes do "pronto"');
      assert.notEqual(p.codigo, 0);
      assert.match(p.saida.texto, /REQUEST_STATE_SECRET/);
      if (segredo) assert.ok(!p.saida.texto.includes(curto));
    }
  });
});
