// Factory do McpServer. O createMcpHandler chama esta função a CADA request:
// é isso que torna o servidor stateless (nada sobrevive entre requests no
// objeto do protocolo). Capabilities são derivadas do que registramos:
// registrar uma tool anuncia `tools`; registrar um resource anuncia `resources`.
import { McpServer } from '@modelcontextprotocol/server';
import { log } from './log.ts';
import { registrarListarSalas } from './tools/listar-salas.ts';
import { registrarConsultarDisponibilidade } from './tools/consultar-disponibilidade.ts';
import { registrarPolitica } from './recursos/politica.ts';

export function criarServidor(): McpServer {
  // O catálogo é fixo (as tools e o resource não mudam com o processo no ar),
  // então não prometemos notificações de list_changed. Sem isto, o SDK
  // anuncia listChanged: true ao registrar a primeira tool ou resource.
  const servidor = new McpServer(
    { name: 'central-de-salas', version: '1.0.0' },
    { capabilities: { tools: { listChanged: false }, resources: { listChanged: false } } },
  );
  registrarListarSalas(servidor);
  registrarConsultarDisponibilidade(servidor);
  registrarPolitica(servidor);
  return servidor;
}

export function registrarErroInterno(erro: Error): void {
  // O SDK chama onerror tanto para rejeições de protocolo esperadas (_meta
  // incompleto, header divergente) quanto para falhas internas. Separamos as
  // duas no log; o detalhe fica só no stderr, nunca na resposta pública.
  const rejeicao = erro.message.startsWith('Rejected');
  log(rejeicao ? 'rejeitado' : 'erro', { tipo: erro.name, mensagem: erro.message });
}
