# agente

Hoje (Passo 9): **Host MCP** sobre um **cliente MCP** independente do servidor da Central de Salas. Tudo fala só por HTTP (Streamable HTTP, revisão `2026-07-28`) com o SDK oficial `@modelcontextprotocol/client` 2.4.0, e nada é importado de `servidor-mcp/`. O servidor A2A (porta 7300) vem nos próximos passos e vai usar o Host.

- `src/mcp/`: cliente, só protocolo (transporte, `_meta`, headers, ids, erros JSON-RPC e de rede).
- `src/host/`: Host, que organiza o uso (catálogo, política, contexto de execução, continuação MRTR, seis desfechos). Não tem nenhuma regra de salas.
- `src/demo.ts`: aplicação de terminal que consome só o Host.

Detalhes de projeto: seções "Passo 8" e "Passo 9" de [`../ARQUITETURA.md`](../ARQUITETURA.md).

## Como rodar

```powershell
cd agente
npm install
npm run check      # tsc --noEmit
npm test           # unidade + cliente + Host (sobe o servidor-mcp sozinho, em porta livre)
```

Demonstração, com o servidor MCP no ar (`cd servidor-mcp; npm start`):

```powershell
npm run demo                                              # reserva simples
npm run demo -- --exemplo conflito                        # input_required: escolha no teclado (1, 2, r, c)
npm run demo -- --exemplo conflito --escolha sala-fusca   # escolha por argumento
npm run demo -- --exemplo conflito --recusar              # decline (ou --cancelar)
npm run demo -- --exemplo conflito --escolha sala-x       # resposta_invalida: nada é enviado
npm run demo -- --sala sala-porao --inicio 2026-11-25T09:00:00-03:00 --fim 2026-11-25T10:00:00-03:00 --responsavel Igor
npm run demo -- --traceparent 00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01
```

`MCP_URL` muda o endpoint (padrão `http://localhost:7301/mcp`). A demo imprime o catálogo, a política com a origem, cada request enviado (id JSON-RPC, `Mcp-Method`, `Mcp-Name`, `MCP-Protocol-Version`, `traceparent`), o tipo de cada resultado e a continuação resumida (sem o `requestState`).

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
