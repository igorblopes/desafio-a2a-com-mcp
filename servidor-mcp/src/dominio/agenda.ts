// Estado do domínio do processo: as salas (fixas) lidas de dados/salas.json.
// É um singleton de MÓDULO, carregado uma vez ao subir. O McpServer é criado
// por request (stateless), então nada de domínio pode morar dentro dele.
// Reservas entram aqui no passo seguinte.
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

function carregarSalas(): readonly Sala[] {
  const arquivo = path.join(config.dadosDir, 'salas.json');
  const bruto = JSON.parse(readFileSync(arquivo, 'utf8'));
  // Valida a forma ao subir: se o arquivo não bater com o contrato, falha cedo.
  return Object.freeze(z.array(SalaSchema).parse(bruto));
}

const salas = carregarSalas();

export function listarSalas(): readonly Sala[] {
  return salas;
}
