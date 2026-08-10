"""Contract tests for the quicklaunch UpdaterFn Lambda.

Extracts the inline Python out of the CloudFormation template and drives the
handler against stubbed ECS/SecretsManager, so the update path is testable
without deploying a stack.

The case that earns this file: the gateway asks for a BARE version (the control
plane strips the `v` before serving it) while published images are tagged
`vX.Y.Z`. A `^v...` regex here rejects every unattended update the gateway will
ever send, and because the gateway records the attempt either way, its 6h retry
TTL then suppresses the retry -- turning a lagging-index stall into a permanent
one.

Run: python3 ci/test-quicklaunch-updater.py
"""
import json, base64, os, sys, types

os.environ.update({
    'TOKEN_SECRET_ARN': 'arn:aws:secretsmanager:eu-central-1:111122223333:secret:synthetic',
    'CLUSTER': 'anyray-cluster',
    'FAMILY_PREFIX': 'anyray-',
    'INDEX_URL': 'https://charts.example.invalid/index.yaml',
})

TPL = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                   'aws', 'anyray-quicklaunch.template.yaml')

# ---- extract the inline Lambda source ----------------------------------
src = open(TPL).read()
start = src.index('  UpdaterFn:')
zf = src.index('ZipFile: |', start) + len('ZipFile: |')
lines = []
for ln in src[zf:].split('\n')[1:]:
    if ln.strip() == '':
        lines.append('')
        continue
    if not ln.startswith('          '):
        break
    lines.append(ln[10:])
code = '\n'.join(lines)

# ---- stub boto3 --------------------------------------------------------
STATE = {'deployed': 'v1.10.240', 'registered': [], 'updated': []}

class FakeEcs:
    def list_services(self, **kw):
        return {'serviceArns': ['arn:svc/anyray-gateway']}
    def describe_services(self, **kw):
        return {'services': [{'serviceName': 'anyray-gateway',
                              'taskDefinition': 'arn:aws:ecs:::task-definition/anyray-gateway:7'}]}
    def describe_task_definition(self, taskDefinition):
        return {'taskDefinition': {
            'family': taskDefinition, 'taskDefinitionArn': 'arn:x', 'revision': 7,
            'status': 'ACTIVE', 'registeredAt': 'now',
            'containerDefinitions': [
                {'name': 'gateway',
                 'image': 'public.ecr.aws/anyray/gateway:' + STATE['deployed']}]}}
    def register_task_definition(self, **td):
        STATE['registered'].append(td['containerDefinitions'][0]['image'])
        return {'taskDefinition': {'taskDefinitionArn': 'arn:new'}}
    def update_service(self, **kw):
        STATE['updated'].append(kw['service'])

class FakeSm:
    def get_secret_value(self, SecretId):
        return {'SecretString': 'tok-synthetic'}

boto3 = types.ModuleType('boto3')
boto3.client = lambda svc, *a, **k: FakeEcs() if svc == 'ecs' else FakeSm()
sys.modules['boto3'] = boto3

ns = {}
exec(compile(code, 'updater.py', 'exec'), ns)
handler = ns['handler']
ns['latest_release'] = lambda: 'v1.10.242'   # stub the index (no network)

AUTH = {'authorization': 'Bearer tok-synthetic'}

def call(body=None, headers=AUTH, b64=False):
    STATE['registered'].clear(); STATE['updated'].clear()
    ev = {'headers': headers}
    if body is not None:
        ev['body'] = base64.b64encode(body.encode()).decode() if b64 else body
        ev['isBase64Encoded'] = b64
    r = handler(ev, None)
    return r['statusCode'], json.loads(r['body'])

fails = []
def check(name, cond, detail=''):
    print(('  ok   ' if cond else '  FAIL ') + name + ('' if cond else '  <<< %s' % (detail,)))
    if not cond:
        fails.append(name)

print('== the blocker: gateway sends a BARE version (control plane strips the v) ==')
c, b = call(json.dumps({'target': '1.10.245'}))
check('bare "1.10.245" accepted', c == 200, '%s %s' % (c, b))
check('rolled to the v-prefixed published tag',
      STATE['registered'] == ['public.ecr.aws/anyray/gateway:v1.10.245'], STATE['registered'])
check('reports requested, not index', b.get('target') == 'requested', b)

print('== v-prefixed still works (console / future callers) ==')
c, b = call(json.dumps({'target': 'v1.10.244'}))
check('v-prefixed accepted', c == 200 and b['tag'] == 'v1.10.244', '%s %s' % (c, b))

