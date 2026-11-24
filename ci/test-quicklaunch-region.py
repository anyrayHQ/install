"""Contract tests for the quicklaunch region topology.

Topology=region deploys an inference region of an existing home: the gateway
runs `build/region-server.js`, the optimizer pulls home's state from the region
gateway's internal listener (:8789), and no console, metering or home secret
exists. Topology=home (the default) must stay exactly the stack it was. Why
each case is here:
  - the template renders both ways: conditions resolve, and every Ref/GetAtt in
    a created resource names a resource that is also created;
  - a region never holds the admin token, content key, pseudonym salt or
    deployment token, and never sets metering on: the region gateway refuses to
    start with any of them (monorepo gateway/src/regionServer.ts), and the
    optimizer refuses the admin token and content key (optimizer/src/regionBoot.ts);
  - the region wiring the images need: the region token, ANYRAY_REGION_GATEWAY_URL
    on the optimizer, port 8789 reachable only from inside the stack;
  - a home keeps its console, deployment token, updater front door and
    metering, and has none of the region pieces;
  - the follow-home path, run for real against stubbed AWS: every unreadable
    or held answer changes nothing, a newer or older home build moves every
    service to it with the gateway last, and an event can never name a target;
  - SecretFn generates no home secret for a region.

Run: python3 ci/test-quicklaunch-region.py
"""
import io, json, os, re, sys, types, urllib.error

import yaml

TPL = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                   'aws', 'anyray-quicklaunch.template.yaml')
SRC = open(TPL).read()

fails = []


def check(name, ok, detail=''):
    print(('  ok   ' if ok else '  FAIL ') + name + ('' if ok else '  <<< %s' % (detail,)))
    if not ok:
        fails.append(name)


# ---- load the template with its short-form intrinsics ----------------------
class CfnLoader(yaml.SafeLoader):
    pass


def _intrinsic(loader, suffix, node):
    if isinstance(node, yaml.ScalarNode):
        value = loader.construct_scalar(node)
    elif isinstance(node, yaml.SequenceNode):
        value = loader.construct_sequence(node, deep=True)
    else:
        value = loader.construct_mapping(node, deep=True)
    if suffix == 'Ref':
        return {'Ref': value}
    if suffix == 'Condition':
        return {'Condition': value}
    if suffix == 'GetAtt' and isinstance(value, str):
        value = value.split('.', 1)
    return {'Fn::' + suffix: value}


CfnLoader.add_multi_constructor('!', _intrinsic)
DOC = yaml.load(SRC, Loader=CfnLoader)
NO_VALUE = object()


# ---- render one parameter set ----------------------------------------------
def render(overrides):
    params = {k: v.get('Default') for k, v in DOC['Parameters'].items()}
    params.update(overrides)
    cache = {}

    def cond(name):
        if name not in cache:
            cache[name] = truth(DOC['Conditions'][name])
        return cache[name]

    def scalar(node):
        if isinstance(node, dict) and 'Ref' in node:
            return params[node['Ref']]
        return node

    def truth(node):
        (k, v), = node.items()
        if k == 'Condition':
            return cond(v)
        if k == 'Fn::Equals':
            return scalar(v[0]) == scalar(v[1])
        if k == 'Fn::Not':
            return not truth(v[0])
        if k == 'Fn::And':
            return all(truth(x) for x in v)
        if k == 'Fn::Or':
            return any(truth(x) for x in v)
        raise ValueError(k)

    def resolve(node):
        if isinstance(node, list):
            out = [resolve(x) for x in node]
            return [x for x in out if x is not NO_VALUE]
        if isinstance(node, dict):
            if list(node) == ['Fn::If']:
                name, yes, no = node['Fn::If']
                return resolve(yes if cond(name) else no)
            if node == {'Ref': 'AWS::NoValue'}:
                return NO_VALUE
            out = {k: resolve(v) for k, v in node.items()}
            return {k: v for k, v in out.items() if v is not NO_VALUE}
        return node

    resources = {}
    for name, body in DOC['Resources'].items():
        if name.startswith('Fn::ForEach::'):
            _, _, fragment = body
            (key, res), = fragment.items()
            name, body = key.replace('&{Cidr}', 'X'), res
        if 'Condition' in body and not cond(body['Condition']):
            continue
        resources[name] = resolve(body)
    outputs = {k: resolve(v) for k, v in DOC['Outputs'].items()
               if 'Condition' not in v or cond(v['Condition'])}
    return params, resources, outputs, cond


