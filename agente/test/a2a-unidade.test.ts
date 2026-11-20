// Testes unitários da camada A2A (sem HTTP): máquina de estados,
// repositório de Tasks, parser do pedido, Agent Card e (Passo 11) a parte
// pura da ponte: pergunta, escolha e continuações por Task.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { TaskState, type Task } from '@a2a-js/sdk';
import { criarAgentCard } from '../src/a2a/card.ts';
import { lerConfigDoAgente } from '../src/a2a/config.ts';
import { ehTerminal, exigirTransicao, podeTransitar, TransicaoInvalida } from '../src/a2a/tarefas/estados.ts';
import { lerPedido } from '../src/a2a/tarefas/pedido.ts';
import { RepositorioDeTasks } from '../src/a2a/tarefas/repositorio.ts';
import { criarContinuacao } from '../src/host/continuacao.ts';
import { lerPedidos } from '../src/mcp/mrtr.ts';
import { lerEscolha, mensagemDeAlternativas, perguntaDe } from '../src/a2a/ponte.ts';
import { RetomadasPendentes, type Pendente } from '../src/a2a/tarefas/retomadas.ts';
import { DIR_DO_AGENTE } from './apoio.ts';

const S = TaskState;

describe('máquina de estados', () => {
  test('caminhos permitidos', () => {
    for (const [de, para] of [
      [undefined, S.TASK_STATE_SUBMITTED],
      [S.TASK_STATE_SUBMITTED, S.TASK_STATE_WORKING],
      [S.TASK_STATE_WORKING, S.TASK_STATE_COMPLETED],
      [S.TASK_STATE_WORKING, S.TASK_STATE_FAILED],
      [S.TASK_STATE_WORKING, S.TASK_STATE_INPUT_REQUIRED],
      [S.TASK_STATE_INPUT_REQUIRED, S.TASK_STATE_WORKING],
      [S.TASK_STATE_INPUT_REQUIRED, S.TASK_STATE_CANCELED],
      [S.TASK_STATE_WORKING, S.TASK_STATE_CANCELED],
      [S.TASK_STATE_WORKING, S.TASK_STATE_WORKING],
      [S.TASK_STATE_INPUT_REQUIRED, S.TASK_STATE_INPUT_REQUIRED],
    ] as const) {
      assert.ok(podeTransitar(de, para), `${de} → ${para}`);
    }
  });
  test('caminhos proibidos', () => {
    for (const [de, para] of [
      [undefined, S.TASK_STATE_WORKING],
      [S.TASK_STATE_SUBMITTED, S.TASK_STATE_COMPLETED],
      [S.TASK_STATE_WORKING, S.TASK_STATE_SUBMITTED],
      [S.TASK_STATE_INPUT_REQUIRED, S.TASK_STATE_COMPLETED],
      [S.TASK_STATE_INPUT_REQUIRED, S.TASK_STATE_FAILED],
      [S.TASK_STATE_COMPLETED, S.TASK_STATE_WORKING],
      [S.TASK_STATE_FAILED, S.TASK_STATE_WORKING],
      [S.TASK_STATE_CANCELED, S.TASK_STATE_WORKING],
      [S.TASK_STATE_COMPLETED, S.TASK_STATE_FAILED],
    ] as const) {
      assert.equal(podeTransitar(de, para), false, `${de} → ${para}`);
    }
    assert.throws(() => exigirTransicao('t1', S.TASK_STATE_COMPLETED, S.TASK_STATE_WORKING), (e) => e instanceof TransicaoInvalida && /TASK_STATE_COMPLETED → TASK_STATE_WORKING/.test(e.message));
  });
  test('terminais: COMPLETED, FAILED, CANCELED', () => {
    assert.deepEqual(
      [S.TASK_STATE_SUBMITTED, S.TASK_STATE_WORKING, S.TASK_STATE_INPUT_REQUIRED, S.TASK_STATE_COMPLETED, S.TASK_STATE_FAILED, S.TASK_STATE_CANCELED].map(ehTerminal),
      [false, false, false, true, true, true],
    );
  });
});

const task = (id: string, state: TaskState, extra: Partial<Task> = {}) => ({ id, contextId: `ctx-${id}`, status: { state, message: undefined, timestamp: undefined }, history: [], artifacts: [], metadata: undefined, ...extra }) as Task;

