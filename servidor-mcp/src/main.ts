// Borda HTTP do servidor MCP.
// 1. Lê o corpo e registra método, id e traceparent no stderr (inclusive de
//    requests que o SDK vai rejeitar, como _meta incompleto).
// 2. Entrega o request ao handler do SDK, que faz o protocolo inteiro:
//    validação do _meta e dos headers espelho, JSON-RPC, despacho e resposta.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import {
  createMcpHandler,
  hostHeaderValidationResponse,
  localhostAllowedHostnames,
} from '@modelcontextprotocol/server';
import { config } from './config.ts';
import { log } from './log.ts';
import { criarServidor, registrarErroInterno } from './servidor.ts';
import { listarSalas, reservasIniciais } from './dominio/agenda.ts';
import { cabecalhoDaPolitica } from './recursos/politica.ts';

const handler = createMcpHandler(criarServidor, {
  legacy: 'reject', // só a revisão 2026-07-28 (nada de initialize/sessão)
  responseMode: 'json', // nunca SSE: o validador lê o corpo como JSON
  onerror: registrarErroInterno,
});

async function lerCorpo(req: IncomingMessage): Promise<Buffer> {
  const partes: Buffer[] = [];
  for await (const parte of req) partes.push(parte as Buffer);
  return Buffer.concat(partes);
}

function registrarEntrada(corpo: Buffer): void {
  try {
    const msg = JSON.parse(corpo.toString('utf8'));
    for (const m of Array.isArray(msg) ? msg : [msg]) {
      const meta = m?.params?._meta ?? {};
      log('recv', {
        method: m?.method,
        id: m?.id === undefined ? undefined : JSON.stringify(m.id),
        name: m?.params?.name ?? m?.params?.uri,
        traceparent: typeof meta.traceparent === 'string' ? meta.traceparent : undefined,
      });
    }
  } catch {
    log('recv', { erro: 'corpo nao e JSON', bytes: corpo.length });
  }
}

async function atender(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  if (url.pathname !== config.caminho) {
    res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
    return;
  }

  const corpo = req.method === 'POST' ? await lerCorpo(req) : undefined;
  if (corpo) registrarEntrada(corpo);

  const headers = new Headers();
  for (const [nome, valor] of Object.entries(req.headers)) {
    if (valor !== undefined) headers.set(nome, Array.isArray(valor) ? valor.join(', ') : valor);
  }
  const request = new Request(url, { method: req.method, headers, body: corpo ? new Uint8Array(corpo) : undefined });

  // Proteção contra DNS rebinding: só aceitamos Host de localhost.
  const resposta =
    hostHeaderValidationResponse(request, localhostAllowedHostnames()) ??
    (await handler.fetch(request));

  // Repassa a resposta em streaming, sem bufferizar: chamadas comuns voltam
  // como um JSON único (responseMode 'json'), mas subscriptions/listen é SSE
  // por definição e ficaria pendurado se esperássemos o corpo inteiro.
  res.writeHead(resposta.status, Object.fromEntries(resposta.headers));
  if (!resposta.body) {
    res.end();
    return;
  }
  const corpoResposta = Readable.fromWeb(resposta.body as WebReadableStream<Uint8Array>);
  req.on('close', () => corpoResposta.destroy());
  corpoResposta.pipe(res);
}

createServer((req, res) => {
  atender(req, res).catch((erro: unknown) => {
    registrarErroInterno(erro instanceof Error ? erro : new Error(String(erro)));
    if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain' });
    res.end('internal error');
  });
}).listen(config.porta, () => {
  log('pronto', {
    url: `http://localhost:${config.porta}${config.caminho}`,
    salas: listarSalas().length,
    reservas: reservasIniciais,
    politica: cabecalhoDaPolitica,
    protocolo: '2026-07-28',
  });
});