def refs(node, out):
    """Every resource a node names through Ref, GetAtt or ${Name} in a Sub."""
    if isinstance(node, list):
        for x in node:
            refs(x, out)
    elif isinstance(node, dict):
        for k, v in node.items():
            if k == 'Ref':
                out.add(v)
            elif k == 'Fn::GetAtt':
                out.add(v[0])
            elif k == 'Fn::Sub':
                text, local = (v, {}) if isinstance(v, str) else (v[0], v[1])
                out.update(m.split('.')[0] for m in re.findall(r'\$\{([A-Za-z0-9.:]+)\}', text)
                           if m.split('.')[0] not in local)
                refs(local, out)
            else:
                refs(v, out)
    return out


def env_of(task, container='gateway'):
    c = next(c for c in task['Properties']['ContainerDefinitions'] if c['Name'] == container)
    env = {e['Name']: e.get('Value') for e in c.get('Environment', [])}
    sec = {e['Name']: e['ValueFrom'] for e in c.get('Secrets', [])}
    return c, env, sec


HOME = {'Topology': 'home', 'AllowedCidr': ['203.0.113.0/24'], 'DeploymentToken': 'adt_synthetic'}
REGION = {'Topology': 'region', 'AllowedCidr': ['203.0.113.0/24'],
          'RegionToken': 'arr_e30.synthetic', 'CertificateArn': 'arn:aws:acm:eu-west-1:000000000000:certificate/x',
          'GatewayPublicUrl': 'https://eu.anyray.example.com:8787'}
FORBIDDEN_GATEWAY = {'ANYRAY_ADMIN_TOKEN', 'ANYRAY_DEPLOYMENT_TOKEN', 'ANYRAY_CONTENT_KEY',
                     'ANYRAY_PSEUDONYM_SALT', 'ANYRAY_OBSERVABILITY_DB_URL', 'ANYRAY_UPDATER_URL',
                     'ANYRAY_CONSOLE_PUBLIC_URL'}
FORBIDDEN_OPTIMIZER = {'ANYRAY_ADMIN_TOKEN', 'ANYRAY_CONTENT_KEY', 'ANYRAY_OBSERVABILITY_DB_URL'}
PSEUDO = {'AWS::Region', 'AWS::StackName', 'AWS::AccountId', 'AWS::Partition', 'AWS::NoValue', 'Cidr'}  # Cidr: the Fn::ForEach loop variable

for label, overrides in (('home', HOME), ('region', REGION)):
    for auto in ('true', 'false'):
        params, res, outs, _ = render({**overrides, 'EnableAutoUpdate': auto})
        print('== %s, EnableAutoUpdate=%s renders ==' % (label, auto))
        dangling = sorted(n for n in refs(list(res.values()) + list(outs.values()), set())
                          if n not in res and n not in params and n not in PSEUDO)
        check('every reference names a created resource or a parameter', not dangling, dangling)

print('== a region holds no home secret ==')
_, R, ROUT, rcond = render(REGION)
gw, genv, gsec = env_of(R['GatewayTask'])
_, oenv, osec = env_of(R['OptimizerTask'], 'optimizer')
check('the gateway starts the region entry', gw.get('Command') == ['node', 'build/region-server.js'], gw.get('Command'))
check('the gateway carries the region token from its own secret',
      gsec.get('ANYRAY_REGION_TOKEN') == {'Ref': 'RegionTokenSecret'}, gsec.get('ANYRAY_REGION_TOKEN'))
check('the gateway holds nothing a region refuses',
      not (FORBIDDEN_GATEWAY & (set(genv) | set(gsec))), FORBIDDEN_GATEWAY & (set(genv) | set(gsec)))