describe('repositório de Tasks', () => {
  test('grava, lê cópias e registra só mudanças de estado', async () => {
    const linhas: string[] = [];
    const repo = new RepositorioDeTasks((l) => linhas.push(l));
    await repo.save(task('a', S.TASK_STATE_SUBMITTED));
    await repo.save(task('a', S.TASK_STATE_WORKING));
    await repo.save(task('a', S.TASK_STATE_WORKING, { artifacts: [{ artifactId: 'x' } as never] }));
    const lida = (await repo.load('a'))!;
    lida.status!.state = S.TASK_STATE_FAILED;
    assert.equal((await repo.load('a'))!.status!.state, S.TASK_STATE_WORKING, 'quem lê não altera o guardado');
    assert.deepEqual(linhas, ['[a2a] task=a nenhum -> TASK_STATE_SUBMITTED', '[a2a] task=a TASK_STATE_SUBMITTED -> TASK_STATE_WORKING']);
  });
  test('Task terminal não volta a executar; Task nova não nasce no meio', async () => {
    const repo = new RepositorioDeTasks(() => {});
    await repo.save(task('b', S.TASK_STATE_SUBMITTED));
    await repo.save(task('b', S.TASK_STATE_WORKING));
    await repo.save(task('b', S.TASK_STATE_COMPLETED));
    await assert.rejects(repo.save(task('b', S.TASK_STATE_WORKING)), TransicaoInvalida);
    assert.equal((await repo.load('b'))!.status!.state, S.TASK_STATE_COMPLETED);
    await assert.rejects(repo.save(task('c', S.TASK_STATE_WORKING)), TransicaoInvalida);
    assert.equal(await repo.load('c'), undefined);
  });
  test('Tasks independentes', async () => {
    const repo = new RepositorioDeTasks(() => {});
    await repo.save(task('d', S.TASK_STATE_SUBMITTED));
    await repo.save(task('e', S.TASK_STATE_SUBMITTED));
    await repo.save(task('d', S.TASK_STATE_WORKING));
    assert.equal((await repo.load('e'))!.status!.state, S.TASK_STATE_SUBMITTED);
    assert.equal(repo.tamanho, 2);
  });
});

describe('parser do pedido', () => {
  const ok = 'reservar sala=sala-aquario inicio=2026-11-03T10:00:00-03:00 fim=2026-11-03T11:00:00-03:00 responsavel=Marty';
  test('formato do contrato', () => {
    assert.deepEqual(lerPedido(ok), { ok: true, pedido: { sala: 'sala-aquario', inicio: '2026-11-03T10:00:00-03:00', fim: '2026-11-03T11:00:00-03:00', responsavel: 'Marty' } });
  });
  test('responsável com espaços e campos em outra ordem', () => {
    const r = lerPedido('reservar responsavel=Doc Brown sala=sala-porao fim=2026-11-03T11:00:00-03:00 inicio=2026-11-03T10:00:00-03:00');
    assert.ok(r.ok && r.pedido.responsavel === 'Doc Brown' && r.pedido.sala === 'sala-porao');
  });
  test('não valida domínio: sala inexistente e horário estranho passam (o MCP decide)', () => {
    assert.ok(lerPedido('reservar sala=sala-delorean inicio=ontem fim=amanha responsavel=Doc').ok);
  });
  test('erros de formato', () => {
    for (const [texto, msg] of [
      ['escolha=sala-fusca', /não reconhecido/],
      ['reservar sala=x inicio=a fim=b', /ausentes: responsavel/],
      ['reservar sala=x sala=y inicio=a fim=b responsavel=c', /repetido: sala/],
      ['reservar sala=x inicio=a fim=b responsavel=c andar=2', /desconhecido: andar/],
      ['reservar sala= inicio=a fim=b responsavel=c', /vazio: sala|desconhecido/],
    ] as const) {
      const r = lerPedido(texto);
      assert.ok(!r.ok && msg.test(r.erro), `${texto} → ${JSON.stringify(r)}`);
    }
  });
});

describe('Agent Card e configuração', () => {
  test('card igual ao exemplo oficial (exemplos/wire/07), trocando só a URL', async () => {
    const exemplo = JSON.parse(await readFile(path.join(DIR_DO_AGENTE, '..', 'exemplos', 'wire', '07-a2a-agent-card.json'), 'utf8'));
    const esperado = exemplo.response.body;
    esperado.supportedInterfaces[0].url = 'http://localhost:7300/a2a';
    assert.deepEqual(JSON.parse(JSON.stringify(criarAgentCard('http://localhost:7300'))), esperado);
  });
  test('padrões e variáveis de ambiente', () => {
    assert.deepEqual(lerConfigDoAgente({}), { porta: 7300, urlPublica: 'http://localhost:7300', mcp: new URL('http://localhost:7301/mcp') });
    const c = lerConfigDoAgente({ A2A_PORT: '8080', A2A_PUBLIC_URL: 'http://127.0.0.1:8080/', MCP_URL: 'http://127.0.0.1:9/mcp' });
    assert.deepEqual([c.porta, c.urlPublica, c.mcp.port], [8080, 'http://127.0.0.1:8080', '9']);
    assert.throws(() => lerConfigDoAgente({ A2A_PORT: 'x' }), /A2A_PORT/);
  });
});

// ---- Passo 11: ponte (tradução pura) e continuações por Task ----

