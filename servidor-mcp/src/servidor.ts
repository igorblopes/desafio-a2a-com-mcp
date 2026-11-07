// Factory do McpServer. O createMcpHandler chama esta função a CADA request:
// é isso que torna o servidor stateless (nada sobrevive entre requests no
// objeto do protocolo). Capabilities são derivadas do que registramos:
// registrar tools anuncia `tools`; resources entram no próximo passo.
import { McpServer } from '@modelcontextprotocol/server';
import { log } from './log.ts';
import { registrarListarSalas } from './tools/listar-salas.ts';

export function criarServidor(): McpServer {
  const servidor = new McpServer({ name: 'central-de-salas', version: '1.0.0' });
  registrarListarSalas(servidor);
  return servidor;
}

export function registrarErroInterno(erro: Error): void {
  // O SDK chama onerror tanto para rejeições de protocolo esperadas (_meta
  // incompleto, header divergente) quanto para falhas internas. Separamos as
  // duas no log; o detalhe fica só no stderr, nunca na resposta pública.
  const rejeicao = erro.message.startsWith('Rejected');
  log(rejeicao ? 'rejeitado' : 'erro', { tipo: erro.name, mensagem: erro.message });
}
