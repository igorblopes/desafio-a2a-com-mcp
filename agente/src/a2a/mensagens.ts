// Construção de mensagens, status e artifacts no modelo do SDK A2A.
// O SDK usa o modelo do protobuf da v1.0 (Part.content = { $case, value }) e
// serializa no JSON do contrato ({ "text": "..." }).
import { randomUUID } from 'node:crypto';
import { Role, TaskState, type Artifact, type Message, type Part, type TaskStatus } from '@a2a-js/sdk';

export const parteDeTexto = (texto: string): Part => ({ content: { $case: 'text', value: texto }, metadata: undefined, filename: '', mediaType: '' }) as Part;

/** Texto de todas as partes de texto, na ordem (ignora arquivos e dados). */
export function textoDe(mensagem: Message | undefined): string {
  return (mensagem?.parts ?? [])
    .map((p) => (p.content?.$case === 'text' ? p.content.value : ''))
    .filter(Boolean)
    .join('\n');
}

export function mensagemDoAgente(texto: string, taskId: string, contextId: string): Message {
  return { messageId: `msg-${randomUUID()}`, role: Role.ROLE_AGENT, parts: [parteDeTexto(texto)], taskId, contextId, metadata: undefined, extensions: [], referenceTaskIds: [] };
}

export function status(state: TaskState, mensagem?: Message): TaskStatus {
  return { state, message: mensagem, timestamp: new Date().toISOString() };
}

/** Artifact "reserva": o JSON da reserva, como texto, numa parte só (exemplos/wire/10). */
export function artifactDaReserva(reserva: Record<string, unknown>): Artifact {
  return { artifactId: `art-${randomUUID()}`, name: 'reserva', description: '', parts: [parteDeTexto(JSON.stringify(reserva))], metadata: undefined, extensions: [] };
}