const formulario = (props: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  method: 'elicitation/create',
  params: { mode: 'form', message: 'Escolha', requestedSchema: { type: 'object', properties: props, required: Object.keys(props) } },
  ...extra,
});
const continuacaoCom = (inputRequests: Record<string, unknown>, requestState = 'v1.OPACO') =>
  criarContinuacao({
    operacao: 't1',
    ferramenta: 'reservar_sala',
    argumentos: { sala: 'sala-garagem' },
    pedidos: lerPedidos({ resultType: 'input_required', inputRequests, requestState } as never),
    requestState,
    traceparent: undefined,
    rodada: 1,
  });

describe('ponte: pergunta tirada do formulário do servidor', () => {
  test('enum: chave real, campo sala, ordem do servidor e mensagem exata', () => {
    const c = continuacaoCom({ '__main__:escolha_de_sala': formulario({ sala: { type: 'string', enum: ['sala-mirante', 'sala-fusca'] } }) });
    assert.equal(c.pedidos[0]!.chave, '__main__:escolha_de_sala');
    assert.deepEqual(perguntaDe(c), { ok: true, campo: 'sala', alternativas: ['sala-mirante', 'sala-fusca'], mensagem: 'alternativas: sala-mirante, sala-fusca' });
  });
  test('const (uma alternativa só) também vale', () => {
    const c = continuacaoCom({ k: formulario({ sala: { type: 'string', const: 'sala-mirante' } }) });
    assert.deepEqual(perguntaDe(c), { ok: true, campo: 'sala', alternativas: ['sala-mirante'], mensagem: 'alternativas: sala-mirante' });
  });
  test('formulários que a ponte não sabe responder', () => {
    assert.equal(perguntaDe(continuacaoCom({})).ok, false);
    assert.equal(perguntaDe(continuacaoCom({ a: formulario({ sala: { enum: ['x'] } }), b: formulario({ sala: { enum: ['y'] } }) })).ok, false);
    assert.equal(perguntaDe(continuacaoCom({ k: formulario({ nome: { type: 'string' } }) })).ok, false);
    assert.equal(perguntaDe(continuacaoCom({ k: { method: 'elicitation/create', params: { mode: 'url', url: 'https://x' } } })).ok, false);
  });
  test('mensagem é estável (mesma lista → mesmo texto)', () => {
    assert.equal(mensagemDeAlternativas(['sala-fusca', 'sala-mirante']), 'alternativas: sala-fusca, sala-mirante');
    assert.equal(mensagemDeAlternativas(['sala-fusca', 'sala-mirante']), mensagemDeAlternativas(['sala-fusca', 'sala-mirante']));
  });
});

describe('ponte: escolha do cliente', () => {
  const alts = ['sala-fusca', 'sala-mirante'];
  test('escolha válida vira accept no campo do formulário', () => {
    assert.deepEqual(lerEscolha('escolha=sala-mirante', 'sala', alts), { tipo: 'aceitar', valor: 'sala-mirante', resposta: { action: 'accept', content: { sala: 'sala-mirante' } } });
  });
  test('escolha=recusar vira decline', () => {
    assert.deepEqual(lerEscolha('escolha=recusar', 'sala', alts), { tipo: 'recusar', resposta: { action: 'decline' } });
  });
  test('fora da lista ou fora do formato: inválida', () => {
    for (const t of ['escolha=sala-aquario', 'escolha=', 'sala-fusca', 'quero a primeira', 'escolha=sala-fusca extra', 'ESCOLHA=sala-fusca']) {
      assert.equal(lerEscolha(t, 'sala', alts).tipo, 'invalida', t);
    }
  });
});

describe('continuações pendentes por Task', () => {
  const pendente = (rs: string, alts: string[]): Pendente => ({
    continuacao: continuacaoCom({ k: formulario({ sala: { enum: alts } }) }, rs),
    campo: 'sala',
    alternativas: alts,
    mensagem: mensagemDeAlternativas(alts),
    politica: '2026-11-01',
  });
  test('uma entrada por taskId, sem mistura; tomar consome', () => {
    const r = new RetomadasPendentes();
    r.guardar('A', pendente('v1.AAA', ['sala-fusca']));
    r.guardar('B', pendente('v1.BBB', ['sala-mirante']));
    assert.equal(r.obter('A')!.continuacao.requestState, 'v1.AAA');
    assert.equal(r.obter('B')!.continuacao.requestState, 'v1.BBB');
    assert.deepEqual(r.obter('B')!.alternativas, ['sala-mirante']);
    assert.equal(r.tomar('B')!.continuacao.requestState, 'v1.BBB');
    assert.equal(r.obter('B'), undefined);
    assert.equal(r.tomar('B'), undefined, 'uma continuação só é usada uma vez');
    assert.equal(r.obter('A')!.continuacao.requestState, 'v1.AAA', 'A não foi afetada');
    assert.equal(r.tamanho, 1);
  });
  test('não vaza por JSON nem por quem a recebeu', () => {
    const r = new RetomadasPendentes();
    r.guardar('A', pendente('v1.SEGREDO', ['sala-fusca']));
    assert.ok(!JSON.stringify({ r }).includes('SEGREDO'));
    assert.throws(() => {
      (r.obter('A')!.alternativas as string[]).push('sala-x');
    });
  });
});