check('metering is off in the region', genv.get('ANYRAY_METERING_ENABLED') != 'true')
check('the gateway has its optimizer URL and token and the regional database',
      'ANYRAY_OPTIMIZER_URL' in genv and {'ANYRAY_OPTIMIZER_TOKEN', 'ANYRAY_SPEND_DB_URL'} <= set(gsec))
check('the gateway announces its own https URL',
      genv.get('ANYRAY_GATEWAY_PUBLIC_URL') == {'Ref': 'GatewayPublicUrl'}, genv.get('ANYRAY_GATEWAY_PUBLIC_URL'))
check('the optimizer is in region mode on the internal listener',
      'gateway-dns.${AWS::StackName}.anyray.internal:8789' in json.dumps(oenv.get('ANYRAY_REGION_GATEWAY_URL')),
      oenv.get('ANYRAY_REGION_GATEWAY_URL'))
check('the optimizer holds nothing a region refuses',
      not (FORBIDDEN_OPTIMIZER & (set(oenv) | set(osec))), FORBIDDEN_OPTIMIZER & (set(oenv) | set(osec)))
check('gateway and optimizer share one optimizer token',
      gsec['ANYRAY_OPTIMIZER_TOKEN'] == osec['ANYRAY_OPTIMIZER_TOKEN'])
check('the gateway container check is liveness only',
      '/livez' in json.dumps(gw['HealthCheck']['Command']), gw['HealthCheck']['Command'])
check('8789 is a container port', any(p['ContainerPort'] == 8789 for p in gw['PortMappings']))
check('8789 is open only to the tasks and the probe',
      R['TasksSelfRegionInternal']['Properties']['SourceSecurityGroupId'] == {'Ref': 'TasksSg'}
      and R['TasksFromFollowHome']['Properties']['SourceSecurityGroupId'] == {'Ref': 'FollowHomeSg'})
alb_ports = {r['Properties']['FromPort'] for n, r in R.items() if n.startswith('Alb') and n.endswith('IngressX')}
check('the load balancer never exposes 8789 or the console', alb_ports == {8787, 443}, alb_ports)
check('the target group stays on the gateway port', R['GatewayTg']['Properties']['Port'] == 8787)
for gone in ('ProxyTask', 'ProxyServiceV2', 'ProxyTg', 'ConsoleListener', 'ProxyLogGroup', 'TasksFromAlbProxy',
             'DeploymentTokenSecret', 'UpdaterApi', 'UpdaterIntegration', 'UpdaterRoute', 'UpdaterStage',
             'UpdaterApiPermission'):
    check('no %s in a region' % gone, gone not in R)
check('no console or admin-token output', 'ConsoleURL' not in ROUT and 'AdminTokenCmd' not in ROUT, list(ROUT))
upd = R['UpdaterFn']['Properties']['Environment']['Variables']
check('the region updater reads no admin token', 'TOKEN_SECRET_ARN' not in upd)
check('the region updater is in follow-home mode', upd.get('FOLLOW_HOME_FN') == {'Fn::GetAtt': ['FollowHomeProbeFn', 'Arn']})
check('only the schedule invokes the region updater',
      R['FollowHomePermission']['Properties']['Principal'] == 'events.amazonaws.com'
      and R['FollowHomePermission']['Properties']['SourceArn'] == {'Fn::GetAtt': ['FollowHomeRule', 'Arn']})
check('the probe sits in the VPC on its own security group',
      R['FollowHomeProbeFn']['Properties']['VpcConfig']['SecurityGroupIds'] == [{'Ref': 'FollowHomeSg'}])
statements = R['UpdaterRole']['Properties']['Policies'][0]['PolicyDocument']['Statement']
check('the region updater role cannot read an admin token',
      'secretsmanager:GetSecretValue' not in json.dumps(statements))
check('AppSecrets is told it is a region', R['AppSecrets']['Properties'].get('Topology') == 'region')

print('== a region without auto-update has no follow-home pieces ==')
_, R0, _, _ = render({**REGION, 'EnableAutoUpdate': 'false'})
for gone in ('UpdaterFn', 'FollowHomeProbeFn', 'FollowHomeRule', 'FollowHomeSg', 'TasksFromFollowHome'):
    check('no %s' % gone, gone not in R0)

