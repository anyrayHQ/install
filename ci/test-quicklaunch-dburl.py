"""Contract tests for the quicklaunch SecretFn Lambda's db-url handling.

Extracts the inline Python out of the CloudFormation template and drives the
handler against a stubbed Secrets Manager, so both callers are testable without
deploying a stack.

The case that earns this file: the Db instance sets ManageMasterUserPassword,
so RDS rotates the master password on its own schedule, into its own secret.
The composer that writes `<stack>/anyray/db-url` is a one-shot -- it runs at
stack create, and on update only when its properties change -- so after the
first rotation db-url holds a password that authenticates nothing. Every
already-running task survives on its open connection pool, which is what makes
this invisible: the failure surfaces only at the next task start (an image
roll, a scale event, the auto-updater, a newly added service) as
`password authentication failed for user "postgres"`, which trips the ECS
deployment circuit breaker and can wedge the stack in UPDATE_ROLLBACK_FAILED --
long after the rotation that actually caused it.

Run: python3 ci/test-quicklaunch-dburl.py
"""
import json, os, re, sys, types, urllib.parse

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

MASTER_ARN = 'arn:aws:secretsmanager:eu-central-1:111122223333:secret:rds!db-synthetic'
PREFIX = 'anyray/anyray/'
PROPS = {'Action': 'composeDbUrl', 'Prefix': PREFIX, 'MasterSecretArn': MASTER_ARN,
         'DbHost': 'db.internal', 'DbName': 'postgres'}


class NotFound(Exception): pass
class Exists(Exception): pass
class InvalidRequest(Exception): pass


class FakeSm:
    """Only the calls the handler makes; every write is recorded."""

    def __init__(self, store, password):
        self.store = dict(store)
        self.password = password
        self.puts, self.creates, self.deleted = [], [], []
        self.master_error = None
        self.exceptions = types.SimpleNamespace(
            ResourceNotFoundException=NotFound,
            ResourceExistsException=Exists,
            InvalidRequestException=InvalidRequest)

    def get_secret_value(self, SecretId):
        if SecretId == MASTER_ARN:
            if self.master_error:
                raise self.master_error
            return {'SecretString': json.dumps(
                {'username': 'postgres', 'password': self.password})}
        if SecretId not in self.store:
            raise NotFound()
        return {'SecretString': self.store[SecretId]}

    def put_secret_value(self, SecretId, SecretString):
        self.puts.append(SecretId)
        self.store[SecretId] = SecretString

    def create_secret(self, Name, SecretString):
        if Name in self.store:
            raise Exists()
        self.creates.append(Name)
        self.store[Name] = SecretString
        return {'ARN': 'arn:' + Name}

    def describe_secret(self, SecretId):
        return {'ARN': 'arn:' + SecretId}

    def delete_secret(self, SecretId, ForceDeleteWithoutRecovery):
        self.deleted.append(SecretId)
        self.store.pop(SecretId, None)


def load(sm):
    """Import the extracted handler with boto3 and the CFN reply stubbed."""
    fake_boto3 = types.ModuleType('boto3')
    fake_boto3.client = lambda *a, **k: sm
    sys.modules['boto3'] = fake_boto3
    mod = types.ModuleType('secretfn')
    mod.__dict__['__name__'] = 'secretfn'
    eval(compile(CODE, 'secretfn.py', 'exec'), mod.__dict__)
    sent = []
    mod.urllib.request.urlopen = lambda req: (sent.append(req),
                                              types.SimpleNamespace())[1]
    return mod, sent


def url_for(password):
    q = lambda s: urllib.parse.quote(s, safe='')
    return 'postgresql://%s:%s@db.internal:5432/postgres?sslmode=no-verify' % (
        q('postgres'), q(password))


fails = []


def check(name, ok, detail=''):
    print(('  ok   ' if ok else '  FAIL ') + name + ('' if ok else '   <- ' + str(detail)))
    if not ok:
        fails.append(name)


CTX = types.SimpleNamespace(log_stream_name='synthetic-log-stream')
CFN = {'RequestType': 'Create', 'ResourceProperties': PROPS, 'StackId': 's',
       'RequestId': 'r', 'LogicalResourceId': 'l', 'ResponseURL': 'https://cfn.invalid/x'}

print('== the rotation the one-shot composer misses ==')
sm = FakeSm({PREFIX + 'db-url': url_for('old-synthetic')}, 'new/synthetic?pw')
mod, sent = load(sm)
out = mod.handler({'ResourceProperties': PROPS}, CTX)
check('a rotated master rewrites db-url', out.get('Changed') is True, out)
check('the new password is URL-encoded',
      sm.store[PREFIX + 'db-url'] == url_for('new/synthetic?pw'),
      sm.store[PREFIX + 'db-url'])
check('exactly one write', sm.puts == [PREFIX + 'db-url'], sm.puts)

print('== a refresh that changes nothing writes nothing ==')
# Hourly PutSecretValue on an unchanged URL would churn a new version every
# hour for no reason.
sm = FakeSm({PREFIX + 'db-url': url_for('same-synthetic')}, 'same-synthetic')
mod, sent = load(sm)
out = mod.handler({'ResourceProperties': PROPS}, CTX)
check('no-op when the password is unchanged',
      out.get('Changed') is False and sm.puts == [], '%s %s' % (out, sm.puts))

