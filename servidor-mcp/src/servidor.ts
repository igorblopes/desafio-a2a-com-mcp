// Factory do McpServer. O createMcpHandler chama esta função a CADA request:
// é isso que torna o servidor stateless (nada sobrevive entre requests no
// objeto do protocolo). Capabilities são derivadas do que registramos:
// registrar uma tool anuncia `tools`; registrar um resource anuncia `resources`.
import { McpServer } from '@modelcontextprotocol/server';
import { log } from './log.ts';
import { registrarListarSalas } from './tools/listar-salas.ts';
import { registrarConsultarDisponibilidade } from './tools/consultar-disponibilidade.ts';
import { registrarReservarSala } from './tools/reservar-sala.ts';
import { registrarPolitica } from './recursos/politica.ts';
import { verificarSelo } from './estado-mrtr.ts';

export function criarServidor(): McpServer {
  // O catálogo é fixo (as tools e o resource não mudam com o processo no ar),
  // então não prometemos notificações de list_changed. Sem isto, o SDK
  // anuncia listChanged: true ao registrar a primeira tool ou resource.
  const servidor = new McpServer(
    { name: 'central-de-salas', version: '1.0.0' },
    {
      capabilities: { tools: { listChanged: false }, resources: { listChanged: false } },
      // Todo requestState ecoado passa por aqui ANTES do handler. Se o verify
      // lançar (MAC inválido, expirado, malformado), o SDK responde -32602
      // "Invalid or expired requestState" e o handler nem é chamado.
      requestState: { verify: verificarSelo },
    },
  );
  // Erros vistos DENTRO do protocolo (ex.: requestState recusado pelo verify)
  // chegam por aqui, e não pelo onerror do createMcpHandler.
  servidor.server.onerror = registrarErroInterno;
  registrarListarSalas(servidor);
  registrarConsultarDisponibilidade(servidor);
  registrarReservarSala(servidor);
  registrarPolitica(servidor);
  return servidor;
}

export function registrarErroInterno(erro: Error): void {
  // O SDK chama onerror tanto para rejeições de protocolo esperadas (_meta
  // incompleto, header divergente) quanto para falhas internas. Separamos as
  // duas no log; o detalhe fica só no stderr, nunca na resposta pública.
  // O motivo da recusa do requestState é um código opaco do codec
  // ('mac', 'expired', 'malformed'...) ou o caminho do campo inválido no selo:
  // nunca o requestState inteiro, nunca o segredo.
  const rejeicao = erro.message.startsWith('Rejected') || erro.message.startsWith('requestState verification rejected');
  log(rejeicao ? 'rejeitado' : 'erro', { tipo: erro.name, mensagem: erro.message });
}
