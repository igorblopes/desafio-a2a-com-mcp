// Estado do domínio do processo: as salas (fixas) e as reservas, lidas de
// dados/. É um singleton de MÓDULO, carregado uma vez ao subir. O McpServer é
// criado por request (stateless), então nada de domínio pode morar dentro dele.
//
// Este arquivo só CARREGA e GUARDA dados. Regras (validação, janela, duração,
// conflito) ficam em regras.ts, como funções puras que recebem os dados.
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

// inicio e fim são guardados como vieram (ISO 8601 com offset): é assim que
// voltam nas respostas. Comparações usam instantes, calculados em regras.ts.
export const ReservaSchema = z.object({
  id: z.string(),
  sala: z.string(),
  inicio: z.iso.datetime({ offset: true }),
  fim: z.iso.datetime({ offset: true }),
  responsavel: z.string(),
});
export type Reserva = z.infer<typeof ReservaSchema>;

function carregar<T>(arquivo: string, schema: z.ZodType<T>): readonly T[] {
  const bruto = JSON.parse(readFileSync(path.join(config.dadosDir, arquivo), 'utf8'));
  // Valida a forma ao subir: se o arquivo não bater com o contrato, falha cedo.
  return Object.freeze(z.array(schema).parse(bruto));
}

const salas = carregar('salas.json', SalaSchema);
// Lista em memória. Neste passo só é lida; reservar_sala vai acrescentar a ela.
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