print('== a home is unchanged ==')
_, H, HOUT, hcond = render(HOME)
hgw, henv, hsec = env_of(H['GatewayTask'])
_, hoenv, hosec = env_of(H['OptimizerTask'], 'optimizer')
check('the home gateway keeps its default command', 'Command' not in hgw)
check('the home gateway keeps metering, the console URL and the updater URL',
      henv.get('ANYRAY_METERING_ENABLED') == 'true' and 'ANYRAY_CONSOLE_PUBLIC_URL' in henv
      and 'ANYRAY_UPDATER_URL' in henv)
check('the home gateway keeps every home secret',
      {'ANYRAY_ADMIN_TOKEN', 'ANYRAY_CONTENT_KEY', 'ANYRAY_PSEUDONYM_SALT', 'ANYRAY_DEPLOYMENT_TOKEN',
       'ANYRAY_OBSERVABILITY_DB_URL'} <= set(hsec))
check('the home gateway holds no region token', 'ANYRAY_REGION_TOKEN' not in hsec)
check('the home optimizer keeps the admin token and content key and is not in region mode',
      {'ANYRAY_ADMIN_TOKEN', 'ANYRAY_CONTENT_KEY'} <= set(hosec) and 'ANYRAY_REGION_GATEWAY_URL' not in hoenv)
check('the home gateway check still reads readiness',
      "localhost:8787/'" in json.dumps(hgw['HealthCheck']['Command']), hgw['HealthCheck']['Command'])
check('8789 is not opened on a home', all(p['ContainerPort'] != 8789 for p in hgw['PortMappings']))
for kept in ('ProxyTask', 'ProxyServiceV2', 'ConsoleListener', 'DeploymentTokenSecret', 'UpdaterApi'):
    check('a home keeps %s' % kept, kept in H)
for gone in ('RegionTokenSecret', 'TasksSelfRegionInternal', 'FollowHomeProbeFn', 'FollowHomeRule', 'FollowHomeSg'):
    check('a home has no %s' % gone, gone not in H)
check('AppSecrets properties are what they were (no generate re-run on update)',
      'Topology' not in H['AppSecrets']['Properties'])
check('the home updater keeps its admin-token gate and has no follow-home mode',
      'TOKEN_SECRET_ARN' in H['UpdaterFn']['Properties']['Environment']['Variables']
      and 'FOLLOW_HOME_FN' not in H['UpdaterFn']['Properties']['Environment']['Variables'])

print('== the topology rules ==')
rules = DOC['Rules']
check('a home requires the deployment token and refuses a region token',
      rules['HomeNeedsDeploymentToken']['RuleCondition'] == {'Fn::Equals': [{'Ref': 'Topology'}, 'home']})
region_rule = json.dumps(rules['RegionNeedsTokenAndHttps'])
check('a region requires its token, HTTPS and its URL, and refuses the deployment token',
      all(p in region_rule for p in ('RegionToken', 'DeploymentToken', 'CertificateArn', 'GatewayPublicUrl')))


# ---- the inline Lambdas, run for real --------------------------------------
def inline_code(resource):
    start = SRC.index('  %s:\n' % resource)
    at = SRC.index('ZipFile: |', start) + len('ZipFile: |')
    lines = []
    for ln in SRC[at:].split('\n')[1:]:
        if ln.strip() == '':
            lines.append('')
            continue
        if not ln.startswith('          '):
            break
        lines.append(ln[10:])
    return '\n'.join(lines)


STATE = {'tags': {}, 'registered': [], 'updated': [], 'refreshed': 0, 'probe': None, 'secrets': {}}


class FakeEcs:
    def list_services(self, cluster, maxResults, **kw):
        return {'serviceArns': ['arn:' + f for f in STATE['tags']]}

    def describe_services(self, cluster, services):
        return {'services': [{'serviceName': a[4:] + '-svc', 'taskDefinition': a[4:]} for a in services]}

    def describe_task_definition(self, taskDefinition):
        tag = STATE['tags'][taskDefinition]
        return {'taskDefinition': {'family': taskDefinition, 'containerDefinitions': [
            {'name': 'app', 'image': 'public.ecr.aws/anyray/x:' + tag},
            {'name': 'drain', 'image': 'public.ecr.aws/anyray/x:' + tag}]}}

    def register_task_definition(self, **td):
        STATE['registered'].append((td['family'], td['containerDefinitions'][0]['image'].rsplit(':', 1)[1]))
        return {'taskDefinition': {'taskDefinitionArn': 'td/' + td['family']}}

    def update_service(self, cluster, service, taskDefinition=None, **kw):
        STATE['updated'].append(service)


