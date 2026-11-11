// requestState do MRTR: o "selo" que leva o pedido interrompido até o retry.
//
// O servidor é stateless: entre o input_required e o retry ele não guarda
// NADA sobre o pedido pendente. Tudo o que o retry precisa viaja dentro do
// requestState, que o cliente ecoa sem modificar. Como esse texto volta pelas
// mãos do cliente, ele é entrada NÃO confiável; por isso é assinado.
//
// Mecanismo: createRequestStateCodec do próprio SDK (HMAC-SHA256 + expiração).
//   formato: "v1." base64url({"p": <selo>, "exp": <unix s>}) "." base64url(mac)
// É ASSINADO, não cifrado: o cliente consegue ler o selo, mas não alterá-lo
// sem invalidar o MAC. Não colocamos nada secreto no selo.
//
// Verificação: ligada em ServerOptions.requestState.verify (servidor.ts). O
// SDK roda o verify ANTES do handler; qualquer falha (MAC, expirado, malformado,
// selo fora do formato) vira -32602 "Invalid or expired requestState", e o
// handler recebe o selo já verificado em ctx.mcpReq.requestState().
//
// Reinício: a única coisa de que o verify precisa é a chave, que vem do
// ambiente. Mesmo REQUEST_STATE_SECRET ⇒ um selo emitido antes do restart
// continua válido depois dele.
import { createRequestStateCodec, type RequestStateCodec, type ServerContext } from '@modelcontextprotocol/server';
import * as z from 'zod';
import { config, segredoDoRequestState } from './config.ts';

/** Versão do formato do selo. Mudou o formato? Incrementa e selos antigos são recusados. */
export const VERSAO_DO_SELO = 1;

export const SeloReservaSchema = z.object({
  v: z.literal(VERSAO_DO_SELO),
  /** Ferramenta que emitiu o selo: um selo de reservar_sala só serve para reservar_sala. */
  ferramenta: z.literal('reservar_sala'),
  /** Pedido original, já validado pelas regras. É a fonte da verdade no retry. */
  pedido: z.object({ sala: z.string(), inicio: z.string(), fim: z.string(), responsavel: z.string() }),
  /** Salas oferecidas, na ordem do enum. A escolha do cliente tem de estar aqui. */
  alternativas: z.array(z.string()).min(1),
  /** Chave da entrada em inputRequests; o inputResponses tem de vir com ela. */
  chave: z.string(),
  /** Emissão (unix s). A expiração (exp) fica no envelope do codec, fora do selo. */
  emitidoEm: z.int(),
}).strict();
export type SeloReserva = z.infer<typeof SeloReservaSchema>;

let codec: RequestStateCodec<SeloReserva> | undefined;

/** Codec criado na primeira emissão/verificação, com a chave do ambiente. */
function obterCodec(): RequestStateCodec<SeloReserva> {
  codec ??= createRequestStateCodec<SeloReserva>({
    key: segredoDoRequestState(),
    ttlSeconds: config.ttlDoRequestState,
  });
  return codec;
}

/** Sela o pedido interrompido. O resultado vai em inputRequired({ requestState }). */
export function selar(selo: Omit<SeloReserva, 'v' | 'ferramenta' | 'emitidoEm'>): Promise<string> {
  return obterCodec().mint({ v: VERSAO_DO_SELO, ferramenta: 'reservar_sala', emitidoEm: Math.floor(Date.now() / 1000), ...selo });
}

/**
 * O hook de ServerOptions.requestState.verify. Confere MAC e validade (codec)
 * e, depois, a FORMA do selo: um MAC válido sobre um selo de outra versão ou
 * de outra ferramenta também é recusado. Qualquer throw aqui vira -32602.
 */
export async function verificarSelo(estado: string, ctx: ServerContext): Promise<SeloReserva> {
  return SeloReservaSchema.parse(await obterCodec().verify(estado, ctx));
}
