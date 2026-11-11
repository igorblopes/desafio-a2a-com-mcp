// Regras de negócio da Central de Salas: funções PURAS, sem MCP e sem I/O.
// Recebem dados e devolvem decisões. As mensagens de erro são as do enunciado,
// byte a byte; o validador procura exatamente estes textos.
//
// Datas: toda comparação é feita entre INSTANTES (milissegundos desde a época),
// nunca entre strings. A janela de uso é avaliada no horário de São Paulo,
// fixo em UTC-03:00 (o contrato do starter), e não no fuso da máquina.
import type { Reserva, Sala } from './agenda.ts';

export const MENSAGENS = {
  salaInexistente: (id: string) => `Sala inexistente: ${id}`,
  intervaloInvalido: 'Intervalo invalido: fim deve ser posterior a inicio',
  foraDaJanela: 'Fora da janela de uso: a politica permite reservas entre 08:00 e 20:00',
  duracaoAcima: 'Duracao acima do limite: a politica permite no maximo 2 horas',
  semAlternativas: 'Sem alternativas disponiveis no intervalo',
} as const;

const MINUTO = 60_000;
const HORA = 60 * MINUTO;
const DIA = 24 * HORA;

export const POLITICA = {
  offsetSaoPaulo: -3 * HORA, // UTC-03:00, sem horário de verão
  abertura: 8 * HORA, // 08:00
  fechamento: 20 * HORA, // 20:00
  duracaoMaxima: 2 * HORA,
} as const;

/** Intervalo semiaberto [inicio, fim), em milissegundos desde a época (UTC). */
export type Intervalo = { inicio: number; fim: number };

export type Decisao<T> = { ok: true; valor: T } | { ok: false; mensagem: string };

/**
 * Converte ISO 8601 COM offset (ex.: 2026-11-03T09:00:00-03:00 ou ...Z) em
 * instante. Sem offset, Date.parse usaria o fuso da máquina; por isso o
 * inputSchema da tool já exige o offset, e aqui recusamos de novo por garantia.
 */
export function instante(iso: string): number {
  if (!/(Z|[+-]\d{2}:\d{2})$/.test(iso)) throw new Error(`data sem offset: ${iso}`);
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) throw new Error(`data inválida: ${iso}`);
  return ms;
}

/** Milissegundos desde a meia-noite no horário de São Paulo (UTC-03:00). */
function horaEmSaoPaulo(ms: number): number {
  const local = ms + POLITICA.offsetSaoPaulo;
  return ((local % DIA) + DIA) % DIA;
}

// ---------- regras isoladas (reutilizáveis por reservar_sala) ----------

export function validarSala(salas: readonly Sala[], id: string): Decisao<Sala> {
  const sala = salas.find((s) => s.id === id);
  return sala ? { ok: true, valor: sala } : { ok: false, mensagem: MENSAGENS.salaInexistente(id) };
}

/** fim <= inicio é inválido: intervalo vazio também é recusado. */
export function validarIntervalo(i: Intervalo): Decisao<Intervalo> {
  return i.fim > i.inicio ? { ok: true, valor: i } : { ok: false, mensagem: MENSAGENS.intervaloInvalido };
}

/**
 * Início e fim precisam estar em [08:00, 20:00] no horário de São Paulo, ambos
 * inclusive (08:00–09:00 e 19:00–20:00 são válidos). Como a duração máxima é
 * 2h, um intervalo que atravesse a meia-noite sempre cai fora da janela ou
 * acima do limite; não é preciso tratar "mesmo dia" à parte.
 */
export function validarJanela(i: Intervalo): Decisao<Intervalo> {
  const dentro = (ms: number) => {
    const h = horaEmSaoPaulo(ms);
    return h >= POLITICA.abertura && h <= POLITICA.fechamento;
  };
  return dentro(i.inicio) && dentro(i.fim) ? { ok: true, valor: i } : { ok: false, mensagem: MENSAGENS.foraDaJanela };
}

/** Exatamente 2h é válido; acima disso, não. */
export function validarDuracao(i: Intervalo): Decisao<Intervalo> {
  return i.fim - i.inicio <= POLITICA.duracaoMaxima
    ? { ok: true, valor: i }
    : { ok: false, mensagem: MENSAGENS.duracaoAcima };
}

/** Sobreposição de semiabertos: a.inicio < b.fim E a.fim > b.inicio. Adjacentes não conflitam. */
export function sobrepoe(a: Intervalo, b: Intervalo): boolean {
  return a.inicio < b.fim && a.fim > b.inicio;
}

/** Reservas que conflitam com o intervalo, em ordem de início. Só considera a lista recebida. */
export function conflitos(reservas: readonly Reserva[], i: Intervalo): Reserva[] {
  return reservas
    .map((r) => ({ r, intervalo: { inicio: instante(r.inicio), fim: instante(r.fim) } }))
    .filter(({ intervalo }) => sobrepoe(i, intervalo))
    .sort((a, b) => a.intervalo.inicio - b.intervalo.inicio || a.r.id.localeCompare(b.r.id))
    .map(({ r }) => r);
}

// ---------- composição: o pedido inteiro ----------

export type PedidoValido = { sala: Sala; intervalo: Intervalo };

/**
 * Aplica as regras em ordem fixa e para na primeira violação:
 *   1. sala existe   2. fim > inicio   3. janela 08:00–20:00   4. duração <= 2h
 * A ordem vai do pré-requisito mais básico ao mais específico: janela e
 * duração só fazem sentido para um intervalo válido de uma sala que existe.
 * consultar_disponibilidade e reservar_sala usam esta mesma função.
 */
export function validarPedido(salas: readonly Sala[], salaId: string, inicioIso: string, fimIso: string): Decisao<PedidoValido> {
  const sala = validarSala(salas, salaId);
  if (!sala.ok) return sala;
  const intervalo: Intervalo = { inicio: instante(inicioIso), fim: instante(fimIso) };
  for (const regra of [validarIntervalo, validarJanela, validarDuracao]) {
    const d = regra(intervalo);
    if (!d.ok) return d;
  }
  return { ok: true, valor: { sala: sala.valor, intervalo } };
}

// ---------- alternativas (MRTR, Passo 7) ----------

/** Quantas alternativas, no máximo, a elicitation oferece. */
export const MAX_ALTERNATIVAS = 3;

/**
 * Salas que podem substituir `pedida` no MESMO intervalo:
 *   - diferente da sala pedida;
 *   - capacidade >= a da sala pedida (ninguém troca por uma sala menor);
 *   - sem conflito no intervalo, olhando a agenda atual (`reservasDe`).
 * Ordem: capacidade crescente (a menor sala que serve vem primeiro) e, no
 * empate, id em ordem de código (comparação de strings simples, sem locale,
 * para o resultado não depender da máquina). No máximo MAX_ALTERNATIVAS.
 */
export function alternativas(
  salas: readonly Sala[],
  reservasDe: (salaId: string) => readonly Reserva[],
  pedida: Sala,
  intervalo: Intervalo,
  limite = MAX_ALTERNATIVAS,
): Sala[] {
  return salas
    .filter((s) => s.id !== pedida.id && s.capacidade >= pedida.capacidade)
    .filter((s) => conflitos(reservasDe(s.id), intervalo).length === 0)
    .sort((a, b) => a.capacidade - b.capacidade || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .slice(0, limite);
}
