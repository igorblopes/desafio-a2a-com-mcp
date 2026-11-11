// Testes unitários das regras de domínio (src/dominio/regras.ts): funções
// puras, sem servidor e sem MCP. Os dados são montados aqui, não lidos de
// dados/, para que cada caso mostre exatamente o que está sendo testado.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { Reserva, Sala } from '../src/dominio/agenda.ts';
import {
  MAX_ALTERNATIVAS,
  MENSAGENS,
  alternativas,
  conflitos,
  instante,
  sobrepoe,
  validarDuracao,
  validarIntervalo,
  validarJanela,
  validarPedido,
  validarSala,
  type Intervalo,
} from '../src/dominio/regras.ts';

const SALAS: Sala[] = [
  { id: 'sala-garagem', nome: 'Garagem', capacidade: 12, recursos: ['tv', 'quadro'] },
  { id: 'sala-fusca', nome: 'Fusca', capacidade: 12, recursos: ['tv'] },
];
const RESERVA_GARAGEM: Reserva = {
  id: 'res-0001', sala: 'sala-garagem',
  inicio: '2026-11-03T14:00:00-03:00', fim: '2026-11-03T15:00:00-03:00', responsavel: 'Marty',
};
const RESERVA_FUSCA: Reserva = {
  id: 'res-0002', sala: 'sala-fusca',
  inicio: '2026-11-03T14:00:00-03:00', fim: '2026-11-03T15:00:00-03:00', responsavel: 'Jennifer',
};

/** Atalho: horário de 03/11/2026 em São Paulo, ex.: em('14:00'). */
const em = (hora: string) => `2026-11-03T${hora}:00-03:00`;
const intervalo = (de: string, ate: string): Intervalo => ({ inicio: instante(em(de)), fim: instante(em(ate)) });
const reprovaCom = (d: { ok: boolean; mensagem?: string }, mensagem: string) => {
  assert.equal(d.ok, false);
  assert.equal(d.mensagem, mensagem);
};

describe('existência de sala', () => {
  test('sala válida', () => {
    const d = validarSala(SALAS, 'sala-garagem');
    assert.ok(d.ok && d.valor.nome === 'Garagem');
  });
  test('sala inexistente reproduz o id exatamente como recebido', () => {
    reprovaCom(validarSala(SALAS, 'sala-delorean'), 'Sala inexistente: sala-delorean');
    reprovaCom(validarSala(SALAS, ' Sala-Garagem '), 'Sala inexistente:  Sala-Garagem ');
  });
});

describe('intervalo', () => {
  test('início antes do fim', () => assert.ok(validarIntervalo(intervalo('09:00', '10:00')).ok));
  test('início igual ao fim (duração zero)', () => reprovaCom(validarIntervalo(intervalo('09:00', '09:00')), MENSAGENS.intervaloInvalido));
  test('início depois do fim', () => reprovaCom(validarIntervalo(intervalo('10:00', '09:00')), MENSAGENS.intervaloInvalido));
});

describe('janela de uso (08:00–20:00, São Paulo)', () => {
  test('início exatamente às 08:00', () => assert.ok(validarJanela(intervalo('08:00', '09:00')).ok));
  test('início antes das 08:00', () => reprovaCom(validarJanela(intervalo('07:59', '09:00')), MENSAGENS.foraDaJanela));
  test('fim exatamente às 20:00', () => assert.ok(validarJanela(intervalo('19:00', '20:00')).ok));
  test('fim depois das 20:00', () => reprovaCom(validarJanela(intervalo('19:00', '20:01')), MENSAGENS.foraDaJanela));
  test('um segundo depois das 20:00 já está fora', () => {
    const i = { inicio: instante(em('19:00')), fim: instante('2026-11-03T20:00:01-03:00') };
    reprovaCom(validarJanela(i), MENSAGENS.foraDaJanela);
  });
  test('o caso do validador: 07:00–08:00', () => reprovaCom(validarJanela(intervalo('07:00', '08:00')), MENSAGENS.foraDaJanela));
});

describe('duração máxima (2h)', () => {
  test('menos de 2h', () => assert.ok(validarDuracao(intervalo('09:00', '10:59')).ok));
  test('exatamente 2h', () => assert.ok(validarDuracao(intervalo('09:00', '11:00')).ok));
  test('mais de 2h', () => reprovaCom(validarDuracao(intervalo('09:00', '11:01')), MENSAGENS.duracaoAcima));
});

