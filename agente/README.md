# agente

Hoje (Passo 8): **cliente MCP independente** do servidor da Central de Salas. Ele fala só por HTTP (Streamable HTTP, revisão `2026-07-28`) com o SDK oficial `@modelcontextprotocol/client` 2.4.0 e não importa nada de `servidor-mcp/`. O servidor A2A (porta 7300) vem nos próximos passos e vai reutilizar `src/mcp/`.

Detalhes de projeto: seção "Passo 8" de [`../ARQUITETURA.md`](../ARQUITETURA.md).

## Como rodar

```powershell
cd agente
npm install
npm run check      # tsc --noEmit
npm test           # unidade + integração (sobe o servidor-mcp sozinho, em porta livre)
```

Demonstração, com o servidor MCP no ar (`cd servidor-mcp; npm start`):

```powershell
npm run demo                                              # reserva simples
npm run demo -- --exemplo conflito                        # input_required: escolha no teclado (1, 2, r, c)
npm run demo -- --exemplo conflito --escolha sala-fusca   # escolha por argumento
npm run demo -- --exemplo conflito --recusar              # decline (ou --cancelar)
npm run demo -- --sala sala-porao --inicio 2026-11-25T09:00:00-03:00 --fim 2026-11-25T10:00:00-03:00 --responsavel Igor
npm run demo -- --traceparent 00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01
```

`MCP_URL` muda o endpoint (padrão `http://localhost:7301/mcp`). A demo imprime cada request enviado (id JSON-RPC, `Mcp-Method`, `Mcp-Name`, `MCP-Protocol-Version`, `traceparent`) e o resultado estruturado.

A demo altera a agenda do servidor (que é em memória). Reinicie o servidor antes de rodar o validador.

## Uso como biblioteca

```ts
import { ClienteMcp } from './src/mcp/cliente.ts';
import { aceitar } from './src/mcp/mrtr.ts';

const cliente = await ClienteMcp.conectar({ url: new URL('http://localhost:7301/mcp') });
const op = { traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01' };
await cliente.descobrir(op);                      // tools/list: obrigatório antes de chamar
const { versao } = await cliente.lerPolitica(op); // resources/read politica://uso
let r = await cliente.chamarTool('reservar_sala', { sala, inicio, fim, responsavel }, op);
if (r.tipo === 'input_required') {
  const [pedido] = r.pedidos;                     // chave, mensagem, campos/opções
  r = await cliente.continuar(r, { [pedido.chave]: aceitar(pedido, { sala: 'sala-fusca' }) }, op);
}
```
