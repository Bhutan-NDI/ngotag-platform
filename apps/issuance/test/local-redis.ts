import { execFileSync } from 'child_process';

export function localRedis(): { host: string; port: number } {
  const context = execFileSync('docker', ['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}'], {
    encoding: 'utf8'
  }).trim();
  if (!context.startsWith('unix://')) {
    throw new Error('A local Docker context is required');
  }
  const port = execFileSync('docker', ['port', 'codex-issuance-p2-redis', '6379/tcp'], { encoding: 'utf8' }).trim();
  const match = /^127\.0\.0\.1:(\d+)$/.exec(port);
  if (!match) {
    throw new Error('Dedicated Redis fixture must publish only on localhost');
  }
  return { host: '127.0.0.1', port: Number(match[1]) };
}
