// Estado do domínio do processo: as salas (fixas) e as reservas, lidas de
// dados/. É um singleton de MÓDULO, carregado uma vez ao subir. O McpServer é
// criado por request (stateless), então nada de domínio pode morar dentro dele.
//
// Este arquivo só CARREGA e GUARDA dados. Regras (validação, janela, duração,
// conflito) ficam em regras.ts, como funções puras que recebem os dados.
// As duas tools leem e escrevem ESTA mesma lista: uma reserva criada por
// reservar_sala aparece na consulta seguinte, até o processo reiniciar.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import * as z from 'zod';
import { config } from '../config.ts';

export const SalaSchema = z.object({
  id: z.string(),
  nome: z.string(),
  capacidade: z.int().min(1), // pessoas; uma sala sem lugar nenhum não faz sentido
  recursos: z.array(z.string()),
});
export type Sala = z.infer<typeof SalaSchema>;

/** ISO 8601 com offset obrigatório (Z ou ±HH:MM): sem ele, o instante dependeria do fuso da máquina. */
export const DataIso = z.iso.datetime({ offset: true }).describe('ISO 8601 com offset, ex.: 2026-11-03T14:00:00-03:00');

// inicio e fim são guardados como vieram (ISO 8601 com offset): é assim que
// voltam nas respostas. Comparações usam instantes, calculados em regras.ts.
export const ReservaSchema = z.object({
  id: z.string(),
  sala: z.string(),
  inicio: DataIso,
  fim: DataIso,
  responsavel: z.string(),
});
export type Reserva = z.infer<typeof ReservaSchema>;

function carregar<T>(arquivo: string, schema: z.ZodType<T>): readonly T[] {
  const bruto = JSON.parse(readFileSync(path.join(config.dadosDir, arquivo), 'utf8'));
  // Valida a forma ao subir: se o arquivo não bater com o contrato, falha cedo.
  return Object.freeze(z.array(schema).parse(bruto));
}

const salas = carregar('salas.json', SalaSchema);
// Lista em memória, iniciada com o conteúdo do arquivo (que nunca é reescrito).
const reservas: Reserva[] = [...carregar('reservas.json', ReservaSchema)];

export function listarSalas(): readonly Sala[] {
  return salas;
}

export function buscarSala(id: string): Sala | undefined {
  return salas.find((s) => s.id === id);
}

export function reservasDaSala(salaId: string): readonly Reserva[] {
  return reservas.filter((r) => r.sala === salaId);
}

/** Quantas reservas vieram de dados/reservas.json (só para o log de subida). */
export const reservasIniciais = reservas.length;

/**
 * Próximo id no padrão do starter (res-0001, res-0002, ...): maior número já
 * usado + 1, com 4 dígitos. Calculado sobre a lista inteira (iniciais e
 * criadas), então não colide com nenhuma das duas. Sem contador separado e
 * sem aleatoriedade: o mesmo histórico gera sempre os mesmos ids.
 */
export function proximoIdDeReserva(lista: readonly Pick<Reserva, 'id'>[] = reservas): string {
  const maior = lista.reduce((max, r) => {
    const m = /^res-(\d+)$/.exec(r.id);
    return m ? Math.max(max, Number(m[1])) : max;
  }, 0);
  return `res-${String(maior + 1).padStart(4, '0')}`;
}

/**
 * Grava uma reserva na memória do processo e a devolve com o id gerado.
 * NÃO valida nada: quem chama já passou por validarPedido e conflitos. Como
 * o Node executa um handler por vez entre dois `await`, a sequência
 * "verificar conflito → adicionar" (sem await no meio) não sofre corrida.
 */
export function adicionarReserva(dados: Omit<Reserva, 'id'>): Reserva {
  const reserva: Reserva = { id: proximoIdDeReserva(), ...dados };
  reservas.push(reserva);
  return reserva;
}