class FakeLambda:
    def invoke(self, FunctionName, **kw):
        if FunctionName == 'secret-fn':
            STATE['refreshed'] += 1
            return {'Payload': io.BytesIO(b'{"Changed": false}')}
        probe = STATE['probe']
        if probe == 'crash':
            return {'FunctionError': 'Unhandled', 'Payload': io.BytesIO(b'{"errorMessage": "x"}')}
        return {'Payload': io.BytesIO(json.dumps(probe).encode())}


class FakeSm:
    class exceptions:
        class ResourceExistsException(Exception):
            pass

        class ResourceNotFoundException(Exception):
            pass

        class InvalidRequestException(Exception):
            pass

    def get_secret_value(self, SecretId):
        if SecretId in STATE['secrets']:
            return {'SecretString': STATE['secrets'][SecretId]}
        raise AssertionError('the region updater read a secret: %s' % SecretId)

    def create_secret(self, Name, SecretString):
        if Name in STATE['secrets']:
            raise self.exceptions.ResourceExistsException()
        STATE['secrets'][Name] = SecretString
        return {'ARN': 'arn:' + Name}

    def describe_secret(self, SecretId):
        return {'ARN': 'arn:' + SecretId}


boto3 = types.ModuleType('boto3')
boto3.client = lambda svc, *a, **k: {'ecs': FakeEcs, 'lambda': FakeLambda}.get(svc, FakeSm)()
sys.modules['boto3'] = boto3

os.environ.update({'CLUSTER': 'c', 'FAMILY_PREFIX': 'st-', 'FOLLOW_HOME_FN': 'probe-fn',
                   'SECRET_FN_ARN': 'secret-fn', 'REFRESH_PAYLOAD': '{}',
                   'INDEX_URL': 'https://charts.invalid/index.yaml'})
os.environ.pop('TOKEN_SECRET_ARN', None)
updater = {}
exec(compile(inline_code('UpdaterFn'), 'updater.py', 'exec'), updater)
updater['latest_release'] = lambda: (_ for _ in ()).throw(AssertionError('a region read the release index'))


def follow(probe, tags, event=None):
    STATE.update(probe=probe, tags=dict(tags), registered=[], updated=[], refreshed=0)
    return updater['handler'](event if event is not None else {'followHome': True}, None)


print('== follow-home holds on anything it cannot trust ==')
RUNNING = {'st-gateway': 'v1.10.640', 'st-optimizer': 'v1.10.640'}
for probe, why in (({'hold': 'warming'}, 'gateway still warming'), ({'hold': 'home_unreachable'}, 'home unreachable'),
                   ({}, 'empty answer'), ({'home': 'latest'}, 'not a release'),
                   ({'home': '1.10'}, 'short version'), ('crash', 'probe crashed')):
    r = follow(probe, RUNNING)
    check('holds (%s)' % why, r['status'] == 'hold' and not STATE['updated'] and not STATE['refreshed'], (r, STATE['updated']))

print('== follow-home moves to home whichever way it went ==')
r = follow({'home': '1.10.650', 'region': '1.10.640'}, RUNNING)
check('forward to home', r['tag'] == 'v1.10.650' and len(STATE['updated']) == 2, r)
check('the gateway moves last', STATE['updated'][-1] == 'st-gateway-svc', STATE['updated'])
check('db-url is refreshed once before the roll', STATE['refreshed'] == 1)
check('every container moves together', all(t == 'v1.10.650' for _, t in STATE['registered']), STATE['registered'])
r = follow({'home': '1.10.630', 'region': '1.10.640'}, RUNNING)
check('backward when home rolled back', r['status'] == 'ok' and r['tag'] == 'v1.10.630'
      and STATE['updated'][-1] == 'st-gateway-svc', r)
