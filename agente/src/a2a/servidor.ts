// Borda HTTP do agente (express):
//   GET  /.well-known/agent-card.json   Agent Card v1.0
//   POST /a2a                           JSON-RPC 2.0: SendMessage, GetTask
//
// O dispatcher JSON-RPC é o jsonRpcHandler do SDK A2A: valida o envelope,
// encontra o método, valida os params, chama o manipulador e devolve o
// resultado com o MESMO id. Aqui ficam só três ajustes de borda:
//   1. log de cada chamada (método, id, traceparent), sem conteúdo;
//   2. A2A-Version: 1.0 quando o header não vem (o SDK trataria como v0.3 e
//      responderia -32009; o validador nunca manda o header);
//   3. JSON malformado vira -32700 e envelope inválido vira -32600 (e não
//      uma página HTML ou um -32602).
import express, { type NextFunction, type Request, type Response } from 'express';
import type { AgentCard } from '@a2a-js/sdk';
import type { AgentExecutor, TaskStore } from '@a2a-js/sdk/server';
import { agentCardHandler, jsonRpcHandler, UserBuilder } from '@a2a-js/sdk/server/express';
import { ManipuladorDaCentral } from './manipulador.ts';

export type Registro = (linha: string) => void;

export interface DependenciasDoServidor {
  card: AgentCard;
  tasks: TaskStore;
  executor: AgentExecutor;
  registrar?: Registro;
}

export function criarAplicacao({ card, tasks, executor, registrar = (l) => console.error(l) }: DependenciasDoServidor): express.Express {
  const manipulador = new ManipuladorDaCentral(card, tasks, executor);
  const app = express();
  app.disable('x-powered-by');

  app.use('/.well-known/agent-card.json', agentCardHandler({ agentCardProvider: manipulador }));

  app.use('/a2a', express.json({ limit: '1mb' }), (req: Request, res: Response, next: NextFunction) => {
    const corpo = req.body as { method?: unknown; id?: unknown } | undefined;
    const tp = req.headers.traceparent ?? '-';
    registrar(`[a2a] recv method=${String(corpo?.method ?? '-')} id=${JSON.stringify(corpo?.id ?? null)} traceparent=${tp}`);
    // Envelope JSON-RPC 2.0: objeto com jsonrpc "2.0" e method string. O SDK
    // responderia -32602 a um envelope quebrado; a spec JSON-RPC pede -32600.
    if (!envelopeValido(req.body)) {
      const id = (req.body as { id?: unknown } | undefined)?.id;
      res.status(200).json({ jsonrpc: '2.0', id: typeof id === 'string' || typeof id === 'number' ? id : null, error: { code: -32600, message: 'Invalid Request' } });
      return;
    }
    if (!req.headers['a2a-version']) req.headers['a2a-version'] = '1.0';
    next();
  });
  app.use('/a2a', jsonRpcHandler({ requestHandler: manipulador, userBuilder: UserBuilder.noAuthentication }));

  // JSON inválido (express.json) → JSON-RPC Parse error, id null.
  app.use('/a2a', (erro: unknown, _req: Request, res: Response, next: NextFunction) => {
    if ((erro as { type?: string } | undefined)?.type === 'entity.parse.failed') {
      res.status(200).json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      return;
    }
    next(erro);
  });
  return app;
}

function envelopeValido(corpo: unknown): boolean {
  if (typeof corpo !== 'object' || corpo === null || Array.isArray(corpo)) return false;
  const c = corpo as Record<string, unknown>;
  if (c.jsonrpc !== '2.0' || typeof c.method !== 'string') return false;
  return !('id' in c) || c.id === null || typeof c.id === 'string' || typeof c.id === 'number';
}
