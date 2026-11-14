"""Contract tests for how the quicklaunch template names the database version.

The template pinned `EngineVersion: '17.5'` from its first day. In November
2026 RDS retired 17.5 for new databases in most regions, and every new stack
there failed on its Db resource: "Cannot find version 17.5 for postgres".

The value cannot simply be changed. CloudFormation sends any change of this
property to RDS, and live tests on throwaway databases showed what RDS does
with it (staging account, 14 Nov 2026):

  database still on 17.5, template -> '17' or '17.7'   restarted and upgraded
  database RDS moved to 17.11,   template -> '17'      update FAILS, rolls back
                                 ("Cannot upgrade postgres from 17.11 to 17.9")
  database RDS moved to 17.9,    template -> '17.7'    update FAILS, rolls back

So the version is decided ONCE per stack and never changes after: a new stack
gets the major version alone (RDS picks the region's current minor), and a
stack that already exists keeps the 17.5 it was created with, which makes the
property unchanged and leaves its database alone. SecretFn's `generate` holds
that decision in a create-if-missing secret, the same way it holds the master
password.

Run: python3 ci/test-quicklaunch-dbengine.py
"""
import json, os, sys, types

TPL = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                   'aws', 'anyray-quicklaunch.template.yaml')

# ---- extract the inline Lambda source ----------------------------------
src = open(TPL).read()
start = src.index('  SecretFn:')
zf = src.index('ZipFile: |', start) + len('ZipFile: |')
lines = []
for ln in src[zf:].split('\n')[1:]:
    if ln.strip() == '':
        lines.append('')
        continue
    if not ln.startswith('          '):
        break
    lines.append(ln[10:])
CODE = '\n'.join(lines)

PREFIX = 'anyray/anyray/'
MARKER = PREFIX + 'db-engine-version'
NAMES = ['content-key', 'optimizer-token', 'admin-token', 'pseudonym-salt', 'db-master',
         'db-engine-version']
# A stack that exists already holds every secret an older template generated.
EXISTING = {PREFIX + n: 'synthetic-' + n for n in NAMES if n != 'db-engine-version'}


class NotFound(Exception): pass
class Exists(Exception): pass


class FakeSm:
    """Only the calls `generate` makes; every write is recorded."""

    def __init__(self, store):
        self.store = dict(store)
        self.creates, self.puts, self.deleted = [], [], []
        self.exceptions = types.SimpleNamespace(
            ResourceNotFoundException=NotFound, ResourceExistsException=Exists)

    def create_secret(self, Name, SecretString):
        if Name in self.store:
            raise Exists()
        self.creates.append(Name)
        self.store[Name] = SecretString
        return {'ARN': 'arn:' + Name}

    def put_secret_value(self, SecretId, SecretString):
        self.puts.append(SecretId)
        self.store[SecretId] = SecretString

    def describe_secret(self, SecretId):
        if SecretId not in self.store:
            raise NotFound()
        return {'ARN': 'arn:' + SecretId}

    def get_secret_value(self, SecretId):
        if SecretId not in self.store:
            raise NotFound()
        return {'SecretString': self.store[SecretId]}

    def delete_secret(self, SecretId, ForceDeleteWithoutRecovery):
        self.deleted.append(SecretId)
        self.store.pop(SecretId, None)


def run(sm, request_type, names=NAMES):
    """One CloudFormation call to `generate`; returns the reply it PUT back."""
    fake_boto3 = types.ModuleType('boto3')
    fake_boto3.client = lambda name, *a, **k: sm
    sys.modules['boto3'] = fake_boto3
    mod = types.ModuleType('secretfn')
    mod.__dict__['__name__'] = 'secretfn'
    eval(compile(CODE, 'secretfn.py', 'exec'), mod.__dict__)
    sent = []
    mod.urllib.request.urlopen = lambda req: (sent.append(req), types.SimpleNamespace())[1]
    event = {'RequestType': request_type, 'StackId': 's', 'RequestId': 'r',
             'LogicalResourceId': 'AppSecrets', 'ResponseURL': 'https://cfn.invalid/x',
             'ResourceProperties': {'Action': 'generate', 'Prefix': PREFIX, 'Names': names}}
    if request_type != 'Create':
        event['PhysicalResourceId'] = PREFIX + 'generate'
    mod.handler(event, types.SimpleNamespace(log_stream_name='synthetic-log-stream'))
    assert len(sent) == 1, sent
    return json.loads(sent[0].data.decode())


