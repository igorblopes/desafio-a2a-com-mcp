// Testes unitários (sem servidor): trace, versão da política, MRTR e erros.
// Complementam, não substituem, os testes de integração.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { ProtocolError, SdkError, SdkErrorCode, type InputRequiredResult } from '@modelcontextprotocol/client';
import { lerConfig, URL_MCP_PADRAO } from '../src/config.ts';
import { analisarTraceparent, traceparentFilho } from '../src/trace.ts';
import { extrairVersao } from '../src/mcp/politica.ts';
import { aceitar, cancelar, continuacao, lerPedidos, problemasDoConteudo, recusar } from '../src/mcp/mrtr.ts';
import { classificar } from '../src/mcp/resultado.ts';
import { ErroDeUso, ErroMcp, traduzirErro } from '../src/mcp/erros.ts';
import { TRACEPARENT, TRACE_ID } from './apoio.ts';

describe('config', () => {
  test('MCP_URL ausente usa o padrão', () => assert.equal(lerConfig({}).url.href, URL_MCP_PADRAO));
  test('MCP_URL definida é usada', () => assert.equal(lerConfig({ MCP_URL: 'http://127.0.0.1:9999/mcp' }).url.port, '9999'));
  test('MCP_URL inválida falha cedo', () => {
    assert.throws(() => lerConfig({ MCP_URL: 'nao é url' }), /MCP_URL inválida/);
    assert.throws(() => lerConfig({ MCP_URL: 'ftp://x/mcp' }), /http/);
  });
});

describe('traceparent', () => {
  test('decompõe um valor válido', () => {
    assert.deepEqual(analisarTraceparent(TRACEPARENT), { traceId: TRACE_ID, parentId: '00f067aa0ba902b7', flags: '01' });
  });
  test('recusa formatos inválidos', () => {
    for (const v of ['', 'abc', TRACEPARENT.toUpperCase(), `ff-${TRACE_ID}-00f067aa0ba902b7-01`, `00-${'0'.repeat(32)}-00f067aa0ba902b7-01`, `00-${TRACE_ID}-${'0'.repeat(16)}-01`]) {
      assert.equal(analisarTraceparent(v), null, v);
    }
  });
  test('o filho preserva trace-id e flags e troca o span', () => {
    const filho = traceparentFilho(TRACEPARENT);
    const ctx = analisarTraceparent(filho)!;
    assert.equal(ctx.traceId, TRACE_ID);
    assert.equal(ctx.flags, '01');
    assert.notEqual(ctx.parentId, '00f067aa0ba902b7');
    assert.notEqual(traceparentFilho(TRACEPARENT), filho);
  });
  test('filho de valor inválido lança, em vez de inventar', () => assert.throws(() => traceparentFilho('x'), TypeError));
});

describe('versão da política', () => {
  test('LF', () => assert.equal(extrairVersao('versao: 2026-11-01\n\n- regra'), '2026-11-01'));
  test('CRLF', () => assert.equal(extrairVersao('versao: 2099-12-31\r\n\r\n- regra'), '2099-12-31'));
  test('sem a linha', () => assert.equal(extrairVersao('# Politica\nversao: 2026-11-01'), undefined));
});

const INPUT_REQUIRED = {
  resultType: 'input_required',
  inputRequests: {
    'qualquer:chave': {
      method: 'elicitation/create',
      params: {
        mode: 'form',
        message: 'Escolha',
        requestedSchema: { type: 'object', properties: { sala: { type: 'string', title: 'Sala', enum: ['sala-fusca', 'sala-mirante'] } }, required: ['sala'] },
      },
    },
  },
  requestState: 'v1.opaco.nao-mexer',
} as unknown as InputRequiredResult;

