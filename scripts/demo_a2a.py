# Demonstracao manual do agente A2A, so com a biblioteca padrao do Python (3.10+).
#
# Cada comando envia UM request ao agente usando o envelope dos exemplos oficiais
# (exemplos/wire/08, 09 e 10): mesmo metodo, mesma estrutura, mesmos headers. So
# troca o que precisa mudar a cada envio: o messageId (novo), o texto e o taskId.
# A resposta JSON e impressa inteira, seguida de uma linha de resumo.
#
# Uso (na raiz do repositorio, com o servidor MCP e o agente no ar):
#   python scripts/demo_a2a.py card                      # GET /.well-known/agent-card.json
#   python scripts/demo_a2a.py pedir                     # SendMessage do exemplo 08 (sala-garagem 14h-15h, 03/11)
#   python scripts/demo_a2a.py pedir "reservar sala=... inicio=... fim=... responsavel=..."
#   python scripts/demo_a2a.py responder <taskId> escolha=sala-mirante   # continuacao (exemplo 10)
#   python scripts/demo_a2a.py responder <taskId> escolha=recusar
#   python scripts/demo_a2a.py consultar <taskId>        # GetTask (exemplo 09)
#
# Opcoes: --agente URL (padrao http://localhost:7300); --sem-trace (nao envia traceparent).
import argparse, json, pathlib, secrets, sys, urllib.error, urllib.request

WIRE = pathlib.Path(__file__).resolve().parent.parent / 'exemplos' / 'wire'


def request_do_exemplo(nome):
    return json.loads((WIRE / nome).read_text(encoding='utf-8'))['request']


def enviar(url, req, corpo, sem_trace):
    headers = dict(req['headers'])
    if sem_trace:
        headers.pop('traceparent', None)
    http = urllib.request.Request(url, data=json.dumps(corpo).encode('utf-8'), headers=headers, method='POST')
    return abrir(http)


def abrir(http):
    try:
        with urllib.request.urlopen(http, timeout=30) as r:
            return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b'{}')
    except urllib.error.URLError as e:
        sys.exit(f'nao foi possivel falar com {http.full_url}: {e.reason} (o agente esta no ar?)')


def mensagem(req, texto, task_id=None):
    corpo = json.loads(json.dumps(req['body']))
    msg = corpo['params']['message']
    msg['messageId'] = 'msg-' + secrets.token_hex(6)
    msg['parts'] = [{'text': texto}]
    if task_id is None:
        msg.pop('taskId', None)
    else:
        msg['taskId'] = task_id
    return corpo


def resumo(status, corpo):
    if 'error' in corpo:
        e = corpo['error']
        return f'HTTP {status} | erro {e.get("code")}: {e.get("message")}'
    r = corpo.get('result', corpo)
    task = r.get('task', r) if isinstance(r, dict) else {}
    if 'status' not in task:
        return f'HTTP {status}'
    texto = ' '.join(p.get('text', '') for p in (task['status'].get('message') or {}).get('parts', []))
    artefatos = ', '.join(a.get('name', '?') for a in task.get('artifacts') or []) or '-'
    return f'HTTP {status} | task {task.get("id")} | {task["status"]["state"]} | "{texto}" | artifacts: {artefatos}'


def main():
    ap = argparse.ArgumentParser(description='Demonstracao do agente A2A com os envelopes de exemplos/wire.')
    ap.add_argument('--agente', default='http://localhost:7300')
    ap.add_argument('--sem-trace', action='store_true', help='nao envia o header traceparent')
    sub = ap.add_subparsers(dest='comando', required=True)
    sub.add_parser('card')
    p = sub.add_parser('pedir')
    p.add_argument('texto', nargs='?')
    p = sub.add_parser('responder')
    p.add_argument('task_id')
    p.add_argument('texto')
    p = sub.add_parser('consultar')
    p.add_argument('task_id')
    a = ap.parse_args()
    base = a.agente.rstrip('/')

    if a.comando == 'card':
        status, corpo = abrir(urllib.request.Request(base + '/.well-known/agent-card.json'))
        print(json.dumps(corpo, indent=2, ensure_ascii=False))
        print(f'HTTP {status}')
        return
    if a.comando == 'pedir':
        req = request_do_exemplo('08-a2a-send-message.json')
        texto = a.texto or req['body']['params']['message']['parts'][0]['text']
        corpo = mensagem(req, texto)
    elif a.comando == 'responder':
        req = request_do_exemplo('10-a2a-send-message-continuacao.json')
        corpo = mensagem(req, a.texto, a.task_id)
    else:
        req = request_do_exemplo('09-a2a-get-task-input-required.json')
        corpo = json.loads(json.dumps(req['body']))
        corpo['params']['id'] = a.task_id
    status, resposta = enviar(base + '/a2a', req, corpo, a.sem_trace)
    print(json.dumps(resposta, indent=2, ensure_ascii=False))
    print(resumo(status, resposta))


if __name__ == '__main__':
    main()
