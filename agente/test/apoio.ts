// Apoio dos testes de integração: sobe o servidor MCP REAL como outro
// processo (o mesmo `node --import tsx src/main.ts` do npm start) e conversa
// com ele só por HTTP. Nada de servidor-mcp/ é importado.
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ClienteMcp } from '../src/mcp/cliente.ts';
import { fetchObservado, type RequestObservado } from '../src/mcp/observacao.ts';

export const DIR_DO_SERVIDOR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'servidor-mcp');
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
  /** stderr acumulado do servidor (os logs "[mcp] recv ..."). */
  saida: { texto: string };
  processo: ChildProcess;
  parar(): Promise<void>;
}

export async function subirServidor(env: Record<string, string> = {}): Promise<ServidorDeTeste> {
  const porta = await portaLivre();
  const processo = spawn(process.execPath, ['--import', 'tsx', 'src/main.ts'], {
    cwd: DIR_DO_SERVIDOR,
    env: {
      ...process.env,
      MCP_PORT: String(porta),
      REQUEST_STATE_SECRET: randomBytes(32).toString('hex'), // só desta execução
      REQUEST_STATE_TTL_SECONDS: '',
      ...env,
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  const saida = { texto: '' };
  await new Promise<void>((resolve, reject) => {
    const limite = setTimeout(() => reject(new Error(`servidor não subiu:\n${saida.texto}`)), 15000);
    processo.stderr!.on('data', (parte: Buffer) => {
      saida.texto += parte.toString('utf8');
      if (saida.texto.includes('[mcp] pronto')) {
        clearTimeout(limite);
        resolve();
      }
    });
    processo.once('exit', (c) => {
      clearTimeout(limite);
      reject(new Error(`servidor saiu (${c}):\n${saida.texto}`));
    });
  });
  return {
    url: new URL(`http://localhost:${porta}/mcp`),
    porta,
    saida,
    processo,
    parar: () =>
      new Promise<void>((resolve) => {
        if (processo.exitCode !== null) return resolve();
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