print('== no body => index path unchanged (console one-click) ==')
for label, kwargs in [('absent', {}), ('empty', {'body': ''}), ('blank', {'body': '   '}),
                      ('no target key', {'body': '{}'})]:
    c, b = call(**kwargs)
    check('%s body falls back to index' % label,
          c == 200 and b['tag'] == 'v1.10.242' and b['target'] == 'index', '%s %s' % (c, b))

print('== base64 (Function URL may encode) ==')
c, b = call(json.dumps({'target': '1.10.243'}), b64=True)
check('base64 body decoded', c == 200 and b['tag'] == 'v1.10.243', '%s %s' % (c, b))

print('== downgrade is refused (the primitive this change would have created) ==')
c, b = call(json.dumps({'target': '1.10.100'}))
check('older version rejected 400', c == 400, '%s %s' % (c, b))
check('nothing registered on refusal', STATE['registered'] == [], STATE['registered'])
check('nothing rolled on refusal', STATE['updated'] == [], STATE['updated'])

print('== equal version is a no-op, not a refusal ==')
c, b = call(json.dumps({'target': '1.10.240'}))
check('same version = alreadyCurrent',
      c == 200 and b['alreadyCurrent'] == ['anyray-gateway'], '%s %s' % (c, b))

print('== malformed input => 400, never 500, never reaches an image ==')
INJECTION = 'v1.10.245; ' + 'rm -rf' + ' /'
for label, body in [('latest', '{"target":"latest"}'),
                    ('shell injection', json.dumps({'target': INJECTION})),
                    ('traversal', '{"target":"../../evil"}'),
                    ('non-string', '{"target":123}'),
                    ('bad json', 'not json'),
                    ('json array', '[1,2,3]'),
                    ('json string', '"v1.10.245"'),
                    ('overlong digits', json.dumps({'target': 'v1.10.' + '9' * 400}))]:
    c, b = call(body)
    ok = c == 400 and STATE['registered'] == []
    check('%s -> 400, no image touched' % label, ok,
          '%s %s reg=%s' % (c, b, STATE['registered']))

print('== control chars are normalized away, never reaching an image ==')
# `$` in Python is not an end-of-string anchor, so `v1.2.3\n` clears a `^...$`
# regex. fullmatch + re-emitting from the parsed digit groups means a newline
# can never land in a RegisterTaskDefinition parameter or a log line.
STATE['deployed'] = 'v1.0.0'
c, b = call(json.dumps({'target': 'v1.2.3\n'}))
check('newline-suffixed version does not reach the image',
      all('\n' not in img for img in STATE['registered']),
      STATE['registered'])
check('tag echoed back is clean', '\n' not in b.get('tag', ''), b)
STATE['deployed'] = 'v1.10.240'

print('== auth still precedes body parsing ==')
c, b = call('{"target":"v1.10.245"}', headers={})
check('no token => 403 even with a valid body', c == 403, '%s %s' % (c, b))
c, b = call('not json at all', headers={'authorization': 'Bearer wrong'})
check('bad token => 403, malformed body never parsed', c == 403, '%s %s' % (c, b))

print('== bearer scheme is matched, not assumed by offset ==')
# The old code sliced 7 characters off the header without checking the prefix,
# so any 7-byte preamble stood in for "Bearer ".
c, b = call('{}', headers={'authorization': 'XXXXXXXtok-synthetic'})
check('7-byte preamble is not a bearer prefix', c == 403, '%s %s' % (c, b))
c, b = call('{}', headers={'authorization': 'bearer tok-synthetic'})
check('scheme is case-insensitive (RFC 7235)', c == 200, '%s %s' % (c, b))
c, b = call('{}', headers={'authorization': 'Bearer    '})
check('blank token rejected', c == 403, '%s %s' % (c, b))

print('== an internal failure tells the CALLER nothing about the deployment ==')
# This endpoint is public (AuthType NONE) and the catch-all also covers
# authorised(), so a missing/denied secret must not echo its ARN back.
ARN = os.environ['TOKEN_SECRET_ARN']
del os.environ['TOKEN_SECRET_ARN']
try:
    c, b = call('{}', headers=AUTH)
    msg = json.dumps(b)
    check('secret ARN never reaches the response', ARN not in msg, msg)
    check('bare env var name never reaches the response',
          'TOKEN_SECRET_ARN' not in msg, msg)
    check('still a 500 with a pointer to the logs', c == 500, '%s %s' % (c, b))
finally:
    os.environ['TOKEN_SECRET_ARN'] = ARN

print()
print('FAILED: %d' % len(fails) if fails else 'ALL PASS')
sys.exit(1 if fails else 0)
