# agente

**Servidor A2A** na porta 7300 (`@a2a-js/sdk` 1.3.0, protocolo A2A 1.0, JSON-RPC) que atende pedidos de reserva criando **Tasks** e os executa pelo **Host MCP**, que fala com o servidor da Central de Salas só por HTTP (Streamable HTTP, revisão `2026-07-28`, `@modelcontextprotocol/client` 2.4.0). Nada é importado de `servidor-mcp/`.

- `src/main.ts` e `src/a2a/`: Agent Card, `POST /a2a` (`SendMessage`, `GetTask`), Tasks em memória com máquina de estados explícita, artifact `reserva` e a **ponte**: um conflito pausa a Task (`INPUT_REQUIRED`) e um novo `SendMessage` com o mesmo `taskId` a retoma.
- `src/mcp/`: cliente, só protocolo (transporte, `_meta`, headers, ids, erros JSON-RPC e de rede).
- `src/host/`: Host, que organiza o uso (catálogo, política, contexto de execução, continuação MRTR, seis desfechos). Não tem nenhuma regra de salas.
- `src/demo.ts`: aplicação de terminal que consome só o Host.

Como rodar o projeto inteiro, onde a ponte acontece e a demonstração com os envelopes oficiais: [`../README.md`](../README.md). Detalhes de projeto: [`../ARQUITETURA.md`](../ARQUITETURA.md).

## Como rodar

```powershell
cd agente
npm ci             # exatamente o package-lock.json (instale também o servidor-mcp: os testes o sobem)
npm run check      # tsc --noEmit
npm test           # unidade, cliente, Host, A2A, ponte e falhas (sobe servidor-mcp e agente sozinhos, em portas livres)
```

## Servidor A2A

```powershell
cd servidor-mcp; npm start     # terminal 1: MCP na 7301 (precisa de REQUEST_STATE_SECRET no .env)
cd agente; npm start           # terminal 2: A2A na 7300 (sobe mesmo sem o MCP)
```

Variáveis: `A2A_PORT` (padrão 7300), `A2A_PUBLIC_URL` (padrão `http://localhost:<porta>`, vai no card), `MCP_URL` (padrão `http://localhost:7301/mcp`) e `MCP_TIMEOUT_MS` (padrão 20000, entre 1000 e 120000: quanto o agente espera por uma resposta do servidor MCP antes de desistir; um `tools/call` sem resposta termina a Task em `FAILED` dizendo que não dá para confirmar se a reserva foi registrada, e nunca é reenviado sozinho).

O pedido é um texto fixo: `reservar sala=<id> inicio=<ISO> fim=<ISO> responsavel=<nome>`. O agente só lê o formato; as regras de salas são do servidor MCP.

```bash
curl -s http://localhost:7300/.well-known/agent-card.json

curl -s http://localhost:7300/a2a -H 'content-type: application/json' \
  -H 'traceparent: 00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01' \
  -d '{"jsonrpc":"2.0","id":"req-1","method":"SendMessage","params":{"message":{"messageId":"m1","role":"ROLE_USER","parts":[{"text":"reservar sala=sala-porao inicio=2026-11-25T09:00:00-03:00 fim=2026-11-25T10:00:00-03:00 responsavel=Marty"}]}}}'

curl -s http://localhost:7300/a2a -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":"req-2","method":"GetTask","params":{"id":"<task.id da resposta anterior>"}}'
```

Desfechos: `TASK_STATE_COMPLETED` com o artifact `reserva`; `TASK_STATE_FAILED` com a mensagem do servidor MCP (por exemplo `Sala inexistente: sala-delorean`) ou com `Servidor de reservas indisponivel no momento.`; `TASK_STATE_INPUT_REQUIRED` quando a sala está ocupada, com a mensagem `alternativas: sala-fusca, sala-mirante`. Uma Task terminal não aceita nova mensagem (`-32004`).

Para responder a uma Task pausada, mande outro `SendMessage` com `"taskId"` dentro de `message` e o texto `escolha=<sala>` (conclui a reserva) ou `escolha=recusar` (`TASK_STATE_CANCELED`). Uma escolha fora da lista deixa a Task pausada, com a mesma mensagem:

```bash
curl -s http://localhost:7300/a2a -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":"req-3","method":"SendMessage","params":{"message":{"messageId":"m2","role":"ROLE_USER","taskId":"<task.id pausada>","parts":[{"text":"escolha=sala-mirante"}]}}}'
```

As Tasks ficam em memória: reiniciar o agente apaga todas. Reinicie os dois processos antes de rodar o validador.

## Demonstração do Host MCP (terminal)

Com o servidor MCP no ar (`cd servidor-mcp; npm start`):

```powershell
npm run demo                                              # reserva simples
npm run demo -- --exemplo conflito                        # input_required: escolha no teclado (1, 2, r, c)
npm run demo -- --exemplo conflito --escolha sala-fusca   # escolha por argumento
npm run demo -- --exemplo conflito --recusar              # decline (ou --cancelar)
npm run demo -- --exemplo conflito --escolha sala-x       # resposta_invalida: nada é enviado
npm run demo -- --sala sala-porao --inicio 2026-11-25T09:00:00-03:00 --fim 2026-11-25T10:00:00-03:00 --responsavel Marty
npm run demo -- --traceparent 00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01
```

`MCP_URL` muda o endpoint (padrão `http://localhost:7301/mcp`) e `MCP_TIMEOUT_MS` a espera máxima por resposta (padrão 20000). A demo imprime o catálogo, a política com a origem, cada request enviado (id JSON-RPC, `Mcp-Method`, `Mcp-Name`, `MCP-Protocol-Version`, `traceparent`), o tipo de cada resultado e a continuação resumida (sem o `requestState`).

A demo altera a agenda do servidor (que é em memória). Reinicie o servidor antes de rodar o validador.

## Uso como biblioteca

```ts
import { HostMcp } from './src/host/host.ts';

const ctx = { operacao: 'op-1', traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01' };
const host = await HostMcp.iniciar({ url: new URL('http://localhost:7301/mcp') }, ctx); // connect + tools/list
const { versao, origem } = await host.lerPolitica(ctx);                                 // resources/read politica://uso
let r = await host.executar('reservar_sala', { sala, inicio, fim, responsavel }, ctx);
if (r.tipo === 'input_required') {
  const guardada = JSON.stringify(r.continuacao);           // é um valor: pode ser guardado e retomado depois
  r = await host.continuar(JSON.parse(guardada), { action: 'accept', content: { sala: 'sala-fusca' } }, ctx);
}
// r.tipo: completo | erro_execucao | input_required | erro_protocolo | falha_transporte | resposta_invalida
await host.encerrar();
```

A `Continuacao` carrega o `requestState` do servidor. Guarde-a em lugar privado e, para log, use `resumir(continuacao)`.
