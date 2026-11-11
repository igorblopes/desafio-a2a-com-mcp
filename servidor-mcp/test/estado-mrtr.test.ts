// Testes unitários do requestState (src/estado-mrtr.ts) e da leitura do
// segredo (src/config.ts). O segredo é gerado aqui, a cada execução: nenhum
// valor real fica no repositório.
import { test, describe, mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createRequestStateCodec, type ServerContext } from '@modelcontextprotocol/server';

const SEGREDO = randomBytes(32).toString('hex');
process.env.REQUEST_STATE_SECRET = SEGREDO;
delete process.env.REQUEST_STATE_TTL_SECONDS;
// Import dinâmico: o segredo precisa estar no ambiente antes de o módulo ler.
const { selar, verificarSelo } = await import('../src/estado-mrtr.ts');
const { segredoDoRequestState, config } = await import('../src/config.ts');

const ctx = {} as ServerContext; // sem bind: o codec não olha o contexto
const PEDIDO = { sala: 'sala-garagem', inicio: '2026-11-03T14:00:00-03:00', fim: '2026-11-03T15:00:00-03:00', responsavel: 'Marty' };
const SELO = { pedido: PEDIDO, alternativas: ['sala-fusca', 'sala-mirante'], chave: 'escolha_de_sala' };

/** Troca UM caractere no meio do corpo assinado. */
function adulterar(estado: string): string {
  const i = Math.floor(estado.length / 2);
  return estado.slice(0, i) + (estado[i] === 'A' ? 'B' : 'A') + estado.slice(i + 1);
}

afterEach(() => mock.timers.reset());

describe('requestState: selar e verificar', () => {
  test('ida e volta: o pedido inteiro volta do próprio estado, sem memória no servidor', async () => {
    const estado = await selar(SELO);
    assert.match(estado, /^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    const selo = await verificarSelo(estado, ctx);
    assert.deepEqual(selo.pedido, PEDIDO);
    assert.deepEqual(selo.alternativas, ['sala-fusca', 'sala-mirante']);
    assert.equal(selo.chave, 'escolha_de_sala');
    assert.equal(selo.v, 1);
    assert.equal(selo.ferramenta, 'reservar_sala');
    assert.ok(Math.abs(selo.emitidoEm - Date.now() / 1000) < 5);
  });

  test('é assinado, não cifrado: o corpo é legível, mas o segredo não aparece nele', async () => {
    const estado = await selar(SELO);
    const corpo = JSON.parse(Buffer.from(estado.split('.')[1], 'base64url').toString('utf8'));
    assert.equal(corpo.p.pedido.responsavel, 'Marty');
    assert.equal(typeof corpo.exp, 'number');
    assert.ok(!estado.includes(SEGREDO));
  });

  test('um caractere alterado → recusado (mac)', async () => {
    const estado = await selar(SELO);
    await assert.rejects(verificarSelo(adulterar(estado), ctx));
  });

  test('corpo trocado por outro com o MAC original → recusado', async () => {
    const [v, , mac] = (await selar(SELO)).split('.');
    const falso = Buffer.from(JSON.stringify({ p: { ...SELO, pedido: { ...PEDIDO, responsavel: 'Biff' } }, exp: 9999999999 })).toString('base64url');
    await assert.rejects(verificarSelo(`${v}.${falso}.${mac}`, ctx), /mac/);
  });

  test('assinado com outra chave → recusado', async () => {
    const outro = createRequestStateCodec({ key: randomBytes(32), ttlSeconds: 900 });
    const estado = await outro.mint({ v: 1, ferramenta: 'reservar_sala', emitidoEm: 0, ...SELO });
    await assert.rejects(verificarSelo(estado, ctx), /mac/);
  });

  test('expira: válido aos 14 min 59 s, recusado depois de 15 min (relógio simulado)', async () => {
    assert.equal(config.ttlDoRequestState, 900);
    const agora = Date.now();
    const estado = await selar(SELO);
    mock.timers.enable({ apis: ['Date'], now: agora + 899_000 });
    await verificarSelo(estado, ctx);
    mock.timers.setTime(agora + 902_000);
    await assert.rejects(verificarSelo(estado, ctx), /expired/);
  });

  test('MAC válido, mas selo de outra versão ou de outra ferramenta → recusado', async () => {
    const mesmoSegredo = createRequestStateCodec({ key: Buffer.from(SEGREDO, 'hex'), ttlSeconds: 900 });
    const v2 = await mesmoSegredo.mint({ v: 2, ferramenta: 'reservar_sala', emitidoEm: 0, ...SELO });
    const outraTool = await mesmoSegredo.mint({ v: 1, ferramenta: 'listar_salas', emitidoEm: 0, ...SELO });
    await assert.rejects(verificarSelo(v2, ctx));
    await assert.rejects(verificarSelo(outraTool, ctx));
  });

  test('lixo e formatos inválidos → recusados', async () => {
    for (const lixo of ['', 'abc', 'v1.', 'v1.x.y', 'v2.aaa.bbb']) await assert.rejects(verificarSelo(lixo, ctx));
  });
});

describe('REQUEST_STATE_SECRET', () => {
  test('aceita hex de 64 dígitos (32 bytes) e devolve os bytes', () => {
    assert.equal(segredoDoRequestState({ REQUEST_STATE_SECRET: SEGREDO }).byteLength, 32);
  });
  test('ausente, curta ou fora de hex → erro que NÃO contém o valor', () => {
    const curto = 'ab'.repeat(16); // 16 bytes
    const naoHex = 'z'.repeat(64);
    for (const env of [{}, { REQUEST_STATE_SECRET: '' }, { REQUEST_STATE_SECRET: curto }, { REQUEST_STATE_SECRET: naoHex }]) {
      assert.throws(
        () => segredoDoRequestState(env),
        (e: Error) => /REQUEST_STATE_SECRET/.test(e.message) && !e.message.includes(curto) && !e.message.includes(naoHex),
      );
    }
  });
});