print('== the refresh follows db-url, it never creates it ==')
# The Delete branch force-deletes db-url. A scheduled refresh racing in behind
# that would otherwise resurrect a LIVE master credential as an orphan secret
# outliving the stack that owned it.
sm = FakeSm({}, 'synthetic')
mod, sent = load(sm)
out = mod.handler({'ResourceProperties': PROPS}, CTX)
check('an absent db-url is not resurrected',
      sm.creates == [] and sm.puts == [] and out.get('Changed') is False,
      'creates=%s puts=%s out=%s' % (sm.creates, sm.puts, out))

print('== the CloudFormation contract still holds ==')
sm = FakeSm({}, 'synthetic')
mod, sent = load(sm)
mod.handler(dict(CFN), CTX)
body = json.loads(sent[0].data.decode()) if sent else {}
check('create answers SUCCESS on the response URL', body.get('Status') == 'SUCCESS', body)
check('create composes db-url', sm.store.get(PREFIX + 'db-url') == url_for('synthetic'),
      sm.store)
check('create reports the ARN back to the stack',
      body.get('Data', {}).get('DbUrlArn') == 'arn:' + PREFIX + 'db-url', body)

print('== the two callers never cross ==')
# EventBridge sends the properties bare. Answering a ResponseURL that is not
# there is what the dispatch branch exists to prevent -- including from the
# failure path.
sm = FakeSm({PREFIX + 'db-url': url_for('old-synthetic')}, 'new-synthetic')
mod, sent = load(sm)
mod.handler({'ResourceProperties': PROPS}, CTX)
check('a scheduled refresh sends no CloudFormation reply', sent == [], sent)

sm = FakeSm({PREFIX + 'db-url': url_for('old-synthetic')}, 'new-synthetic')
sm.master_error = RuntimeError('AccessDeniedException')
mod, sent = load(sm)
try:
    mod.handler({'ResourceProperties': PROPS}, CTX)
    check('an unreadable master raises', False, 'did not raise')
except RuntimeError:
    check('an unreadable master raises', True)
check('a failed refresh still sends no CloudFormation reply', sent == [], sent)

print('== delete still tears the secrets down ==')
sm = FakeSm({PREFIX + 'db-url': url_for('synthetic')}, 'synthetic')
mod, sent = load(sm)
ev = dict(CFN); ev['RequestType'] = 'Delete'; ev['ResourceProperties'] = dict(PROPS)
ev['ResourceProperties']['Names'] = ['db-url']
mod.handler(ev, CTX)
check('delete removes db-url', sm.deleted == [PREFIX + 'db-url'], sm.deleted)

print('== the master password is OURS, minted once, and never rewritten ==')
# The stack sets MasterUserPassword from <stack>/anyray/db-master instead of
# ManageMasterUserPassword. Two properties carry the whole design: the secret
# is shaped exactly like the RDS-managed one (so compose_db_url is unchanged),
# and `ensure` is create-if-missing -- a stack UPDATE re-runs `generate`, and
# must never change the password out from under a live database.
GEN = {'Action': 'generate', 'Prefix': PREFIX}
sm = FakeSm({}, 'unused-synthetic')
mod, sent = load(sm)
ev = dict(CFN); ev['ResourceProperties'] = GEN
mod.handler(ev, CTX)
minted = sm.store.get(PREFIX + 'db-master')
check('db-master is minted on create', minted is not None, sm.creates)
doc = json.loads(minted)
# Failure details below describe the SHAPE, never the value: `check` prints the
# detail, and a test that leaks a credential into CI logs on failure is the
# same class of bug this whole change is about (py/clear-text-logging-sensitive-data).
check('shaped like the RDS-managed secret it replaces',
      sorted(doc) == ['password', 'username'] and doc['username'] == 'postgres',
      {'keys': sorted(doc), 'username': doc.get('username')})
# RDS rejects '/', '"', '@' and space in a master password; hex avoids all of
# them, and also survives URL-encoding into the connection string unchanged.
check('password is URL/RDS-safe hex',
      re.fullmatch(r'[0-9a-f]{64}', doc['password']) is not None,
      'length=%d, charset-ok=%s' % (len(doc['password']),
                                    bool(re.fullmatch(r'[0-9a-f]*', doc['password']))))
check('compose_db_url reads it unchanged',
      mod.compose_db_url({'MasterSecretArn': PREFIX + 'db-master',
                          'DbHost': 'db.internal', 'DbName': 'postgres'})
      == url_for(doc['password']), 'compose mismatch')

# The load-bearing one: re-running generate (every stack UPDATE does) must NOT
# rotate the password. Changing it here would leave RDS on the old credential
# while db-url advertised the new one -- the exact outage this change removes.
before = dict(sm.store)
sm.creates.clear(); sm.puts.clear()
mod.handler(dict(ev), CTX)
# Compares by value but REPORTS only which names moved — never a stored value.
check('a stack update does not re-mint the password',
      sm.store == before,
      {'changed': sorted(k for k in set(before) | set(sm.store)
                         if before.get(k) != sm.store.get(k))})
check('and writes nothing at all', sm.puts == [] and sm.creates == [],
      {'puts': sm.puts, 'creates': sm.creates})

print()
print('FAILED: %d' % len(fails) if fails else 'ALL PASS')
sys.exit(1 if fails else 0)
