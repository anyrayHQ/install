"""Contract tests for the quicklaunch stop drain (ANY-2048).

ECS drops a stopping task from Cloud Map and signals it in the same moment, so
a caller that resolved the task's name keeps dialing its IP until the DNS cache
expires, while the app has already stopped listening. On Anyray's own ECS
stack the 2026-11-04 v1.10.560 roll showed the cost: Cloud Map deregistered
each task within 2s of its stop, and callers were refused for up to 18s after
it (nine console 502s, and gateway -> optimizer calls that fell open and busted
prompt caches). The quicklaunch stack has the same two Cloud Map hops:
gateway -> optimizer-dns and proxy -> gateway-dns.

So the optimizer and gateway tasks each carry a `drain` container. It depends
on the app container, ECS stops containers in reverse dependency order, so it
takes the stop signal first and holds the task while the app keeps serving.
Why each case is here:
  - both tasks carry it, non-essential, depending on their app container with
    START, on the app's own image (the updater moves every container's tag
    together, and its forward-only check reads them all);
  - the two scripts are the same script;
  - its hold outlasts the DNS window (record TTL plus the proxy's nginx
    `resolver valid=10s`) and its StopTimeout covers the hold, under
    Fargate's 120s cap;
  - run for real under node: TERM, INT and QUIT each start the hold, the
    process stays up through it, exits 0 after it, and a second signal
    neither cuts it short nor restarts it;
  - the app containers themselves are untouched (no dependency of their own,
    StopTimeouts as they were), and the proxy, which no one reaches through
    Cloud Map, carries no drain.

Run: python3 ci/test-quicklaunch-drain.py   (needs node on PATH)
"""
import os, re, select, shutil, signal, subprocess, sys, time

TPL = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                   'aws', 'anyray-quicklaunch.template.yaml')
SRC = open(TPL).read()

# The proxy image's nginx re-resolves gateway-dns at most this often
# (monorepo console/server/nginx.conf: `resolver ... valid=10s`). The image is
# built elsewhere, so the number is stated here rather than read.
PROXY_RESOLVER_VALID_S = 10
FARGATE_MAX_STOP_TIMEOUT_S = 120
GRACEFUL_EXIT_MARGIN_S = 10

failures = []


def check(label, ok, detail=''):
    if ok:
        print('  ok:', label)
    else:
        print('  FAIL:', label, ('- ' + detail) if detail else '', file=sys.stderr)
        failures.append(label)


def resource_block(name):
    """The text of one top-level resource, `  Name:` up to the next one."""
    m = re.search(r'(?m)^  %s:\n(.*?)(?=^  [A-Za-z][A-Za-z0-9]*:\n|\Z)' % re.escape(name), SRC, re.S)
    return m.group(1) if m else ''


def containers(task_block):
    """{name: text} for each `        - Name: x` container in a task block.

    Only what follows ContainerDefinitions: Volumes use the same indentation."""
    _, _, defs = task_block.partition('      ContainerDefinitions:\n')
    parts = re.split(r'(?m)^        - Name: ', defs)
    out = {}
    for part in parts[1:]:
        name, _, body = part.partition('\n')
        out[name.strip()] = body
    return out


def field(body, key):
    m = re.search(r'(?m)^          %s: (.+)$' % re.escape(key), body)
    return m.group(1).strip() if m else None


def drain_script(body):
    m = re.search(r'(?m)^          Command:\n            - \|\n((?:              .*\n|\n)+)', body)
    if not m:
        return None
    return '\n'.join(ln[14:] for ln in m.group(1).rstrip('\n').split('\n')) + '\n'


def cloud_map_ttls():
    ttls = []
    for name in ('GatewayDiscovery', 'OptimizerDiscovery'):
        m = re.search(r'TTL: (\d+)', resource_block(name))
        if m:
            ttls.append(int(m.group(1)))
    return ttls


scripts = {}
holds = {}
for task, app in (('OptimizerTask', 'optimizer'), ('GatewayTask', 'gateway')):
    print('== %s carries a stop drain ==' % task)
    cs = containers(resource_block(task))
    check('%s has a drain container' % task, 'drain' in cs, 'containers: %s' % sorted(cs))
    if 'drain' not in cs or app not in cs:
        continue
    d, a = cs['drain'], cs[app]
    check('it is not essential', field(d, 'Essential') == 'false', field(d, 'Essential') or 'unset')
    check('it depends on the %s container with START' % app,
          re.search(r'(?m)^            - \{ ContainerName: %s, Condition: START \}$' % app, d) is not None)
    check('it runs the app image', field(d, 'Image') == field(a, 'Image'),
          '%s vs %s' % (field(d, 'Image'), field(a, 'Image')))
    check('it runs node -e', field(d, 'EntryPoint') == '[node, -e]', field(d, 'EntryPoint') or 'unset')
    check('the %s container has no dependency of its own' % app, 'DependsOn:' not in a)
    script = drain_script(d)
    check('it carries a drain script', script is not None)
    if script is None:
        continue
    scripts[task] = script
    m = re.search(r'const drainMs = (\d+);', script)
    check('the script declares drainMs', m is not None)
    hold = int(m.group(1)) / 1000 if m else 0
    holds[task] = hold
    stop = int(field(d, 'StopTimeout') or 0)
    check('StopTimeout %ss covers the %ss hold plus %ss' % (stop, hold, GRACEFUL_EXIT_MARGIN_S),
          hold + GRACEFUL_EXIT_MARGIN_S <= stop <= FARGATE_MAX_STOP_TIMEOUT_S)

