// Resource politica://uso: expõe dados/politica-de-uso.md sem transformá-lo.
//
// O arquivo é lido UMA vez ao subir (singleton de módulo, como as salas em
// dominio/agenda.ts): se ele faltar, o processo nem sobe. O texto é servido
// como está, inclusive a linha "versao: ...". A versão também é extraída
// dessa linha (nunca fixada no código) para o campo `politica` da reserva.
//
// Registrar um resource faz o McpServer responder resources/list e
// resources/read. URI não registrada vira erro -32602 do próprio SDK
// (ResourceNotFoundError), nunca um `contents` vazio.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { McpServer } from '@modelcontextprotocol/server';
import { config } from '../config.ts';

const URI = 'politica://uso';
const MIME = 'text/markdown';
const texto = readFileSync(path.join(config.dadosDir, 'politica-de-uso.md'), 'utf8');

/** Primeira linha do arquivo, só para o log de subida (ex.: "versao: 2026-11-01"). */
export const cabecalhoDaPolitica = texto.split(/\r?\n/, 1)[0].trim();

/**
 * Lê "versao: <valor>" da primeira linha. Aceita CRLF (Git no Windows com
 * autocrlf) e espaços extras. Sem essa linha, falha ao subir: uma reserva
 * sem versão de política não cumpre o contrato.
 */
export function extrairVersao(conteudo: string): string {
  const primeira = conteudo.split(/\r?\n/, 1)[0];
  const m = /^\s*versao:\s*(\S+)\s*$/.exec(primeira);
  if (!m) throw new Error(`politica-de-uso.md sem "versao: ..." na primeira linha: ${JSON.stringify(primeira)}`);
  return m[1];
}

export const versaoDaPolitica = extrairVersao(texto);

export function registrarPolitica(servidor: McpServer): void {
  servidor.registerResource(
    'politica-de-uso',
    URI,
    {
      title: 'Política de uso das salas',
      description: 'Regras de reserva. A primeira linha declara a versão vigente.',
      mimeType: MIME,
    },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: MIME, text: texto }] }),
  );
}
