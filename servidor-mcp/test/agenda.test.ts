// Testes unitários da agenda em memória (src/dominio/agenda.ts) e da versão da
// política (src/recursos/politica.ts). O node:test roda cada arquivo num
// processo próprio, então as reservas criadas aqui não vazam para outros testes.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { adicionarReserva, listarSalas, proximoIdDeReserva, reservasDaSala } from '../src/dominio/agenda.ts';
import { conflitos, instante, validarPedido } from '../src/dominio/regras.ts';
import { extrairVersao, versaoDaPolitica } from '../src/recursos/politica.ts';

const dados = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'dados');
const ARQUIVO_RESERVAS = path.join(dados, 'reservas.json');
const BYTES_ORIGINAIS = readFileSync(ARQUIVO_RESERVAS);
const em = (dia: string, hora: string) => `2026-11-${dia}T${hora}:00-03:00`;

/** O mesmo pipeline da tool reservar_sala, sem MCP: valida, checa conflito e só então grava. */
function reservar(sala: string, inicio: string, fim: string, responsavel: string) {
  const pedido = validarPedido(listarSalas(), sala, inicio, fim);
  if (!pedido.ok) return { erro: pedido.mensagem };
  if (conflitos(reservasDaSala(sala), pedido.valor.intervalo).length > 0) return { erro: 'conflito' };
  return { reserva: adicionarReserva({ sala, inicio, fim, responsavel }) };
}
const total = () => listarSalas().reduce((n, s) => n + reservasDaSala(s.id).length, 0);

describe('ids de reserva', () => {
  test('próximo id continua a numeração do arquivo (res-0001, res-0002 → res-0003)', () => {
    assert.equal(proximoIdDeReserva([{ id: 'res-0001' }, { id: 'res-0002' }]), 'res-0003');
  });
  test('usa o maior número, mesmo fora de ordem ou com buracos', () => {
    assert.equal(proximoIdDeReserva([{ id: 'res-0007' }, { id: 'res-0002' }]), 'res-0008');
  });
  test('ignora ids fora do padrão e começa em res-0001 numa lista vazia', () => {
    assert.equal(proximoIdDeReserva([{ id: 'abc' }]), 'res-0001');
    assert.equal(proximoIdDeReserva([]), 'res-0001');
  });
  test('passa de 4 dígitos sem colidir', () => {
    assert.equal(proximoIdDeReserva([{ id: 'res-9999' }]), 'res-10000');
  });
});

describe('agenda em memória', () => {
  test('carrega as reservas iniciais do arquivo', () => {
    assert.deepEqual(reservasDaSala('sala-garagem').map((r) => r.id), ['res-0001']);
    assert.deepEqual(reservasDaSala('sala-fusca').map((r) => r.id), ['res-0002']);
  });

  test('reserva válida: id novo, campos preservados, visível em consultas posteriores', () => {
    const { reserva } = reservar('sala-aquario', em('05', '09:00'), em('05', '10:00'), 'Doc');
    assert.ok(reserva);
    assert.deepEqual(reserva, {
      id: 'res-0003', sala: 'sala-aquario', inicio: em('05', '09:00'), fim: em('05', '10:00'), responsavel: 'Doc',
    });
    assert.deepEqual(reservasDaSala('sala-aquario'), [reserva]);
    const pedido = { inicio: instante(em('05', '09:30')), fim: instante(em('05', '09:45')) };
    assert.deepEqual(conflitos(reservasDaSala('sala-aquario'), pedido), [reserva]);
  });

  test('duas reservas sequenciais: ids distintos e as duas continuam na agenda', () => {
    const a = reservar('sala-porao', em('05', '10:00'), em('05', '11:00'), 'Marty').reserva;
    const b = reservar('sala-porao', em('05', '11:00'), em('05', '12:00'), 'Jennifer').reserva; // adjacente
    assert.equal(a?.id, 'res-0004');
    assert.equal(b?.id, 'res-0005');
    assert.deepEqual(reservasDaSala('sala-porao').map((r) => r.id), ['res-0004', 'res-0005']);
  });

  test('as reservas iniciais continuam lá', () => {
    assert.deepEqual(reservasDaSala('sala-garagem').map((r) => r.id), ['res-0001']);
  });

  test('pedido inválido ou em conflito não grava nada', () => {
    const antes = total();
    assert.deepEqual(reservar('sala-delorean', em('05', '09:00'), em('05', '10:00'), 'X'), { erro: 'Sala inexistente: sala-delorean' });
    assert.equal(reservar('sala-aquario', em('05', '10:00'), em('05', '09:00'), 'X').erro, 'Intervalo invalido: fim deve ser posterior a inicio');
    assert.equal(reservar('sala-aquario', em('05', '07:00'), em('05', '08:00'), 'X').erro, 'Fora da janela de uso: a politica permite reservas entre 08:00 e 20:00');
    assert.equal(reservar('sala-aquario', em('05', '12:00'), em('05', '15:00'), 'X').erro, 'Duracao acima do limite: a politica permite no maximo 2 horas');
    assert.equal(reservar('sala-garagem', em('03', '14:30'), em('03', '15:30'), 'X').erro, 'conflito');
    assert.equal(total(), antes);
  });

  test('consultar não altera o estado', () => {
    const antes = total();
    conflitos(reservasDaSala('sala-aquario'), { inicio: instante(em('05', '08:00')), fim: instante(em('05', '20:00')) });
    reservasDaSala('sala-aquario');
    assert.equal(total(), antes);
  });

  test('dados/reservas.json não foi reescrito', () => {
    assert.ok(readFileSync(ARQUIVO_RESERVAS).equals(BYTES_ORIGINAIS));
  });
});

describe('versão da política', () => {
  test('vem da primeira linha do arquivo, não do código', () => {
    const arquivo = readFileSync(path.join(dados, 'politica-de-uso.md'), 'utf8');
    assert.equal(`versao: ${versaoDaPolitica}`, arquivo.split(/\r?\n/, 1)[0].trim());
  });
  test('aceita LF e CRLF', () => {
    assert.equal(extrairVersao('versao: 2026-11-01\n\n- regra'), '2026-11-01');
    assert.equal(extrairVersao('versao: 2026-11-01\r\n\r\n- regra'), '2026-11-01');
    assert.equal(extrairVersao('versao:   2027-01-15  \n'), '2027-01-15');
  });
  test('arquivo sem a linha de versão é recusado', () => {
    assert.throws(() => extrairVersao('# Politica\nversao: 2026-11-01'));
  });
});
