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
# STATE['fleet'] (family -> deployed tag, insertion-ordered) models a
# multi-service stack; None keeps the terse single-gateway default driven by
# STATE['deployed'], which most cases use.
STATE = {'deployed': 'v1.10.240', 'fleet': None, 'registered': [], 'updated': []}

def fleet():
    return STATE['fleet'] or {'anyray-gateway': STATE['deployed']}

class FakeEcs:
    def list_services(self, **kw):
        return {'serviceArns': ['arn:svc/' + f for f in fleet()]}
    def describe_services(self, **kw):
        return {'services': [{'serviceName': f,
                              'taskDefinition': 'arn:aws:ecs:::task-definition/%s:7' % f}
                             for f in fleet()]}
    def describe_task_definition(self, taskDefinition):
        name = taskDefinition.split('anyray-', 1)[-1]
        return {'taskDefinition': {
            'family': taskDefinition, 'taskDefinitionArn': 'arn:x', 'revision': 7,
            'status': 'ACTIVE', 'registeredAt': 'now',
            'containerDefinitions': [
                {'name': name,
                 'image': 'public.ecr.aws/anyray/%s:%s' % (name, fleet()[taskDefinition])}]}}
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

print('== mixed-version fleet: one refusal must mean ZERO mutations ==')
# gateway v1.0.0, proxy v3.0.0, target v2.0.0: an upgrade for the first
# service walked, a downgrade for the second. Validating inside the update
# loop registered + rolled the gateway FIRST and only then rejected on the
# proxy -- the caller got a 400 while the deployment had in fact partially
# updated, leaving the services this Lambda exists to keep on ONE version on
# two. The all-service read-only preflight must reject the whole call before
# any RegisterTaskDefinition/UpdateService, whatever the family list holds.
STATE['fleet'] = {'anyray-gateway': 'v1.0.0', 'anyray-proxy': 'v3.0.0'}
c, b = call(json.dumps({'target': 'v2.0.0'}))
check('mixed-version downgrade rejected 400', c == 400, '%s %s' % (c, b))
check('same refusal message shape', 'refusing to move anyray-proxy backwards' in b.get('message', ''), b)
check('ZERO task definitions registered', STATE['registered'] == [], STATE['registered'])
check('ZERO services rolled', STATE['updated'] == [], STATE['updated'])
STATE['fleet'] = None

print('== mixed-version fleet: a fully valid target still rolls only the stale ==')
# endpoint-control is in the fleet too: FAMILIES membership is the only thing
# that admits a service, so this doubles as proof the newest family is walked
# by the same preflight with no special-casing (RFC 0014).
STATE['fleet'] = {'anyray-gateway': 'v1.0.0', 'anyray-proxy': 'v2.0.0',
                  'anyray-endpoint-control': 'v1.5.0'}
c, b = call(json.dumps({'target': 'v2.0.0'}))
check('stale rolled, current skipped',
      c == 200 and b['updated'] == ['anyray-gateway', 'anyray-endpoint-control']
      and b['alreadyCurrent'] == ['anyray-proxy'], '%s %s' % (c, b))
check('endpoint-control image re-tagged like its siblings',
      'public.ecr.aws/anyray/endpoint-control:v2.0.0' in STATE['registered'],
      STATE['registered'])
STATE['fleet'] = None

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