print('== the hold outlasts the DNS window ==')
ttls = cloud_map_ttls()
check('both Cloud Map services were found', len(ttls) == 2, str(ttls))
window = (max(ttls) if ttls else 0) + PROXY_RESOLVER_VALID_S
for task, hold in holds.items():
    check('%s holds %ss, longer than TTL %s + valid %s' % (task, hold, max(ttls or [0]), PROXY_RESOLVER_VALID_S),
          ttls and hold > window)
check('both tasks run the same drain script', len(set(scripts.values())) == 1 and len(scripts) == 2)

print('== the app containers and the proxy are as they were ==')
check('the optimizer keeps StopTimeout 30',
      field(containers(resource_block('OptimizerTask')).get('optimizer', ''), 'StopTimeout') == '30')
check('the gateway keeps StopTimeout 120',
      field(containers(resource_block('GatewayTask')).get('gateway', ''), 'StopTimeout') == '120')
check('the proxy carries no drain', 'drain' not in containers(resource_block('ProxyTask')))

node = shutil.which('node')
if not scripts:
    check('a drain script to run', False)
elif node is None:
    check('node is on PATH to run the drain script', False)
else:
    script = next(iter(scripts.values()))
    test_hold = 1.5
    fast = script.replace(re.search(r'const drainMs = \d+;', script).group(0),
                          'const drainMs = %d;' % int(test_hold * 1000))
    # The handlers are installed synchronously, so a line printed after the script's last statement
    # proves they are in place. A fixed head start was not enough: on a loaded runner node had not
    # reached them 0.5s in, the signal killed it (-15), and every check below failed with it.
    READY = 'drain-test: handlers installed'
    fast += "console.log('%s');\n" % READY
    second_signal_after = 1.0  # a restarted hold would end at this + test_hold, well past the bound below

    def wait_ready(p, timeout=20):
        deadline = time.time() + timeout
        seen = b''
        while time.time() < deadline and p.poll() is None:
            if select.select([p.stdout], [], [], 0.1)[0]:
                chunk = os.read(p.stdout.fileno(), 4096)
                if not chunk:
                    break
                seen += chunk
                if READY.encode() in seen:
                    return True, seen
        return False, seen

    def run(signals):
        p = subprocess.Popen([node, '-e', fast], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        ready, early = wait_ready(p)
        if not ready:
            p.kill()
            p.wait()
            return False, 'never ready', 0.0, (early + p.stdout.read()).decode()
        start = time.time()
        for i, sig in enumerate(signals):
            if i:
                time.sleep(second_signal_after)
            p.send_signal(sig)
        time.sleep(0.2)
        alive_early = p.poll() is None
        try:
            rc = p.wait(timeout=10)
        except subprocess.TimeoutExpired:
            p.kill()
            rc = 'timeout'
        out = (early + p.stdout.read()).decode()
        return alive_early, rc, time.time() - start, out

    for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGQUIT):
        print('== %s starts the hold ==' % sig.name)
        alive, rc, elapsed, out = run([sig])
        check('still up after the signal', alive)
        check('exits 0', rc == 0, str(rc))
        check('held for the drain (%.1fs)' % elapsed, test_hold <= elapsed < test_hold + 2)
        check('says which signal started it', sig.name in out, out.strip())

    print('== a second signal neither cuts the hold short nor restarts it ==')
    alive, rc, elapsed, out = run([signal.SIGTERM, signal.SIGTERM])
    check('still up after the second signal', alive)
    check('exits 0', rc == 0, str(rc))
    check('held once, from the first signal (%.1fs)' % elapsed,
          test_hold <= elapsed < test_hold + second_signal_after - 0.1)
    check('logged once', out.count('stop signal') == 1, out.strip())

if failures:
    print('quicklaunch drain checks FAILED (%d)' % len(failures), file=sys.stderr)
    sys.exit(1)
print('all quicklaunch drain checks passed')
