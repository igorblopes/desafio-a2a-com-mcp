// Processo do agente A2A (porta 7300). Independente do servidor MCP: sobe
// mesmo com o MCP fora do ar; o Host MCP conecta na primeira Task e reconecta
// depois de uma falha de transporte.
//
//   npm start                       (A2A_PORT, A2A_PUBLIC_URL, MCP_URL opcionais)
import { criarAgentCard } from './a2a/card.ts';
import { lerConfigDoAgente } from './a2a/config.ts';
import { ExecutorDeReservas } from './a2a/executor.ts';
import { ConexaoMcp, ServicoDeReserva } from './a2a/reserva.ts';
import { criarAplicacao } from './a2a/servidor.ts';
import { RepositorioDeTasks } from './a2a/tarefas/repositorio.ts';
import { RetomadasPendentes } from './a2a/tarefas/retomadas.ts';

const config = lerConfigDoAgente();
const conexao = new ConexaoMcp({ url: config.mcp });
const app = criarAplicacao({
  card: criarAgentCard(config.urlPublica),
  tasks: new RepositorioDeTasks(),
  executor: new ExecutorDeReservas(new ServicoDeReserva(conexao), new RetomadasPendentes()),
});

const servidor = app.listen(config.porta, () => {
  console.error(`[a2a] pronto em http://localhost:${config.porta} (card ${config.urlPublica}/.well-known/agent-card.json, mcp ${config.mcp.href})`);
});
servidor.on('error', (e) => {
  console.error(`[a2a] nao foi possivel abrir a porta ${config.porta}: ${e.message}`);
  process.exit(1);
});

for (const sinal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sinal, () => {
    servidor.close();
    void conexao.descartar().finally(() => process.exit(0));
  });
}