describe('MRTR (unidade)', () => {
  test('lê chave, método, modo, schema e opções sem presumir a chave', () => {
    const [p] = lerPedidos(INPUT_REQUIRED);
    assert.equal(p!.chave, 'qualquer:chave');
    assert.equal(p!.metodo, 'elicitation/create');
    assert.equal(p!.modo, 'form');
    assert.equal(p!.suportado, true);
    assert.deepEqual(p!.campos, [{ nome: 'sala', tipo: 'string', titulo: 'Sala', obrigatorio: true, opcoes: ['sala-fusca', 'sala-mirante'] }]);
  });
  test('valida o conteúdo contra o schema recebido', () => {
    const [p] = lerPedidos(INPUT_REQUIRED);
    assert.deepEqual(problemasDoConteudo(p!, { sala: 'sala-fusca' }), []);
    assert.match(problemasDoConteudo(p!, { sala: 'sala-x' }).join(), /fora das opções/);
    assert.match(problemasDoConteudo(p!, {}).join(), /obrigatório/);
    assert.match(problemasDoConteudo(p!, { sala: 'sala-fusca', extra: 1 }).join(), /não pedido/);
    assert.match(problemasDoConteudo(p!, { sala: 3 }).join(), /string/);
    assert.throws(() => aceitar(p!, { sala: 'sala-x' }), ErroDeUso);
  });
  test('inputResponses usa a mesma chave e o requestState segue intacto', () => {
    const pedidos = lerPedidos(INPUT_REQUIRED);
    const c = continuacao(pedidos, INPUT_REQUIRED.requestState, { 'qualquer:chave': aceitar(pedidos[0]!, { sala: 'sala-fusca' }) });
    assert.deepEqual(c, { inputResponses: { 'qualquer:chave': { action: 'accept', content: { sala: 'sala-fusca' } } }, requestState: 'v1.opaco.nao-mexer' });
    assert.deepEqual(recusar(), { action: 'decline' });
    assert.deepEqual(cancelar(), { action: 'cancel' });
  });
  test('chave faltando ou sobrando é recusada antes de enviar', () => {
    const pedidos = lerPedidos(INPUT_REQUIRED);
    assert.throws(() => continuacao(pedidos, 'x', {}), /faltando: qualquer:chave/);
    assert.throws(() => continuacao(pedidos, 'x', { 'qualquer:chave': recusar(), outra: recusar() }), /sobrando: outra/);
  });
  test('pedido que não é form (ex.: url) não é respondido com accept', () => {
    const r = { ...INPUT_REQUIRED, inputRequests: { k: { method: 'elicitation/create', params: { mode: 'url', message: 'm', url: 'https://x' } } } } as unknown as InputRequiredResult;
    const [p] = lerPedidos(r);
    assert.equal(p!.suportado, false);
    assert.throws(() => aceitar(p!, {}), /não suportado/);
  });
  test('classificar separa input_required, isError e complete, guardando o bruto', () => {
    const chamada = { nome: 't', argumentos: {} };
    const ir = classificar(chamada, INPUT_REQUIRED);
    assert.equal(ir.tipo, 'input_required');
    assert.equal(ir.bruto, INPUT_REQUIRED);
    const erro = classificar(chamada, { content: [{ type: 'text', text: 'falhou' }], isError: true });
    assert.deepEqual([erro.tipo, erro.tipo === 'erro_execucao' && erro.mensagem], ['erro_execucao', 'falhou']);
    const ok = classificar(chamada, { content: [], structuredContent: { a: 1 } });
    assert.deepEqual([ok.tipo, ok.tipo === 'completo' && ok.estruturado], ['completo', { a: 1 }]);
  });
});

describe('erros', () => {
  test('ProtocolError vira jsonrpc com code e data', () => {
    const e = traduzirErro(new ProtocolError(-32602, 'Invalid', { x: 1 })) as ErroMcp;
    assert.deepEqual([e.categoria, e.codigo, e.dados], ['jsonrpc', -32602, { x: 1 }]);
  });
  test('timeout e conexão fechada viram transporte', () => {
    assert.equal((traduzirErro(new SdkError(SdkErrorCode.RequestTimeout, 't')) as ErroMcp).categoria, 'transporte');
    assert.equal((traduzirErro(new SdkError(SdkErrorCode.ConnectionClosed, 't')) as ErroMcp).categoria, 'transporte');
  });
  test('fetch failed vira transporte', () => {
    assert.equal((traduzirErro(new TypeError('fetch failed')) as ErroMcp).categoria, 'transporte');
  });
});
