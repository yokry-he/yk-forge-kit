import { BuildIdSchema, DeployBasePathSchema } from '@forgekit/contracts';

export const shellQuote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;
export function releaseRoot(basePath: string, projectId: string, targetId: string): string {
  return `${DeployBasePathSchema.parse(basePath)}/forgekit-${BuildIdSchema.parse(projectId)}-${BuildIdSchema.parse(targetId)}`;
}
export function retentionPlan(releaseId: string, retainedIds: string[], retention: number): { keep: string[]; prune: string[] } {
  BuildIdSchema.parse(releaseId); retainedIds.forEach(id => BuildIdSchema.parse(id));
  if (!Number.isInteger(retention) || retention < 1 || retention > 50) throw new Error('invalid_retention');
  const all = [...new Set([releaseId, ...retainedIds])];
  return { keep: all.slice(0, retention), prune: all.slice(retention) };
}
/** GNU Linux: flock protects the whole transfer/switch/prune, timeout bounds abandoned remote sessions. */
export function releaseScript(root: string, operationId: string, releaseId: string, rollback: boolean, prune: string[]): string {
  BuildIdSchema.parse(operationId); BuildIdSchema.parse(releaseId); prune.forEach(id => BuildIdSchema.parse(id));
  // root comes exclusively from releaseRoot (or a private temp directory in script tests).
  const body = `set -eu
umask 022
cd ${shellQuote(root)}
[ ! -L releases ] && [ -d releases ] || exit 1
[ ! -e current ] || [ -L current ] || exit 1
staging=releases/.staging-${operationId}
release=releases/${releaseId}
link=.current-${operationId}
created=0
cleanup() {
  rm -rf -- "$staging"
  rm -f -- "$link"
  if [ "$(readlink current || true)" != "$release" ] && [ "$created" = 1 ] && [ "${rollback ? 'rollback' : 'deploy'}" = deploy ]; then rm -rf -- "$release"; fi
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM
${rollback ? '[ ! -L "$release" ] && [ -f "$release/.forgekit-complete" ] && [ -f "$release/index.html" ] || exit 1' : `if [ "$(readlink current || true)" != "$release" ]; then
  [ ! -L "$release" ] && [ ! -e "$release" ] || exit 1
  rm -rf -- "$staging"
  mkdir -- "$staging"
  tar --extract --file=- --directory="$staging" --no-same-owner --no-same-permissions
  [ -f "$staging/index.html" ] && [ ! -L "$staging/index.html" ] || exit 1
  touch "$staging/.forgekit-complete"
  mv -T -- "$staging" "$release"
  created=1
else
  cat >/dev/null
  [ -f "$release/.forgekit-complete" ] && [ -f "$release/index.html" ] || exit 1
fi`}
ln -s -- "$release" "$link"
mv -Tf -- "$link" current
printf 'B12_SWITCHED\\n'
${prune.map(id => `[ "$(readlink current)" = "releases/${id}" ] || rm -rf -- releases/${id}`).join('\n')}
printf 'B12_DONE\\n'
`;
  return `set -eu; umask 022; mkdir -p -- ${shellQuote(root)}; [ ! -L ${shellQuote(root)} ]; mkdir -p -- ${shellQuote(root + '/releases')}; exec timeout --signal=TERM --kill-after=5s 300s flock -w 10 ${shellQuote(root + '/.deploy.lock')} sh -c ${shellQuote(body)}`;
}