fails = []


def check(name, ok, detail=''):
    print(('  ok   ' if ok else '  FAIL ') + name + ('' if ok else '   <- ' + str(detail)))
    if not ok:
        fails.append(name)


def version_of(reply):
    return (reply.get('Data') or {}).get('DbEngineVersion')


print('== a new stack names the major version alone ==')
sm = FakeSm({})
reply = run(sm, 'Create')
check('the create succeeds', reply['Status'] == 'SUCCESS', reply)
check("a new stack's database is declared as '17'", version_of(reply) == '17', reply.get('Data'))
check('the decision is stored', sm.store.get(MARKER) == '17', sm.store.get(MARKER))

print('== a stack that already exists keeps the version it was created with ==')
# The first update to this template: every older secret exists, the decision
# does not. Anything but 17.5 here is a change CloudFormation sends to RDS.
sm = FakeSm(EXISTING)
reply = run(sm, 'Update')
check('the update succeeds', reply['Status'] == 'SUCCESS', reply)
check("an existing stack's database stays declared as '17.5'",
      version_of(reply) == '17.5', reply.get('Data'))
check('the decision is stored', sm.store.get(MARKER) == '17.5', sm.store.get(MARKER))
check('no other secret is created or rewritten',
      sm.creates == [MARKER] and sm.puts == [], (sm.creates, sm.puts))

print('== the decision never changes afterwards ==')
for decided in ('17', '17.5'):
    for request_type in ('Update', 'Create'):
        sm = FakeSm(dict(EXISTING, **{MARKER: decided}))
        reply = run(sm, request_type)
        check("a stack decided as '%s' answers '%s' on %s" % (decided, decided, request_type),
              version_of(reply) == decided, reply.get('Data'))
        check('  and writes nothing', sm.creates == [] and sm.puts == [],
              (sm.creates, sm.puts))

print('== a rollback to the older template keeps the decision ==')
# CloudFormation calls Update again with the OLD properties, whose Names lack
# the new secret. The decision must survive it, or the next attempt would
# decide again.
sm = FakeSm(dict(EXISTING, **{MARKER: '17.5'}))
reply = run(sm, 'Update', names=[n for n in NAMES if n != 'db-engine-version'])
check('the decision is still there', sm.store.get(MARKER) == '17.5', sm.store.get(MARKER))
check('and nothing is deleted', sm.deleted == [], sm.deleted)

print('== deleting the stack removes the decision with the other secrets ==')
sm = FakeSm(dict(EXISTING, **{MARKER: '17'}))
run(sm, 'Delete')
check('the decision is deleted', MARKER in sm.deleted, sm.deleted)

print('== the template wires it ==')
db = src[src.index('\n  Db:\n'):src.index('\n  Efs:\n')]
check('Db takes its engine version from the decision',
      'EngineVersion: !GetAtt AppSecrets.DbEngineVersion' in db, 'not wired')
check('Db names no version of its own',
      "EngineVersion: '" not in db and 'EngineVersion: "' not in db, 'a literal is still there')
secrets = src[src.index('\n  AppSecrets:\n'):src.index('\n  DbUrlSecret:\n')]
# Names is what makes CloudFormation call generate on an existing stack's
# update (a property changed) and what Delete cleans up.
check('AppSecrets lists the decision among its names', 'db-engine-version' in secrets,
      'missing from Names')

print()
print('FAILED: %d' % len(fails) if fails else 'ALL PASS')
sys.exit(1 if fails else 0)