r = follow({'home': '1.10.640', 'region': '1.10.640'}, RUNNING)
check('already on home: nothing rolls', not STATE['updated'] and not STATE['refreshed']
      and sorted(r['alreadyCurrent']) == ['st-gateway-svc', 'st-optimizer-svc'], r)
r = follow({'home': '1.10.650'}, RUNNING,
           event={'headers': {'authorization': 'Bearer x'}, 'body': json.dumps({'target': 'v9.9.9'})})
check('an event can never name the target', r['tag'] == 'v1.10.650', r)

print('== the probe reads the gateway view like the Helm job ==')
probe_ns = {}
exec(compile(inline_code('FollowHomeProbeFn'), 'probe.py', 'exec'), probe_ns)


def answer(payload=None, status=200, err=None):
    def fake(url, timeout):
        if err:
            raise err
        if status != 200:
            raise urllib.error.HTTPError(url, status, 'x', {}, None)
        return io.BytesIO(json.dumps(payload).encode())
    probe_ns['urllib'].request.urlopen = fake
    return probe_ns['read_view']('http://gateway-dns.st.anyray.internal:8789/v1/region-home-build')


real_urlopen = probe_ns['urllib'].request.urlopen
try:
    check('a ready view passes home and region',
          answer({'v': 1, 'region': '1.10.640', 'home': '1.10.650'}) == {'home': '1.10.650', 'region': '1.10.640'})
    check('a gateway hold is passed through', answer({'v': 1, 'region': '1.10.640', 'home': None, 'hold': 'warming'}) == {'hold': 'warming'})
    check('an odd hold reason is not echoed', answer({'v': 1, 'region': '1.10.640', 'home': None, 'hold': 'Bad Reason!'}) == {'hold': 'unknown'})
    check('a 404 (gateway older than following home) holds', 'HTTP 404' in answer(status=404)['hold'])
    check('an unreachable gateway holds', answer(err=OSError('refused')) == {'hold': 'region gateway unreachable'})
    check('a wrong version holds', 'unreadable' in answer({'v': 2, 'region': '1.10.640', 'home': '1.10.650'})['hold'])
    check('a non-release home holds', 'unreadable' in answer({'v': 1, 'region': '1.10.640', 'home': 'latest'})['hold'])
    check('a non-object answer holds', 'unreadable' in answer(['x'])['hold'])
finally:
    probe_ns['urllib'].request.urlopen = real_urlopen

print('== SecretFn makes no home secret for a region ==')
secret_fn = {}
exec(compile(inline_code('SecretFn'), 'secretfn.py', 'exec'), secret_fn)
sent = {}
secret_fn['send'] = lambda event, context, status, data=None, pid=None: sent.update(status=status, data=data)
STATE['secrets'] = {}
secret_fn['handler']({'RequestType': 'Create', 'ResourceProperties': {
    'Action': 'generate', 'Prefix': 'st/anyray/', 'Topology': 'region'}}, None)
made = set(STATE['secrets'])
check('generate succeeds', sent.get('status') == 'SUCCESS', sent)
check('no admin token, content key or salt is created',
      not ({'st/anyray/admin-token', 'st/anyray/content-key', 'st/anyray/pseudonym-salt'} & made), made)
check('the optimizer token and database credential are', {'st/anyray/optimizer-token', 'st/anyray/db-master'} <= made, made)
check('the home-secret attributes resolve, empty',
      all(sent['data'].get(k) == '' for k in ('ContentKeyArn', 'AdminTokenArn', 'SaltArn')), sent.get('data'))
STATE['secrets'] = {}
secret_fn['handler']({'RequestType': 'Create', 'ResourceProperties': {'Action': 'generate', 'Prefix': 'st/anyray/'}}, None)
check('a home still gets every secret',
      {'st/anyray/admin-token', 'st/anyray/content-key', 'st/anyray/pseudonym-salt'} <= set(STATE['secrets']))

print()
print('FAILED: %d' % len(fails) if fails else 'ALL PASS')
sys.exit(1 if fails else 0)
