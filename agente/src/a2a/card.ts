// Agent Card A2A v1.0: o "cartão de visita" que outro agente lê em
// /.well-known/agent-card.json antes de conversar. Espelha
// exemplos/wire/07-a2a-agent-card.json.
//
// Opacidade: o card diz O QUE o agente faz (reservar sala, por texto) e COMO
// falar com ele (JSON-RPC em /a2a, versão 1.0). Não diz que por dentro há um
// servidor MCP, nem nomes de tools, nem requestState.
//
// Campos da v1.0 (e não da v0.x): supportedInterfaces[] com url,
// protocolBinding e protocolVersion. Não existem `url`, `preferredTransport`
// nem `additionalInterfaces` no nível do card.
import type { AgentCard } from '@a2a-js/sdk';

export const ID_DA_SKILL = 'reservar-sala';

export function criarAgentCard(urlPublica: string): AgentCard {
  return {
    name: 'Central de Salas',
    description: 'Reserva salas de reuniao da Hill Valley Tech.',
    provider: { organization: 'Hill Valley Tech', url: 'https://hillvalley.example' },
    version: '1.0.0',
    supportedInterfaces: [{ url: `${urlPublica}/a2a`, protocolBinding: 'JSONRPC', protocolVersion: '1.0' }],
    capabilities: { streaming: false, pushNotifications: false, extendedAgentCard: false },
    defaultInputModes: ['text/plain'],
    defaultOutputModes: ['text/plain'],
    skills: [
      {
        id: ID_DA_SKILL,
        name: 'Reservar sala',
        description: 'Reserva uma sala em um intervalo. Se houver conflito, pergunta qual alternativa usar.',
        tags: ['salas', 'agenda'],
        examples: ['reservar sala=sala-garagem inicio=2026-11-03T14:00:00-03:00 fim=2026-11-03T15:00:00-03:00 responsavel=Marty'],
        inputModes: ['text/plain'],
        outputModes: ['text/plain'],
      },
    ],
  } as unknown as AgentCard; // só os campos do contrato (exemplos/wire/07); o resto é opcional no JSON
}