describe('conflito (semiaberto [inicio, fim))', () => {
  const existente = intervalo('14:00', '15:00');
  const casos: Array<[string, string, string, boolean]> = [
    ['sem conflito (antes)', '10:00', '11:00', false],
    ['adjacente antes: 13:00–14:00', '13:00', '14:00', false],
    ['idêntico: 14:00–15:00', '14:00', '15:00', true],
    ['parcial: 14:30–15:30', '14:30', '15:30', true],
    ['parcial pela esquerda: 13:30–14:30', '13:30', '14:30', true],
    ['contido: 14:15–14:45', '14:15', '14:45', true],
    ['contendo: 13:00–16:00', '13:00', '16:00', true],
    ['adjacente depois: 15:00–16:00', '15:00', '16:00', false],
  ];
  for (const [nome, de, ate, esperado] of casos) {
    test(nome, () => assert.equal(sobrepoe(intervalo(de, ate), existente), esperado));
  }
  test('só considera a lista recebida (reserva de outra sala não conflita)', () => {
    const daGaragem = [RESERVA_GARAGEM, RESERVA_FUSCA].filter((r) => r.sala === 'sala-garagem');
    assert.deepEqual(conflitos(daGaragem, intervalo('14:00', '15:00')), [RESERVA_GARAGEM]);
  });
  test('devolve as reservas em conflito ordenadas por início', () => {
    const outra: Reserva = { ...RESERVA_GARAGEM, id: 'res-0009', inicio: em('13:00'), fim: em('14:00') };
    assert.deepEqual(
      conflitos([RESERVA_GARAGEM, outra], intervalo('13:30', '14:30')).map((r) => r.id),
      ['res-0009', 'res-0001'],
    );
  });
  test('consultar não altera a lista', () => {
    const lista = Object.freeze([RESERVA_GARAGEM]);
    conflitos(lista, intervalo('14:00', '15:00'));
    assert.deepEqual(lista, [RESERVA_GARAGEM]);
  });
});

describe('datas, offsets e fuso da máquina', () => {
  test('offsets diferentes para o mesmo instante são iguais', () => {
    assert.equal(instante('2026-11-03T14:00:00-03:00'), instante('2026-11-03T17:00:00Z'));
    assert.equal(instante('2026-11-03T14:00:00-03:00'), instante('2026-11-03T18:00:00+01:00'));
  });
  test('a janela vale para o instante, qualquer que seja o offset do pedido', () => {
    // 11:00Z = 08:00 em São Paulo (dentro); 10:59Z = 07:59 (fora).
    assert.ok(validarJanela({ inicio: instante('2026-11-03T11:00:00Z'), fim: instante('2026-11-03T12:00:00Z') }).ok);
    reprovaCom(validarJanela({ inicio: instante('2026-11-03T10:59:00Z'), fim: instante('2026-11-03T12:00:00Z') }), MENSAGENS.foraDaJanela);
  });
  test('conflito detectado entre offsets diferentes', () => {
    const pedido = { inicio: instante('2026-11-03T17:30:00Z'), fim: instante('2026-11-03T18:30:00Z') }; // 14:30–15:30 em SP
    assert.deepEqual(conflitos([RESERVA_GARAGEM], pedido), [RESERVA_GARAGEM]);
  });
  test('data sem offset é recusada (dependeria do fuso da máquina)', () => {
    assert.throws(() => instante('2026-11-03T14:00:00'));
  });
  test('resultado não depende do TZ configurado no processo', () => {
    const original = process.env.TZ;
    const executar = () => [
      validarPedido(SALAS, 'sala-garagem', em('08:00'), em('10:00')).ok,
      validarPedido(SALAS, 'sala-garagem', em('07:00'), em('08:00')).ok,
      validarPedido(SALAS, 'sala-garagem', em('19:00'), em('20:00')).ok,
      instante(em('14:00')),
    ];
    try {
      const horasLocais = new Set<number>();
      const resultados = ['UTC', 'America/Sao_Paulo', 'Asia/Tokyo', 'America/Los_Angeles', 'Pacific/Kiritimati'].map((tz) => {
        process.env.TZ = tz;
        horasLocais.add(new Date(instante(em('14:00'))).getHours());
        return executar();
      });
      // Prova de que a troca de TZ teve efeito: a hora LOCAL mudou...
      assert.ok(horasLocais.size > 1, 'process.env.TZ não alterou o fuso; o teste não provaria nada');
      // ...mas as regras deram sempre a mesma resposta.
      for (const r of resultados) assert.deepEqual(r, [true, false, true, instante('2026-11-03T17:00:00Z')]);
    } finally {
      if (original === undefined) delete process.env.TZ;
      else process.env.TZ = original;
    }
  });
  test('datas no passado são aceitas (nenhuma regra usa a data de hoje)', () => {
    assert.ok(validarPedido(SALAS, 'sala-garagem', '1999-01-04T09:00:00-03:00', '1999-01-04T10:00:00-03:00').ok);
  });
});

