# servidor-mcp

Servidor MCP da Central de Salas: Streamable HTTP, revisão `2026-07-28`, sem sessão. Cada request carrega no `_meta` a própria versão e as próprias capabilities, e o servidor responde sempre em JSON (nunca SSE).

> **Estado atual (Passo 3):** só existe a tool `listar_salas`. `consultar_disponibilidade`, `reservar_sala`, o resource `politica://uso` e o MRTR entram nos próximos passos.

## Pré-requisito

- Node.js **22 ou superior** (`node -v`).

## Como rodar

```powershell
cd servidor-mcp
npm ci          # instala exatamente as versões do package-lock.json
npm start       # escuta em http://localhost:7301/mcp; logs no stderr
```

Outros scripts:

| Comando | O que faz |
|---|---|
| `npm run dev` | Sobe com `tsx watch`, reiniciando a cada alteração em `src/` |
| `npm run check` | Checagem de tipos (`tsc --noEmit`), sem gerar arquivos |

## Variáveis de ambiente

| Variável | Padrão | Uso |
|---|---|---|
| `MCP_PORT` | `7301` | Porta HTTP |
| `DADOS_DIR` | `../dados` (relativo a `servidor-mcp/`) | Pasta com `salas.json` |

Exemplo, no PowerShell: `$env:MCP_PORT = '7401'; npm start`.

## Exemplos de request (PowerShell)

Todo request precisa:

- dos headers `MCP-Protocol-Version`, `Mcp-Method` e, em `tools/call`, `Mcp-Name`, que espelham o corpo;
- no corpo, de `params._meta` com `io.modelcontextprotocol/protocolVersion` e `io.modelcontextprotocol/clientCapabilities`. O `traceparent` é opcional e aparece no log.

Os exemplos funcionam no Windows PowerShell 5.1 e no PowerShell 7.

```powershell
$url  = 'http://localhost:7301/mcp'
$meta = @{
  'io.modelcontextprotocol/protocolVersion'    = '2026-07-28'
  'io.modelcontextprotocol/clientCapabilities' = @{ elicitation = @{ form = @{} } }
  'traceparent' = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01'
}

# tools/list
$corpo = @{ jsonrpc = '2.0'; id = 1; method = 'tools/list'; params = @{ _meta = $meta } } | ConvertTo-Json -Depth 10
$h = @{ 'Accept' = 'application/json, text/event-stream'; 'MCP-Protocol-Version' = '2026-07-28'; 'Mcp-Method' = 'tools/list' }
$r = Invoke-RestMethod -Uri $url -Method Post -ContentType 'application/json' -Headers $h -Body $corpo
$r.result.tools | Select-Object name, description

# tools/call listar_salas
$corpo = @{ jsonrpc = '2.0'; id = 2; method = 'tools/call'
            params = @{ name = 'listar_salas'; arguments = @{}; _meta = $meta } } | ConvertTo-Json -Depth 10
$h = @{ 'Accept' = 'application/json, text/event-stream'; 'MCP-Protocol-Version' = '2026-07-28'
        'Mcp-Method' = 'tools/call'; 'Mcp-Name' = 'listar_salas' }
$r = Invoke-RestMethod -Uri $url -Method Post -ContentType 'application/json' -Headers $h -Body $corpo
$r.result.resultType                       # complete
$r.result.structuredContent.salas | Format-Table
```

Para ver uma rejeição de protocolo (HTTP 400 + `-32602`), remova `io.modelcontextprotocol/protocolVersion` do `$meta`. No PowerShell 5.1, o `Invoke-RestMethod` lança exceção em respostas 4xx, e o corpo precisa ser lido do stream da resposta:

```powershell
$meta.Remove('io.modelcontextprotocol/protocolVersion')
$corpo = @{ jsonrpc = '2.0'; id = 3; method = 'tools/list'; params = @{ _meta = $meta } } | ConvertTo-Json -Depth 10
$h = @{ 'Accept' = 'application/json, text/event-stream'; 'MCP-Protocol-Version' = '2026-07-28'; 'Mcp-Method' = 'tools/list' }
try {
  Invoke-RestMethod -Uri $url -Method Post -ContentType 'application/json' -Headers $h -Body $corpo
} catch {
  'HTTP ' + [int]$_.Exception.Response.StatusCode                 # HTTP 400
  $s = $_.Exception.Response.GetResponseStream(); $s.Position = 0
  (New-Object System.IO.StreamReader($s)).ReadToEnd()              # {"jsonrpc":"2.0","error":{"code":-32602,...}}
}
```

No PowerShell 7 é mais simples: acrescente `-SkipHttpErrorCheck -StatusCodeVariable st` ao `Invoke-RestMethod`, e o corpo do erro volta como resultado normal.

## Logs (stderr)

Uma linha por evento, prefixada por `[mcp]`:

| Evento | Quando | Exemplo |
|---|---|---|
| `pronto` | O servidor subiu | `[mcp] pronto url=http://localhost:7301/mcp salas=5 protocolo=2026-07-28` |
| `recv` | Todo request recebido, **antes** do SDK (inclusive os que serão rejeitados) | `[mcp] recv method=tools/call id=2 name=listar_salas traceparent=00-4bf9…-01` |
| `rejeitado` | O SDK recusou o request por protocolo (`_meta` incompleto, header divergente…) | `[mcp] rejeitado tipo=Error mensagem="Rejected inbound request (envelope-invalid): …"` |
| `erro` | Falha interna inesperada | `[mcp] erro tipo=… mensagem=…` |

Ao subir, também aparece este aviso do SDK, que é **esperado**:

```
responseMode: 'json' drops mid-call notifications. subscriptions/listen streams are always served over SSE regardless; other notifications emitted before a result are dropped.
```

Ele avisa que notificações enviadas no meio de uma chamada são descartadas no modo JSON. Não usamos notificações desse tipo.

## Arquivos

| Arquivo | Responsabilidade |
|---|---|
| `src/main.ts` | Borda HTTP (`node:http`): valida o Host, registra cada request no stderr, entrega ao `createMcpHandler` do SDK e repassa a resposta em streaming |
| `src/config.ts` | Lê `MCP_PORT` e `DADOS_DIR` uma única vez |
| `src/log.ts` | Log de uma linha no stderr |
| `src/servidor.ts` | Factory do `McpServer` (uma instância por request, por isso stateless) e tratamento do `onerror` |
| `src/tools/listar-salas.ts` | Tool `listar_salas`: `structuredContent` conforme o `outputSchema` e o mesmo JSON em texto |
| `src/dominio/agenda.ts` | Carrega e valida `dados/salas.json` uma vez (singleton de módulo) |
