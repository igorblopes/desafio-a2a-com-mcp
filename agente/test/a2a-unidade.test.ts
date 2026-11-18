// Testes unitários da camada A2A (sem HTTP): máquina de estados,
// repositório de Tasks, parser do pedido e Agent Card.
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
      [S.TASK_STATE_WORKING, S.TASK_STATE_WORKING],
    ] as const) {
      assert.ok(podeTransitar(de, para), `${de} → ${para}`);
    }
  });
  test('caminhos proibidos', () => {
    for (const [de, para] of [
      [undefined, S.TASK_STATE_WORKING],
      [S.TASK_STATE_SUBMITTED, S.TASK_STATE_COMPLETED],
      [S.TASK_STATE_WORKING, S.TASK_STATE_SUBMITTED],
      [S.TASK_STATE_WORKING, S.TASK_STATE_CANCELED],
      [S.TASK_STATE_INPUT_REQUIRED, S.TASK_STATE_COMPLETED],
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
