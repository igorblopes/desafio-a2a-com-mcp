// Apoio dos testes de integração: sobe o servidor MCP REAL (e, nos testes
// A2A, o agente REAL) como outros processos (o mesmo `node --import tsx
// src/main.ts` do npm start) e conversa com eles só por HTTP. Nada de
// servidor-mcp/ é importado.
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HostMcp } from '../src/host/host.ts';
import type { ContextoDeExecucao } from '../src/host/contexto.ts';
import { ClienteMcp } from '../src/mcp/cliente.ts';
import { fetchObservado, type RequestObservado } from '../src/mcp/observacao.ts';

export const DIR_DO_SERVIDOR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'servidor-mcp');
export const DIR_DO_AGENTE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const TRACEPARENT = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';
export const TRACE_ID = '4bf92f3577b34da6a3ce929d0e0e4736';

export const em = (dia: string, hora: string) => `2026-11-${dia}T${hora}:00-03:00`;

export function portaLivre(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, () => {
      const { port } = s.address() as { port: number };
      s.close(() => resolve(port));
    });
  });
}

export interface ServidorDeTeste {
  url: URL;
  porta: number;
  /** stderr acumulado do processo (os logs "[mcp] recv ..." ou "[a2a] ..."). */
  saida: { texto: string };
  processo: ChildProcess;
  parar(): Promise<void>;
}

export async function subirServidor(env: Record<string, string> = {}): Promise<ServidorDeTeste> {
  const porta = env.MCP_PORT ? Number(env.MCP_PORT) : await portaLivre();
  return subirProcesso(DIR_DO_SERVIDOR, '[mcp] pronto', new URL(`http://localhost:${porta}/mcp`), porta, {
    REQUEST_STATE_SECRET: randomBytes(32).toString('hex'), // só desta execução
    REQUEST_STATE_TTL_SECONDS: '',
    ...env,
    MCP_PORT: String(porta),
  });
}

/** Sobe o agente A2A REAL (src/main.ts, o mesmo do npm start) em outro processo. `url` é a base (http://localhost:porta). */
export async function subirAgente(mcp: URL, env: Record<string, string> = {}): Promise<ServidorDeTeste> {
  const porta = env.A2A_PORT ? Number(env.A2A_PORT) : await portaLivre();
  return subirProcesso(DIR_DO_AGENTE, '[a2a] pronto', new URL(`http://localhost:${porta}`), porta, { MCP_URL: mcp.href, ...env, A2A_PORT: String(porta), A2A_PUBLIC_URL: '' });
}

async function subirProcesso(cwd: string, pronto: string, url: URL, porta: number, env: Record<string, string>): Promise<ServidorDeTeste> {
  const processo = spawn(process.execPath, ['--import', 'tsx', 'src/main.ts'], {
    cwd,
    env: { ...process.env, TRACEPARENT: '', ...env },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  const saida = { texto: '' };
  await new Promise<void>((resolve, reject) => {
    const limite = setTimeout(() => reject(new Error(`processo não subiu:\n${saida.texto}`)), 15000);
    processo.stderr!.on('data', (parte: Buffer) => {
      saida.texto += parte.toString('utf8');
      if (saida.texto.includes(pronto)) {
        clearTimeout(limite);
        resolve();
      }
    });
    processo.once('exit', (c) => {
      clearTimeout(limite);
      reject(new Error(`processo saiu (${c}):\n${saida.texto}`));
    });
  });
  return {
    url,
    porta,
    saida,
    processo,
    parar: () =>
      new Promise<void>((resolve) => {
        if (processo.exitCode !== null || processo.signalCode !== null) return resolve();
        processo.once('exit', () => resolve());
        processo.kill();
      }),
  };
}

/** Cliente conectado + registro de tudo que ele mandou pelo fio. */
export async function conectar(url: URL): Promise<{ cliente: ClienteMcp; fio: RequestObservado[] }> {
  const fio: RequestObservado[] = [];
  const cliente = await ClienteMcp.conectar({ url, fetch: fetchObservado((r) => fio.push(r)) });
  return { cliente, fio };
}

/** Linhas "[mcp] recv" do servidor para um id JSON-RPC. */
export function logDoId(saida: string, id: string | number | undefined): string | undefined {
  return saida.split(/\r?\n/).find((l) => l.startsWith('[mcp] recv ') && l.includes(` id=${JSON.stringify(id)} `));
}

/** Host iniciado (server/discover + tools/list) + registro do fio. */
export async function iniciarHost(url: URL, ctx: ContextoDeExecucao = {}): Promise<{ host: HostMcp; fio: RequestObservado[] }> {
  const fio: RequestObservado[] = [];
  const host = await HostMcp.iniciar({ url, fetch: fetchObservado((r) => fio.push(r)) }, ctx);
  return { host, fio };
}

/** Um traceparent válido com trace-id aleatório: cada teste rastreia só os próprios requests. */
export function novoTraceparent(): { traceparent: string; traceId: string } {
  const traceId = randomBytes(16).toString('hex');
  return { traceparent: `00-${traceId}-${randomBytes(8).toString('hex')}-01`, traceId };
}

/** POST JSON-RPC em /a2a. Devolve status HTTP e corpo já lido. */
export async function rpc(base: URL, corpo: unknown, headers: Record<string, string> = {}): Promise<{ http: number; corpo: any; texto: string }> {
  const r = await fetch(new URL('/a2a', base), { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: typeof corpo === 'string' ? corpo : JSON.stringify(corpo) });
  const texto = await r.text();
  let json: unknown;
  try {
    json = JSON.parse(texto);
  } catch {
    json = undefined;
  }
  return { http: r.status, corpo: json, texto };
}
