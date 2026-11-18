// Testes do CLIENTE MCP (camada de protocolo), contra o servidor real.
// O cliente não tem catálogo nem regra de operação: só monta e envia o
// request certo. Os cenários de aplicação estão em host.test.ts.
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { ClienteMcp } from '../src/mcp/cliente.ts';
import { ErroMcp } from '../src/mcp/erros.ts';
import type { RequestObservado } from '../src/mcp/observacao.ts';
import { conectar, em, portaLivre, subirServidor, type ServidorDeTeste } from './apoio.ts';

let srv: ServidorDeTeste;
let cliente: ClienteMcp;
let fio: RequestObservado[];

before(async () => {
  srv = await subirServidor();
  ({ cliente, fio } = await conectar(srv.url));
});
after(async () => {
  await cliente?.fechar();
  await srv?.parar();
});

describe('cliente MCP (protocolo)', () => {
  test('conectar faz só o server/discover, com pin 2026-07-28', () => {
    assert.deepEqual(fio.map((r) => [r.metodo, r.headers['mcp-protocol-version']]), [['server/discover', '2026-07-28']]);
  });

  test('listarTools vai ao fio toda vez (sem cache)', async () => {
    const antes = fio.length;
    await cliente.listarTools();
    await cliente.listarTools();
    assert.deepEqual(fio.slice(antes).map((r) => r.metodo), ['tools/list', 'tools/list']);
  });

  test('chamarTool envia sem conferir catálogo (isso é do Host) e classifica o resultado', async () => {
    const r = await cliente.chamarTool('listar_salas', {});
    assert.equal(r.tipo, 'completo');
    await assert.rejects(cliente.chamarTool('nao_existe', {}), (e) => e instanceof ErroMcp && e.categoria === 'jsonrpc' && e.codigo === -32602);
  });

  test('retry: inputResponses e requestState em params, fora de arguments, com id novo', async () => {
    const args = { sala: 'sala-garagem', inicio: em('03', '14:00'), fim: em('03', '15:00'), responsavel: 'Marty' };
    const r = await cliente.chamarTool('reservar_sala', args);
    assert.equal(r.tipo, 'input_required');
    if (r.tipo !== 'input_required') return;
    const original = fio.at(-1)!;
    const chave = r.pedidos[0]!.chave;
    const fim = await cliente.chamarTool('reservar_sala', args, { retry: { inputResponses: { [chave]: { action: 'decline' } }, requestState: r.requestState } });
    assert.equal(fim.tipo, 'completo');
    const retry = fio.at(-1)!;
    assert.notEqual(retry.id, original.id);
    assert.deepEqual(retry.params!.arguments, args);
    assert.equal(retry.params!.requestState, r.requestState);
    assert.deepEqual(retry.params!.inputResponses, { [chave]: { action: 'decline' } });
  });

  test('servidor fora do ar no connect → ErroMcp transporte', async () => {
    const porta = await portaLivre();
    await assert.rejects(ClienteMcp.conectar({ url: new URL(`http://localhost:${porta}/mcp`) }), (e) => e instanceof ErroMcp && e.categoria === 'transporte');
  });
});