describe('ordem das validações (para na primeira violação)', () => {
  test('sala inexistente vence tudo', () => {
    reprovaCom(validarPedido(SALAS, 'sala-x', em('10:00'), em('06:00')), 'Sala inexistente: sala-x');
  });
  test('intervalo invertido vence janela e duração', () => {
    reprovaCom(validarPedido(SALAS, 'sala-garagem', em('22:00'), em('06:00')), MENSAGENS.intervaloInvalido);
  });
  test('janela vence duração', () => {
    reprovaCom(validarPedido(SALAS, 'sala-garagem', em('05:00'), em('09:00')), MENSAGENS.foraDaJanela);
  });
  test('pedido válido devolve a sala e o intervalo', () => {
    const d = validarPedido(SALAS, 'sala-garagem', em('09:00'), em('11:00'));
    assert.ok(d.ok);
    assert.equal(d.valor.sala.id, 'sala-garagem');
    assert.deepEqual(d.valor.intervalo, intervalo('09:00', '11:00'));
  });
});

describe('alternativas (MRTR)', () => {
  // As 5 salas reais do starter, montadas aqui para o teste ser autoexplicativo.
  const CINCO: Sala[] = [
    { id: 'sala-aquario', nome: 'Aquario', capacidade: 4, recursos: [] },
    { id: 'sala-porao', nome: 'Porao', capacidade: 6, recursos: [] },
    { id: 'sala-garagem', nome: 'Garagem', capacidade: 12, recursos: [] },
    { id: 'sala-fusca', nome: 'Fusca', capacidade: 12, recursos: [] },
    { id: 'sala-mirante', nome: 'Mirante', capacidade: 20, recursos: [] },
  ];
  const sala = (id: string) => CINCO.find((s) => s.id === id)!;
  const ocupadas = (...ids: string[]) => (salaId: string): Reserva[] =>
    ids.includes(salaId) ? [{ id: `res-${salaId}`, sala: salaId, inicio: em('14:00'), fim: em('15:00'), responsavel: 'X' }] : [];
  const ids = (salas: Sala[]) => salas.map((s) => s.id);
  const i = intervalo('14:00', '15:00');

  test('exemplo do enunciado: garagem ocupada → fusca, mirante (capacidade, depois id)', () => {
    assert.deepEqual(ids(alternativas(CINCO, ocupadas('sala-garagem'), sala('sala-garagem'), i)), ['sala-fusca', 'sala-mirante']);
  });
  test('exclui salas menores que a pedida e a própria sala pedida', () => {
    const r = ids(alternativas(CINCO, ocupadas('sala-porao'), sala('sala-porao'), i));
    assert.ok(!r.includes('sala-aquario'), 'aquario (4) é menor que porao (6)');
    assert.ok(!r.includes('sala-porao'));
  });
  test('exclui salas ocupadas no intervalo, mas não as ocupadas em outro horário', () => {
    assert.deepEqual(ids(alternativas(CINCO, ocupadas('sala-garagem', 'sala-fusca'), sala('sala-garagem'), i)), ['sala-mirante']);
    assert.deepEqual(
      ids(alternativas(CINCO, ocupadas('sala-garagem', 'sala-fusca'), sala('sala-garagem'), intervalo('15:00', '16:00'))),
      ['sala-fusca', 'sala-mirante'],
    );
  });
  test('ordena por capacidade e desempata por id; no máximo 3', () => {
    assert.equal(MAX_ALTERNATIVAS, 3);
    // aquario ocupado: porao (6), fusca (12), garagem (12), mirante (20) → corta mirante
    assert.deepEqual(ids(alternativas(CINCO, ocupadas('sala-aquario'), sala('sala-aquario'), i)), ['sala-porao', 'sala-fusca', 'sala-garagem']);
  });
  test('a ordem não depende da ordem do arquivo', () => {
    const embaralhadas = [CINCO[4], CINCO[2], CINCO[0], CINCO[3], CINCO[1]];
    assert.deepEqual(ids(alternativas(embaralhadas, ocupadas('sala-aquario'), sala('sala-aquario'), i)), ['sala-porao', 'sala-fusca', 'sala-garagem']);
  });
  test('sem alternativa possível → lista vazia (a maior sala ocupada)', () => {
    assert.deepEqual(alternativas(CINCO, ocupadas('sala-mirante'), sala('sala-mirante'), i), []);
    assert.equal(MENSAGENS.semAlternativas, 'Sem alternativas disponiveis no intervalo');
  });
});
